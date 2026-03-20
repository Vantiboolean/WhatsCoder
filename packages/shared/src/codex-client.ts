/**
 * WebSocket JSON-RPC 2.0 client for the Codex App Server.
 *
 * Protocol notes:
 *   - Codex app-server omits the `"jsonrpc":"2.0"` header on the wire.
 *   - One JSON object per WebSocket text frame.
 *   - Supports ws:// transport via `--listen ws://IP:PORT`.
 */

import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcServerRequest,
  ServerMessage,
  ThreadSummary,
  ThreadDetail,
  Turn,
  ConnectionState,
  ModelInfo,
  AccountInfo,
  ApprovalDecision,
  DynamicToolCallContentItem,
  ChatgptAuthTokensRefreshResponse,
} from './types';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
export type ServerRequestHandler = (request: JsonRpcServerRequest) => void;

export type SourceKind =
  | 'cli'
  | 'vscode'
  | 'appServer'
  | 'exec'
  | 'unknown'
  | 'subAgent'
  | 'subAgentOther'
  | 'subAgentThreadSpawn'
  | 'subAgentCompact'
  | 'subAgentReview';

const ALL_SOURCE_KINDS: SourceKind[] = [
  'cli',
  'vscode',
  'appServer',
  'exec',
  'unknown',
  'subAgent',
  'subAgentOther',
  'subAgentThreadSpawn',
  'subAgentCompact',
  'subAgentReview',
];

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function createTextInput(text: string) {
  return [{ type: 'text' as const, text }];
}

export class CodexClient {
  private ws: WebSocket | null = null;
  private nextId = 10_000;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: NotificationHandler[] = [];
  private serverRequestHandlers: ServerRequestHandler[] = [];
  private stateListeners: Array<(state: ConnectionState) => void> = [];
  private _state: ConnectionState = 'disconnected';
  private _url = '';
  private _lastError = '';
  private _connectionEpoch = 0;
  private _autoReconnect = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempt = 0;

  get state(): ConnectionState {
    return this._state;
  }

  get url(): string {
    return this._url;
  }

  get lastError(): string {
    return this._lastError;
  }

  private setState(s: ConnectionState) {
    this._state = s;
    for (const fn of [...this.stateListeners]) fn(s);
  }

  onStateChange(fn: (state: ConnectionState) => void): () => void {
    this.stateListeners.push(fn);
    return () => {
      this.stateListeners = this.stateListeners.filter((h) => h !== fn);
    };
  }

