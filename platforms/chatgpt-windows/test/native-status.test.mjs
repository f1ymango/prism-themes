import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { normalizeSettings } from '../src/settings.mjs';

const execute = promisify(execFile);
const base = resolve('.prism-probe/native-status-tests');
async function fixture(run) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'status-'));
  const state = join(root, 'state');
  await mkdir(state);
  const preferences = { schema: 1, image: resolve('assets/prism-night.png'), enabled: true, settings: normalizeSettings({ controls: false }) };
  const fresh = { pid: process.pid, created: new Date().toISOString(), at: new Date().toISOString() };
  const data = {
    installation: { enabled: true, implementationVersion: 2 },
    worker: { ...fresh, state: 'armed' },
    supervisor: { ...fresh, state: 'running', restarts: 0 },
    host: { ...fresh, state: 'running', parent: process.pid, preferencesRevision: JSON.stringify(preferences), windows: [{ applied: true }], attaching: 0, discovering: 0, knownProcesses: 1, errors: [], waiting: [] },
    preferences,
  };
  const save = async () => {
    await writeFile(join(root, 'installation.json'), JSON.stringify(data.installation));
    for (const key of ['worker', 'supervisor', 'host', 'preferences']) await writeFile(join(state, `${key}.json`), JSON.stringify(data[key]));
  };
  const status = async () => { await save(); return JSON.parse((await execute(process.execPath, [resolve('scripts/native/control.mjs'), '--root', root, 'status'], { windowsHide: true })).stdout); };
  try { await run(data, status); }
  finally {
    const absolute = resolve(root);
    if (!absolute.startsWith(base + sep)) throw new Error('Refusing cleanup outside test root');
    await rm(absolute, { recursive: true });
  }
}

test('stale renderer status cannot claim a live wallpaper even if its PID exists', async () => fixture(async (data, status) => {
  assert.equal((await status()).appliedWindows, 1);
  data.host.at = new Date(Date.now() - 31000).toISOString();
  const result = await status();
  assert.equal(result.hostRunning, false);
  assert.equal(result.appliedWindows, 0);
  assert.equal(result.recovering, true);
  assert.equal(result.restartRequired, false);
}));

test('a window still attaching reports recovery without requesting a restart', async () => fixture(async (data, status) => {
  data.host.windows = [];
  data.host.attaching = 1;
  const result = await status();
  assert.equal(result.recovering, true);
  assert.equal(result.restartRequired, false);
}));

test('a large video still transferring reports progress without requesting a restart',async()=>fixture(async(data,status)=>{
  data.host.windows=[];data.host.knownProcesses=0;data.host.updatingWindows=1;
  const result=await status();assert.equal(result.updatingWindows,1);assert.equal(result.recovering,true);assert.equal(result.restartRequired,false);
}));

test('unsupported app builds report a review requirement instead of a recovery loop', async () => fixture(async (data, status) => {
  data.worker.state = 'unsupported';
  data.supervisor.state = 'paused';
  data.supervisor.message = 'App hash differs from the verified build';
  const result = await status();
  assert.equal(result.compatibilityReviewRequired, true);
  assert.equal(result.recovering, false);
  assert.equal(result.restartRequired, false);
  assert.match(result.message, /hash differs/);
}));
