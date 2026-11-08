import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTheme, deriveTheme } from '../src/theme.mjs';
import { wallpaperStyle } from '../src/wallpaper-style.mjs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

const sample = (r, g, b) => Uint8ClampedArray.from([r, g, b, 255, r, g, b, 255]);

test('theme settings reject CSS injection and out-of-range values', () => {
  assert.deepEqual(normalizeTheme(), { mode: 'auto', font: 'auto', tint: null, accent: null, opacity: .76, radius: 14 });
  for (const value of [null, [], { font: 'url(evil)' }, { tint: '#fff;background:red' }, { accent: 'red' }, { opacity: .1 }, { opacity: NaN }, { radius: 29 }, { radius: 1.5 }, { css: '*' }]) {
    assert.throws(() => normalizeTheme(value));
  }
});

test('decoded frame colours affect the theme while panel tint stays near native light or dark', () => {
  const theme = normalizeTheme();
  const cyan = deriveTheme(sample(25, 190, 210), theme, false);
  const red = deriveTheme(sample(210, 40, 45), theme, false);
  assert.notEqual(cyan.accent, red.accent);
  assert.equal(cyan.font, 'rounded');
  assert.ok(parseInt(cyan.tint.slice(1, 3), 16) < 80);
  const light = deriveTheme(sample(25, 190, 210), theme, true);
  assert.ok(parseInt(light.tint.slice(1, 3), 16) > 190);
});

test('explicit theme choices produce scoped reversible CSS; off restores baseline tint', () => {
  const chosen = normalizeTheme({ font: 'serif', tint: '#233445', accent: '#ff7788', opacity: .8, radius: 9 });
  const effective = deriveTheme(sample(25, 190, 210), chosen, false);
  assert.deepEqual(effective, { font: 'serif', tint: '#233445', accent: '#ff7788', opacity: .8, radius: 9 });
  const css = wallpaperStyle('theme-owner-123', effective);
  assert.match(css, /#233445cc/);
  assert.match(css, /Georgia/);
  assert.match(css, /border-radius:9px/);
  assert.ok(css.includes('html[data-prism-wallpaper="theme-owner-123"] #root'));
  assert.equal(deriveTheme(sample(25, 190, 210), normalizeTheme({ mode: 'off' }), false), null);
  assert.ok(!wallpaperStyle('theme-owner-123', null).includes('font-family:Georgia'));
});

test('theme commands persist overrides and a new wallpaper resets to auto', async () => {
  const base = resolve('.prism-probe/theme-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'theme-'));
  const asset = resolve('assets/prism-night.png');
  const state = join(root, 'state');
  const control = resolve('scripts/native/control.mjs');
  const run = async (...args) => JSON.parse((await execute(process.execPath, [control, '--root', root, ...args], { windowsHide: true })).stdout);
  try {
    await mkdir(state);
    await writeFile(join(root, 'installation.json'), JSON.stringify({ product: 'prism-chatgpt', enabled: true }));
    await writeFile(join(state, 'preferences.json'), JSON.stringify({ schema: 1, image: asset, enabled: true, settings: { controls: false } }));
    assert.equal((await run('theme', 'font', 'serif')).theme.font, 'serif');
    assert.equal((await run('theme', 'accent', '#ff7788')).theme.accent, '#ff7788');
    assert.equal((await run('theme', 'opacity', '80%')).theme.opacity, .8);
    assert.equal((await run('theme', 'off')).theme.mode, 'off');
    await assert.rejects(run('theme', 'tint', 'red'));
    assert.equal((await run('bg', asset)).theme.mode, 'auto');
    assert.equal(JSON.parse(await readFile(join(state, 'preferences.json'), 'utf8')).theme.accent, null);
  } finally {
    if (!resolve(root).startsWith(base + sep)) throw new Error('Refusing cleanup outside theme test root');
    await rm(root, { recursive: true });
  }
});
