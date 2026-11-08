import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverApp } from '../../src/app.mjs';
import { launchIsolated } from '../../src/session.mjs';
import { registeredLauncher } from '../../src/windows.mjs';
import { verifyDebugListener, snapshotAppRoots, waitForDebugListenerClosed } from '../../src/verification.mjs';
import { connectRenderer } from '../../src/renderer.mjs';
import { loadLocalImage } from '../../src/media.mjs';
import { wallpaperExpression } from '../../src/wallpaper.mjs';
import { saveJson } from '../../src/preferences.mjs';

const root = resolve('.prism-probe', `surfaces-${randomUUID().slice(0,8)}`), owner = randomUUID();
await mkdir(root, { recursive: true });
let app, original, session, renderer;
const report = { result: 'failed', checks: {}, error: null };
const snapshot = `(()=>{
  const alpha=color=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,1,1);return x.getImageData(0,0,1,1).data[3]/255};
  return Object.fromEntries([...document.querySelectorAll('[data-prism-test]')].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return [e.id,{alpha:alpha(s.backgroundColor),background:s.backgroundColor,image:s.backgroundImage,beforeAlpha:alpha(getComputedStyle(e,'::before').backgroundColor),width:r.width,height:r.height,pointer:s.pointerEvents}]}));
})()`;
try {
  app = await discoverApp(); original = await snapshotAppRoots(app.executable);
  session = await launchIsolated({ ...app, launchExecutable: await registeredLauncher() }, root);
  await verifyDebugListener(session.port,session.child.pid);
  renderer = await connectRenderer(session,{worldName:`prism-surfaces-${owner}`,signal:AbortSignal.timeout(45000)});
  await renderer.evaluate(`(()=>{
    const section=document.createElement('section');section.id='prism-surface-fixture';section.style.cssText='width:500px;height:400px;position:fixed;inset:0;z-index:10000';
    section.innerHTML=\`<style>
      #prism-surface-fixture [data-prism-test]{width:300px;height:24px;background:rgb(45,45,45)}
      #prism-surface-fixture header::before{content:'';background:rgb(45,45,45);height:8px}
      #test-top-fade,#test-bottom-fade,#test-footer-background{background-image:linear-gradient(#181818,transparent)!important}
    </style>
    <div id="test-top-fade" data-prism-test class="MainContentTopFade-fixture"></div>
    <div class="thread-scroll-container"><div id="test-bottom-fade" data-prism-test class="background-fixture fade-fixture pointer-events-none"></div></div>
    <div data-thread-scroll-footer="true"><div id="test-footer-background" data-prism-test class="pointer-events-none bg-surface"></div></div>
    <div id="test-panel" data-prism-test data-summary-panel-variant="summary"><header id="test-panel-header" data-prism-test></header></div>
    <div id="test-composer" data-prism-test data-composer-layout="multiline" data-composer-surface-variant="default" data-composer-dark><button id="test-button" data-prism-test>Control</button></div>
    <div id="test-card" data-prism-test class="[--resource-card-row-padding-x:0.75rem]"><div id="test-card-body" data-prism-test class="bg-surface"></div><pre><code><div id="test-code" data-prism-test class="bg-surface">Code</div></code></pre></div>
    <div role="dialog"><div id="test-dialog-panel" data-prism-test data-summary-panel-variant="summary"><header id="test-dialog-header" data-prism-test></header></div><div id="test-dialog-composer" data-prism-test data-composer-layout="multiline" data-composer-surface-variant="default"></div></div>\`;
    document.getElementById('root').append(section);
  })()`);
  const before=await renderer.evaluate(snapshot);
  await renderer.evaluate(wallpaperExpression('apply',{runId:owner,image:await loadLocalImage(resolve('assets/prism-night.png')),settings:{controls:false},ttlMs:20000}));
  const after=await renderer.evaluate(snapshot);
  assert.equal(after['test-top-fade'].image,'none'); assert.equal(after['test-top-fade'].alpha,0);
  assert.equal(after['test-bottom-fade'].image,'none'); assert.equal(after['test-bottom-fade'].alpha,0);
  assert.equal(after['test-footer-background'].image,'none');assert.equal(after['test-footer-background'].alpha,0);
  report.checks.decorativeFadesRemoved=true;
  for(const key of ['test-panel','test-composer','test-card'])assert.ok(after[key].alpha>.6&&after[key].alpha<.7,key);
  assert.equal(after['test-panel-header'].alpha,0);assert.equal(after['test-panel-header'].beforeAlpha,0);
  assert.equal(after['test-card-body'].alpha,0);report.checks.panelsComposerCardsTranslucent=true;
  for(const key of ['test-button','test-code','test-dialog-panel','test-dialog-header','test-dialog-composer'])assert.deepEqual(after[key],before[key],key);
  report.checks.controlsCodeAndDialogsPreserved=true;
  for(const key of Object.keys(before))assert.deepEqual([after[key].width,after[key].height,after[key].pointer],[before[key].width,before[key].height,before[key].pointer],key);
  report.checks.layoutAndPointerBehaviorPreserved=true;
  await renderer.evaluate(wallpaperExpression('remove',{runId:owner}));
  assert.deepEqual(await renderer.evaluate(snapshot),before);report.checks.nativeStylesRestored=true;
  report.result='passed';
}catch(error){report.error=error.stack;}
finally{
  renderer?.client.close();
  if(session){await session.stop();report.checks.listenerClosed=await waitForDebugListenerClosed(session.port);}
  if(app&&original)report.checks.originalAppProcessesPreserved=JSON.stringify(await snapshotAppRoots(app.executable))===JSON.stringify(original);
  await saveJson(join(root,'surface-report.json'),report);console.log(JSON.stringify({root,...report},null,2));
}
if(report.result!=='passed')process.exitCode=1;
