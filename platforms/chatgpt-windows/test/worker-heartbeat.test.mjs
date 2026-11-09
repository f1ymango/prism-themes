import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { readWorkerHeartbeat } from '../src/worker-heartbeat.mjs';

test('a brief Windows sharing lock does not terminate the worker heartbeat reader', { skip: process.platform !== 'win32' }, async () => {
  const base = resolve('.prism-probe/heartbeat-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'reader-'));
  const file = join(root, 'worker.json');
  let child;
  try {
    const heartbeat = { pid: process.pid, created: 'fixture', at: new Date().toISOString() };
    await writeFile(file, JSON.stringify(heartbeat));
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$stream=[IO.File]::Open($env:PRISM_HEARTBEAT_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)
try { [Console]::WriteLine('locked');[Console]::Out.Flush();Start-Sleep -Milliseconds 350 } finally { $stream.Dispose() }
`], { windowsHide: true, env: { ...process.env, PRISM_HEARTBEAT_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('Windows reader did not acquire its file handle')), 10000);
      child.stdout.on('data', data => { if (data.toString().includes('locked')) { clearTimeout(timer); ready(); } });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Reader exited ${code}`)); } });
    });
    assert.deepEqual(await readWorkerHeartbeat(file), heartbeat);
  } finally {
    if (child && child.exitCode === null) await once(child, 'exit');
    const absolute = resolve(root);
    if (!absolute.startsWith(base + sep)) throw new Error('Refusing cleanup outside the heartbeat test root');
    await rm(absolute, { recursive: true });
  }
});
