import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpClient } from '../../src/cdp.mjs';
import { connectRenderer } from '../../src/renderer.mjs';
import { wallpaperExpression } from '../../src/wallpaper.mjs';
import { loadLocalMedia } from '../../src/media.mjs';
import { transferVideo } from '../../src/media-transfer.mjs';
import { readPreferences, saveJson, claimManagerLock, isProcessAlive } from '../../src/preferences.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, parent: { type: 'string' } } });
const root = values.root;
const state = join(root, 'state');
const installation = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
const parent = Number(values.parent);
const parentCreated = JSON.parse(await readFile(join(state, 'worker.json'), 'utf8')).created;
const release = await claimManagerLock(join(state, 'host.lock'));
if (!release) process.exit(0);
const execute = promisify(execFile);
const roots = new Map(), pending = new Map(), failures = new Map(), ignoredRecords = new Set();
const owner = installation.id;
let imageCache, imagePath, revision, preferences, configurationError = null;
const exists = async path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
let latestStatus, statusWrites = Promise.resolve();
function publishStatus(value) {
  if (value) latestStatus = value;
  if (!latestStatus) return Promise.resolve();
  const updatingWindows = [...roots.values()].reduce((sum,app)=>sum+[...app.contexts.values()].filter(context=>context.updating).length,0);
  const snapshot = { ...latestStatus, updatingWindows, at: new Date().toISOString() };
  statusWrites = statusWrites.catch(()=>{}).then(()=>saveJson(join(state,'host.json'),snapshot));
  return statusWrites;
}
const statusHeartbeat = setInterval(()=>publishStatus().catch(()=>{}),2000);

async function discover(record) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$env:PRISM_HOST_PID)
if(!$p -or $p.ExecutablePath -ne $env:PRISM_HOST_IMAGE -or (Get-Process -Id $p.ProcessId).StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $env:PRISM_HOST_CREATED){'{"identityMatched":false}';exit 0}
[pscustomobject]@{identityMatched=$true;listeners=@(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -eq [int]$env:PRISM_HOST_PID } | Select-Object LocalAddress,LocalPort)} | ConvertTo-Json -Depth 4 -Compress
`], { windowsHide: true, timeout: 10000, env: { ...process.env, PRISM_HOST_PID: String(record.pid), PRISM_HOST_IMAGE: installation.image, PRISM_HOST_CREATED: String(record.created) } });
  const discovery = JSON.parse(stdout);
  if (!discovery.identityMatched) return null;
  for (const listener of discovery.listeners) {
    if (listener.LocalAddress !== '127.0.0.1') continue;
    try {
      const response = await fetch(`http://127.0.0.1:${listener.LocalPort}/json/version`, { signal: AbortSignal.timeout(1000) });
      const version = await response.json();
      const url = new URL(version.webSocketDebuggerUrl);
      if (url.hostname !== '127.0.0.1' || Number(url.port) !== listener.LocalPort) continue;
      const client = await CdpClient.connect(url.href);
      return { client, browserUrl: url.href, pid: record.pid, contexts: new Map(), attaching: new Map(), pageErrors: new Map(), liveTargets: new Set(), disposed: false };
    } catch { /* A package may own unrelated listeners. */ }
  }
  throw new Error('Waiting for the prepared process to expose its loopback renderer');
}

