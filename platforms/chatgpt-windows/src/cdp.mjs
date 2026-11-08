export class CdpClient {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #closed = false;

  static async connect(endpoint, { timeoutMs = 5000 } = {}) {
    const url = new URL(endpoint);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
        !/^\/devtools\/browser\/[\w-]+$/.test(url.pathname)) throw new Error('Only a loopback browser debugging endpoint is accepted.');
    const socket = new WebSocket(endpoint);
    const client = new CdpClient(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out.')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed.')); }, { once: true });
    });
    return client;
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { this.close(); return; }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => this.#rejectPending());
    socket.addEventListener('error', () => this.#rejectPending());
  }

  #rejectPending() {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`CDP connection closed during ${pending.method}.`));
    }
    this.#pending.clear();
  }

  send(method, params = {}, { sessionId, timeoutMs = 5000 } = {}) {
    if (this.#closed) return Promise.reject(new Error('CDP connection is closed.'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try { this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }

  close() {
    this.#rejectPending();
    if (this.#socket.readyState < WebSocket.CLOSING) this.#socket.close();
  }
}

export async function evaluate(client, sessionId, expression, contextId) {
  const response = await client.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, timeout: 4000,
    ...(contextId ? { contextId } : {}),
  }, { sessionId });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description?.split('\n')[0] ?? response.exceptionDetails.text;
    throw new Error(`Probe script failed: ${detail}`);
  }
  return response.result?.value;
}
