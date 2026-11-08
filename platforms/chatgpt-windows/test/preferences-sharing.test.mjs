import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { saveJson } from '../src/preferences.mjs';

test('atomic preferences survive a temporary Windows reader that denies file replacement', { skip: process.platform !== 'win32' }, async () => {
  const base = resolve('.prism-probe/sharing-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'reader-'));
  const file = join(root, 'preferences.json');
  let child;
  try {
    await saveJson(file, { value: 'before' });
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$stream=[IO.File]::Open($env:PRISM_SHARING_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
try { [Console]::WriteLine('locked');[Console]::Out.Flush();Start-Sleep -Milliseconds 400 } finally { $stream.Dispose() }
`], { windowsHide: true, env: { ...process.env, PRISM_SHARING_FILE: file }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Windows reader did not acquire its file handle')), 10000);
      child.stdout.on('data', data => { if (data.toString().includes('locked')) { clearTimeout(timer); resolveReady(); } });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error(`Reader exited ${code}`)); } });
    });
    await saveJson(file, { value: 'after' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { value: 'after' });
  } finally {
    if (child && child.exitCode === null) await once(child, 'exit');
    const absolute = resolve(root);
    if (!absolute.startsWith(base + sep)) throw new Error('Refusing cleanup outside the sharing-test root');
    await rm(absolute, { recursive: true });
  }
});
