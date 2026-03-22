/**
 * Pure helpers to mutate `ThreadDetail` for live UI: Codex pushes JSON-RPC-style `method` + `params` events;
 * `applyServerEventToThreadDetail` folds them into turns/items (including optimistic IDs and streaming deltas).
 */
import type { ThreadDetail, ThreadItem, Turn } from '@whats-coder/shared';

const OPTIMISTIC_TURN_PREFIX = 'optimistic-turn-';
const OPTIMISTIC_ITEM_PREFIX = 'optimistic-';
const REALTIME_TURN_PREFIX = 'realtime-thread-';
const THREAD_HOOK_TURN_PREFIX = 'hook-thread-';
const CLAUDE_TURN_PREFIX = 'claude-turn-';

type Params = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cloneItem(item: ThreadItem): ThreadItem {
  const content = Array.isArray(item.content)
    ? item.content.every((entry) => typeof entry === 'string')
      ? [...item.content]
      : item.content.map((entry) => (isRecord(entry) ? { ...entry } : entry))
    : item.content;

  return {
    ...item,
    changes: item.changes ? item.changes.map((change) => ({ ...change })) : item.changes,
    progressMessages: item.progressMessages ? [...item.progressMessages] : item.progressMessages,
    content,
    contentItems: item.contentItems ? item.contentItems.map((entry) => ({ ...entry })) : item.contentItems,
  };
}

function cloneTurn(turn: Turn): Turn {
  return {
    ...turn,
    items: (turn.items ?? []).map(cloneItem),
    error: turn.error ? { ...turn.error } : turn.error,
  };
}

function cloneTurnShell(turn: Turn): Turn {
  return {
    ...turn,
    items: [...(turn.items ?? [])],
    error: turn.error ? { ...turn.error } : turn.error,
  };
}

function cloneThread(thread: ThreadDetail): ThreadDetail {
  return {
    ...thread,
    turns: (thread.turns ?? []).map(cloneTurn),
  };
}

function isSyntheticTurnId(turnId: string): boolean {
  return (
    turnId.startsWith(REALTIME_TURN_PREFIX) ||
    turnId.startsWith(THREAD_HOOK_TURN_PREFIX) ||
    turnId.startsWith(CLAUDE_TURN_PREFIX)
  );
}

function isSyntheticItem(item: ThreadItem): boolean {
  return (
    item.type === 'hook' ||
    item.type === 'rawResponseItem' ||
    item.type === 'realtimeAudio' ||
    item.type === 'contextCompaction' ||
    item.id.startsWith('turn-diff-') ||
    item.id.startsWith('turn-plan-') ||
    item.id.startsWith('raw-response-') ||
    item.id.startsWith('realtime-') ||
    item.id.startsWith('hook-')
  );
}

function normalizeItem(value: unknown): ThreadItem | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.type !== 'string') {
    return null;
  }
  return value as ThreadItem;
}

function normalizeTurn(value: unknown): Turn | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  return {
    id: value.id,
    status: (typeof value.status === 'string' ? value.status : 'inProgress') as Turn['status'],
    items: Array.isArray(value.items)
      ? value.items.map(normalizeItem).filter((item): item is ThreadItem => item != null)
      : [],
    error: isRecord(value.error) ? (value.error as Turn['error']) : null,
  };
}

function mergeTurn(existing: Turn | undefined, incoming: Turn): Turn {
  return {
    id: incoming.id,
    status: incoming.status ?? existing?.status ?? 'inProgress',
    items: incoming.items.length > 0 ? incoming.items.map(cloneItem) : existing?.items ?? [],
    error: incoming.error ?? existing?.error ?? null,
  };
}

function ensureTurn(turns: Turn[], turnId: string): number {
  const existingIndex = turns.findIndex((turn) => turn.id === turnId);
  if (existingIndex >= 0) {
    return existingIndex;
  }

  const optimisticIndex = turns.findIndex(
    (turn) => turn.id.startsWith(OPTIMISTIC_TURN_PREFIX) && turn.status === 'inProgress',
  );

  if (optimisticIndex >= 0) {
    turns[optimisticIndex] = {
      ...cloneTurnShell(turns[optimisticIndex]),
      id: turnId,
    };
    return optimisticIndex;
  }

  turns.push({
    id: turnId,
    status: 'inProgress',
    items: [],
    error: null,
  });
  return turns.length - 1;
}

