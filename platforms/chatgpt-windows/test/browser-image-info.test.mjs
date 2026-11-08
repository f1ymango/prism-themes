import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browserImageInfo } from '../src/browser-image-info.mjs';
import { inspectImage } from '../src/media.mjs';

test('browser picker and Node validator agree on fixture dimensions', async () => {
  for (const name of ['prism-night.png', 'prism-plum.png']) {
    const bytes = await readFile(new URL(`../assets/${name}`, import.meta.url));
    assert.deepEqual(browserImageInfo(new Uint8Array(bytes)), inspectImage(bytes));
  }
});

test('browser picker rejects unsupported files and malformed/animated PNG data', async () => {
  assert.throws(() => browserImageInfo(new Uint8Array([1,2,3])), /PNG/);
  const bytes = await readFile(new URL('../assets/prism-night.png', import.meta.url));
  assert.throws(() => browserImageInfo(new Uint8Array(bytes.subarray(0,40))), /Truncated/);
  const animated = Buffer.alloc(12); animated.write('acTL',4);
  assert.throws(() => browserImageInfo(new Uint8Array(Buffer.concat([bytes.subarray(0,33),animated,bytes.subarray(33)]))), /static PNG/);
});
