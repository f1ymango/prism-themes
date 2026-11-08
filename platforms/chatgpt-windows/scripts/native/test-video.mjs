import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverApp } from '../../src/app.mjs';
import { launchIsolated } from '../../src/session.mjs';
import { registeredLauncher } from '../../src/windows.mjs';
import { verifyDebugListener, snapshotAppRoots, waitForDebugListenerClosed } from '../../src/verification.mjs';
import { connectRenderer } from '../../src/renderer.mjs';
import { loadLocalMedia } from '../../src/media.mjs';
import { wallpaperExpression } from '../../src/wallpaper.mjs';
import { saveJson } from '../../src/preferences.mjs';

const execute = promisify(execFile), root = resolve('.prism-probe', `video-${randomUUID().slice(0, 8)}`), state = join(root, 'state');
const discoveryOnly = process.argv.includes('--discovery-only');
await mkdir(state, { recursive: true });
const owner = randomUUID(), created = new Date(performance.timeOrigin).toISOString();
const report = { result: 'failed', checks: {}, observations: {}, error: null };
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const control = async (...args) => JSON.parse((await execute(process.execPath, [resolve('scripts/native/control.mjs'), '--root', root, ...args], { windowsHide: true })).stdout);
let session, renderer, host, heartbeat, app, originalRoots;
const wait = async (check, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  do { if (await check()) return; await delay(300); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}; ${JSON.stringify(await control('status'))}`);
};
const videoStatus = () => renderer.evaluate(`(()=>{const v=document.querySelector('#prism-wallpaper-v1 video');return v?{time:v.currentTime,paused:v.paused,muted:v.muted,loop:v.loop,width:v.videoWidth,height:v.videoHeight,src:v.src}:null})()`);
try {
  app = await discoverApp(); originalRoots = await snapshotAppRoots(app.executable);
  await saveJson(join(root, 'installation.json'), { product: 'prism-chatgpt', enabled: true, id: owner, image: app.executable });
  await control('bg', resolve('assets/prism-night.png'));
  const beat = () => saveJson(join(state, 'worker.json'), { state: 'armed', pid: process.pid, created, at: new Date().toISOString() });
  await beat(); heartbeat = setInterval(() => beat().catch(() => {}), 2000);
  const artifacts = join(root, 'session'); await mkdir(artifacts);
  session = await launchIsolated({ ...app, launchExecutable: await registeredLauncher() }, artifacts);
  await verifyDebugListener(session.port, session.child.pid);
  renderer = await connectRenderer(session, { worldName: `prism-persistent-${owner}`, signal: AbortSignal.timeout(45000) });
  const originalPages = (await renderer.client.send('Target.getTargets')).targetInfos.map(t=>t.targetId);
  await renderer.client.send('Runtime.evaluate', { expression: `window.electronBridge.sendMessageFromView({type:'open-in-new-window',path:'/'})`, awaitPromise: true }, { sessionId: renderer.sessionId });
  let visibleTarget;
  await wait(async()=>{visibleTarget=(await renderer.client.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&!originalPages.includes(t.targetId)&&/^app:\/\/-\/index\.html/.test(t.url))?.targetId;return !!visibleTarget;},'visible test window');
  renderer.client.close();
  renderer = await connectRenderer(session, { worldName: `prism-persistent-${owner}`, targetId: visibleTarget, signal: AbortSignal.timeout(45000) });
  assert.equal(await renderer.evaluate('document.hidden'),false);
  const supported = discoveryOnly ? [] : await renderer.evaluate(`['video/webm;codecs=vp8','video/mp4'].filter(type=>MediaRecorder.isTypeSupported(type))`);
  if(!discoveryOnly)assert.ok(supported.some(type => type.startsWith('video/webm')));
  report.observations.recorderTypes = supported;
  const videos = [];
  for (const type of supported) {
    const recorded = await renderer.evaluate(`(async()=>{
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
      const ctx=canvas.getContext('2d');let frame=0;
      const draw=()=>{ctx.fillStyle='#111a35';ctx.fillRect(0,0,320,180);ctx.fillStyle='#a289ff';ctx.beginPath();ctx.arc(40+(frame++%100)*2.4,90,25,0,Math.PI*2);ctx.fill();};draw();
      const stream=canvas.captureStream(12),recorder=new MediaRecorder(stream,{mimeType:${JSON.stringify(type)},videoBitsPerSecond:200000}),chunks=[];
      const done=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=resolve;recorder.onerror=reject});
      const timer=setInterval(draw,80);recorder.start();await new Promise(r=>setTimeout(r,1400));recorder.stop();await done;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
      const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
    })()`);
    const path = join(root, type.startsWith('video/mp4') ? 'motion.mp4' : 'motion.webm');
    await writeFile(path, Buffer.from(recorded, 'base64')); await loadLocalMedia(path); videos.push(path);
  }
  if (videos.some(path=>path.endsWith('.mp4'))) {
    const mp4=videos.find(path=>path.endsWith('.mp4')),padding=Buffer.alloc(40*1024*1024);
    padding.writeUInt32BE(padding.length);padding.write('free',4);
    const padded=join(root,'large-motion.mp4');await writeFile(padded,Buffer.concat([await readFile(mp4),padding]));videos.push(padded);
    const upperPadding=Buffer.alloc(128*1024*1024-(await readFile(mp4)).length);
    upperPadding.writeUInt32BE(upperPadding.length);upperPadding.write('free',4);
    const maximum=join(root,'maximum-motion.mp4');await writeFile(maximum,Buffer.concat([await readFile(mp4),upperPadding]));videos.push(maximum);
  }
  const sampleIndex=process.argv.indexOf('--sample-video');
  if(sampleIndex>=0)videos.push(resolve(process.argv[sampleIndex+1]));
  console.log(JSON.stringify({stage:'Generated procedural video fixtures',supported}));
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${session.child.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`], { windowsHide: true });
  await appendFile(join(state, 'activations.jsonl'), JSON.stringify({ pid: session.child.pid, created: stdout.trim(), patched: true, resumed: true }) + '\n');
  await appendFile(join(state, 'activations.jsonl'), JSON.stringify({ pid: process.pid, created: '1', patched: true, resumed: true }) + '\n');
  host = spawn(process.execPath, [resolve('scripts/native/host.mjs'), '--root', root, '--parent', String(process.pid)], { windowsHide: true, stdio: 'ignore' });
  await wait(async () => (await control('status')).appliedWindows > 0, 'initial image');
  await wait(async()=>{const s=await control('status');return !s.recovering&&s.errors.length===0;},'stale process-id record ignored');
  report.checks.staleActivationRecordIgnored=true;
  if(!discoveryOnly){
  for (const path of videos) {
    const started=performance.now();
    await control('bg', path);
    const media=await loadLocalMedia(path,{encoding:'metadata'}),expected=media.sha256;
    await wait(async () => (await control('status')).appliedWindows > 0 && await renderer.evaluate(`globalThis.__prismWallpaperV1?.image.sha256===${JSON.stringify(expected)}`) && !!await videoStatus(), 'video command applied',45000);
    const start = await videoStatus(); assert.ok(start.muted && start.loop && start.width>0 && start.height>0 && start.width*start.height<=8_294_400);
    await wait(async () => { const v=await videoStatus();return !v.paused && Math.abs(v.time-start.time)>.1; }, 'video advancing');
    report.checks[path.endsWith('.mp4') ? 'mp4Playback' : 'webmPlayback'] = true;
    if(media.bytes>30*1024*1024){report.checks.largeVideoPlayback=true;report.observations.largeVideoTransfers??=[];report.observations.largeVideoTransfers.push({bytes:media.bytes,elapsedMs:Math.round(performance.now()-started),width:start.width,height:start.height});}
    console.log(JSON.stringify({stage:'Playback passed',bytes:media.bytes,elapsedMs:Math.round(performance.now()-started)}));
  }
  // Settings must preserve the video element and decoder instead of restarting playback.
  await renderer.evaluate(`globalThis.prismPreviousVideo=document.querySelector('#prism-wallpaper-v1 video')`);
  await control('dim', '55%'); await control('fit', 'contain');
  await wait(async () => (await control('status')).appliedWindows > 0, 'video settings');
  assert.equal(await renderer.evaluate(`globalThis.prismPreviousVideo===document.querySelector('#prism-wallpaper-v1 video')&&prismPreviousVideo.style.objectFit==='contain'`), true);
  report.checks.settingsPreserveDecoder = true;
  const repeated=videos.at(-1);await control('bg',repeated);await wait(async()=>(await control('status')).appliedWindows>0,'repeated selection');
  assert.equal(await renderer.evaluate(`globalThis.prismPreviousVideo===document.querySelector('#prism-wallpaper-v1 video')`),true);report.checks.repeatedSelectionPreservesDecoder=true;
  const duration=await renderer.evaluate(`document.querySelector('#prism-wallpaper-v1 video').duration`);
  if(Number.isFinite(duration)&&duration>.4){await renderer.evaluate(`document.querySelector('#prism-wallpaper-v1 video').currentTime=${duration-.08}`);await wait(async()=>{const v=await videoStatus();return !v.paused&&v.time<duration-.2;},'loop wraps');report.checks.loopWraps=true;}
  await renderer.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, { sessionId: renderer.sessionId });
  await wait(async () => (await videoStatus()).paused, 'reduced-motion pause');
  await renderer.client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, { sessionId: renderer.sessionId });
  await wait(async () => !(await videoStatus()).paused, 'motion resume'); report.checks.reducedMotionPauseResume = true;
  await renderer.evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))`);
  await wait(async () => (await videoStatus()).paused, 'hidden pause');
  await renderer.evaluate(`delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))`);
  await wait(async () => !(await videoStatus()).paused, 'visible resume'); report.checks.visibilityPolicyPauseResume = true;
  // A structurally plausible but undecodable replacement must retain the previous video.
  const valid = await loadLocalMedia(videos[0]);
  const box = (name,data) => { const b=Buffer.alloc(data.length+8);b.writeUInt32BE(b.length);b.write(name,4);data.copy(b,8);return b; };
  const bad = Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0mp42')),box('moov',Buffer.alloc(4)),box('mdat',Buffer.alloc(4))]);
  const invalid = join(root,'undecodable.mp4'); await writeFile(invalid,bad); await control('bg',invalid);
  await wait(async () => (await control('status')).errors.length > 0, 'invalid codec rejection');
  assert.equal(await renderer.evaluate(`globalThis.prismPreviousVideo===document.querySelector('#prism-wallpaper-v1 video')`),true);
  report.checks.failedReplacementRetainsPreviousVideo = true;
  await control('bg', videos[0]); await wait(async () => (await control('status')).appliedWindows > 0, 'valid replacement recovery');
  await renderer.evaluate(`globalThis.prismPreviousVideo=document.querySelector('#prism-wallpaper-v1 video');globalThis.prismPreviousUrl=prismPreviousVideo.src`);
  await control('bg', resolve('assets/prism-plum.png')); await wait(async () => (await control('status')).appliedWindows > 0 && !await videoStatus(), 'return to static');
  assert.equal(await renderer.evaluate(`prismPreviousVideo.paused&&!prismPreviousVideo.getAttribute('src')&&prismPreviousVideo.readyState===0`),true);
  assert.equal(await renderer.evaluate(`fetch(prismPreviousUrl).then(()=>false,()=>true)`),true); report.checks.staticSwitchReleasesVideoAndUrl = true;
  await control('bg',videos[0]); await wait(async () => (await control('status')).appliedWindows > 0 && !!await videoStatus(), 'video before removal');
  await renderer.evaluate(`globalThis.prismPreviousVideo=document.querySelector('#prism-wallpaper-v1 video')`);
  await control('off'); await wait(async () => !await renderer.evaluate(`!!document.querySelector('#prism-wallpaper-v1')`), 'off removes wallpaper');
  assert.equal(await renderer.evaluate(`prismPreviousVideo.paused&&!prismPreviousVideo.getAttribute('src')`),true);report.checks.offReleasesVideo = true;
  const maximum=videos.find(path=>path.endsWith('maximum-motion.mp4'));
  if(maximum){
    await control('bg',maximum);
    await wait(async()=>(await control('status')).updatingWindows>0,'large transfer progress',15000);
    const cancelledAt=performance.now();await control('off');
    await wait(async()=>{const s=await control('status');return s.updatingWindows===0&&s.errors.length===0&&!await renderer.evaluate(`!!globalThis.__prismWallpaperTransferV1||!!document.querySelector('#prism-wallpaper-v1')`);},'cancelled transfer cleanup',8000);
    report.checks.offCancelsLargeTransfer=true;report.observations.cancelMs=Math.round(performance.now()-cancelledAt);
  }
  }
  report.result = 'passed';
} catch (error) { report.error = error.stack; }
finally {
  clearInterval(heartbeat);
  await writeFile(join(state,'host-stop'),'stop');
  if(host) { const deadline=Date.now()+8000;while(host.exitCode===null&&Date.now()<deadline)await delay(200);if(host.exitCode===null)host.kill(); }
  renderer?.client.close();
  if(session){const port=session.port;await session.stop();report.checks.listenerClosed=await waitForDebugListenerClosed(port);}
  if(app&&originalRoots)report.checks.originalAppProcessesPreserved=JSON.stringify(await snapshotAppRoots(app.executable))===JSON.stringify(originalRoots);
  await saveJson(join(root,'video-report.json'), report);
  console.log(JSON.stringify({root,...report},null,2));
}
if(report.result!=='passed')process.exitCode=1;
