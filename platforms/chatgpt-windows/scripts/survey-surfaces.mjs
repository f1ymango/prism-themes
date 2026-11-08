import { parseArgs } from 'node:util';
import { runExperiment } from '../src/experiment.mjs';

const { values } = parseArgs({ options: { 'app-dir': { type: 'string' } } });
const report = await runExperiment({ name: 'surface-survey', appDir: values['app-dir'], async main(context) {
  context.report.surfaces = await context.evaluate(`(() => {
    const width=innerWidth,height=innerHeight;
    return [...document.querySelectorAll('html,body,body div,body main,body form,body section')].map(element=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return {tag:element.tagName,id:element.id,classes:String(element.className).slice(0,300),width:Math.round(rect.width),height:Math.round(rect.height),background:style.backgroundColor,backgroundImage:style.backgroundImage,position:style.position,buttons:element.querySelectorAll('button').length,parentTag:element.parentElement?.tagName,parentId:element.parentElement?.id};
    }).filter(item=>(item.width>width*.8&&item.height>height*.8)||(item.buttons>=2&&item.width<width*.8&&item.width>200&&item.height>150)).slice(0,40);
  })()`);
  console.log(JSON.stringify({ surfaces: context.report.surfaces }, null, 2));
  context.report.checks.surfaceSurveyCompleted = true;
} });
if (report.result !== 'passed') process.exitCode = 1;
