import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeSettings } from './settings.mjs';

export function validatePreferences(value, baseDirectory) {
  if (!value || value.schema !== 1 || typeof value.image !== 'string' || !value.image.trim() || typeof value.enabled !== 'boolean') throw new Error('Invalid Prism preferences.');
  return { schema: 1, image: resolve(baseDirectory, value.image), enabled: value.enabled, settings: normalizeSettings(value.settings) };
}

export async function readPreferences(filename) {
  return validatePreferences(JSON.parse(await readFile(filename, 'utf8')), dirname(filename));
}

export async function saveJson(filename, value) {
  await mkdir(dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, filename); break; }
      catch (error) {
        if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(20 * 2 ** Math.min(attempt, 3));
      }
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function claimManagerLock(filename) {
  await mkdir(dirname(filename), { recursive: true });
  let file;
  try { file = await open(filename, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lock = JSON.parse(await readFile(filename, 'utf8'));
    if (isProcessAlive(lock.pid)) return null;
    await unlink(filename);
    return claimManagerLock(filename);
  }
  const token = randomUUID();
  await file.writeFile(JSON.stringify({ pid: process.pid, token })); await file.close();
  return async () => {
    const lock = JSON.parse(await readFile(filename, 'utf8'));
    if (lock.token === token) await unlink(filename);
  };
}
