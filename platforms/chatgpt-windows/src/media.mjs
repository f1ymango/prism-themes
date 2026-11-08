import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_VIDEO_BYTES = 128 * 1024 * 1024;

export function inspectMedia(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_VIDEO_BYTES) throw new Error('Wallpaper must contain between 1 byte and 128 MiB.');
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    let offset = 0, movie = false, data = false, type = false;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error('Truncated MP4 box.');
      let size = bytes.readUInt32BE(offset), header = 8;
      const name = bytes.toString('ascii', offset + 4, offset + 8);
      if (size === 1) {
        if (offset + 16 > bytes.length) throw new Error('Truncated MP4 box.');
        const large = bytes.readBigUInt64BE(offset + 8);
        if (large > BigInt(bytes.length)) throw new Error('Invalid MP4 box length.');
        size = Number(large); header = 16;
      } else if (size === 0) size = bytes.length - offset;
      if (size < header || offset + size > bytes.length) throw new Error('Invalid MP4 box length.');
      if (name === 'ftyp') {
        const brands = [];
        for (let i = offset + header; i + 4 <= offset + size; i += 4) if (i !== offset + header + 4) brands.push(bytes.toString('ascii', i, i + 4));
        type = brands.some(brand => /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(brand));
      }
      if (name === 'moov' && size > header) movie = true;
      if (name === 'mdat' && size > header) data = true;
      offset += size;
    }
    if (!type || !movie || !data) throw new Error('Choose a complete MP4 video with movie and media data.');
    return { mime: 'video/mp4', kind: 'video' };
  }
  if (bytes.length > 16 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
    const vint = (offset, id = false) => {
      const first = bytes[offset];
      let width = 1;
      while (width <= 8 && !(first & (0x80 >> (width - 1)))) width++;
      if (width > 8 || offset + width > bytes.length || (id && width > 4)) throw new Error('Invalid WebM header.');
      let value = id ? first : first & (0xff >> width);
      for (let i = 1; i < width; i++) value = value * 256 + bytes[offset + i];
      return { width, value };
    };
    const header = vint(4), end = 4 + header.width + header.value;
    if (end > bytes.length || header.value > 4096) throw new Error('Truncated WebM header.');
    let webm = false;
    for (let offset = 4 + header.width; offset < end;) {
      const id = vint(offset, true); offset += id.width;
      const size = vint(offset); offset += size.width;
      if (offset + size.value > end) throw new Error('Invalid WebM header element.');
      if (id.value === 0x4282) webm = bytes.toString('ascii', offset, offset + size.value) === 'webm';
      offset += size.value;
    }
    if (!webm || end + 5 > bytes.length || bytes.readUInt32BE(end) !== 0x18538067) throw new Error('Choose a complete WebM video.');
    return { mime: 'video/webm', kind: 'video' };
  }
  return { ...inspectImage(bytes), kind: 'image' };
}

export function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image must contain between 1 byte and 15 MiB.');
  let mime, width, height;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) throw new Error('Invalid PNG header.');
    mime = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let ended = false, hasImageData = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (offset + length + 12 > bytes.length) throw new Error('Truncated PNG chunk.');
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL') throw new Error('Animated PNG is outside the static-image milestone.');
      if (type === 'IDAT') hasImageData = true;
      offset += length + 12;
      if (type === 'IEND') {
        if (length !== 0 || offset !== bytes.length) throw new Error('Invalid PNG ending.');
        ended = true; break;
      }
    }
    if (!ended || !hasImageData) throw new Error('Truncated PNG image data.');
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = 'image/jpeg';
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG marker.');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) throw new Error('Truncated JPEG segment.');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (size < 8) throw new Error('Invalid JPEG frame.');
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += size;
    }
  } else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp';
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('Invalid WebP container length.');
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), data = offset + 8;
      if (data + size > bytes.length) throw new Error('Truncated WebP chunk.');
      if (type === 'ANIM' || type === 'ANMF') throw new Error('Animated WebP is outside the static-image milestone.');
      if (type === 'VP8X') {
        if (size < 10 || bytes[data] & 2) throw new Error('Invalid or animated WebP.');
        width = bytes.readUIntLE(data + 4, 3) + 1; height = bytes.readUIntLE(data + 7, 3) + 1;
      } else if (type === 'VP8 ' && !width) {
        if (size < 10 || !bytes.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) throw new Error('Invalid WebP frame.');
        width = bytes.readUInt16LE(data + 6) & 0x3fff; height = bytes.readUInt16LE(data + 8) & 0x3fff;
      } else if (type === 'VP8L' && !width) {
        if (size < 5 || bytes[data] !== 0x2f) throw new Error('Invalid lossless WebP frame.');
        const dimensions = bytes.readUInt32LE(data + 1);
        width = (dimensions & 0x3fff) + 1; height = ((dimensions >>> 14) & 0x3fff) + 1;
      }
      offset = data + size + (size % 2);
    }
  } else throw new Error('Choose a static PNG, JPEG, or WebP image; file names do not determine the type.');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('Image dimensions must be valid and contain at most 40 million pixels.');
  }
  return { mime, width, height };
}

export async function loadLocalImage(filename) {
  return loadFile(filename, MAX_IMAGE_BYTES, inspectImage);
}

export async function loadLocalMedia(filename, { encoding = 'base64' } = {}) {
  if (!['base64','buffer','metadata','renderer'].includes(encoding)) throw new Error('Invalid media encoding.');
  return loadFile(filename, MAX_VIDEO_BYTES, inspectMedia, encoding);
}

async function loadFile(filename, limit, inspect, encoding = 'base64') {
  const file = await open(filename, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > limit) throw new Error(`Choose a regular wallpaper file no larger than ${limit / 1024 / 1024} MiB.`);
    // A bounded read also handles a file that grows after stat().
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (length !== stat.size) throw new Error('Wallpaper file changed while loading.');
    const info = inspect(bytes);
    const result = { name: basename(filename), ...info, bytes: length, sha256: createHash('sha256').update(bytes).digest('hex') };
    if (encoding === 'buffer') result.data = bytes;
    if (encoding === 'base64' || (encoding === 'renderer' && info.kind !== 'video')) result.dataBase64 = bytes.toString('base64');
    return result;
  } finally { await file.close(); }
}
