// Deterministic, original PNG test fixtures. No downloaded artwork or image dependencies.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(name, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(name, 4, 'ascii'); data.copy(result, 8);
  let crc = 0xffffffff;
  for (const value of result.subarray(4, -4)) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function landscape(width, height, alternate = false) {
  const data = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / width, v = y / height, glow = Math.exp(-((u - .72) ** 2 / .055 + (v - .3) ** 2 / .07));
    let color = [13 + 42 * glow + 6 * v, 21 + 61 * glow + 6 * v, 43 + 61 * glow + 8 * v];
    const ribbon = Math.exp(-((v - (.28 + .07 * Math.sin(u * 7))) ** 2) / .0018) * Math.sin(Math.PI * u) ** 2;
    color = color.map((value, i) => value + ribbon * [14, 54, 45][i]);
    if ((x * 1973 + y * 9277 + x * y * 13) % 5003 < 3 && v < .55) color = [159, 194, 209];
    const moon = Math.hypot((u - .77) * width, (v - .24) * height);
    if (moon < height * .055) color = [222, 219, 180];
    if (v > .66 - .07 * Math.sin(u * 9) - .06 * Math.sin(u * 19)) color = [20, 43, 59];
    if (v > .79 - .05 * Math.sin(u * 12 + 2) - .03 * Math.sin(u * 31)) color = [13, 31, 44];
    if (v > .91 - .05 * Math.sin(u * 8)) color = [9, 21, 32];
    if (alternate) color = [color[2] * .9, color[1] * .75, color[0] + 38];
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    data.set(color.map(value => Math.min(255, Math.round(value))), offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
const directory = resolve('assets');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'prism-night.png'), landscape(1280, 720));
await writeFile(join(directory, 'prism-plum.png'), landscape(960, 1280, true));
console.log('Created two deterministic local PNG fixtures.');
