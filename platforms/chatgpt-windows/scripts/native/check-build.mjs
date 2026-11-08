import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { openAsar } from '../../src/asar.mjs';
import { launchIsolated } from '../../src/session.mjs';
import { registeredLauncher, packageIdentity } from '../../src/windows.mjs';
import { fingerprintApp, verifyDebugListener, waitForDebugListenerClosed } from '../../src/verification.mjs';
import { connectRenderer, readinessExpression } from '../../src/renderer.mjs';
import { wallpaperExpression } from '../../src/wallpaper.mjs';
import { loadLocalImage } from '../../src/media.mjs';
import { saveJson } from '../../src/preferences.mjs';
import { BUILD_CONTRACT, validateBuild } from '../../src/native/build-approval.mjs';

const { values } = parseArgs({ options: { candidate: { type: 'string' }, artifacts: { type: 'string' }, asset: { type: 'string' }, output: { type: 'string' } } });
const candidate = validateBuild(JSON.parse(await readFile(values.candidate, 'utf8')));
const app = { executable: candidate.image, appDir: dirname(candidate.image), archive: join(dirname(candidate.image), 'resources', 'app.asar') };
let session, renderer, result = { ...candidate, contract: BUILD_CONTRACT, checkedAt: new Date().toISOString(), checks: {}, passed: false, error: null };
const owner = randomUUID();
try {
  const archive = await openAsar(app.archive);
  try {
    const metadata = JSON.parse(await archive.readText('package.json'));
    assert.equal(metadata.codexWindowsPackageIdentity, 'OpenAI.Codex');
    assert.equal(metadata.codexBuildFlavor, 'prod');
    assert.equal(metadata.name, 'openai-codex-electron');
    const names = [...archive.entries.keys()].filter(name => /^\.vite\/build\/early-bootstrap.*\.js$/.test(name));
    assert.ok(names.length > 0);
    let isolation = false;
    for (const name of names) if ((await archive.readText(name)).includes('CODEX_ELECTRON_USER_DATA_PATH')) isolation = true;
    assert.ok(isolation, 'The new build does not expose the reviewed isolated-profile mechanism');
    result.embeddedVersion = metadata.version;
  } finally { await archive.close(); }
  const before = await fingerprintApp(app);
  assert.equal(before.executableSha256, candidate.executableSha256);
  assert.equal(before.archiveSha256, candidate.archiveSha256);
  const artifacts = resolve(values.artifacts);
  await mkdir(artifacts, { recursive: true });
  session = await launchIsolated({ ...app, launchExecutable: await registeredLauncher() }, artifacts, { signal: AbortSignal.timeout(35000) });
  assert.equal((await packageIdentity(session.child.pid)).packageFullName, candidate.package);
  await verifyDebugListener(session.port, session.child.pid);
  renderer = await connectRenderer(session, { signal: AbortSignal.timeout(45000), worldName: `prism-build-check-${owner}` });
  const initial = await renderer.evaluate(readinessExpression);
  const image = await loadLocalImage(values.asset);
  const applied = await renderer.evaluate(wallpaperExpression('apply', { runId: owner, image, settings: { dim: .4, controls: false }, ttlMs: 15000 }));
  assert.ok(applied.visible && applied.count === 1 && applied.surfaceCount > 0);
  result.checks.imageVisible = true;
  const changed = await renderer.evaluate(wallpaperExpression('update', { runId: owner, settings: { dim: .6 } }));
  assert.equal(changed.settings.dim, .6);
  result.checks.settingsChanged = true;
  const removed = await renderer.evaluate(wallpaperExpression('remove', { runId: owner }));
  assert.equal(removed.count, 0);
  const restored = await renderer.evaluate(readinessExpression);
  assert.equal(restored.visibleControls, initial.visibleControls);
  result.checks.restored = true;
  assert.deepEqual(await fingerprintApp(app), before);
  result.checks.installedFilesUnchanged = true;
  result.passed = true;
} catch (error) { result.error = error.message; }
finally {
  if (renderer) { await renderer.evaluate(wallpaperExpression('remove', { runId: owner })).catch(() => {});renderer.client.close(); }
  if (session) { await session.stop();result.checks.listenerClosed = await waitForDebugListenerClosed(session.port);if(!result.checks.listenerClosed)result.passed=false; }
  await saveJson(values.output, result);
  console.log(JSON.stringify({ passed: result.passed, package: result.package, checks: result.checks, error: result.error }));
}
if (!result.passed) process.exitCode = 1;
