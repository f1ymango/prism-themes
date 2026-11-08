import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { validatePreferences, saveJson } from './preferences.mjs';

export function themeName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Theme names must contain 1–100 printable characters.');
  return value.trim();
}

export async function readThemeLibrary(filename) {
  let text;
  try { text = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { schema: 1, themes: [] }; throw error; }
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Theme library exceeds its size limit.');
  const library = JSON.parse(text);
  if (library?.schema !== 1 || !Array.isArray(library.themes) || library.themes.length > 256) throw new Error('Invalid theme library.');
  const ids = new Set(), names = new Set();
  for (const entry of library.themes) {
    if (!/^[a-f0-9]{64}$/.test(entry.id ?? '') || ids.has(entry.id) || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error('Invalid or duplicate saved theme.');
    ids.add(entry.id);
    const name = themeName(entry.name).toLowerCase();
    if (names.has(name)) throw new Error('Duplicate saved theme name.');
    names.add(name);
    validatePreferences({ ...entry, enabled: true }, resolve('.'));
  }
  return library;
}

export function findSavedTheme(library, query) {
  const exact = library.themes.find(entry => entry.id === query || entry.name.toLowerCase() === query.toLowerCase());
  const matches = exact ? [exact] : library.themes.filter(entry => entry.id.startsWith(query));
  if (matches.length !== 1) throw new Error(matches.length ? 'Theme name or ID is ambiguous; use the full ID from theme list.' : 'Saved theme not found; use theme list.');
  return matches[0];
}

export async function rememberTheme(filename, library, preferences, media, { name, effectiveTheme } = {}) {
  const previous = library.themes.find(entry => entry.id === media.sha256);
  if (!previous && library.themes.length >= 256) throw new Error('Theme library is full (256 wallpapers).');
  const derivedName = /^[a-f0-9]{64}\.(image|video)$/.test(media.name) ? `Wallpaper ${media.sha256.slice(0, 8)}` : basename(media.name, extname(media.name));
  let label = themeName(name ?? previous?.name ?? derivedName.slice(0, 100));
  if (!name && !previous && library.themes.some(entry => entry.name.toLowerCase() === label.toLowerCase())) label = `${label.slice(0, 88)} (${media.sha256.slice(0, 8)})`;
  if (library.themes.some(entry => entry.id !== media.sha256 && entry.name.toLowerCase() === label.toLowerCase())) throw new Error('That theme name is already used by another wallpaper.');
  const theme = effectiveTheme ? { ...preferences.theme, ...effectiveTheme } : preferences.theme;
  const entry = { schema: 1, id: media.sha256, name: label, image: preferences.image, settings: preferences.settings, theme, updatedAt: new Date().toISOString() };
  const next = { schema: 1, themes: [...library.themes.filter(item => item.id !== entry.id), entry] };
  await saveJson(filename, next);
  return entry;
}
