import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { openAsar } from '../src/asar.mjs';

async function fixture(t, files, payload = 'hello') {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'prism-asar-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(basename(directory).startsWith('prism-asar-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const json = Buffer.from(JSON.stringify({ files }));
  const paddedSize = Math.ceil((8 + json.length) / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(paddedSize, 4);
  prefix.writeUInt32LE(paddedSize - 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  const filename = join(directory, 'test.asar');
  await writeFile(filename, Buffer.concat([prefix, json, Buffer.alloc(8 + paddedSize - 16 - json.length), Buffer.from(payload)]));
  return filename;
}

test('ASAR reads an indexed packed entry without unpacking', async t => {
  const archive = await openAsar(await fixture(t, { nested: { files: { 'file.txt': { size: 5, offset: '0' } } } }));
  try { assert.equal(await archive.readText('nested/file.txt'), 'hello'); }
  finally { await archive.close(); }
});

test('ASAR rejects entry traversal, unpacked entries, oversized reads, and corrupt offsets', async t => {
  await assert.rejects(openAsar(await fixture(t, { '..': { size: 5, offset: '0' } })), /entry name/);
  const archive = await openAsar(await fixture(t, {
    plain: { size: 5, offset: '0' },
    outside: { size: 5, offset: '99999' },
    unpacked: { size: 5, unpacked: true },
  }));
  try {
    await assert.rejects(archive.readText('plain', 4), /bounds/);
    await assert.rejects(archive.readText('outside'), /bounds/);
    await assert.rejects(archive.readText('unpacked'), /unavailable/);
  } finally { await archive.close(); }
});

test('ASAR rejects a truncated prefix', async t => {
  const path = await fixture(t, {});
  await writeFile(path, Buffer.from([4, 0, 0, 0]));
  await assert.rejects(openAsar(path), /prefix/);
});
