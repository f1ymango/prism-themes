import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function launchIsolated(app, runDir, { timeoutMs = 30_000, signal, useExistingBackend = false, profileDirectory, extraArguments = [] } = {}) {
  const profileDir = profileDirectory ?? join(runDir, 'profile');
  const homeDir = join(runDir, 'codex-home');
  await Promise.all([mkdir(profileDir, { recursive: true }), mkdir(homeDir, { recursive: true })]);
  const stdout = await open(join(runDir, 'app-stdout.log'), 'wx');
  const stderr = await open(join(runDir, 'app-stderr.log'), 'wx');
  const launchedAt = Date.now();
  const child = spawn(app.launchExecutable ?? app.executable, [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    ...extraArguments,
  ], {
    windowsHide: true,
    cwd: app.appDir,
    env: {
      ...process.env,
      CODEX_ELECTRON_USER_DATA_PATH: profileDir,
      ...(!useExistingBackend ? { CODEX_HOME: homeDir } : {}),
    },
    stdio: ['ignore', stdout.fd, stderr.fd],
  });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  let exited = false;
  child.once('exit', () => { exited = true; });
  await Promise.all([stdout.close(), stderr.close()]);
  const session = {
    child, profileDir, homeDir,
    async stop() {
      if (!exited && child.pid) {
        // Only terminate the process tree this session created, never an existing app instance.
        await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, timeout: 10_000,
        }).catch(async error => {
          // taskkill can report a disappearing child even after terminating the root.
          await delay(100);
          if (exited) return;
          try { process.kill(child.pid, 0); }
          catch (check) { if (check.code === 'ESRCH') return; throw check; }
          throw error;
        });
      }
    },
  };
  try {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      signal?.throwIfAborted();
      if (spawnError) throw spawnError;
      if (exited) throw new Error(`Isolated app exited before exposing debugging (exit ${child.exitCode}).`);
      try {
        const portFile = join(profileDir, 'DevToolsActivePort');
        const text = await readFile(portFile, 'utf8');
        if ((await stat(portFile)).mtimeMs < launchedAt) { await delay(200, undefined, { signal }); continue; }
        const [portText, browserPath] = text.trim().split(/\r?\n/);
        const port = Number(portText);
        if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[\w-]+$/.test(browserPath)) {
          return { ...session, port, browserUrl: `ws://127.0.0.1:${port}${browserPath}` };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await delay(200, undefined, { signal });
    }
    throw new Error(`No DevToolsActivePort in the isolated profile after ${timeoutMs}ms.`);
  } catch (error) {
    await session.stop();
    throw error;
  }
}
