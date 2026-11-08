import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname, basename } from 'node:path';
import { validatePreferences, saveJson, claimManagerLock } from '../src/preferences.mjs';

async function directory(t) {
  const root = fileURLToPath(new URL('../.prism-probe/unit-preferences/', import.meta.url)).replace(/[\\/]+$/, '');
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, 'prism-prefs-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(path)), root); assert.ok(basename(path).startsWith('prism-prefs-test-'));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

test('preferences reject malformed enabled/settings values before a running session changes', () => {
  const base = resolve('assets');
  const value = { schema: 1, image: 'prism-night.png', enabled: true, settings: { dim: .4 } };
  assert.equal(validatePreferences(value, base).image, join(base, 'prism-night.png'));
  assert.equal(validatePreferences(value, base).theme.mode, 'auto');
  assert.throws(() => validatePreferences({ ...value, enabled: 'yes' }, base), /Invalid/);
  assert.throws(() => validatePreferences({ ...value, settings: { dim: -1 } }, base), /Dim/);
  assert.throws(() => validatePreferences({ ...value, theme: { tint: 'red' } }, base), /hex colour/);
});

test('a failed JSON serialization preserves the last saved preferences', async t => {
  const filename = join(await directory(t), 'settings.json');
  await saveJson(filename, { dim: .4 });
  const circular = {}; circular.value = circular;
  await assert.rejects(saveJson(filename, circular));
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { dim: .4 });
});

test('manager lock prevents duplicate sessions and releases only its own token', async t => {
  const filename = join(await directory(t), 'manager.lock');
  const release = await claimManagerLock(filename);
  assert.equal(await claimManagerLock(filename), null);
  await release();
  const releaseAgain = await claimManagerLock(filename);
  await writeFile(filename, JSON.stringify({ pid: process.pid, token: 'another-owner' }));
  await releaseAgain();
  await access(filename);
});
