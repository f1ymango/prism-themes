import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { normalizeSettings, readWallpaperConfig } from '../src/settings.mjs';

test('wallpaper settings have explicit defaults and reject CSS-like or unknown values', () => {
  assert.deepEqual(normalizeSettings(), { dim: .35, fit: 'cover', position: 'center', controls: true });
  for (const settings of [{ dim: NaN }, { dim: -1 }, { dim: 2 }, { dim: '0.5' }, { fit: 'cover;display:none' }, { position: 'url(...)' }, { controls: 'true' }, { css: '*' }, [], null]) {
    assert.throws(() => normalizeSettings(settings));
  }
});

test('configuration resolves the image relative to the config file', async () => {
  const config = await readWallpaperConfig(fileURLToPath(new URL('../examples/static-wallpaper.json', import.meta.url)));
  assert.equal(config.image, fileURLToPath(new URL('../assets/prism-night.png', import.meta.url)));
  assert.equal(config.settings.fit, 'cover');
});