function cloneTurnForWrite(turns: Turn[], turnIndex: number): Turn {
  const nextTurn = cloneTurnShell(turns[turnIndex]);
  turns[turnIndex] = nextTurn;
  return nextTurn;
}

function replaceOptimisticUserItem(items: ThreadItem[], incoming: ThreadItem): boolean {
  if (incoming.type !== 'userMessage') {
    return false;
  }

  const optimisticIndex = items.findIndex(
    (item) => item.type === 'userMessage' && item.id.startsWith(OPTIMISTIC_ITEM_PREFIX),
  );

  if (optimisticIndex < 0) {
    return false;
  }

  items[optimisticIndex] = cloneItem(incoming);
  return true;
}

function upsertItem(turns: Turn[], turnId: string, incoming: ThreadItem) {
  const turnIndex = ensureTurn(turns, turnId);
  const turn = cloneTurnForWrite(turns, turnIndex);
  const items = turn.items ?? [];
  const existingIndex = items.findIndex((item) => item.id === incoming.id);

  if (existingIndex >= 0) {
    items[existingIndex] = cloneItem({ ...items[existingIndex], ...incoming });
    return;
  }

  if (replaceOptimisticUserItem(items, incoming)) {
    return;
  }

  items.push(cloneItem(incoming));
}

function updateItem(
  turns: Turn[],
  turnId: string,
  itemId: string,
  updater: (item: ThreadItem) => ThreadItem,
  fallbackFactory: () => ThreadItem,
) {
  const turnIndex = ensureTurn(turns, turnId);
  const turn = cloneTurnForWrite(turns, turnIndex);
  const items = turn.items ?? [];
  const itemIndex = items.findIndex((item) => item.id === itemId);

  if (itemIndex >= 0) {
    items[itemIndex] = updater(items[itemIndex]);
    return;
  }

  items.push(updater(fallbackFactory()));
}

function appendText(value: string | undefined, delta: string): string {
  return `${value ?? ''}${delta}`;
}

function appendTerminalInput(value: string | null | undefined, stdin: string): string {
  const prefix = value && value.length > 0 ? `${value}\n` : '';
  return `${prefix}> ${stdin}`;
}

function appendIndexedText(list: string[] | undefined, index: number, delta: string): string[] {
  const next = Array.isArray(list) ? [...list] : [];
  while (next.length <= index) {
    next.push('');
  }
  next[index] = `${next[index] ?? ''}${delta}`;
  return next;
}

