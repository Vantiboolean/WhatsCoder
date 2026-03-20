import wsPkg from 'ws';

const WebSocket = wsPkg;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchTargetWebSocketUrl(cdpListUrl = process.env.CDP_LIST_URL ?? 'http://127.0.0.1:9222/json/list') {
  const response = await fetch(cdpListUrl);
  const targets = await response.json();
  const page = targets.find((target) => target.type === 'page');
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`No page target found at ${cdpListUrl}`);
  }
  return page.webSocketDebuggerUrl;
}

export class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
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
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    if (result?.exceptionDetails) {
      throw new Error(`Evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }

    return result?.result?.value;
  }

  async waitFor(expression, timeoutMs = 15000, intervalMs = 200) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const value = await this.evaluate(expression);
      if (value) {
        return value;
      }
      await sleep(intervalMs);
    }
    throw new Error(`Timed out waiting for expression: ${expression}`);
  }

  async close() {
    if (!this.ws) {
      return;
    }
    this.ws.close();
    await new Promise((resolve) => this.ws.once('close', resolve));
  }
}
