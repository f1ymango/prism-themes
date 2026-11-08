import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { openAsar } from './asar.mjs';

const execFileAsync = promisify(execFile);

export async function discoverApp(explicitPath) {
  if (process.platform !== 'win32') throw new Error('This experiment currently supports Windows only.');
  let appDir = explicitPath ?? process.env.PRISM_CHATGPT_APP_DIR;
  if (!appDir) {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-AppxPackage | Where-Object { $_.Name -eq 'OpenAI.Codex' } | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation",
    ], { windowsHide: true, timeout: 15_000 });
    if (!stdout.trim()) throw new Error('OpenAI.Codex package not found; supply --app-dir.');
    appDir = join(stdout.trim(), 'app');
  }
  appDir = resolve(appDir);
  const executable = join(appDir, 'ChatGPT.exe');
  const archive = join(appDir, 'resources', 'app.asar');
  await Promise.all([access(executable), access(archive)]);
  return { appDir, executable, archive };
}

export async function inspectApp(app) {
  const archive = await openAsar(app.archive);
  try {
    const metadata = JSON.parse(await archive.readText('package.json'));
    const bootstrapEntries = [...archive.entries.keys()].filter(path => /^\.vite\/build\/early-bootstrap.*\.js$/.test(path));
    const sources = await Promise.all(bootstrapEntries.map(async path => ({ path, text: await archive.readText(path) })));
    const find = pattern => sources.filter(source => pattern.test(source.text)).map(source => source.path);
    const html = await archive.readText('webview/index.html');
    return {
      executable: app.executable,
      archive: app.archive,
      archiveBytes: archive.size,
      archiveHeaderSha256: archive.headerSha256,
      metadata: {
        name: metadata.name, version: metadata.version, main: metadata.main,
        buildFlavor: metadata.codexBuildFlavor,
        packageIdentity: metadata.codexWindowsPackageIdentity,
      },
      evidence: {
        isolatedProfile: find(/CODEX_ELECTRON_USER_DATA_PATH/),
        extensionLoader: find(/loadExtension\?\?/),
        developmentOnlyExtensionGate: find(/eI=!en\.app\.isPackaged/),
        restrictedProductionDevtools: find(/allowDevtools:\w+=>\w+\.isInternal\(/),
        reactProfileSwitch: find(/REACT_PROFILE/),
      },
      htmlPolicy: html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i)?.[0] ?? null,
      notes: [
        'Source matches are evidence about this build, not proof that a runtime loading route works.',
        'Inspection does not change the installed package or app data.',
      ],
    };
  } finally {
    await archive.close();
  }
}
