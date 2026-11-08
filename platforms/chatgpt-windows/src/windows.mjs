import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);

export async function registeredLauncher() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('The registered launcher requires Windows.');
  const alias = join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'chatgpt-desktop.exe');
  await access(alias);
  return alias;
}

export async function packageIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process ID.');
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PrismPackageIdentity {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
  public static string Read(uint pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      uint length=0;
      int result=GetPackageFullName(handle, ref length, null);
      if (result==15700) return null;
      if (result!=122) throw new System.ComponentModel.Win32Exception(result);
      StringBuilder name=new StringBuilder((int)length);
      result=GetPackageFullName(handle, ref length, name);
      if (result!=0) throw new System.ComponentModel.Win32Exception(result);
      return name.ToString();
    } finally { CloseHandle(handle); }
  }
}
'@
[PSCustomObject]@{ packageFullName = [PrismPackageIdentity]::Read([uint32]$env:PRISM_IDENTITY_PID) } | ConvertTo-Json -Compress
`;
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 15_000, env: { ...process.env, PRISM_IDENTITY_PID: String(pid) },
  });
  return JSON.parse(stdout);
}
