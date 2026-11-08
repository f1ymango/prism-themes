import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSupportedBuild, supportedBuild } from '../src/compatibility.mjs';

const inspection = { metadata: supportedBuild, archiveHeaderSha256: supportedBuild.archiveHeaderSha256 };

test('compatibility accepts the reviewed build and rejects updated metadata or changed binaries', () => {
  assert.doesNotThrow(() => assertSupportedBuild(inspection, supportedBuild));
  assert.throws(() => assertSupportedBuild({ ...inspection, metadata: { ...supportedBuild, version: 'unknown' } }, supportedBuild), /Unsupported app version/);
  assert.throws(() => assertSupportedBuild(inspection, { ...supportedBuild, archiveSha256: 'changed' }), /differ/);
});
