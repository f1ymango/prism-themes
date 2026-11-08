import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadLocalMedia } from '../../src/media.mjs';
import { normalizeSettings } from '../../src/settings.mjs';
import { readPreferences, saveJson, isProcessAlive } from '../../src/preferences.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' } } });
const root = resolve(values.root ?? join(process.env.LOCALAPPDATA, 'PrismChatGPT'));
const state = join(root, 'state');
const file = join(state, 'preferences.json');
const command = positionals[0] ?? 'status';
const read = async path => readFile(path, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });

async function status() {
  const installation = await read(join(root, 'installation.json'));
  const worker = await read(join(state, 'worker.json'));
  const supervisor = await read(join(state, 'supervisor.json'));
  const host = await read(join(state, 'host.json'));
  const preferences = await read(file);
  const expectedRevision = preferences ? JSON.stringify(await readPreferences(file)) : null;
  const workerRunning = !!worker && isProcessAlive(worker.pid) && Date.now() - Date.parse(worker.at) < 15000 && worker.state === 'armed';
  const hostRunning = !!host && host.state === 'running' && isProcessAlive(host.pid) && host.parent === worker?.pid && Date.now()-Date.parse(host.at)<15000;
  const supervisorRunning = !!supervisor && supervisor.state === 'running' && isProcessAlive(supervisor.pid) && Date.now()-Date.parse(supervisor.at)<15000;
  const compatibilityReviewRequired = worker?.state === 'unsupported' || supervisor?.state === 'paused';
  const recovering = !compatibilityReviewRequired && ((supervisorRunning && (!workerRunning || !hostRunning)) || (hostRunning && ((host?.attaching??0)>0 || (host?.discovering??0)>0 || (host?.updatingWindows??0)>0)));
  return { installed: !!installation?.enabled, implementationVersion: installation?.implementationVersion??1, supervisorRunning, supervisorRestarts: supervisorRunning?supervisor.restarts:0, supervisorState: supervisor?.state??'not-started', workerRunning, hostRunning, workerState: worker?.state ?? 'not-installed', recovering, compatibilityReviewRequired,
    appPackage: installation?.package??null,compatibilitySource:installation?.compatibilitySource??'pinned-baseline',
    message: ['error','paused'].includes(supervisor?.state)?supervisor.message:worker?.message??null,
    enabled: preferences?.enabled ?? false, settings: preferences?.settings ?? null,
    media: hostRunning && host.preferencesRevision === expectedRevision ? host.media ?? null : null,
    appliedWindows: hostRunning && host.preferencesRevision === expectedRevision ? host.windows.filter(w => w.applied).length : 0,
    preparedWindows: hostRunning ? host.windows.length : 0,
    deferredWindows: hostRunning ? host.windows.filter(w=>w.deferred).length : 0,
    attachingWindows: hostRunning ? host.attaching??0 : 0,
    updatingWindows: hostRunning ? host.updatingWindows??0 : 0,
    restartRequired: workerRunning && hostRunning && host.windows.length === 0 && !(host.attaching??0) && !(host.discovering??0) && !(host.knownProcesses??0) && !(host.updatingWindows??0),
    warning: hostRunning ? host.warning : null, errors: hostRunning ? [...host.errors, ...host.waiting] : [] };
}

try {
  if (command === 'status' || command === 'diagnostic') {
    console.log(JSON.stringify({ ...(command === 'diagnostic' ? { marker: 'PRISM_LOCAL_EXEC_OK' } : {}), ...await status() }));
  } else {
    const installation = await read(join(root, 'installation.json'));
    if (!installation?.enabled || installation.product !== 'prism-chatgpt') throw new Error('Run Prism setup before changing wallpaper');
    let preferences;
    try { preferences = await readPreferences(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; preferences = { schema: 1, image: '', enabled: true, settings: normalizeSettings({ controls: false }) }; }
    if (command === 'bg') {
      if (positionals.length !== 2) throw new Error('Expected bg followed by one local image or video path');
      const image = await loadLocalMedia(resolve(positionals[1]), { encoding: 'buffer' });
      const folder = join(root, 'wallpapers');
      await mkdir(folder, { recursive: true });
      const saved = join(folder, `${image.sha256}.${image.kind === 'video' ? 'video' : 'image'}`);
      await writeFile(saved, image.data);
      preferences.image = saved; preferences.enabled = true;
    } else if (command === 'off') preferences.enabled = false;
    else if (command === 'on') preferences.enabled = true;
    else if (command === 'dim') {
      const value = positionals[1];
      const dim = value?.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value);
      preferences.settings = normalizeSettings({ ...preferences.settings, dim });
    } else if (command === 'fit' || command === 'position') preferences.settings = normalizeSettings({ ...preferences.settings, [command]: positionals[1] });
    else throw new Error('Supported commands: status, diagnostic, bg, dim, fit, position, on, off');
    if (!preferences.image) throw new Error('Choose a wallpaper with bg first');
    if (preferences.enabled && command !== 'bg') await loadLocalMedia(preferences.image, { encoding: 'metadata' });
    await saveJson(file, preferences);
    console.log(JSON.stringify({ saved: true, command, ...await status() }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
