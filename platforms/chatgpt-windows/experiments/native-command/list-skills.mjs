import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const child = spawn('codex', ['app-server', '--stdio'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

const lines = readline.createInterface({ input: child.stdout });
let stderr = '';
let settled = false;

const timer = setTimeout(() => finish(new Error('skills/list timed out')), 20000);
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
child.on('error', finish);
child.on('exit', code => {
  if (!settled) finish(new Error(`app-server exited ${code}: ${stderr}`));
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function finish(error, result) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  lines.close();
  child.stdin.end();
  child.kill();
  if (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 0) {
    if (message.error) return finish(new Error(message.error.message));
    send({ method: 'initialized', params: {} });
    send({ method: 'skills/list', id: 1, params: { cwds: [cwd], forceReload: true } });
  } else if (message.id === 1) {
    if (message.error) return finish(new Error(message.error.message));
    const data = message.result?.data?.find(item => item.cwd?.toLowerCase() === cwd.toLowerCase());
    const prism = data?.skills?.filter(item => item.name === 'prism') ?? [];
    finish(null, {
      found: prism.length > 0,
      prism: prism.map(item => ({ name: item.name, path: item.path, enabled: item.enabled, interface: item.interface })),
      errors: data?.errors ?? [],
    });
  }
});

send({
  method: 'initialize',
  id: 0,
  params: { clientInfo: { name: 'prism_native_probe', title: 'Prism native command probe', version: '0.1.0' } },
});
