import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectRenderer } from '../../../src/renderer.mjs';
import { loadLocalImage } from '../../../src/media.mjs';
import { wallpaperExpression } from '../../../src/wallpaper.mjs';

const runDir = resolve(process.argv[2]);
const [port, path] = (await readFile(join(runDir, 'profile', 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
assert.match(port, /^\d+$/);
assert.match(path, /^\/devtools\/browser\/[\w-]+$/);
const renderer = await connectRenderer({ browserUrl: `ws://127.0.0.1:${port}${path}` }, { signal: AbortSignal.timeout(45000), worldName: 'prism-activation-proof' });
const owner = randomUUID();
const call = (action, extra = {}) => renderer.evaluate(wallpaperExpression(action, { runId: owner, ...extra }));
try {
  const image = await loadLocalImage(resolve('assets/prism-night.png'));
  const applied = await call('apply', { image, settings: { dim: .4, fit: 'cover', position: 'center', controls: false } });
  assert.equal(applied.visible, true);
  const second = await loadLocalImage(resolve('assets/prism-plum.png'));
  const switched = await call('apply', { image: second, settings: { dim: .4, fit: 'cover', position: 'center', controls: false } });
  assert.equal(switched.visible, true);
  assert.equal(switched.count, 1);
  assert.equal(switched.image.sha256, second.sha256);
  assert.notEqual(switched.image.sha256, applied.image.sha256);
  const changed = await call('update', { settings: { dim: .7 } });
  assert.equal(changed.settings.dim, .7);
  const screenshot = await renderer.client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, { sessionId: renderer.sessionId });
  await writeFile(join(runDir, 'wallpaper.png'), Buffer.from(screenshot.data, 'base64'));
  const removed = await call('remove');
  assert.equal(removed.count, 0);
  const result = { renderer: renderer.targetUrl, imageVisible: true, liveImageSwitch: true, liveSettingChange: true, restored: true };
  await writeFile(join(runDir, 'renderer-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await call('remove').catch(() => {});
  renderer.client.close();
}
