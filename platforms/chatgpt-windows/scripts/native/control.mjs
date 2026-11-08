import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadLocalMedia } from '../../src/media.mjs';
import { normalizeSettings } from '../../src/settings.mjs';
import { normalizeTheme } from '../../src/theme.mjs';
import { readPreferences, saveJson, isProcessAlive } from '../../src/preferences.mjs';
import { readThemeLibrary, rememberTheme, findSavedTheme } from '../../src/theme-library.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' } } });
const root = resolve(values.root ?? join(process.env.LOCALAPPDATA, 'PrismChatGPT'));
const state = join(root, 'state');
const file = join(state, 'preferences.json');
const libraryFile = join(state, 'themes.json');
const command = positionals[0] ?? 'status';
const read = async path => readFile(path, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });

async function status() {
  const installation = await read(join(root, 'installation.json'));
  const worker = await read(join(state, 'worker.json'));
  const supervisor = await read(join(state, 'supervisor.json'));
  const host = await read(join(state, 'host.json'));
  const preferences = await read(file);
  let library, libraryWarning = null;
  try { library = await readThemeLibrary(libraryFile); }
  catch (error) { library = { themes: [] }; libraryWarning = error.message; }
  const activeTheme = library.themes.find(entry => entry.image === preferences?.image);
  const expectedRevision = preferences ? JSON.stringify(await readPreferences(file)) : null;
  const workerRunning = !!worker && isProcessAlive(worker.pid) && Date.now() - Date.parse(worker.at) < 15000 && worker.state === 'armed';
  const hostRunning = !!host && host.state === 'running' && isProcessAlive(host.pid) && host.parent === worker?.pid && Date.now()-Date.parse(host.at)<15000;
  const supervisorRunning = !!supervisor && supervisor.state === 'running' && isProcessAlive(supervisor.pid) && Date.now()-Date.parse(supervisor.at)<15000;
  const compatibilityReviewRequired = worker?.state === 'unsupported' || supervisor?.state === 'paused';
  const recovering = !compatibilityReviewRequired && ((supervisorRunning && (!workerRunning || !hostRunning)) || (hostRunning && ((host?.attaching??0)>0 || (host?.discovering??0)>0 || (host?.updatingWindows??0)>0)));
  return { installed: !!installation?.enabled, implementationVersion: installation?.implementationVersion??1, supervisorRunning, supervisorRestarts: supervisorRunning?supervisor.restarts:0, supervisorState: supervisor?.state??'not-started', workerRunning, hostRunning, workerState: worker?.state ?? 'not-installed', recovering, compatibilityReviewRequired,
    appPackage: installation?.package??null,compatibilitySource:installation?.compatibilitySource??'pinned-baseline',
    message: ['error','paused'].includes(supervisor?.state)?supervisor.message:worker?.message??null,
    enabled: preferences?.enabled ?? false, settings: preferences?.settings ?? null, theme: preferences ? normalizeTheme(preferences.theme) : null,
    savedThemes: library.themes.length, libraryWarning, activeTheme: activeTheme ? { id: activeTheme.id, name: activeTheme.name } : null,
    effectiveTheme: hostRunning && host.preferencesRevision === expectedRevision ? host.effectiveTheme ?? null : null,
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
  } else if (command === 'theme' && positionals[1] === 'list' && positionals.length === 2) {
    const library = await readThemeLibrary(libraryFile);
    console.log(JSON.stringify({ themes: library.themes.map(({ id, name, settings, theme, updatedAt }) => ({ id, name, settings, theme, updatedAt })) }));
  } else {
    const installation = await read(join(root, 'installation.json'));
    if (!installation?.enabled || installation.product !== 'prism-chatgpt') throw new Error('Run Prism setup before changing wallpaper');
    let preferences;
    try { preferences = await readPreferences(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; preferences = { schema: 1, image: '', enabled: true, settings: normalizeSettings({ controls: false }), theme: normalizeTheme() }; }
    let library = command === 'off' ? null : await readThemeLibrary(libraryFile), media, savedName, effectiveTheme;
    const archiveCurrent = async () => {
      if (!preferences.image) return;
      let currentMedia;
      try { currentMedia = await loadLocalMedia(preferences.image, { encoding: 'metadata' }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const current = await status();
      await rememberTheme(libraryFile, library, preferences, currentMedia, { effectiveTheme: current.effectiveTheme });
      library = await readThemeLibrary(libraryFile);
    };
    if (command === 'bg') {
      if (positionals.length !== 2) throw new Error('Expected bg followed by one local image or video path');
      const image = await loadLocalMedia(resolve(positionals[1]), { encoding: 'buffer' });
      await archiveCurrent();
      const folder = join(root, 'wallpapers');
      await mkdir(folder, { recursive: true });
      const saved = join(folder, `${image.sha256}.${image.kind === 'video' ? 'video' : 'image'}`);
      await writeFile(saved, image.data);
      preferences.image = saved; preferences.enabled = true;
      const remembered = library.themes.find(entry => entry.id === image.sha256);
      if (remembered) { preferences.settings = normalizeSettings(remembered.settings); preferences.theme = normalizeTheme(remembered.theme); }
      else preferences.theme = normalizeTheme();
      media = image;
    } else if (command === 'off') preferences.enabled = false;
    else if (command === 'on') preferences.enabled = true;
    else if (command === 'dim') {
      const value = positionals[1];
      const dim = value?.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value);
      preferences.settings = normalizeSettings({ ...preferences.settings, dim });
    } else if (command === 'fit' || command === 'position') preferences.settings = normalizeSettings({ ...preferences.settings, [command]: positionals[1] });
    else if (command === 'theme') {
      const [field, value] = positionals.slice(1);
      if (positionals.length === 3 && field === 'use') {
        const entry = findSavedTheme(library, value);
        media = await loadLocalMedia(entry.image, { encoding: 'metadata' });
        if (media.sha256 !== entry.id) throw new Error('Saved wallpaper changed; the current theme was preserved.');
        await archiveCurrent();
        preferences = { schema: 1, image: entry.image, enabled: true, settings: normalizeSettings(entry.settings), theme: normalizeTheme(entry.theme) };
      } else if (positionals.length === 3 && field === 'save') {
        savedName = value; effectiveTheme = (await status()).effectiveTheme;
      } else if (positionals.length === 2 && field === 'auto') preferences.theme = normalizeTheme();
      else if (positionals.length === 2 && field === 'off') preferences.theme = normalizeTheme({ mode: 'off' });
      else if (positionals.length === 3 && ['font', 'tint', 'accent', 'opacity', 'radius'].includes(field)) {
        const parsed = field === 'opacity' ? (value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value)) : field === 'radius' ? Number(value) : value;
        preferences.theme = normalizeTheme({ ...normalizeTheme(preferences.theme), mode: 'auto', [field]: parsed });
      } else throw new Error('Theme commands: list, save <name>, use <name or ID>, auto, off, font <auto|modern|rounded|serif|mono>, tint <#rrggbb>, accent <#rrggbb>, opacity <45-90%>, radius <0-28>');
    } else throw new Error('Supported commands: status, diagnostic, bg, dim, fit, position, theme, on, off');
    if (!preferences.image) throw new Error('Choose a wallpaper with bg first');
    if (command !== 'off') {
      media ??= await loadLocalMedia(preferences.image, { encoding: 'metadata' });
      await rememberTheme(libraryFile, library, preferences, media, { name: savedName, effectiveTheme });
    }
    await saveJson(file, preferences);
    console.log(JSON.stringify({ saved: true, command, ...await status() }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
