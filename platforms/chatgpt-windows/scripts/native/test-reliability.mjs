import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, access, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverApp } from '../../src/app.mjs';
import { launchIsolated } from '../../src/session.mjs';
import { registeredLauncher, packageIdentity } from '../../src/windows.mjs';
import { verifyDebugListener, snapshotAppRoots, waitForDebugListenerClosed } from '../../src/verification.mjs';
import { CdpClient } from '../../src/cdp.mjs';
import { connectRenderer } from '../../src/renderer.mjs';
import { loadLocalImage } from '../../src/media.mjs';

const execute = promisify(execFile);
const windowsOnly = process.argv.includes('--windows-only');
const workspace = resolve('.');
const root = join(workspace, '.prism-probe', `r${randomUUID().slice(0, 8)}`);
const profile = join(root, 'profile'), backend = join(root, 'backend');
const shell = 'powershell.exe';
const scripts = join(workspace, 'scripts', 'native');
const state = join(root, 'state');
const ps = async (script, env = {}) => (await execute(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, env: { ...process.env, ...env } })).stdout.trim();
async function script(name, args = []) {
  const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(scripts, name), ...args], { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 });
  return result.stdout;
}
const fixtureArguments = ['-InstallRoot', root, '-NoStartup', '-NoSkill', '-NoHook', '-TestProfile', profile, '-TestBackend', backend, '-MaxSeconds', '300'];
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const control = async (...args) => JSON.parse((await execute(join(root, 'runtime', 'node.exe'), [join(root, 'app', 'scripts', 'native', 'control.mjs'), '--root', root, ...args], { windowsHide: true })).stdout);
const report = { result: 'failed', scope: 'Owned isolated CDP processes; fixture discovery records are seeded after PID, package, and listener verification. The personal callback remains active and unchanged.', checks: {}, observations: {}, error: null };
let app, originalRoots, personalBefore, session, browser;
const verifiers = new Map();
const stage = message => console.log(JSON.stringify({ stage: message }));
async function wait(check, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await delay(500); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}; ${JSON.stringify(await control('status'))}`);
}
async function personalSnapshot() {
  return JSON.parse(await ps(`
$ErrorActionPreference='Stop'
$package=$env:PRISM_TEST_PACKAGE
$values=@()
foreach($path in @(('Registry::HKEY_CURRENT_USER\\Software\\Classes\\ActivatableClasses\\Package\\'+$package+'\\DebugInformation'),('Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\PackagedAppXDebug\\'+$package))) {
 if(Test-Path -LiteralPath $path){$values+=,(Get-Item -LiteralPath $path).GetValue('')}else{$values+=,$null}
}
$run=(Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'PrismChatGPTWallpaper' -ErrorAction SilentlyContinue).PrismChatGPTWallpaper
[pscustomobject]@{callbacks=$values;startup=$run}|ConvertTo-Json -Compress
`, { PRISM_TEST_PACKAGE: 'OpenAI.Codex_26.1103.4239.0_x64__2p2nqsd0c76g0' }));
}
async function killFixtureProcess(pid, expectedImage) {
  await ps(`
