import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const sharingErrors = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOENT']);

export async function readWorkerHeartbeat(filename) {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(await readFile(filename, 'utf8')); }
    catch (error) {
      if (attempt >= 7 || !sharingErrors.has(error.code)) throw error;
      await delay(20 * 2 ** Math.min(attempt, 3));
    }
  }
}
