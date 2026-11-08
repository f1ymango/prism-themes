import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Wallpaper settings must be an object.');
  if (Object.keys(value).some(key => !['dim', 'fit', 'position', 'controls'].includes(key))) throw new Error('Unknown wallpaper setting.');
  const result = { dim: 0.35, fit: 'cover', position: 'center', controls: true, ...value };
  if (typeof result.dim !== 'number' || !Number.isFinite(result.dim) || result.dim < 0 || result.dim > 1) throw new Error('Dim must be a number from 0 to 1.');
  if (!['cover', 'contain'].includes(result.fit)) throw new Error('Fit must be cover or contain.');
  if (!['center', 'top', 'bottom', 'left', 'right'].includes(result.position)) throw new Error('Invalid wallpaper position.');
  if (typeof result.controls !== 'boolean') throw new Error('Controls must be true or false.');
  return result;
}

export async function readWallpaperConfig(filename) {
  const text = await readFile(filename, 'utf8');
  if (Buffer.byteLength(text) > 16 * 1024) throw new Error('Wallpaper configuration is too large.');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 || typeof value.image !== 'string' || !value.image.trim()) throw new Error('Expected a schema 1 configuration with an image path.');
  if (Object.keys(value).some(key => !['schema', 'image', 'settings'].includes(key))) throw new Error('Unknown configuration field.');
  return { image: resolve(dirname(resolve(filename)), value.image), settings: normalizeSettings(value.settings) };
}
