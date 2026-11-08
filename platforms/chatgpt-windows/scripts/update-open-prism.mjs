import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { discoverApp, inspectApp } from '../src/app.mjs';
import { assertSupportedBuild } from '../src/compatibility.mjs';
import { fingerprintApp, verifyDebugListener } from '../src/verification.mjs';
import { packageIdentity } from '../src/windows.mjs';
import { isProcessAlive } from '../src/preferences.mjs';
import { connectRenderer } from '../src/renderer.mjs';
import { evaluate, CdpClient } from '../src/cdp.mjs';
import { inspectImage } from '../src/media.mjs';
import { wallpaperExpression } from '../src/wallpaper.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(project, '.prism-user');
let renderer;
try {
  const status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(directory, 'manager.lock'), 'utf8'));
  if (status.state !== 'running' || lock.pid !== status.managerPid || !isProcessAlive(status.managerPid) || !isProcessAlive(status.appPid)) throw new Error('No active Prism-owned window was found.');
  const app = await discoverApp();
  const before = await fingerprintApp(app);
  assertSupportedBuild(await inspectApp(app), before);
  const identity = await packageIdentity(status.appPid);
  if (!identity.packageFullName?.startsWith('OpenAI.Codex_')) throw new Error('Unexpected app package identity.');
  const [portText, browserPath] = (await readFile(join(directory, 'profile', 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(browserPath)) throw new Error('Invalid existing connection metadata.');
  await verifyDebugListener(port, status.appPid);
  const browserUrl = `ws://127.0.0.1:${port}${browserPath}`;
  const discovery = await CdpClient.connect(browserUrl);
  const ownedTargets = [];
  try {
    const { targetInfos } = await discovery.send('Target.getTargets');
    for (const target of targetInfos.filter(item => item.type === 'page' && /^app:\/\/-\/index\.html(?:[?#]|$)/.test(item.url))) {
      const { sessionId } = await discovery.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      try {
        const response = await discovery.send('Runtime.evaluate', { expression: "document.documentElement.getAttribute('data-prism-wallpaper')", returnByValue: true, timeout: 1000 }, { sessionId, timeoutMs: 2000 });
        if (/^[a-f0-9-]{36}$/.test(response.result?.value ?? '')) ownedTargets.push(target.targetId);
      } finally { await discovery.send('Target.detachFromTarget', { sessionId }); }
    }
  } finally { discovery.close(); }
  if (ownedTargets.length !== 1) throw new Error('Expected exactly one Prism-owned app window; refusing an ambiguous update.');
  renderer = await connectRenderer({ browserUrl }, { worldName: 'prism-update-discovery', targetId: ownedTargets[0] });
  const owner = await renderer.evaluate("document.documentElement.getAttribute('data-prism-wallpaper')");
  if (!/^[a-f0-9-]{36}$/.test(owner ?? '')) throw new Error('The existing wallpaper has no recognized owner.');
  const { frameTree } = await renderer.client.send('Page.getFrameTree', {}, { sessionId: renderer.sessionId });
  const { executionContextId } = await renderer.client.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: `prism-prism-session-${owner}` }, { sessionId: renderer.sessionId });
  const run = expression => evaluate(renderer.client, renderer.sessionId, expression, executionContextId);
  const previous = await run(`(async()=>{
    const state=globalThis.__prismWallpaperV1;
    if(!state||state.runId!==${JSON.stringify(owner)})throw new Error('The original owner context is unavailable');
    const bytes=new Uint8Array(await (await fetch(state.objectUrl)).arrayBuffer());
    let binary='';for(let start=0;start<bytes.length;start+=8192)binary+=String.fromCharCode(...bytes.subarray(start,start+8192));
    return {name:state.image.name,dataBase64:btoa(binary),settings:{...state.settings}};
  })()`);
  const bytes = Buffer.from(previous.dataBase64, 'base64');
  const image = { name: previous.name, dataBase64: previous.dataBase64, ...inspectImage(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  await run(wallpaperExpression('remove', { runId: owner }));
  let applied;
  try { applied = await run(wallpaperExpression('apply', { runId: owner, image, settings: previous.settings, mode: 'session', panelOpen: false })); }
  catch (error) {
    await run(wallpaperExpression('apply', { runId: owner, image, settings: { ...previous.settings, controls: false }, mode: 'session' })).catch(() => {});
    throw error;
  }
  if (!applied.visible || applied.image.sha256 !== image.sha256 || JSON.stringify(applied.settings) !== JSON.stringify(previous.settings)) throw new Error('The in-place upgrade did not preserve the previous appearance.');
  const after = await fingerprintApp(app);
  const report = {
    at: new Date().toISOString(), appPid: status.appPid,
    updatedWithoutRelaunch: isProcessAlive(status.appPid) && isProcessAlive(status.managerPid),
    imagePreserved: true, settingsPreserved: true,
    installedFilesUnchanged: JSON.stringify(before) === JSON.stringify(after),
    controls: ['in-app file picker', 'Prism command bar', 'Ctrl+Alt+P'],
  };
  await mkdir(join(project, '.prism-probe'), { recursive: true });
  await writeFile(join(project, '.prism-probe', 'open-window-update.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { renderer?.client.close(); }
