import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { discoverApp, inspectApp } from '../src/app.mjs';

try {
  const { values } = parseArgs({ options: { 'app-dir': { type: 'string' }, output: { type: 'string' } } });
  const report = await inspectApp(await discoverApp(values['app-dir']));
  if (values.output) {
    const path = resolve(values.output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
