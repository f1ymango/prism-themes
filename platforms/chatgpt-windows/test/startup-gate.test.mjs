import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

test('native activation waits for a cold helper and preserves disabled or unavailable installations', { skip: process.platform !== 'win32' }, async () => {
  const base = resolve('.prism-probe/startup-tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'cold-'));
  const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const run = (file, args) => execute(file, args, { windowsHide: true, timeout: 15000 });
  try {
    await run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/r:System.Web.Extensions.dll', `/out:${join(root, 'PrismHelper.exe')}`, resolve('test/StartupGateWorker.cs')]);
    const harness = join(root, 'StartupGateTests.exe');
    await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/main:StartupGateTests', `/out:${harness}`, resolve('native/ActivationCallback.cs'), resolve('test/StartupGateTests.cs')]);
    assert.match((await run(harness, [root])).stdout, /bounded timeout passed/);
  } finally {
    if (!resolve(root).startsWith(base + sep)) throw new Error('Refusing cleanup outside startup test root');
    await rm(root, { recursive: true });
  }
});