function stringifyUnknown(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getRealtimeTurnId(threadId: string): string {
  return `${REALTIME_TURN_PREFIX}${threadId}`;
}

function toOptionalRealtimeId(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function setTurnState(
  turns: Turn[],
  turnId: string,
  updater: (turn: Turn) => Turn,
) {
  const turnIndex = ensureTurn(turns, turnId);
  const turn = cloneTurnForWrite(turns, turnIndex);
  turns[turnIndex] = updater(turn);
}

function toRealtimeMessageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((entry) => {
      if (!isRecord(entry)) {
        return '';
      }

      if (typeof entry.text === 'string' && entry.text.trim()) {
        return entry.text.trim();
      }

      if (typeof entry.transcript === 'string' && entry.transcript.trim()) {
        return entry.transcript.trim();
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeRealtimeItem(item: Record<string, unknown>): string {
  const type = typeof item.type === 'string' ? item.type : 'event';

  if (type === 'response.cancelled') {
    const responseId = toOptionalRealtimeId(item, ['response_id', 'responseId']);
    return responseId ? `Response cancelled (${responseId})` : 'Response cancelled';
  }

  if (type === 'input_audio_buffer.speech_started') {
    const itemId = toOptionalRealtimeId(item, ['item_id', 'itemId']);
    return itemId ? `Input speech detected (${itemId})` : 'Input speech detected';
  }

  if (type === 'handoff_request') {
    const transcript =
      typeof item.input_transcript === 'string'
        ? item.input_transcript
        : typeof item.active_transcript === 'string'
        ? item.active_transcript
        : '';
    const handoffId = toOptionalRealtimeId(item, ['handoff_id', 'handoffId']);
    if (transcript) {
      return handoffId ? `Handoff requested (${handoffId}): ${transcript}` : `Handoff requested: ${transcript}`;
    }
    return handoffId ? `Handoff requested (${handoffId})` : 'Handoff requested';
  }

  const text = toRealtimeMessageText(item.content);
  if (text) {
    return text;
  }

  return stringifyUnknown(item);
}

function toRealtimeItem(
  threadId: string,
  itemValue: unknown,
): ThreadItem {
  if (!isRecord(itemValue)) {
    return {
      type: 'rawResponseItem',
      id: `realtime-item-${threadId}-${Date.now()}`,
      tool: 'realtime:event',
      status: 'completed',
      result: {
        structuredContent: itemValue,
      },
      text: stringifyUnknown(itemValue),
    };
  }

  const rawType = typeof itemValue.type === 'string' ? itemValue.type : 'event';
  const rawId =
    toOptionalRealtimeId(itemValue, ['id', 'item_id', 'itemId', 'response_id', 'responseId', 'handoff_id', 'handoffId'])
    ?? `${rawType}-${Date.now()}`;
  const itemId = `realtime-${rawId}`;
  const role = typeof itemValue.role === 'string' ? itemValue.role : null;
  const messageText = toRealtimeMessageText(itemValue.content);

  if (rawType === 'message' && messageText) {
    if (role === 'user') {
      return {
        type: 'userMessage',
        id: itemId,
        content: [messageText],
      };
    }

    return {
      type: 'agentMessage',
      id: itemId,
      text: messageText,
    };
  }

  return {
    type: 'rawResponseItem',
    id: itemId,
    tool: `realtime:${rawType}`,
    status: 'completed',
    result: {
      structuredContent: itemValue,
    },
    text: summarizeRealtimeItem(itemValue),
  };
}

function estimateBase64Bytes(data: string): number {
  if (!data) {
    return 0;
  }

  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function formatRealtimeAudioChunkSummary(index: number, audio: {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number | null;
}) {
  const sampleText =
    typeof audio.samplesPerChannel === 'number'
      ? `${audio.samplesPerChannel} samples/ch`
      : 'samples/ch unknown';
  return `Chunk ${index}: ${audio.sampleRate} Hz / ${audio.numChannels} ch / ${sampleText} / ${estimateBase64Bytes(audio.data)} bytes`;
}

function toHookItem(run: Record<string, unknown>) {
  const entries = Array.isArray(run.entries)
    ? run.entries
        .filter(isRecord)
        .map((entry) => {
          const kind = typeof entry.kind === 'string' ? entry.kind : 'output';
          const text = typeof entry.text === 'string' ? entry.text : '';
          return text ? `[${kind}] ${text}` : null;
        })
        .filter((entry): entry is string => entry != null)
    : [];

  return {
    type: 'hook' as const,
    id: typeof run.id === 'string' ? `hook-${run.id}` : `hook-${Date.now()}`,
    tool: `hook:${typeof run.eventName === 'string' ? run.eventName : 'unknown'}`,
    status: typeof run.status === 'string' ? run.status : undefined,
    arguments: {
      eventName: typeof run.eventName === 'string' ? run.eventName : null,
      handlerType: typeof run.handlerType === 'string' ? run.handlerType : null,
      executionMode: typeof run.executionMode === 'string' ? run.executionMode : null,
      scope: typeof run.scope === 'string' ? run.scope : null,
      sourcePath: typeof run.sourcePath === 'string' ? run.sourcePath : null,
    },
    progressMessages: entries.length > 0 ? entries : undefined,
    error:
      typeof run.status === 'string' && (run.status === 'failed' || run.status === 'blocked' || run.status === 'stopped')
        ? { message: typeof run.statusMessage === 'string' && run.statusMessage ? run.statusMessage : `Hook ${run.status}` }
        : null,
  };
}

function formatPlanText(explanation: unknown, plan: unknown): string {
  const parts: string[] = [];

  if (typeof explanation === 'string' && explanation.trim()) {
    parts.push(explanation.trim());
  }

  if (Array.isArray(plan) && plan.length > 0) {
    const steps = plan
      .map((step, index) => {
        if (!isRecord(step)) {
          return null;
        }

        const rawStep = typeof step.step === 'string' ? step.step.trim() : '';
        const rawStatus = typeof step.status === 'string' ? step.status.trim() : '';
        if (!rawStep) {
          return null;
        }

        return `${index + 1}. ${rawStep}${rawStatus ? ` (${rawStatus})` : ''}`;
      })
      .filter((entry): entry is string => entry != null);

    if (steps.length > 0) {
      parts.push(steps.join('\n'));
    }
  }

  return parts.join('\n\n');
}

export function findThreadItem(
  thread: ThreadDetail | null,
  turnId: string | undefined,
  itemId: string | undefined,
): ThreadItem | null {
  if (!thread || !turnId || !itemId) {
    return null;
  }

  const turn = thread.turns?.find((entry) => entry.id === turnId);
  return turn?.items.find((item) => item.id === itemId) ?? null;
}

/**
 * Reconciles a server snapshot with client-only rows (realtime, hooks, errors) the backend does not round-trip.
 */
export function mergeThreadDetailWithLocalState(
  previous: ThreadDetail | null,
  incoming: ThreadDetail,
): ThreadDetail {
  if (!previous?.turns?.length) {
    return cloneThread(incoming);
  }

  const merged = cloneThread(incoming);
  const incomingTurns = merged.turns ?? [];
  const incomingTurnMap = new Map(incomingTurns.map((turn) => [turn.id, turn]));

  for (const previousTurn of previous.turns ?? []) {
    const existingTurn = incomingTurnMap.get(previousTurn.id);
    if (!existingTurn) {
      if (isSyntheticTurnId(previousTurn.id)) {
        incomingTurns.push(cloneTurn(previousTurn));
      }
      continue;
    }

    const existingIds = new Set(existingTurn.items.map((item) => item.id));
    const syntheticItems = previousTurn.items
      .filter((item) => isSyntheticItem(item) && !existingIds.has(item.id))
      .map(cloneItem);

    if (syntheticItems.length > 0) {
      existingTurn.items = [...existingTurn.items, ...syntheticItems];
    }

    if (!existingTurn.error && previousTurn.error && isSyntheticTurnId(previousTurn.id)) {
      existingTurn.error = { ...previousTurn.error };
      existingTurn.status = previousTurn.status;
    }
  }

  merged.turns = incomingTurns;
  return merged;
}

/**
 * Returns a shallow-copied thread with updated `turns`; unknown `method` values are no-ops (returns the same structure).
 */
export function applyServerEventToThreadDetail(
  thread: ThreadDetail | null,
  method: string,
  params: Params,
): ThreadDetail | null {
  if (!thread) {
    return thread;
  }

  const turns = [...(thread.turns ?? [])];
  const next: ThreadDetail = {
    ...thread,
    turns,
  };

  if (method === 'thread/started' && isRecord(params.thread)) {
    const startedThread = params.thread as Partial<ThreadDetail>;
    return {
      ...next,
      ...startedThread,
      turns:
        Array.isArray(startedThread.turns) && startedThread.turns.length > 0
          ? startedThread.turns.map((turn) => cloneTurn(turn as Turn))
          : next.turns,
    };
  }

  if (method === 'thread/status/changed') {
    if (isRecord(params.status)) {
      next.status = params.status as ThreadDetail['status'];
    }
    return next;
  }

  if (method === 'thread/name/updated') {
    next.name = typeof params.threadName === 'string' ? params.threadName : null;
    return next;
  }

  if (method === 'thread/realtime/started') {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    if (!threadId) {
      return next;
    }

    setTurnState(turns, getRealtimeTurnId(threadId), (turn) => ({
      ...turn,
      status: 'inProgress',
      error: null,
    }));
    return next;
  }

  if ((method === 'turn/started' || method === 'turn/completed') && params.turn) {
    const incomingTurn = normalizeTurn(params.turn);
    if (!incomingTurn) {
      return next;
    }

    const existingIndex = turns.findIndex((turn) => turn.id === incomingTurn.id);
    if (existingIndex >= 0) {
      turns[existingIndex] = mergeTurn(turns[existingIndex], incomingTurn);
    } else {
      const optimisticIndex = turns.findIndex((turn) => turn.id.startsWith(OPTIMISTIC_TURN_PREFIX));
      if (optimisticIndex >= 0) {
        turns[optimisticIndex] = mergeTurn(turns[optimisticIndex], incomingTurn);
      } else {
        turns.push(mergeTurn(undefined, incomingTurn));
      }
    }
    return next;
  }

  if (method === 'error') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const error = isRecord(params.error) ? params.error : null;
    if (!turnId || !error || typeof error.message !== 'string') {
      return next;
    }

    const turnIndex = ensureTurn(turns, turnId);
    turns[turnIndex] = {
      ...turns[turnIndex],
      status: turns[turnIndex].status === 'completed' ? 'completed' : 'failed',
      error: {
        message: error.message,
        codexErrorInfo: isRecord(error.codexErrorInfo) ? error.codexErrorInfo : null,
        additionalDetails: typeof error.additionalDetails === 'string' ? error.additionalDetails : null,
      },
    };
    return next;
  }

  if (method === 'thread/realtime/error') {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const message = typeof params.message === 'string' ? params.message : null;
    if (!threadId || !message) {
      return next;
    }

    setTurnState(turns, getRealtimeTurnId(threadId), (turn) => ({
      ...turn,
      status: 'failed',
      error: {
        message,
      },
    }));
    return next;
  }

  if (method === 'thread/realtime/closed') {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    if (!threadId) {
      return next;
    }

    setTurnState(turns, getRealtimeTurnId(threadId), (turn) => ({
      ...turn,
      status: turn.status === 'failed' ? 'failed' : 'completed',
    }));
    return next;
  }

  if ((method === 'hook/started' || method === 'hook/completed') && isRecord(params.run)) {
    const threadScopedTurnId =
      typeof params.turnId === 'string'
        ? params.turnId
        : typeof params.threadId === 'string'
        ? `hook-thread-${params.threadId}`
        : null;
    if (!threadScopedTurnId) {
      return next;
    }

    upsertItem(turns, threadScopedTurnId, toHookItem(params.run));
    return next;
  }

  if ((method === 'item/started' || method === 'item/completed') && params.item) {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const incomingItem = normalizeItem(params.item);
    if (!turnId || !incomingItem) {
      return next;
    }
    upsertItem(turns, turnId, incomingItem);
    return next;
  }

  if (method === 'thread/realtime/itemAdded') {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    if (!threadId || !('item' in params)) {
      return next;
    }

    upsertItem(turns, getRealtimeTurnId(threadId), toRealtimeItem(threadId, params.item));
    return next;
  }

  if (method === 'thread/realtime/outputAudio/delta') {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const audio = isRecord(params.audio) ? params.audio : null;
    const audioData = typeof audio?.data === 'string' ? audio.data : null;
    const sampleRate = typeof audio?.sampleRate === 'number' ? audio.sampleRate : null;
    const numChannels = typeof audio?.numChannels === 'number' ? audio.numChannels : null;
    const samplesPerChannel = typeof audio?.samplesPerChannel === 'number' ? audio.samplesPerChannel : null;
    const audioItemId = typeof audio?.itemId === 'string' && audio.itemId.trim() ? audio.itemId.trim() : null;
    if (
      !threadId ||
      !audioData ||
      sampleRate == null ||
      numChannels == null
    ) {
      return next;
    }

    const itemId = audioItemId ? `realtime-audio-${audioItemId}` : `realtime-audio-${threadId}`;

    updateItem(
      turns,
      getRealtimeTurnId(threadId),
      itemId,
      (item) => {
        const structured =
          isRecord(item.result?.structuredContent) ? item.result.structuredContent : {};
        const totalChunks = typeof structured.totalChunks === 'number' ? structured.totalChunks + 1 : 1;
        const totalBytes =
          typeof structured.totalBytes === 'number'
            ? structured.totalBytes + estimateBase64Bytes(audioData)
            : estimateBase64Bytes(audioData);

        return {
          ...item,
          type: 'realtimeAudio',
          status: 'streaming',
          text: `Streaming audio / ${totalChunks} chunk${totalChunks === 1 ? '' : 's'} / ${sampleRate} Hz / ${numChannels} ch`,
          progressMessages: [
            ...(item.progressMessages ?? []),
            formatRealtimeAudioChunkSummary(totalChunks, {
              data: audioData,
              sampleRate,
              numChannels,
              samplesPerChannel,
            }),
          ],
          result: {
            structuredContent: {
              itemId: audioItemId,
              sampleRate,
              numChannels,
              samplesPerChannel,
              totalChunks,
              totalBytes,
              lastChunkBytes: estimateBase64Bytes(audioData),
              lastChunkBase64Length: audioData.length,
            },
          },
        };
      },
      () => ({
        type: 'realtimeAudio',
        id: itemId,
        status: 'streaming',
        text: '',
        progressMessages: [],
        result: {
          structuredContent: null,
        },
      }),
    );
    return next;
  }

  if (method === 'item/agentMessage/delta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!turnId || !itemId || !delta) {
      return next;
    }

    updateItem(
      turns,
      turnId,
      itemId,
      (item) => ({
        ...item,
        type: 'agentMessage',
        text: appendText(item.text, delta),
      }),
      () => ({
        type: 'agentMessage',
        id: itemId,
        text: '',
      }),
    );
    return next;
  }

  if (method === 'item/reasoning/summaryPartAdded') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    const summaryIndex = typeof params.summaryIndex === 'number' ? params.summaryIndex : 0;
    if (!turnId || !itemId) {
      return next;
    }

    updateItem(
      turns,
      turnId,
      itemId,
      (item) => ({
        ...item,
        type: 'reasoning',
        summary: appendIndexedText(
          Array.isArray(item.summary) ? item.summary : [],
          summaryIndex,
          '',
        ),
      }),
      () => ({
        type: 'reasoning',
        id: itemId,
        summary: [],
        content: [],
      }),
    );
    return next;
  }

  if (method === 'item/reasoning/summaryTextDelta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    const summaryIndex = typeof params.summaryIndex === 'number' ? params.summaryIndex : 0;
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!turnId || !itemId || !delta) {
      return next;
    }

    updateItem(
      turns,
      turnId,
      itemId,
      (item) => ({
        ...item,
        type: 'reasoning',
        summary: appendIndexedText(
          Array.isArray(item.summary) ? item.summary : [],
          summaryIndex,
          delta,
        ),
      }),
      () => ({
        type: 'reasoning',
        id: itemId,
        summary: [],
        content: [],
      }),
    );
    return next;
  }

  if (method === 'item/reasoning/textDelta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    const contentIndex = typeof params.contentIndex === 'number' ? params.contentIndex : 0;
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!turnId || !itemId || !delta) {
      return next;
    }

    updateItem(
      turns,
      turnId,
      itemId,
      (item) => ({
        ...item,
        type: 'reasoning',
        content: appendIndexedText(
          Array.isArray(item.content)
            ? item.content.filter((entry): entry is string => typeof entry === 'string')
            : [],
          contentIndex,
          delta,
        ),
      }),
      () => ({
        type: 'reasoning',
        id: itemId,
        summary: [],
        content: [],
      }),
    );
    return next;
  }

  if (method === 'item/commandExecution/outputDelta' || method === 'command/exec/outputDelta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!turnId || !itemId || !delta) {
      return next;
    }

    updateItem(
      turns,
      turnId,
      itemId,
      (item) => ({
        ...item,
        type: 'commandExecution',
        aggregatedOutput: appendText(item.aggregatedOutput ?? undefined, delta),
      }),
      () => ({
        type: 'commandExecution',
        id: itemId,
        aggregatedOutput: '',
      }),
    );
    return next;
  }

  if (method === 'item/commandExecution/terminalInteraction') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    const stdin = typeof params.stdin === 'string' ? params.stdin : '';
    if (!turnId || !itemId || !stdin) {
      return next;
    }

    updateItem(
      turns,
      turnId,
      itemId,
      (item) => ({
        ...item,
        type: 'commandExecution',
        stdin,
        aggregatedOutput: appendTerminalInput(item.aggregatedOutput, stdin),
      }),
      () => ({
        type: 'commandExecution',
        id: itemId,
        stdin,
        aggregatedOutput: appendTerminalInput(undefined, stdin),
      }),
    );
    return next;
  }

  if (method === 'item/fileChange/outputDelta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!turnId || !itemId || !delta) {
      return next;
    }

    updateItem(
      turns,
      turnId,
      itemId,
      (item) => ({
        ...item,
        type: 'fileChange',
        aggregatedOutput: appendText(item.aggregatedOutput ?? undefined, delta),
      }),
      () => ({
        type: 'fileChange',
        id: itemId,
        aggregatedOutput: '',
      }),
    );
    return next;
  }

  if (method === 'item/mcpToolCall/progress') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    const message = typeof params.message === 'string' ? params.message : '';
    if (!turnId || !itemId || !message) {
      return next;
    }

    updateItem(
      turns,
      turnId,
      itemId,
      (item) => ({
        ...item,
        type: 'mcpToolCall',
        progressMessages: [...(item.progressMessages ?? []), message],
      }),
      () => ({
        type: 'mcpToolCall',
        id: itemId,
        progressMessages: [message],
      }),
    );
    return next;
  }

  if (method === 'item/plan/delta') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
    const delta = typeof params.delta === 'string' ? params.delta : '';
    if (!turnId || !itemId || !delta) {
      return next;
    }

    updateItem(
      turns,
      turnId,
      itemId,
      (item) => ({
        ...item,
        type: 'plan',
        text: appendText(item.text, delta),
      }),
      () => ({
        type: 'plan',
        id: itemId,
        text: '',
      }),
    );
    return next;
  }

  if (method === 'turn/plan/updated') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    if (!turnId) {
      return next;
    }

    upsertItem(turns, turnId, {
      type: 'plan',
      id: `turn-plan-${turnId}`,
      text: formatPlanText(params.explanation, params.plan),
    });
    return next;
  }

  if (method === 'turn/diff/updated') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const diff = typeof params.diff === 'string' ? params.diff : '';
    if (!turnId || !diff) {
      return next;
    }

    upsertItem(turns, turnId, {
      type: 'fileChange',
      id: `turn-diff-${turnId}`,
      status: 'completed',
      changes: [
        {
          path: '(turn diff)',
          kind: 'modify',
          diff,
        },
      ],
      aggregatedOutput: diff,
    });
    return next;
  }

  if (method === 'rawResponseItem/completed') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    if (!turnId || !('item' in params)) {
      return next;
    }

    const itemValue = params.item;
    const rawId =
      isRecord(itemValue) && typeof itemValue.id === 'string'
        ? `raw-response-${itemValue.id}`
        : `raw-response-${turnId}-${Date.now()}`;

    upsertItem(turns, turnId, {
      type: 'rawResponseItem',
      id: rawId,
      result: {
        structuredContent: itemValue,
      },
      text: stringifyUnknown(itemValue),
    });
    return next;
  }

  if (method === 'thread/compacted') {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const itemId = typeof params.itemId === 'string' ? params.itemId : `context-compaction-${Date.now()}`;
    if (!turnId) {
      return next;
    }

    upsertItem(turns, turnId, {
      type: 'contextCompaction',
      id: itemId,
    });
    return next;
  }

  return next;
}
