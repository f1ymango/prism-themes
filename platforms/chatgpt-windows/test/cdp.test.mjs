import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient, evaluate } from '../src/cdp.mjs';

class Socket extends EventTarget {
  readyState = WebSocket.OPEN;
  messages = [];
  send(text) { this.messages.push(JSON.parse(text)); }
  reply(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); }
}

test('CDP rejects non-loopback endpoints before connecting', async () => {
  await assert.rejects(CdpClient.connect('ws://example.com/devtools/browser/abc'), /loopback/);
  await assert.rejects(CdpClient.connect('ws://127.0.0.1:9222/devtools/page/abc'), /loopback/);
});

test('CDP correlates out-of-order replies and preserves renderer session IDs', async () => {
  const socket = new Socket();
  const client = new CdpClient(socket);
  const a = client.send('First', {}, { sessionId: 'renderer' });
  const b = client.send('Second');
  socket.reply({ id: socket.messages[1].id, result: { value: 2 } });
  socket.reply({ id: socket.messages[0].id, result: { value: 1 } });
  assert.deepEqual(await a, { value: 1 });
  assert.deepEqual(await b, { value: 2 });
  assert.equal(socket.messages[0].sessionId, 'renderer');
  client.close();
});

test('CDP rejects protocol errors, timeouts, and in-flight calls on disconnect', async () => {
  const socket = new Socket();
  const client = new CdpClient(socket);
  const bad = client.send('Unsupported');
  socket.reply({ id: socket.messages[0].id, error: { message: 'disabled' } });
  await assert.rejects(bad, /disabled/);
  await assert.rejects(client.send('NoResponse', {}, { timeoutMs: 10 }), /timed out/);
  const pending = client.send('Pending');
  socket.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(client.send('AfterClose'), /closed/);
});

test('renderer evaluation exceptions fail the probe instead of producing a false success', async () => {
  const client = { send: async () => ({ exceptionDetails: { text: 'Uncaught' } }) };
  await assert.rejects(evaluate(client, 'session', 'throw new Error()'), /Probe script failed/);
});
