import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrismCommand } from '../src/prism-command.mjs';

test('in-app commands support a bounded, explicit grammar', () => {
  assert.deepEqual(parsePrismCommand('/prism dim 42%'), { action: 'update', settings: { dim: .42 } });
  assert.deepEqual(parsePrismCommand('fit contain'), { action: 'update', settings: { fit: 'contain' } });
  assert.deepEqual(parsePrismCommand('position top'), { action: 'update', settings: { position: 'top' } });
  assert.deepEqual(parsePrismCommand('pick'), { action: 'choose' });
  assert.deepEqual(parsePrismCommand('reset'), { action: 'reset' });
});

test('invalid and executable-looking commands never reach a shell', () => {
  for (const command of ['dim 101', 'dim -1', 'fit url(x)', 'choose path file', 'dim 40;calc', 'reset now', '', 'x'.repeat(257)]) assert.throws(() => parsePrismCommand(command));
});
