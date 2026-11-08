import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext, Script } from 'node:vm';
import { markerExpression } from '../src/marker.mjs';

test('marker serialization preserves arguments as data and rejects invalid run IDs', () => {
  const expression = markerExpression('apply', { runId: '\");globalThis.compromised=true;//' });
  new Script(expression);
  const context = {};
  assert.throws(() => runInNewContext(expression, context), /run ID/);
  assert.equal(context.compromised, undefined);
});

test('marker refuses to remove another owner before touching the DOM', () => {
  let removed = false;
  const existing = { getAttribute: () => 'foreign-owner', remove: () => { removed = true; } };
  const context = { document: { getElementById: () => existing } };
  runInNewContext('globalThis.top=globalThis', context);
  assert.throws(() => runInNewContext(markerExpression('remove', { runId: 'our-owner-123' }), context), /different owner/);
  assert.equal(removed, false);
});

test('marker refuses subframes and invalid lifetimes', () => {
  assert.throws(() => runInNewContext(markerExpression('apply', { runId: 'our-owner-123' }), { top: {} }), /top-level/);
  assert.throws(() => runInNewContext(markerExpression('apply', { runId: 'our-owner-123', ttlMs: 999999 }), {}), /lifetime/);
});