  onNotification(fn: NotificationHandler): () => void {
    this.notificationHandlers.push(fn);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== fn);
    };
  }

  onServerRequest(fn: ServerRequestHandler): () => void {
    this.serverRequestHandlers.push(fn);
    return () => {
      this.serverRequestHandlers = this.serverRequestHandlers.filter((h) => h !== fn);
    };
  }

  // ── Connection lifecycle ───────────────────────────────────

  async connect(url: string, opts?: { autoReconnect?: boolean }): Promise<void> {
    this.cancelReconnect();
    this.cleanupSocket();

    this._url = url;
    this._lastError = '';
    this._autoReconnect = opts?.autoReconnect ?? true;
    this._reconnectAttempt = 0;

    const epoch = ++this._connectionEpoch;
    this.setState('connecting');

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: typeof resolve | typeof reject, val?: unknown) => {
        if (settled || epoch !== this._connectionEpoch) return;
        settled = true;
        (fn as (v?: unknown) => void)(val);
      };

      try {
        this.ws = new WebSocket(url);
      } catch (e) {
        this._lastError = String(e);
        this.setState('error');
        settle(reject, e);
        return;
      }

      const timeout = setTimeout(() => {
        this._lastError = 'Connection timed out';
        this.setState('error');
        this.ws?.close();
        settle(reject, new Error('Connection timed out'));
      }, 10_000);

      this.ws.onopen = async () => {
        clearTimeout(timeout);
        if (epoch !== this._connectionEpoch) return;
        try {
          await this.initialize();
          this._reconnectAttempt = 0;
          this.setState('connected');
          settle(resolve);
        } catch (e) {
          this._lastError = e instanceof Error ? e.message : String(e);
          this.setState('error');
          settle(reject, e);
        }
      };

      this.ws.onmessage = (event) => {
        if (epoch !== this._connectionEpoch) return;
        try {
          const raw = typeof event.data === 'string' ? event.data : '';
          if (!raw) return;
          const msg: ServerMessage = JSON.parse(raw);

          if ('id' in msg && msg.id != null && 'method' in msg) {
            const request = msg as JsonRpcServerRequest;
            for (const h of [...this.serverRequestHandlers]) {
              try {
                h(request);
              } catch {
                /* handler error */
              }
            }
          } else if ('id' in msg && msg.id != null) {
            const p = this.pending.get(msg.id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(msg.id);
              if ('error' in msg && msg.error) {
                const err = new Error(msg.error.message);
                (err as unknown as Record<string, unknown>).code = msg.error.code;
                (err as unknown as Record<string, unknown>).data = msg.error.data;
                p.reject(err);
              } else {
                p.resolve((msg as JsonRpcResponse).result);
              }
            }
          } else if ('method' in msg) {
            const n = msg as JsonRpcNotification;
            const params = (n.params ?? {}) as Record<string, unknown>;
            for (const h of [...this.notificationHandlers]) {
              try { h(n.method, params); } catch { /* handler error */ }
            }
          }
        } catch (e) {
          for (const h of [...this.notificationHandlers]) {
            try { h('_client/parseError', { raw: event.data, error: String(e) }); } catch { /* */ }
          }
        }
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        if (epoch !== this._connectionEpoch) return;
        this._lastError = 'WebSocket connection failed';
        this.setState('error');
        settle(reject, new Error('WebSocket error'));
      };

      this.ws.onclose = (ev) => {
        clearTimeout(timeout);
        if (epoch !== this._connectionEpoch) return;

        this.drainPending('Connection closed');

        if (this._state !== 'error') {
          this._lastError = ev.reason || 'Connection closed';
          this.setState('disconnected');
        }

        if (this._autoReconnect && epoch === this._connectionEpoch) {
          this.scheduleReconnect();
        }
      };
    });
  }

  disconnect() {
    this._autoReconnect = false;
    this.cancelReconnect();
    this._connectionEpoch++;
    this.cleanupSocket();
    this.drainPending('Disconnected');
    this.setState('disconnected');
  }

  private cleanupSocket() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* */ }
      this.ws = null;
    }
  }

  private drainPending(reason: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  // ── Auto-reconnect ────────────────────────────────────────

  private scheduleReconnect() {
    this.cancelReconnect();
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt) + Math.random() * 500,
      RECONNECT_MAX_MS,
    );
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(async () => {
      if (!this._autoReconnect) return;
      try {
        await this.connect(this._url, { autoReconnect: true });
      } catch {
        // onclose will schedule next attempt
      }
    }, delay);
  }

  private cancelReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // ── Transport ──────────────────────────────────────────────

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = this.nextId = (this.nextId % 0x7FFFFFFF) + 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const msg: JsonRpcRequest = { method, id, params };
      this.ws.send(JSON.stringify(msg));
    });
  }

  private notify(method: string, params?: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: JsonRpcNotification = { method, params };
    this.ws.send(JSON.stringify(msg));
  }

  private sendResponse(id: number, result?: unknown, error?: { code: number; message: string; data?: unknown }) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    const payload = error ? { id, error } : { id, result };
    this.ws.send(JSON.stringify(payload));
  }

  private async initialize() {
    await this.send('initialize', {
      clientInfo: {
        name: 'codex_mobile',
        title: 'Codex Mobile',
        version: '1.0.0',
      },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
  }

  // ── Thread APIs ────────────────────────────────────────────

  async listThreads(params?: {
    cursor?: string | null;
    limit?: number;
    archived?: boolean;
    sortKey?: 'created_at' | 'updated_at';
    cwd?: string;
    searchTerm?: string;
    modelProviders?: string[];
    sourceKinds?: SourceKind[];
  }): Promise<{ data: ThreadSummary[]; nextCursor: string | null }> {
    return (await this.send('thread/list', {
      cursor: params?.cursor ?? null,
      limit: params?.limit ?? 30,
      archived: params?.archived ?? false,
      sortKey: params?.sortKey ?? 'updated_at',
      ...(params?.cwd != null ? { cwd: params.cwd } : {}),
      ...(params?.searchTerm ? { searchTerm: params.searchTerm } : {}),
      ...(params?.modelProviders ? { modelProviders: params.modelProviders } : {}),
      sourceKinds: params?.sourceKinds ?? ALL_SOURCE_KINDS,
    })) as { data: ThreadSummary[]; nextCursor: string | null };
  }

  async readThread(threadId: string, includeTurns = true): Promise<ThreadDetail> {
    const result = (await this.send('thread/read', {
      threadId,
      includeTurns,
    })) as { thread: ThreadDetail };
    return result.thread;
  }

  async startThread(params?: { model?: string; cwd?: string }): Promise<ThreadSummary> {
    const { model, cwd, ...rest } = params ?? {};
    const result = (await this.send('thread/start', {
      ...(model != null ? { model } : {}),
      ...(cwd != null ? { cwd } : {}),
      ...rest,
    })) as { thread: ThreadSummary };
    return result.thread;
  }

  async resumeThread(threadId: string): Promise<ThreadSummary> {
    const result = (await this.send('thread/resume', {
      threadId,
    })) as { thread: ThreadSummary };
    return result.thread;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.send('thread/archive', { threadId });
  }

  async unarchiveThread(threadId: string): Promise<ThreadSummary> {
    const result = (await this.send('thread/unarchive', {
      threadId,
    })) as { thread: ThreadSummary };
    return result.thread;
  }

  async listLoadedThreads(): Promise<string[]> {
    const result = (await this.send('thread/loaded/list', {})) as { data: string[] };
    return result.data;
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await this.send('thread/unsubscribe', { threadId });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.send('thread/name/set', { threadId, name });
  }

  async rollbackThread(threadId: string, numTurns: number): Promise<ThreadDetail> {
    const result = (await this.send('thread/rollback', {
      threadId,
      numTurns,
    })) as { thread: ThreadDetail };
    return result.thread;
  }

  // ── Turn APIs ──────────────────────────────────────────────

  async startTurn(threadId: string, text: string, opts?: { model?: string; reasoningEffort?: string }): Promise<Turn> {
    const result = (await this.send('turn/start', {
      threadId,
      input: createTextInput(text),
      ...(opts?.model != null ? { model: opts.model } : {}),
      ...(opts?.reasoningEffort != null ? { effort: opts.reasoningEffort } : {}),
    })) as { turn: Turn };
    return result.turn;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.send('turn/interrupt', { threadId, turnId });
  }

  // ── Approval APIs ─────────────────────────────────────────

  async respondToApproval(requestId: number, decision: ApprovalDecision): Promise<void> {
    this.sendResponse(requestId, { decision });
  }

  async respondToPermissionsRequest(
    requestId: number,
    permissions: Record<string, unknown>,
    scope: 'turn' | 'session' = 'turn',
  ): Promise<void> {
    this.sendResponse(requestId, { permissions, scope });
  }

  async respondToUserInput(
    requestId: number,
    answers: Record<string, { answers: string[] }>,
  ): Promise<void> {
    this.sendResponse(requestId, { answers });
  }

  async respondToMcpElicitation(
    requestId: number,
    action: 'accept' | 'decline' | 'cancel',
    content: unknown,
    meta: unknown = null,
  ): Promise<void> {
    this.sendResponse(requestId, {
      action,
      content,
      _meta: meta,
    });
  }

  async respondToDynamicToolCall(
    requestId: number,
    contentItems: DynamicToolCallContentItem[],
    success: boolean,
  ): Promise<void> {
    this.sendResponse(requestId, {
      contentItems,
      success,
    });
  }

  async respondToChatgptAuthTokensRefresh(
    requestId: number,
    response: ChatgptAuthTokensRefreshResponse,
  ): Promise<void> {
    this.sendResponse(requestId, response);
  }

  async rejectServerRequest(
    requestId: number,
    message: string,
    code = -32000,
    data?: unknown,
  ): Promise<void> {
    this.sendResponse(requestId, undefined, { code, message, data });
  }

  // ── Model APIs ─────────────────────────────────────────────

  async listModels(): Promise<ModelInfo[]> {
    const result = (await this.send('model/list', {
      limit: 20,
      includeHidden: false,
    })) as { data: ModelInfo[] };
    return result.data;
  }

  // ── Account APIs ───────────────────────────────────────────

  async readAccount(): Promise<{ account: AccountInfo; requiresOpenaiAuth: boolean }> {
    return (await this.send('account/read', {
      refreshToken: false,
    })) as { account: AccountInfo; requiresOpenaiAuth: boolean };
  }

  // ── Config APIs ────────────────────────────────────────────

  async readConfig(): Promise<unknown> {
    return await this.send('config/read', { includeLayers: false });
  }

  // ── Skills APIs ────────────────────────────────────────────

  async listSkills(cwds: string[]): Promise<unknown> {
    return await this.send('skills/list', { cwds, forceReload: true });
  }

  // ── MCP APIs ───────────────────────────────────────────────

  async listMcpServers(): Promise<unknown> {
    return await this.send('mcpServerStatus/list', { cursor: null, limit: 50 });
  }

  // ── Fork ────────────────────────────────────────────────────

  async forkThread(threadId: string, opts?: { ephemeral?: boolean; model?: string }): Promise<ThreadDetail> {
    const result = (await this.send('thread/fork', {
      threadId,
      ...(opts?.ephemeral ? { ephemeral: true } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
    })) as { thread: ThreadDetail };
    return result.thread;
  }

  // ── Thread Compaction ──────────────────────────────────────

  async startThreadCompaction(threadId: string): Promise<void> {
    await this.send('thread/compact/start', { threadId });
  }

  // ── Shell Command ──────────────────────────────────────────

  async runShellCommand(threadId: string, command: string): Promise<void> {
    await this.send('thread/shellCommand', { threadId, command });
  }

  // ── Turn Steer ─────────────────────────────────────────────

  async steerTurn(threadId: string, text: string, expectedTurnId: string): Promise<void> {
    await this.send('turn/steer', {
      threadId,
      input: createTextInput(text),
      expectedTurnId,
    });
  }

  // ── Config Write ───────────────────────────────────────────

  async writeConfigValue(
    keyPath: string,
    value: unknown,
    mergeStrategy: 'replace' | 'upsert' = 'replace',
  ): Promise<void> {
    await this.send('config/value/write', { keyPath, value, mergeStrategy });
  }

  async batchWriteConfig(
    edits: Array<{ keyPath: string; value: unknown; mergeStrategy?: 'replace' | 'upsert' }>,
    reloadUserConfig = true,
  ): Promise<void> {
    await this.send('config/batchWrite', {
      edits: edits.map((edit) => ({
        keyPath: edit.keyPath,
        value: edit.value,
        mergeStrategy: edit.mergeStrategy ?? 'replace',
      })),
      reloadUserConfig,
    });
  }

  // ── Thread Metadata ────────────────────────────────────────

  async updateThreadMetadata(threadId: string, gitInfo?: { branch?: string; sha?: string; originUrl?: string }): Promise<void> {
    await this.send('thread/metadata/update', {
      threadId,
      ...(gitInfo ? { gitInfo } : {}),
    });
  }

  // ── Raw send (for debug) ───────────────────────────────────

  async sendRaw(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return await this.send(method, params);
  }
}

export const codexClient = new CodexClient();
