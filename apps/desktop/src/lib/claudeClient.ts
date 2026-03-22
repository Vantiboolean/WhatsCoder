/**
 * Bridges the UI to the Claude Code CLI path in Tauri: `invoke('claude_send_message')` starts a run; the Rust side
 * emits `claude-stream-chunk` / `claude-stream-done` / `claude-stream-error` so text and usage arrive incrementally.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ThreadSummary,
  ThreadDetail,
  Turn,
  ModelInfo,
} from '@whats-coder/shared';
import {
  createClaudeSession,
  listClaudeSessions,
  getClaudeSession,
  updateClaudeSession,
  deleteClaudeSession,
  addClaudeMessage,
  getClaudeMessages,
  getChatConfig,
  saveChatConfig,
  type ClaudeSessionRow,
  type ClaudeMessageRow,
} from './db';

interface StreamChunkPayload {
  session_id: string;
  event_type: string;
  data: string;
}

interface StreamDonePayload {
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
  stop_reason: string;
  claude_session_id?: string | null;
}

interface StreamErrorPayload {
  session_id: string;
  error: string;
}

export type ClaudeStreamCallback = {
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onError?: (error: string) => void;
  onDone?: (usage: { inputTokens: number; outputTokens: number; model: string; stopReason: string }) => void;
};

const CLAUDE_DEFAULT_MODEL_ID = 'claude-default';

const LEGACY_CLAUDE_MODEL_ID_MAP: Record<string, string> = {
  sonnet: CLAUDE_DEFAULT_MODEL_ID,
  opus: 'claude-opus',
  haiku: 'claude-haiku',
  'claude-sonnet-4-20250514': CLAUDE_DEFAULT_MODEL_ID,
  'claude-opus-4-20250514': 'claude-opus',
  'claude-haiku-4-5-20251001': 'claude-haiku',
  'claude-sonnet-4-0': 'claude-sonnet-4',
};

const CLAUDE_MODELS: ModelInfo[] = [
  { id: CLAUDE_DEFAULT_MODEL_ID, displayName: 'Default(recommended)', isDefault: true },
  { id: 'claude-sonnet-1m', displayName: 'Sonnet(1M context)', isDefault: false },
  { id: 'claude-opus', displayName: 'Opus', isDefault: false },
  { id: 'claude-opus-1m', displayName: 'Opus(1M context)', isDefault: false },
  { id: 'claude-haiku', displayName: 'Haiku', isDefault: false },
  { id: 'claude-sonnet-4', displayName: 'Sonnet 4', isDefault: false },
];

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeClaudeModelId(modelId?: string | null): string {
  if (!modelId) {
    return CLAUDE_DEFAULT_MODEL_ID;
  }
  return LEGACY_CLAUDE_MODEL_ID_MAP[modelId] ?? modelId;
}

export function isClaudeModelId(modelId?: string | null): boolean {
  if (!modelId) {
    return false;
  }
  const normalizedId = normalizeClaudeModelId(modelId);
  return CLAUDE_MODELS.some((model) => model.id === normalizedId);
}

export class ClaudeClient {
  private unlistenChunk: UnlistenFn | null = null;
  private unlistenDone: UnlistenFn | null = null;
  private unlistenError: UnlistenFn | null = null;
  private activeSessionId: string | null = null;

  /** Drops listeners so a new `sendMessage` does not stack duplicate handlers on the global event channels. */
  async dispose(): Promise<void> {
    this.unlistenChunk?.();
    this.unlistenDone?.();
    this.unlistenError?.();
    this.unlistenChunk = null;
    this.unlistenDone = null;
    this.unlistenError = null;
  }

  listModels(): ModelInfo[] {
    return CLAUDE_MODELS;
  }

  getDefaultModel(): string {
    return CLAUDE_MODELS.find((model) => model.isDefault)?.id ?? CLAUDE_MODELS[0].id;
  }

  async createSession(opts?: {
    title?: string;
    model?: string;
    workingDirectory?: string;
  }): Promise<string> {
    const id = generateId();
    await createClaudeSession({
      id,
      title: opts?.title,
      model: normalizeClaudeModelId(opts?.model ?? this.getDefaultModel()),
      workingDirectory: opts?.workingDirectory,
    });
    return id;
  }

  async listSessions(): Promise<ThreadSummary[]> {
    const sessions = await listClaudeSessions();
    return sessions.map(sessionToThreadSummary);
  }

  async getSession(id: string): Promise<ThreadDetail | null> {
    const session = await getClaudeSession(id);
    if (!session) return null;
    const messages = await getClaudeMessages(id);
    return sessionToThreadDetail(session, messages);
  }

  async renameSession(id: string, title: string): Promise<void> {
    await updateClaudeSession(id, { title });
  }

  async archiveSession(id: string): Promise<void> {
    await updateClaudeSession(id, { isArchived: true });
  }

  async removeSession(id: string): Promise<void> {
    await deleteClaudeSession(id);
  }

  async sendMessage(
    sessionId: string,
    text: string,
    opts?: { model?: string },
    callbacks?: ClaudeStreamCallback,
  ): Promise<void> {
    const session = await getClaudeSession(sessionId);
    if (!session) {
      callbacks?.onError?.('Session not found');
      return;
    }

    const selectedModelId = normalizeClaudeModelId(opts?.model ?? session.model ?? this.getDefaultModel());

    const userMsgId = generateId();
    await addClaudeMessage({
      id: userMsgId,
      sessionId,
      role: 'user',
      content: text,
    });

    const existingMessages = await getClaudeMessages(sessionId);
    const historyMessages = existingMessages.slice(0, -1).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    if (session.title === 'New Chat' && text.length > 0) {
      const title = text.slice(0, 60) + (text.length > 60 ? '...' : '');
      await updateClaudeSession(sessionId, { title });
    }

    this.activeSessionId = sessionId;
    let accumulatedText = '';

    await this.dispose();
    // Subscribe before invoke so we do not miss early chunks; filter by `session_id` because events are app-global.

    this.unlistenChunk = await listen<StreamChunkPayload>('claude-stream-chunk', (event) => {
      if (event.payload.session_id !== sessionId) return;
      if (event.payload.event_type === 'text') {
        accumulatedText += event.payload.data;
        callbacks?.onText?.(event.payload.data);
      } else if (event.payload.event_type === 'thinking') {
        callbacks?.onThinking?.(event.payload.data);
      } else if (event.payload.event_type === 'error') {
        callbacks?.onError?.(event.payload.data);
      }
    });

    this.unlistenDone = await listen<StreamDonePayload>('claude-stream-done', async (event) => {
      if (event.payload.session_id !== sessionId) return;
      this.activeSessionId = null;

      if (event.payload.claude_session_id) {
        await saveChatConfig({ thread_id: sessionId, claude_session_id: event.payload.claude_session_id });
      }

      if (accumulatedText) {
        const assistantMsgId = generateId();
        await addClaudeMessage({
          id: assistantMsgId,
          sessionId,
          role: 'assistant',
          content: accumulatedText,
          tokenUsage: {
            input_tokens: event.payload.input_tokens,
            output_tokens: event.payload.output_tokens,
          },
        });
      }

      callbacks?.onDone?.({
        inputTokens: event.payload.input_tokens,
        outputTokens: event.payload.output_tokens,
        model: event.payload.model,
        stopReason: event.payload.stop_reason,
      });
    });

    this.unlistenError = await listen<StreamErrorPayload>('claude-stream-error', (event) => {
      if (event.payload.session_id !== sessionId) return;
      this.activeSessionId = null;
      callbacks?.onError?.(event.payload.error);
    });

    try {
      // Missing chat_config rows are normal for brand-new sessions; proceed without a resumed CLI session id.
      const threadConfig = await getChatConfig(sessionId).catch(() => null);
      await invoke('claude_send_message', {
        config: {
          model: selectedModelId,
          prompt: text,
          history: historyMessages,
          system_prompt: session.system_prompt,
          session_id: sessionId,
          claude_session_id: threadConfig?.claude_session_id ?? null,
          working_directory: session.working_directory,
          permission_mode: 'acceptEdits',
          env: {},
        },
      });
    } catch (error) {
      this.activeSessionId = null;
      callbacks?.onError?.(String(error));
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeSessionId) return;
    try {
      await invoke('claude_interrupt');
    } catch {
      // best effort
    }
  }

  isStreaming(): boolean {
    return this.activeSessionId !== null;
  }
}

