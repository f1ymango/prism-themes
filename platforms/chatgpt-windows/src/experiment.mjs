import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverApp, inspectApp } from './app.mjs';
import { assertSupportedBuild } from './compatibility.mjs';
import { launchIsolated } from './session.mjs';
import { connectRenderer } from './renderer.mjs';
import { fingerprintApp, snapshotAppRoots, verifyDebugListener, waitForDebugListenerClosed } from './verification.mjs';

export async function runExperiment({ name, appDir, launchExecutable, useExistingBackend = false, profileDirectory, extraArguments, main }) {
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid experiment name.');
  const runId = randomUUID();
  const runDir = resolve('.prism-probe', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId.slice(0, 8)}`);
  const report = { startedAt: new Date().toISOString(), runDir, runId, result: 'pending', checks: {} };
  const abort = new AbortController();
  const cleanup = [];
  let app, session, renderer;
  const interrupt = () => { abort.abort(new Error('Experiment interrupted.')); renderer?.client.close(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    app = await discoverApp(appDir);
    if (launchExecutable) app.launchExecutable = launchExecutable;
    report.app = await inspectApp(app);
    report.originalAppRoots = await snapshotAppRoots(app.executable);
    report.packageBefore = await fingerprintApp(app);
    assertSupportedBuild(report.app, report.packageBefore);
    await mkdir(runDir, { recursive: true });
    console.log(JSON.stringify({ stage: 'launching-isolated-instance', runDir }));
    report.backend = useExistingBackend ? 'normal-account-storage' : 'isolated';
    session = await launchIsolated(app, runDir, { signal: abort.signal, useExistingBackend, profileDirectory, extraArguments });
    report.pid = session.child.pid;
    report.listener = await verifyDebugListener(session.port, session.child.pid);
    renderer = await connectRenderer(session, { signal: abort.signal, worldName: `prism-${name}-${runId}` });
    report.appState = renderer.ready;
    report.targetUrl = renderer.targetUrl;
    const context = {
      ...renderer, runId, runDir, report,
      signal: abort.signal,
      pause: ms => delay(ms, undefined, { signal: abort.signal }),
      onCleanup: callback => cleanup.push(callback),
      async reconnect() {
        renderer.client.close();
        renderer = await connectRenderer(session, { signal: abort.signal, worldName: `prism-${name}-${runId}` });
        Object.assign(context, renderer);
      },
      async screenshot(filename) {
        if (!/^[a-z0-9-]+\.png$/.test(filename)) throw new Error('Invalid screenshot name.');
        const screenshot = await renderer.client.send('Page.captureScreenshot', { format: 'png' }, { sessionId: renderer.sessionId });
        await writeFile(join(runDir, filename), Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
      },
    };
    await main(context);
    report.result = 'passed';
  } catch (error) {
    report.result = 'failed';
    report.error = error.message;
  } finally {
    report.cleanupErrors = [];
    for (const callback of cleanup.reverse()) {
      try { await callback(); } catch (error) { report.cleanupErrors.push(error.message); }
    }
    if (renderer) {
      try { await renderer.client.send('Browser.close', {}, { timeoutMs: 3000 }); } catch { /* Expected if shutdown closes the connection first. */ }
      renderer.client.close();
      await delay(300);
    }
    if (session) {
      try { await session.stop(); } catch (error) { report.cleanupErrors.push(error.message); }
      try { report.checks.debugPortClosed = await waitForDebugListenerClosed(session.port); }
      catch (error) { report.cleanupErrors.push(error.message); }
      if (!report.checks.debugPortClosed) report.cleanupErrors.push('The temporary debugging listener could not be confirmed closed.');
    }
    if (app && report.packageBefore) {
      try {
        report.packageAfter = await fingerprintApp(app);
        report.checks.packageUnchanged = JSON.stringify(report.packageBefore) === JSON.stringify(report.packageAfter);
        const after = await snapshotAppRoots(app.executable);
        report.checks.originalAppRootsStillRunning = report.originalAppRoots.every(root => after.some(item => item.pid === root.pid && item.createdAt === root.createdAt));
        if (!report.checks.packageUnchanged || !report.checks.originalAppRootsStillRunning) report.cleanupErrors.push('Package integrity or original process preservation check failed.');
      } catch (error) { report.cleanupErrors.push(error.message); }
    }
    if (report.cleanupErrors.length) report.result = 'failed';
    report.finishedAt = new Date().toISOString();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ result: report.result, error: report.error, cleanupErrors: report.cleanupErrors, report: join(runDir, 'report.json'), checks: report.checks }, null, 2));
  }
  return report;
}
