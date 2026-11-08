import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverApp, inspectApp } from '../src/app.mjs';
import { launchIsolated } from '../src/session.mjs';
import { CdpClient, evaluate } from '../src/cdp.mjs';
import { markerExpression } from '../src/marker.mjs';
import { fingerprintApp, snapshotAppRoots, verifyDebugListener, waitForDebugListenerClosed } from '../src/verification.mjs';
import { assertSupportedBuild } from '../src/compatibility.mjs';

const runDir = resolve('.prism-probe', `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
const report = { startedAt: new Date().toISOString(), runDir, result: 'pending' };
let session;
let client;
let rendererSession;
let contextId;
let app;
const markerOptions = { runId: randomUUID() };
const abort = new AbortController();
const pause = ms => delay(ms, undefined, { signal: abort.signal });
const onInterrupt = () => { abort.abort(new Error('Probe interrupted; cleaning up the owned instance.')); client?.close(); };
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
try {
  const { values } = parseArgs({ options: { 'app-dir': { type: 'string' } } });
  app = await discoverApp(values['app-dir']);
  report.app = await inspectApp(app);
  report.originalAppRoots = await snapshotAppRoots(app.executable);
  report.packageBefore = await fingerprintApp(app);
  assertSupportedBuild(report.app, report.packageBefore);
  await mkdir(runDir, { recursive: true });
  console.log(JSON.stringify({ stage: 'launching-isolated-instance', runDir }));
  session = await launchIsolated(app, runDir, { signal: abort.signal });
  abort.signal.throwIfAborted();
  report.pid = session.child.pid;
  report.debugPort = session.port;
  report.listener = await verifyDebugListener(session.port, session.child.pid);
  client = await CdpClient.connect(session.browserUrl);
  report.browser = await client.send('Browser.getVersion');
  console.log(JSON.stringify({ stage: 'waiting-for-app-renderer', pid: report.pid, port: session.port }));
  let target;
  const deadline = Date.now() + 45_000;
  while (!target && Date.now() < deadline) {
    const { targetInfos } = await client.send('Target.getTargets');
    report.targets = targetInfos.map(({ targetId, type, url }) => ({ targetId, type, url: url.split(/[?#]/)[0] }));
    const candidates = targetInfos.filter(info => info.type === 'page' && /^app:\/\/-\/index\.html(?:[?#]|$)/.test(info.url));
    if (candidates.length > 1) throw new Error('Multiple app renderers found; refusing ambiguous target selection.');
    target = candidates[0];
    if (!target) await pause(250);
  }
  if (!target) throw new Error('No top-level app:// renderer appeared within 45 seconds.');
  ({ sessionId: rendererSession } = await client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
  const { frameTree } = await client.send('Page.getFrameTree', {}, { sessionId: rendererSession });
  ({ executionContextId: contextId } = await client.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id, worldName: `prism-loader-probe-${markerOptions.runId}`,
  }, { sessionId: rendererSession }));
  const readinessExpression = `(() => ({
    ready:document.readyState,body:!!document.body,width:innerWidth,height:innerHeight,protocol:location.protocol,
    visibleControls:[...document.querySelectorAll('button,[role="button"],input,textarea')].filter(element=>{
      const rect=element.getBoundingClientRect();const style=getComputedStyle(element);
      return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';
    }).length
  }))()`;
  let appState;
  const readyDeadline = Date.now() + 30_000;
  do {
    appState = await evaluate(client, rendererSession, readinessExpression, contextId);
    if (appState?.ready === 'complete' && appState.visibleControls > 0) break;
    await pause(300);
  } while (Date.now() < readyDeadline);
  report.appState = appState;
  if (!appState?.body || appState.protocol !== 'app:' || appState.ready !== 'complete' || appState.visibleControls === 0) {
    throw new Error('App interface did not become ready beyond its startup splash.');
  }
  report.before = await evaluate(client, rendererSession, markerExpression('status', markerOptions), contextId);
  report.removeWhenAbsent = await evaluate(client, rendererSession, markerExpression('remove', markerOptions), contextId);
  report.applied = await evaluate(client, rendererSession, markerExpression('apply', markerOptions), contextId);
  report.reapplied = await evaluate(client, rendererSession, markerExpression('apply', markerOptions), contextId);
  try {
    await evaluate(client, rendererSession, markerExpression('remove', { runId: randomUUID() }), contextId);
    throw new Error('A foreign probe owner was incorrectly allowed to remove the marker.');
  } catch (error) {
    if (!error.message.includes('A different owner already uses the probe marker')) throw error;
    report.foreignOwnerRejected = true;
  }
  await pause(500);
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' }, { sessionId: rendererSession });
  await writeFile(join(runDir, 'marker-visible.png'), Buffer.from(screenshot.data, 'base64'), { flag: 'wx' });
  report.removed = await evaluate(client, rendererSession, markerExpression('remove', markerOptions), contextId);
  const afterScreenshot = await client.send('Page.captureScreenshot', { format: 'png' }, { sessionId: rendererSession });
  await writeFile(join(runDir, 'marker-removed.png'), Buffer.from(afterScreenshot.data, 'base64'), { flag: 'wx' });
  report.after = await evaluate(client, rendererSession, readinessExpression, contextId);
  report.expiryApplied = await evaluate(client, rendererSession, markerExpression('apply', { ...markerOptions, ttlMs: 300 }), contextId);
  const expiryStart = Date.now();
  do {
    await pause(200);
    report.expired = await evaluate(client, rendererSession, markerExpression('status', markerOptions), contextId);
    if (!report.expired.installed) break;
  } while (Date.now() - expiryStart < 5000);
  report.expiryObservedAfterMs = Date.now() - expiryStart;
  if (!report.applied.installed || !report.applied.visible || report.reapplied.count !== 1 || report.removed.count !== 0 || report.applied.pointerEvents !== 'none') {
    throw new Error('Marker lifecycle assertions failed.');
  }
  if (report.expired.installed || report.expired.count !== 0 || report.after.visibleControls === 0) throw new Error('Expiry or interface health check failed.');
  report.result = 'marker-apply-remove-passed';
} catch (error) {
  report.result = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (client && rendererSession && contextId) {
    try { await evaluate(client, rendererSession, markerExpression('remove', markerOptions), contextId); }
    catch (error) { report.markerCleanupError = error.message; }
  }
  if (client) {
    try { await client.send('Browser.close', {}, { timeoutMs: 3000 }); }
    catch { /* The browser can disconnect before acknowledging its shutdown. */ }
    client.close();
    await delay(300);
  }
  if (session) {
    try { await session.stop(); report.processCleanup = 'stopped-owned-instance'; }
    catch (error) { report.processCleanup = error.message; report.result = 'failed'; process.exitCode = 1; }
    try { report.debugPortClosed = await waitForDebugListenerClosed(session.port); }
    catch (error) { report.listenerVerificationError = error.message; }
    if (!report.debugPortClosed) { report.result = 'failed'; report.error = 'Debug listener remained open after cleanup.'; process.exitCode = 1; }
  }
  if (app && report.packageBefore) {
    try {
      report.packageAfter = await fingerprintApp(app);
      report.packageUnchanged = JSON.stringify(report.packageBefore) === JSON.stringify(report.packageAfter);
      const rootsAfter = await snapshotAppRoots(app.executable);
      report.originalAppRootsStillRunning = report.originalAppRoots.every(before => rootsAfter.some(after => before.pid === after.pid && before.createdAt === after.createdAt));
    } catch (error) { report.integrityVerificationError = error.message; }
    if (!report.packageUnchanged || !report.originalAppRootsStillRunning) {
      report.result = 'failed'; report.error = 'Package integrity or original process preservation check failed.'; process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({
    result: report.result,
    error: report.error,
    report: join(runDir, 'report.json'),
    checks: {
      appReady: report.appState?.ready,
      visibleControls: report.appState?.visibleControls,
      markerApplied: report.applied?.installed,
      duplicateCount: report.reapplied?.count,
      removedCount: report.removed?.count,
      foreignOwnerRejected: report.foreignOwnerRejected,
      expiredCount: report.expired?.count,
      debugPortClosed: report.debugPortClosed,
      packageUnchanged: report.packageUnchanged,
      originalAppRootsStillRunning: report.originalAppRootsStillRunning,
    },
  }, null, 2));
}