async function syncRoot(app) {
  let targetInfos;
  try { ({ targetInfos } = await app.client.send('Target.getTargets')); }
  catch {
    app.client.close();
    app.client = await CdpClient.connect(app.browserUrl);
    ({ targetInfos } = await app.client.send('Target.getTargets'));
  }
  const pages = targetInfos.filter(info => info.type === 'page' && /^app:\/\/-\/index\.html(?:[?#]|$)/.test(info.url));
  const live = new Set(pages.map(page => page.targetId));
  app.liveTargets = live;
  for (const [id, context] of app.contexts) if (!live.has(id)) { context.client.close(); app.contexts.delete(id); }
  for (const [id, task] of app.attaching) if (!live.has(id)) task.controller.abort();
  for (const id of app.pageErrors.keys()) if (!live.has(id)) app.pageErrors.delete(id);
  for (const page of pages) {
    if (app.contexts.has(page.targetId) || app.attaching.has(page.targetId) || Date.now() - (app.pageErrors.get(page.targetId)?.at ?? 0) < 3000) continue;
    const controller = new AbortController();
    const task = connectRenderer(app, { signal: controller.signal, worldName: `prism-persistent-${owner}`, targetId: page.targetId })
      .then(context => {
        if (app.disposed || !app.liveTargets.has(page.targetId)) { context.client.close(); return; }
        context.revision = null; context.lastSuccess = 0;
        app.contexts.set(page.targetId, context); app.pageErrors.delete(page.targetId);
      }, error => { if (!controller.signal.aborted) app.pageErrors.set(page.targetId, { at: Date.now(), error: error.message }); })
      .finally(() => app.attaching.delete(page.targetId));
    app.attaching.set(page.targetId, { controller, task });
  }
  await Promise.allSettled([...app.contexts].map(async ([id, context]) => {
    const call = (action, extra = {}) => context.evaluate(wallpaperExpression(action, { runId: owner, mode: 'session', persist: false, ttlMs: 20000, ...extra }));
    try {
      if (context.revision !== revision) {
        if (preferences.enabled) {
          let applied;
          try {
            if (imageCache.kind === 'video' && context.mediaSha !== imageCache.sha256 && await context.evaluate('document.hidden')) {
              await call('renew'); context.deferred = true; app.pageErrors.delete(id); return;
            }
            context.deferred = false;
            if (context.mediaSha === imageCache.sha256) {
              applied = await call('renew');
              if (applied.installed) applied = await call('update', { settings: preferences.settings, theme: preferences.theme });
            }
            if (!applied?.installed) {
              if (imageCache.kind === 'video') {
                context.updating = true;
                try {
                  applied = await transferVideo(context, imagePath, imageCache, { runId: owner, mode: 'session', persist: false, ttlMs: 20000, settings: preferences.settings, theme: preferences.theme }, {
                    shouldAbort: async () => !isProcessAlive(parent) || await exists(join(state,'stop')) || await exists(join(state,'host-stop')) || await readPreferences(join(state,'preferences.json')).then(next=>!next.enabled||next.image!==imagePath),
                  });
                } finally { context.updating = false; }
              } else applied = await call('apply', { image: imageCache, settings: preferences.settings, theme: preferences.theme, restoreSaved: false });
            }
          } catch (error) {
            // A rejected replacement must not expire the previous working wallpaper.
            await call('renew');
            if (error.code === 'PRISM_TRANSFER_CANCELLED') { app.pageErrors.delete(id); return; }
            app.pageErrors.set(id, { at: Date.now(), error: error.message });
            return;
          }
          if (!applied.visible || applied.surfaceCount < 1) throw new Error('No supported background surface was found');
          context.mediaSha = imageCache.sha256;
          context.effectiveTheme = applied.effectiveTheme;
        } else { await call('remove'); context.mediaSha = null; context.effectiveTheme = null; }
        context.revision = revision;
      } else if (preferences.enabled) {
        const renewed = await call('renew');
        if (!renewed.installed) context.revision = null;
        else context.effectiveTheme = renewed.effectiveTheme;
      }
      context.lastSuccess = Date.now();
      app.pageErrors.delete(id);
    } catch (error) {
      context.client.close(); app.contexts.delete(id);
      app.pageErrors.set(id, { at: Date.now(), error: error.message });
    }
  }));
}

try {
  while (isProcessAlive(parent) && !await exists(join(state, 'stop')) && !await exists(join(state, 'host-stop'))) {
    if (Date.now() - (await stat(join(state, 'worker.json'))).mtimeMs > 20000) break;
    const heartbeat = JSON.parse(await readFile(join(state, 'worker.json'), 'utf8'));
    if (heartbeat.pid !== parent || heartbeat.created !== parentCreated) break;
    try {
      const next = await readPreferences(join(state, 'preferences.json'));
      if (next.image !== imagePath) { imageCache = await loadLocalMedia(next.image, { encoding: 'renderer' }); imagePath = next.image; }
      preferences = next; revision = JSON.stringify(next); configurationError = null;
    } catch (error) { configurationError = error.message; }
    let records = [];
    try {
      const log = await readFile(join(state, 'activations.jsonl'), 'utf8');
      records = log.split(/\r?\n/).flatMap(line => { try { const r = JSON.parse(line); return r.patched && r.resumed ? [r] : []; } catch { return []; } });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const record of records) {
      const key = `${record.pid}:${record.created}`;
      if (roots.has(key) || pending.has(key) || ignoredRecords.has(key) || !isProcessAlive(record.pid)) continue;
      if ((failures.get(key)?.count ?? 0) >= 8 || Date.now() - (failures.get(key)?.at ?? 0) < 3000) continue;
      const task = discover(record).then(app => { if (app) roots.set(key, app); else ignoredRecords.add(key); failures.delete(key); }, error => { failures.set(key, { count: (failures.get(key)?.count ?? 0) + 1, at: Date.now(), error: error.message }); }).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    if (preferences) await Promise.allSettled([...roots].map(async ([key, app]) => {
      if (!isProcessAlive(app.pid)) { app.disposed=true;for(const task of app.attaching.values())task.controller.abort();for (const c of app.contexts.values()) c.client.close(); app.client.close(); roots.delete(key); return; }
      try { await syncRoot(app); app.error = null; } catch (error) { app.error = error.message; }
    }));
    const status = { state: 'running', pid: process.pid, parent, enabled: preferences?.enabled ?? false, image: preferences?.image ?? null, preferencesRevision: revision,
      media: imageCache ? { kind: imageCache.kind, mime: imageCache.mime, sha256: imageCache.sha256 } : null,
      effectiveTheme: [...roots.values()].flatMap(app => [...app.contexts.values()]).find(context => context.revision === revision && context.effectiveTheme)?.effectiveTheme ?? null,
      created: new Date(performance.timeOrigin).toISOString(),
      windows: [...roots.values()].flatMap(app => [...app.contexts].map(([targetId,c]) => ({ appPid: app.pid, targetId, deferred: !!c.deferred, applied: c.revision === revision && !!preferences?.enabled && Date.now()-c.lastSuccess<10000, lastSuccessAt: new Date(c.lastSuccess).toISOString() }))),
      attaching: [...roots.values()].reduce((count,app)=>count+app.attaching.size,0),
      knownProcesses: roots.size, discovering: pending.size,
      warning: configurationError, errors: [...roots.values()].flatMap(a => [...(a.error?[a.error]:[]),...[...a.pageErrors.values()].map(e=>e.error)]), waiting: [...failures].filter(([key]) => isProcessAlive(Number(key.split(':')[0]))).map(([, f]) => f.error) };
    await publishStatus(status);
    await delay(2000);
  }
} finally {
  clearInterval(statusHeartbeat);
  await Promise.allSettled([...pending.values()]);
  for (const app of roots.values()) { app.disposed=true;for(const task of app.attaching.values())task.controller.abort(); }
  await Promise.allSettled([...roots.values()].flatMap(app=>[...app.attaching.values()].map(t=>t.task)));
  await Promise.allSettled([...roots.values()].flatMap(app => [...app.contexts.values()].map(async context => {
    try { await context.evaluate(wallpaperExpression('remove', { runId: owner })); } finally { context.client.close(); }
  })));
  for (const app of roots.values()) app.client.close();
  await statusWrites.catch(()=>{});
  await saveJson(join(state, 'host.json'), { state: 'stopped', pid: process.pid, at: new Date().toISOString() });
  await release();
}
