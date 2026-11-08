import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { runExperiment } from '../src/experiment.mjs';
import { registeredLauncher, packageIdentity } from '../src/windows.mjs';

const { values } = parseArgs({ options: { 'app-dir': { type: 'string' } } });
const alias = await registeredLauncher();
const report = await runExperiment({ name: 'registered-launch', appDir: values['app-dir'], launchExecutable: alias, async main(context) {
  context.report.launcher = alias;
  context.report.identity = await packageIdentity(context.report.pid);
  assert.match(context.report.identity.packageFullName ?? '', /^OpenAI\.Codex_/);
  context.report.checks.windowsPackageIdentityPreserved = true;
} });
if (report.result !== 'passed') process.exitCode = 1;