$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:PRISM_TEST_PID)
if(!$p -or $p.ExecutablePath -ne $env:PRISM_TEST_IMAGE -or !$p.CommandLine.Contains($env:PRISM_TEST_ROOT)){throw 'Fixture process ownership did not match'}
$process=Get-Process -Id $p.ProcessId
Stop-Process -InputObject $process -Force
`, { PRISM_TEST_PID: String(pid), PRISM_TEST_IMAGE: expectedImage, PRISM_TEST_ROOT: root });
}
async function visibleNativeWindows(pid) {
  return Number(await ps(`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PrismFixtureWindows {
 delegate bool Callback(IntPtr window,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr data);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 public static int Count(uint target) {int count=0;EnumWindows((window,data)=>{uint pid;GetWindowThreadProcessId(window,out pid);if(pid==target&&IsWindowVisible(window))count++;return true;},IntPtr.Zero);return count;}
}
'@
[PrismFixtureWindows]::Count([uint32]$env:PRISM_TEST_PID)
`, { PRISM_TEST_PID: String(pid) }));
}
async function launch(round) {
  session = await launchIsolated({ ...app, launchExecutable: await registeredLauncher() }, join(root, `launch-${round}`), { profileDirectory: profile });
  const identity = await packageIdentity(session.child.pid);
  assert.match(identity.packageFullName, /^OpenAI\.Codex_/);
  await verifyDebugListener(session.port, session.child.pid);
  const created = await ps(`(Get-Process -Id ([int]$env:PRISM_TEST_PID)).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`, { PRISM_TEST_PID: String(session.child.pid) });
  await appendFile(join(state, 'activations.jsonl'), `${JSON.stringify({ pid: session.child.pid, created, patched: true, resumed: true, source: 'owned-test-session' })}\n`);
  browser = await CdpClient.connect(session.browserUrl);
  await wait(async () => (await control('status')).appliedWindows > 0, 'fixture wallpaper application');
}
async function page(id) {
  if (!verifiers.has(id)) verifiers.set(id, await connectRenderer(session, { signal: AbortSignal.timeout(45000), worldName: 'prism-reliability-verification', targetId: id }));
  return verifiers.get(id);
}
async function appPages() { return (await browser.send('Target.getTargets')).targetInfos.filter(p => p.type === 'page' && /^app:\/\/-\/index\.html(?:[?#]|$)/.test(p.url)); }
async function layerCount(id) { return (await page(id)).evaluate(`document.querySelectorAll('#prism-wallpaper-v1').length`); }
async function imageHash(id) {
  return (await page(id)).evaluate(`(async()=>{const img=document.querySelector('#prism-wallpaper-v1 img');if(!img)return null;const b=await(await fetch(img.src)).arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(x=>x.toString(16).padStart(2,'0')).join('')})()`);
}
async function disconnectVerifiers() { for (const v of verifiers.values()) v.client.close(); verifiers.clear(); browser?.close(); browser = null; }

try {
  app = await discoverApp();
  originalRoots = await snapshotAppRoots(app.executable);
  personalBefore = await personalSnapshot();
  await script('install.ps1', [...fixtureArguments, '-Image', resolve('assets/prism-night.png')]);
  const installation = await read(join(root, 'installation.json'));
  assert.ok(installation.startupCommand.length <= 260);
  assert.equal(installation.startupCommand, `"${join(root, 'PrismHelper.exe')}"`);
  report.checks.shortLoginCommand = true;
  stage('Fixture installed; personal callback preserved');
  await launch(1);
  const initialPages = await appPages();
  const first = initialPages[0].targetId;
  const windowsBefore = await visibleNativeWindows(session.child.pid);
  const firstContext = await page(first);
  const opened = await firstContext.client.send('Runtime.evaluate', { expression: `window.electronBridge.sendMessageFromView({type:'open-in-new-window',path:'/'})`, awaitPromise: true, returnByValue: true }, { sessionId: firstContext.sessionId });
  assert.equal(opened.exceptionDetails, undefined);
  let second;
  await wait(async () => { second=(await appPages()).find(p=>!initialPages.some(old=>old.targetId===p.targetId))?.targetId;return !!second; }, 'native app new window');
  report.observations.windowCreation = 'App-owned open-in-new-window bridge within the isolated process';
  await wait(async () => (await control('status')).appliedWindows >= 2 && await layerCount(second) === 1, 'second application target');
  if (windowsOnly) {
    const known = await appPages();
    const extra = await firstContext.client.send('Runtime.evaluate', { expression: `window.electronBridge.sendMessageFromView({type:'open-in-new-window',path:'/'})`, awaitPromise: true, returnByValue: true }, { sessionId: firstContext.sessionId });
    assert.equal(extra.exceptionDetails, undefined);
    await wait(async () => (await appPages()).length > known.length && (await control('status')).appliedWindows >= 3, 'third app target and second visible window');
  }
  const windowsAfter = await visibleNativeWindows(session.child.pid);
  assert.ok(windowsAfter > windowsBefore, 'The app did not create another visible native window');
  report.observations.nativeWindowCounts = { before: windowsBefore, after: windowsAfter };
  report.checks.appOwnedNewWindowCreated = true;
  if (windowsOnly) { assert.ok(windowsAfter >= 2);report.checks.twoVisibleNativeWindows = true; }
  const chosen = resolve('assets/prism-plum.png');
  const expectedHash = (await loadLocalImage(chosen)).sha256;
  await control('bg', chosen);
  await wait(async () => await imageHash(first) === expectedHash && await imageHash(second) === expectedHash, 'image synchronized across targets');
  report.checks.multipleTargetsUpdated = true;
  for (const target of await appPages()) assert.equal(await imageHash(target.targetId), expectedHash);
  stage('Multiple application targets show the same image');
  if (!windowsOnly) {
  const secondContext = await page(second);
  await secondContext.client.send('Page.setDocumentContent', { frameId: (await secondContext.client.send('Page.getFrameTree', {}, { sessionId: secondContext.sessionId })).frameTree.frame.id, html: '<html><body><p>Prism isolated readiness probe</p></body></html>' }, { sessionId: secondContext.sessionId });
  const hostBefore = await read(join(state, 'host.json'));
  await killFixtureProcess(hostBefore.pid, join(root, 'runtime', 'node.exe'));
  await wait(async () => { const s = await control('status'); const host = await read(join(state, 'host.json')); return host.pid !== hostBefore.pid && s.hostRunning && s.appliedWindows > 0 && s.attachingWindows > 0; }, 'renderer host recovery with a stalled target');
  const observationStart = Date.now();
  while (Date.now() - observationStart < 26000) { assert.equal(await layerCount(first), 1); await delay(2000); }
  report.checks.stalledTargetDoesNotExpireHealthyWallpaper = true;
  report.checks.rendererHostCrashRecovery = true;
  await secondContext.client.send('Page.reload', {}, { sessionId: secondContext.sessionId });
  secondContext.client.close(); verifiers.delete(second);
  await wait(async () => { const s = await control('status'); return s.appliedWindows >= 2 && await layerCount(second) === 1; }, 'reloaded target recovery');
  assert.equal(await layerCount(first), 1);
  report.checks.rendererReloadRecovery = true;
  stage('Host crash, stalled-window isolation, and renderer reload passed');

  const workerBefore = await read(join(state, 'worker.json'));
  const workerImage = join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await killFixtureProcess(workerBefore.pid, workerImage);
  await wait(async () => { const w = await read(join(state, 'worker.json')); const s = await control('status'); return w.pid !== workerBefore.pid && s.workerRunning && s.hostRunning && s.appliedWindows >= 2; }, 'worker crash recovery');
  assert.equal(await layerCount(first), 1); assert.equal(await layerCount(second), 1);
  report.checks.workerCrashRecovery = true;
  const workerStable = await read(join(state, 'worker.json'));
  const supervisorBefore = await read(join(state, 'supervisor.json'));
  await killFixtureProcess(supervisorBefore.pid, join(root, 'PrismHelper.exe'));
  await ps(`Start-Process -FilePath (Join-Path $env:PRISM_TEST_ROOT 'PrismHelper.exe') -WindowStyle Hidden`, { PRISM_TEST_ROOT: root });
  await wait(async () => (await control('status')).supervisorRunning, 'startup command recovery');
  assert.equal((await read(join(state, 'worker.json'))).pid, workerStable.pid);
  const supervisorStable = await read(join(state, 'supervisor.json'));
  await ps(`Start-Process -FilePath (Join-Path $env:PRISM_TEST_ROOT 'PrismHelper.exe') -WindowStyle Hidden`, { PRISM_TEST_ROOT: root });
  await delay(2000);
  assert.equal((await read(join(state, 'supervisor.json'))).pid, supervisorStable.pid);
  report.checks.startupCommandAdoptsExistingWorker = true;
  report.checks.duplicateStartupIsIdempotent = true;
  stage('Worker recovery and repeated short startup entry passed');

  await disconnectVerifiers();
  const firstPort = session.port;
  await session.stop(); session = null;
  assert.equal(await waitForDebugListenerClosed(firstPort), true);
  await wait(async () => (await control('status')).preparedWindows === 0, 'closed window cleanup');
  await launch(2);
  const reopened = (await appPages())[0].targetId;
  assert.equal(await imageHash(reopened), expectedHash);
  report.checks.repeatedColdSessionRetainsImage = true;

  const originalManifest = await read(join(root, 'installation.json'));
  await writeFile(join(root, 'installation.json'), JSON.stringify({ ...originalManifest, executableSha256: '0'.repeat(64) }));
  await killFixtureProcess((await read(join(state, 'worker.json'))).pid, workerImage);
  await wait(async () => (await read(join(state, 'worker.json'))).state === 'unsupported' && (await read(join(state, 'supervisor.json'))).state === 'paused', 'compatibility guard');
  const paused = await read(join(state, 'supervisor.json'));
  await delay(5000);
  assert.equal((await read(join(state, 'supervisor.json'))).restarts, paused.restarts);
  report.checks.unsupportedBuildPausesWithoutRestartLoop = true;
  await writeFile(join(root, 'installation.json'), JSON.stringify(originalManifest));
  await script('install.ps1', [...fixtureArguments, '-Upgrade']);
  await wait(async () => (await control('status')).appliedWindows > 0 && await imageHash(reopened) === expectedHash, 'repair without app restart');
  report.checks.repairReattachesExistingApp = true;
  stage('Cold session persistence, compatibility pause, and live repair passed');
  }
  report.result = 'passed';
} catch (error) { report.error = error.stack ?? error.message; }
finally {
  try {
    if (await access(join(root,'installation.json')).then(()=>true,()=>false)) await script('remove.ps1', ['-InstallRoot', root, '-NoStartup']);
    if (session && browser) for (const target of await appPages()) await wait(async () => await layerCount(target.targetId) === 0, 'restoration on removal', 25000);
    report.checks.removalRestoresRemainingTargets = true;
  } catch (error) { report.error = `${report.error ?? ''}\nCleanup: ${error.message}`; report.result = 'failed'; }
  await disconnectVerifiers();
  if (session) { const port = session.port; await session.stop(); report.checks.testListenerClosed = await waitForDebugListenerClosed(port); }
  if (originalRoots) {
    const current = await snapshotAppRoots(app.executable);
    report.checks.originalAppProcessesPreserved = originalRoots.every(p => current.some(c => c.pid === p.pid && c.createdAt === p.createdAt));
  }
  if (personalBefore) report.checks.personalRegistrationsUnchanged = JSON.stringify(await personalSnapshot()) === JSON.stringify(personalBefore);
  if (Object.values(report.checks).includes(false)) report.result = 'failed';
  try { await mkdir(root,{recursive:true});await writeFile(join(root, 'reliability-report.json'), JSON.stringify(report, null, 2)); } catch { }
  console.log(JSON.stringify({ ...report, report: join(root, 'reliability-report.json') }));
}
if (report.result !== 'passed') process.exitCode = 1;
