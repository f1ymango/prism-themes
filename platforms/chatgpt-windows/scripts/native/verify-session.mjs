import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { connectRenderer } from '../../src/renderer.mjs';
import { loadLocalImage } from '../../src/media.mjs';

const [root, profile, mode = 'full'] = process.argv.slice(2);
const execute = promisify(execFile);
const node = join(root, 'runtime', 'node.exe');
const controller = join(root, 'app', 'scripts', 'native', 'control.mjs');
const control = async (...args) => JSON.parse((await execute(node, [controller, '--root', root, ...args], { windowsHide: true })).stdout);
async function wait(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await delay(400); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}; status=${JSON.stringify(await control('status'))}`);
}
const [port, browserPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
const renderer = await connectRenderer({ browserUrl: `ws://127.0.0.1:${port}${browserPath}` }, { signal: AbortSignal.timeout(60000), worldName: 'prism-persistent-verification' });
const imageHash = () => renderer.evaluate(`(async()=>{const img=document.querySelector('#prism-wallpaper-v1 img');if(!img)return null;const b=await(await fetch(img.src)).arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('')})()`);
try {
  if (mode === 'removed') {
    await wait(async () => await renderer.evaluate(`!document.getElementById('prism-wallpaper-v1')`), 'wallpaper removal', 25000);
    assert.equal((await control('status')).installed, false);
    console.log(JSON.stringify({ removalRestoresAppearance: true }));
    process.exitCode = 0;
  } else {
  await wait(async () => (await control('status')).appliedWindows > 0, 'automatic wallpaper application');
  let preferences = JSON.parse(await readFile(join(root, 'state', 'preferences.json'), 'utf8'));
  const expected = await loadLocalImage(preferences.image);
  assert.equal(await imageHash(), expected.sha256);
  const checks = { automaticApplication: true };
  if (mode === 'full') {
    const secondPath = resolve('assets/prism-plum.png');
    const second = await loadLocalImage(secondPath);
    await control('bg', secondPath);
    await wait(async () => (await control('status')).appliedWindows > 0, 'live image command');
    assert.equal(await imageHash(), second.sha256);
    checks.liveImageCommand = true;
    const before = await readFile(join(root, 'state', 'preferences.json'), 'utf8');
    const invalid = join(root, 'invalid.image');
    await writeFile(invalid, 'invalid image');
    await assert.rejects(control('bg', invalid));
    assert.equal(await readFile(join(root, 'state', 'preferences.json'), 'utf8'), before);
    assert.equal(await imageHash(), second.sha256);
    checks.invalidImagePreservesWallpaper = true;
    await control('dim', '62%');
    await wait(async () => (await control('status')).appliedWindows > 0, 'live dimming');
    const settings = await control('status');
    assert.equal(settings.settings.dim, .62);
    checks.liveDimmingCommand = true;
    await control('off');
    await wait(async () => await renderer.evaluate(`!document.getElementById('prism-wallpaper-v1')`), 'restore command');
    checks.restoreCommand = true;
    await control('on');
    await wait(async () => (await control('status')).appliedWindows > 0, 'enable command');
    assert.equal(await imageHash(), second.sha256);
    checks.enableCommand = true;
  } else {
    assert.equal(preferences.settings.dim, .62);
    assert.equal(await imageHash(), (await loadLocalImage(resolve('assets/prism-plum.png'))).sha256);
    checks.savedImageAfterReinstall = true;
  }
  await writeFile(join(root, `verification-${mode}.json`), JSON.stringify(checks, null, 2));
  console.log(JSON.stringify(checks));
  }
} finally { renderer.client.close(); }