function sessionToThreadSummary(session: ClaudeSessionRow): ThreadSummary {
  return {
    id: session.id,
    preview: session.title,
    name: session.title,
    ephemeral: false,
    modelProvider: 'claude',
    cwd: session.working_directory ?? undefined,
    createdAt: session.created_at * 1000,
    updatedAt: session.updated_at * 1000,
  };
}

function sessionToThreadDetail(
  session: ClaudeSessionRow,
  messages: ClaudeMessageRow[],
): ThreadDetail {
  const turns: Turn[] = [];
  let currentTurn: Turn | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      if (currentTurn) {
        turns.push(currentTurn);
      }
      currentTurn = {
        id: `turn-${message.id}`,
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            id: message.id,
            content: [{ type: 'text', text: message.content }],
          },
        ],
      };
    } else if (message.role === 'assistant' && currentTurn) {
      currentTurn.items.push({
        type: 'agentMessage',
        id: message.id,
        text: message.content,
      });
    }
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return {
    id: session.id,
    preview: session.title,
    name: session.title,
    ephemeral: false,
    modelProvider: 'claude',
    cwd: session.working_directory ?? undefined,
    createdAt: session.created_at * 1000,
    updatedAt: session.updated_at * 1000,
    turns,
  };
}

let instance: ClaudeClient | null = null;

export function getClaudeClient(): ClaudeClient {
  if (!instance) {
    instance = new ClaudeClient();
  }
  return instance;
}
