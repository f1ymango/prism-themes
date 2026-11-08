import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inspectImage, inspectMedia, loadLocalImage, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from '../src/media.mjs';

const fixture = new URL('../assets/prism-night.png', import.meta.url);

test('video sniffing validates containers rather than trusting an extension', () => {
  const box = (name, data) => { const b = Buffer.alloc(8 + data.length); b.writeUInt32BE(b.length); b.write(name, 4); data.copy(b, 8); return b; };
  const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0mp42')), box('moov', Buffer.alloc(4)), box('mdat', Buffer.alloc(4))]);
  assert.deepEqual(inspectMedia(mp4), { mime: 'video/mp4', kind: 'video' });
  assert.throws(() => inspectMedia(mp4.subarray(0, mp4.length - 1)), /length/);
  assert.throws(() => inspectMedia(mp4.subarray(0, 20)), /complete MP4/);
  assert.throws(() => inspectMedia(Buffer.alloc(MAX_VIDEO_BYTES + 1)), /128 MiB/);
  const webm = Buffer.from([0x1a,0x45,0xdf,0xa3,0x87,0x42,0x82,0x84,...Buffer.from('webm'),0x18,0x53,0x80,0x67,0xff]);
  assert.deepEqual(inspectMedia(webm), { mime: 'video/webm', kind: 'video' });
  const fake = Buffer.from(webm); fake.write('matr', 8);
  assert.throws(() => inspectMedia(fake), /complete WebM/);
});

test('local PNG is recognized by its bytes with bounded metadata and a content fingerprint', async () => {
  const image = await loadLocalImage(fileURLToPath(fixture));
  assert.equal(image.mime, 'image/png');
  assert.equal(image.width, 1280); assert.equal(image.height, 720);
  assert.equal(image.sha256.length, 64);
  assert.equal(Buffer.from(image.dataBase64, 'base64').length, image.bytes);
});

test('missing, oversized, unsupported, malformed, animated, and excessive-dimension images fail before launch', async () => {
  await assert.rejects(loadLocalImage(fileURLToPath(new URL('../assets/does-not-exist.png', import.meta.url))), /ENOENT/);
  assert.throws(() => inspectImage(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /15 MiB/);
  for (const bytes of [Buffer.from('<svg/>'), Buffer.from('GIF89a'), Buffer.from('not an image')]) assert.throws(() => inspectImage(bytes), /static PNG/);
  const png = await readFile(fixture);
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16);
  assert.throws(() => inspectImage(huge), /40 million/);
  assert.throws(() => inspectImage(png.subarray(0, 40)), /Truncated/);
  const animatedChunk = Buffer.alloc(12); animatedChunk.write('acTL', 4);
  assert.throws(() => inspectImage(Buffer.concat([png.subarray(0, 33), animatedChunk, png.subarray(33)])), /Animated PNG/);
});

test('JPEG frame dimensions are extracted without trusting the file extension', () => {
  const jpeg = Buffer.from([255,216,255,192,0,11,8,0,24,0,32,1,1,17,0,255,217]);
  assert.deepEqual(inspectImage(jpeg), { mime: 'image/jpeg', width: 32, height: 24 });
  assert.throws(() => inspectImage(jpeg.subarray(0, 9)), /Truncated/);
});

test('WebP dimensions and animation flags are checked within the RIFF bounds', () => {
  const webp = Buffer.alloc(30);
  webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(31, 24, 3); webp.writeUIntLE(23, 27, 3);
  assert.deepEqual(inspectImage(webp), { mime: 'image/webp', width: 32, height: 24 });
  const animated = Buffer.from(webp); animated[20] = 2;
  assert.throws(() => inspectImage(animated), /animated WebP/);
  assert.throws(() => inspectImage(webp.subarray(0, 29)), /length/);
});
