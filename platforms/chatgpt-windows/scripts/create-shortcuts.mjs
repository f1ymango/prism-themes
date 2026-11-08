import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverApp } from '../src/app.mjs';

const execute = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = await discoverApp();
const literal = value => `'${value.replaceAll("'", "''")}'`;
// Standard Windows command-line argument quoting; values are then parsed as PowerShell literals.
const windowsArgument = value => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
for (const [name, flag, description] of [
  ['Launch Prism', '', 'Open ChatGPT with your saved Prism wallpaper'],
  ['Choose Wallpaper', '--choose-image', 'Choose an image for the Prism ChatGPT window'],
  ['Stop Prism', '--stop', 'Close only the Prism-managed ChatGPT window'],
]) {
  const command = `& ${literal(process.execPath)} ${literal(join(project, 'scripts', 'start-prism.mjs'))}${flag ? ` ${flag}` : ''}`;
  const argumentsText = `-NoProfile -NonInteractive -WindowStyle Hidden -Command ${windowsArgument(command)}`;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='Stop'
$shell=New-Object -ComObject WScript.Shell
$link=$shell.CreateShortcut($env:PRISM_SHORTCUT_PATH)
$link.TargetPath=$env:PRISM_SHORTCUT_TARGET
$link.Arguments=$env:PRISM_SHORTCUT_ARGS
$link.WorkingDirectory=$env:PRISM_SHORTCUT_CWD
$link.IconLocation=$env:PRISM_SHORTCUT_ICON
$link.Description=$env:PRISM_SHORTCUT_DESCRIPTION
$link.Save()
`], { windowsHide: true, env: { ...process.env,
    PRISM_SHORTCUT_PATH: join(project, `${name}.lnk`),
    PRISM_SHORTCUT_TARGET: join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    PRISM_SHORTCUT_ARGS: argumentsText, PRISM_SHORTCUT_CWD: project,
    PRISM_SHORTCUT_ICON: `${app.executable},0`, PRISM_SHORTCUT_DESCRIPTION: description,
  } });
  console.log(join(project, `${name}.lnk`));
}
