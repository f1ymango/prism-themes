import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

export async function fingerprintApp(app) {
  const hash = async path => {
    const sha = createHash('sha256');
    for await (const chunk of createReadStream(path)) sha.update(chunk);
    return sha.digest('hex');
  };
  const [executableSha256, archiveSha256] = await Promise.all([hash(app.executable), hash(app.archive)]);
  return { executableSha256, archiveSha256 };
}

async function powershellJson(script, env = {}) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 15_000, env: { ...process.env, ...env },
  });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

export async function snapshotAppRoots(executable) {
  return await powershellJson(
    "$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" | Where-Object { $_.ExecutablePath -eq $env:PRISM_PROBE_APP_EXE -and $_.CommandLine -notmatch '(?:^|\\s)--type=' } | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; createdAt = $_.CreationDate.ToUniversalTime().ToString('o') } })",
    { PRISM_PROBE_APP_EXE: executable },
  );
}

export async function verifyDebugListener(port, pid) {
  const listeners = await powershellJson(
    "$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:PRISM_PROBE_PORT) | Select-Object LocalAddress,OwningProcess)",
    { PRISM_PROBE_PORT: String(port) },
  );
  if (listeners.length !== 1 || listeners[0].LocalAddress !== '127.0.0.1' || listeners[0].OwningProcess !== pid) {
    throw new Error('Debug listener must belong to the spawned instance and bind only to 127.0.0.1.');
  }
  return { address: listeners[0].LocalAddress, pid: listeners[0].OwningProcess, port };
}

export async function waitForDebugListenerClosed(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  do {
    // A refused TCP connection can time out on Windows even after the listener is gone.
    // Query the local OS table instead, accepting shutdown only when no listener exists.
    const listeners = await powershellJson(
      "$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -eq [int]$env:PRISM_PROBE_PORT } | Select-Object LocalAddress,OwningProcess)",
      { PRISM_PROBE_PORT: String(port) },
    );
    if (listeners.length === 0) return true;
    await delay(250);
  } while (Date.now() < deadline);
  return false;
}
