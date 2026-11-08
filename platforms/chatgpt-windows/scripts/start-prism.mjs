import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSettings, readWallpaperConfig } from '../src/settings.mjs';
import { loadLocalImage } from '../src/media.mjs';
import { wallpaperExpression } from '../src/wallpaper.mjs';
import { runExperiment } from '../src/experiment.mjs';
import { registeredLauncher, packageIdentity } from '../src/windows.mjs';
import { readPreferences, saveJson, claimManagerLock, isProcessAlive } from '../src/preferences.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
let dataDirectory = join(project, '.prism-user');
let releaseLock;

async function chooseImage(initialPath) {
  const command = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Choose your Prism wallpaper'
$dialog.Filter = 'Static images (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp'
$dialog.InitialDirectory = $env:PRISM_PICKER_DIRECTORY
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }
$dialog.Dispose()
`;
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-STA', '-Command', command], {
    windowsHide: true, env: { ...process.env, PRISM_PICKER_DIRECTORY: dirname(initialPath) },
  });
  return stdout.trim() || null;
}

try {
  const { values } = parseArgs({ options: {
    'app-dir': { type: 'string' }, 'data-dir': { type: 'string' }, image: { type: 'string' },
    dim: { type: 'string' }, fit: { type: 'string' }, position: { type: 'string' },
    'choose-image': { type: 'boolean' }, stop: { type: 'boolean' }, status: { type: 'boolean' },
    'smoke-seconds': { type: 'string' },
  } });
  if (values['data-dir']) dataDirectory = resolve(values['data-dir']);
  const preferencesFile = join(dataDirectory, 'settings.json');
  const lockFile = join(dataDirectory, 'manager.lock');
  const stopFile = join(dataDirectory, 'stop.request');
  const statusFile = join(dataDirectory, 'status.json');
  if (values.stop) {
    let lock;
    try { lock = JSON.parse(await readFile(lockFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (lock && isProcessAlive(lock.pid)) { await saveJson(stopFile, { requestedAt: new Date().toISOString() }); console.log('Prism is stopping its own window.'); }
    else console.log('Prism is not running.');
  } else if (values.status) {
    let status = { state: 'not-started' };
    try { status = JSON.parse(await readFile(statusFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(JSON.stringify(status, null, 2));
  } else {
    const defaults = await readWallpaperConfig(join(project, 'examples', 'static-wallpaper.json'));
    let preferences;
    try { preferences = await readPreferences(preferencesFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      preferences = { schema: 1, image: defaults.image, enabled: true, settings: defaults.settings };
    }
    let imagePath = values.image ? resolve(values.image) : preferences.image;
    if (values['choose-image']) {
      imagePath = await chooseImage(imagePath);
      if (!imagePath) { console.log('Image selection cancelled.'); process.exit(0); }
    }
    let image = await loadLocalImage(imagePath);
    preferences = {
      schema: 1, image: imagePath, enabled: true,
      settings: normalizeSettings({ ...preferences.settings,
        ...(values.dim !== undefined ? { dim: Number(values.dim) } : {}),
        ...(values.fit ? { fit: values.fit } : {}),
        ...(values.position ? { position: values.position } : {}),
      }),
    };
    const smokeSeconds = Number(values['smoke-seconds'] ?? 0);
    if (!Number.isInteger(smokeSeconds) || smokeSeconds < 0 || smokeSeconds > 120) throw new Error('Smoke duration must be from 0 to 120 seconds.');
    await saveJson(preferencesFile, preferences);
    releaseLock = await claimManagerLock(lockFile);
    if (!releaseLock) console.log('Settings saved. The running Prism window will update.');
    else {
      await unlink(stopFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await saveJson(statusFile, { state: 'starting', managerPid: process.pid });
      const report = await runExperiment({ name: 'prism-session', appDir: values['app-dir'], launchExecutable: await registeredLauncher(), useExistingBackend: true, profileDirectory: join(dataDirectory, 'profile'), async main(context) {
        const identity = await packageIdentity(context.report.pid);
        if (!identity.packageFullName?.startsWith('OpenAI.Codex_')) throw new Error('The Prism window did not receive the expected package identity.');
        context.report.identity = identity;
        const call = (action, extra = {}) => context.evaluate(wallpaperExpression(action, { runId: context.runId, mode: 'session', ...extra }));
        context.onCleanup(() => call('remove'));
        let lastFile = JSON.stringify(preferences), lastRenew = 0;
        let imageFilename = preferences.image;
        let needsApply = true, smokeControlsChecked = false, configurationError = null;
        let restoreSaved = !values.image && !values['choose-image'];
        const started = Date.now();
        let lastStatus;
        context.report.checks.windowsPackageIdentityPreserved = true;
        while (!context.signal.aborted) {
          try {
            await readFile(stopFile);
            context.report.stopReason = 'stop-request'; break;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!isProcessAlive(context.report.pid)) { context.report.stopReason = 'window-closed'; break; }
          if (smokeSeconds && Date.now() - started >= smokeSeconds * 1000) { context.report.stopReason = 'smoke-complete'; break; }
          try {
            try {
              const next = await readPreferences(preferencesFile);
              const serialized = JSON.stringify(next);
              if (serialized !== lastFile) {
                // Validate a changed file before replacing the last working wallpaper.
                const nextImage = next.image === imageFilename ? image : await loadLocalImage(next.image);
                preferences = next; image = nextImage; imageFilename = next.image;
                lastFile = serialized; needsApply = true;
                restoreSaved = false;
              }
              configurationError = null;
            } catch (error) { configurationError = error.message; }
            if (preferences.enabled && needsApply) {
              const applied = await call('apply', { image, settings: preferences.settings, restoreSaved });
              restoreSaved = false;
              if (!applied.visible || applied.surfaceCount < 1) throw new Error('The wallpaper could not map the main app surface.');
              context.report.checks.mainSurfaceWallpaperApplied = true;
              needsApply = false; lastRenew = Date.now();
              if (smokeSeconds && !smokeControlsChecked) {
                await context.screenshot('managed-wallpaper.png');
                if (preferences.settings.controls) {
                  await context.evaluate(`(() => {const input=document.getElementById('prism-wallpaper-controls-v1').shadowRoot.querySelector('[name="dim"]');input.value='42';input.dispatchEvent(new Event('input'));})()`);
                }
                smokeControlsChecked = true;
              }
            } else if (!preferences.enabled && needsApply) { await call('remove'); needsApply = false; }
            const state = await context.evaluate(`(() => {const state=globalThis.__prismWallpaperV1;return state?{exists:true,settings:{...state.settings},command:state.hostCommand}: {exists:false};})()`);
            if (state.command === 'close') { context.report.stopReason = 'close-button'; break; }
            if (state.command === 'restore') {
              preferences.enabled = false;
              await saveJson(preferencesFile, preferences); lastFile = JSON.stringify(preferences);
              await call('remove');
            } else if (state.exists && preferences.enabled) {
              if (JSON.stringify(state.settings) !== JSON.stringify(preferences.settings)) {
                preferences.settings = normalizeSettings(state.settings);
                await saveJson(preferencesFile, preferences); lastFile = JSON.stringify(preferences);
                context.report.checks.settingsSaved = true;
              }
              if (Date.now() - lastRenew > 20_000) { await call('renew'); lastRenew = Date.now(); }
            } else if (preferences.enabled) needsApply = true;
            const status = { state: 'running', managerPid: process.pid, appPid: context.report.pid, enabled: preferences.enabled, image: preferences.image, settings: preferences.settings, warning: configurationError };
            const serializedStatus = JSON.stringify(status);
            if (serializedStatus !== lastStatus) { await saveJson(statusFile, status); lastStatus = serializedStatus; }
          } catch (error) {
            if (/Session with given id not found|context|closed|target|timed out/i.test(error.message)) {
              await context.reconnect(); needsApply = true; restoreSaved = true; continue;
            }
            throw error;
          }
          await context.pause(1000);
        }
        context.report.checks.managedSessionCompleted = true;
      } });
      await saveJson(statusFile, { state: report.result === 'passed' ? 'stopped' : 'error', error: report.error ?? report.cleanupErrors[0] ?? null, lastReport: report.runDir });
      if (report.result !== 'passed') process.exitCode = 1;
    }
  }
} catch (error) {
  await mkdir(dataDirectory, { recursive: true });
  await saveJson(join(dataDirectory, 'last-error.json'), { at: new Date().toISOString(), error: error.message });
  console.error(error.message); process.exitCode = 1;
} finally { if (releaseLock) await releaseLock(); }
