import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { runExperiment } from '../src/experiment.mjs';
import { registeredLauncher, packageIdentity } from '../src/windows.mjs';
import { loadLocalImage } from '../src/media.mjs';
import { wallpaperExpression } from '../src/wallpaper.mjs';

const { values } = parseArgs({ options: { 'app-dir': { type: 'string' } } });
const report = await runExperiment({ name: 'signed-in', appDir: values['app-dir'], launchExecutable: await registeredLauncher(), useExistingBackend: true, async main(context) {
  context.report.identity = await packageIdentity(context.report.pid);
  assert.match(context.report.identity.packageFullName ?? '', /^OpenAI\.Codex_/);
  // Record structural facts only, never message text, account details, or credentials.
  const deadline = Date.now() + 30_000;
  do {
    try { context.report.interface = await context.evaluate(`(() => {
      const visible=element=>{const r=element.getBoundingClientRect();return r.width>0&&r.height>0};
      const editors=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(visible);
      const surfaces=[...document.querySelectorAll('#root .bg-surface')].filter(visible).map(element=>{
        const r=element.getBoundingClientRect();return {width:Math.round(r.width),height:Math.round(r.height),background:getComputedStyle(element).backgroundColor};
      });
      const sampled=new Set([document.documentElement,document.body]);
      for(const [x,y] of [[.05,.5],[.5,.5],[.8,.5],[.5,.9]]) {
        let element=document.elementFromPoint(innerWidth*x,innerHeight*y);
        for(let depth=0;element&&depth<32;depth++,element=element.parentElement)sampled.add(element);
      }
      const opaqueSurfaces=[...sampled].map(element=>{
        const r=element.getBoundingClientRect(),s=getComputedStyle(element),rgba=s.backgroundColor.match(/[\\d.]+/g);
        const before=getComputedStyle(element,'::before');
        return {tag:element.tagName,id:element.id,classes:String(element.className).slice(0,800),width:Math.round(r.width),height:Math.round(r.height),background:s.backgroundColor,backgroundImage:s.backgroundImage,beforeBackground:before.backgroundColor,beforeImage:before.backgroundImage,alpha:rgba?(rgba.length>3?Number(rgba[3]):1):0};
      }).filter(item=>item.width>innerWidth*.2&&item.height>innerHeight*.4&&(item.alpha>.05||item.backgroundImage!=='none'||item.beforeImage!=='none'||item.beforeBackground!=='rgba(0, 0, 0, 0)')).slice(0,16);
      return {visibleEditors:editors.length,visibleButtons:[...document.querySelectorAll('button')].filter(visible).length,surfaces,opaqueSurfaces,hasRoot:!!document.getElementById('root'),bodyChildren:[...document.body.children].slice(0,8).map(element=>({tag:element.tagName,id:element.id})),viewport:{width:innerWidth,height:innerHeight}};
    })()`); }
    catch (error) {
      if (!/Session with given id not found|context|closed|target|timed out/i.test(error.message)) throw error;
      await context.reconnect();
      continue;
    }
    if (context.report.interface.visibleEditors > 0) break;
    await context.pause(500);
  } while (Date.now() < deadline);
  assert.ok(context.report.interface.visibleEditors > 0, 'No signed-in composer appeared.');
  context.report.checks.windowsPackageIdentityPreserved = true;
  context.report.checks.signedInComposerVisible = true;
  console.log(JSON.stringify({ interface: context.report.interface }, null, 2));
  const image = await loadLocalImage('assets/prism-night.png');
  const call = action => context.evaluate(wallpaperExpression(action, { runId: context.runId, image, settings: { controls: false } }));
  context.onCleanup(() => call('remove'));
  context.report.wallpaper = await call('apply');
  await context.screenshot('signed-in-wallpaper.png');
  await call('remove');
  context.report.checks.signedInWallpaperApplied = true;
} });
if (report.result !== 'passed') process.exitCode = 1;
