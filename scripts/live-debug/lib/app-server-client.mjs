import wsPkg from 'ws';

const WebSocket = wsPkg;

export class AppServerClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 10000;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (typeof message.id !== 'number') {
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });

    await this.send('initialize', {
      clientInfo: {
        name: 'codex-mobile-live-debug',
        title: 'Codex Mobile Live Debug',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized', {});
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  notify(method, params = {}) {
    this.ws.send(JSON.stringify({ method, params }));
  }

  async listThreads(params = {}) {
    return await this.send('thread/list', {
      cursor: null,
      limit: 30,
      archived: false,
      sortKey: 'updated_at',
      ...params,
    });
  }

  async readThread(threadId, includeTurns = true) {
    const result = await this.send('thread/read', { threadId, includeTurns });
    return result?.thread ?? null;
  }

  async close() {
    if (!this.ws) {
      return;
    }
    this.ws.close();
    await new Promise((resolve) => this.ws.once('close', resolve));
  }
}
