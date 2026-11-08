import { resolve } from 'node:path';
import { runExperiment } from '../src/experiment.mjs';
import { registeredLauncher } from '../src/windows.mjs';

const report = await runExperiment({ name: 'extension-loading', launchExecutable: await registeredLauncher(), extraArguments: [`--load-extension=${resolve('experiments/extension-probe')}`], async main(context) {
  await context.pause(500);
  context.report.contentScriptLoaded = await context.evaluate("!!document.getElementById('prism-extension-loading-probe')");
  const { targetInfos } = await context.client.send('Target.getTargets');
  context.report.workers = [];
  for (const target of targetInfos.filter(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension:'))) {
    const { sessionId } = await context.client.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const response = await context.client.send('Runtime.evaluate', { expression: 'globalThis.__prismExtensionProbe??null', returnByValue: true }, { sessionId });
    if (response.result?.value !== null && response.result?.value !== undefined) context.report.workers.push(response.result.value);
    await context.client.send('Target.detachFromTarget', { sessionId });
  }
  context.report.checks.extensionInjectedIntoApp = context.report.contentScriptLoaded;
  console.log(JSON.stringify({ contentScriptLoaded: context.report.contentScriptLoaded, workers: context.report.workers }));
} });
if (report.result !== 'passed') process.exitCode = 1;
