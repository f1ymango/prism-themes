import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cwd = resolve(process.cwd());
let projectName = null;

if (cwd.toLowerCase() === expectedRoot.toLowerCase()) {
  try {
    const packageJson = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
    projectName = packageJson.name ?? null;
  } catch {
    // The result remains a diagnostic failure; do not treat a missing file as success.
  }
}

const result = {
  marker: 'PRISM_LOCAL_EXEC_OK',
  expectedWorkspace: cwd.toLowerCase() === expectedRoot.toLowerCase(),
  projectName,
  wallpaperChanged: false,
};

process.stdout.write(`${JSON.stringify(result)}\n`);
if (!result.expectedWorkspace || projectName !== 'prism-chatgpt') process.exitCode = 1;
