import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext, Script } from 'node:vm';
import { wallpaperExpression } from '../src/wallpaper.mjs';

test('wallpaper serialization treats injected strings as data and rejects bad owners', async () => {
  const expression = wallpaperExpression('apply', { runId: '\");globalThis.compromised=true;//' });
  new Script(expression);
  const context = {};
  await assert.rejects(runInNewContext(expression, context), /Invalid wallpaper owner/);
  assert.equal(context.compromised, undefined);
});

test('wallpaper refuses foreign owners, non-app renderers, subframes, and excessive lifetimes', async () => {
  const expression = wallpaperExpression('remove', { runId: 'our-owner-123' });
  const context = { location: { protocol: 'app:' }, __prismWallpaperV1: { runId: 'foreign-owner' } };
  runInNewContext('globalThis.top=globalThis', context);
  await assert.rejects(runInNewContext(expression, context), /different owner/);
  await assert.rejects(runInNewContext(expression, { top: {}, location: { protocol: 'app:' } }), /top-level/);
  const web = { location: { protocol: 'https:' } }; runInNewContext('globalThis.top=globalThis', web);
  await assert.rejects(runInNewContext(expression, web), /top-level/);
  await assert.rejects(runInNewContext(wallpaperExpression('apply', { runId: 'our-owner-123', ttlMs: 999999 }), {}), /lifetime/);
});
