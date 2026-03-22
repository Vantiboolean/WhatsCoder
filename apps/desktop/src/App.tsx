import { lazy, startTransition, Suspense, useState, useCallback, useRef, useEffect, useMemo, useDeferredValue } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CodexClient,
  type ConnectionState,
  type ThreadSummary,
  type ThreadDetail,
  type ThreadItem,
  type ThreadContinuation,
  type ModelInfo,
  type AccountInfo,
  type ApprovalDecision,
  type DynamicToolCallContentItem,
  type ChatgptAuthTokensRefreshReason,
  type ChatgptAuthTokensRefreshResponse,
} from '@codex-mobile/shared';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import {
  getChatConfig,
  saveChatConfig,
  getSettingJson,
  setSettingJson,
  addClaudeMessage,
  addChatMessage,
  getChatMessages,
  getAllChatHistory,
  searchChatHistory,
  listConnections,
  saveConnection,
  deleteConnection,
  setDefaultConnection,
  listAutomations,
  getAutomation,
  listRunningAutomationRuns,
  createAutomationRun,
  updateAutomationRun,
  updateAutomation,
  type ChatConfig,
  type AutomationExecutionState,
  type AutomationRow,
  type AutomationRunRow,
  type AutomationTriggerSource,
  type ChatHistoryEntry,
  type SavedConnectionRow,
} from './lib/db';
import { invoke } from '@tauri-apps/api/core';
import { automationRowToScheduleConfig, computeNextRun, computeRetryDelaySeconds } from './lib/automations';
import { DESKTOP_DYNAMIC_TOOL_SPECS, executeDesktopDynamicToolCall } from './lib/dynamicTools';
import { getClaudeClient, isClaudeModelId, normalizeClaudeModelId } from './lib/claudeClient';
import { applyServerEventToThreadDetail, findThreadItem, mergeThreadDetailWithLocalState } from './state/threadState';
import { CodeViewer, type OverlayView } from './components/CodeViewer';
import { ThreadSidebar } from './components/ThreadSidebar';
import { ThreadWorkspace } from './components/ThreadWorkspace';
import { ChatComposer, type ChatComposerHandle } from './components/ChatComposer';
import { ThreadToolbar } from './components/ThreadToolbar';
import type { RightSidebarTab } from './components/RightSidebar';
import { ProvidersPanel } from './components/ProvidersPanel';
import { UsagePanel } from './components/UsagePanel';
import { AutomationsPanel } from './components/AutomationsPanel';
import { KanbanPanel, type KanbanProject } from './components/KanbanPanel';
import {
  getKanbanLinkedThreadIds,
  listRunningKanbanIssueRuns,
  updateKanbanIssueExecution,
  updateKanbanIssueRun,
  type KanbanExecutionState,
} from './lib/kanbanDb';

type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh';
type ThemeMode = 'dark' | 'light' | 'system';
type StartAutomationThreadOptions = { revealThread?: boolean; toast?: boolean };
type ExecuteAutomationOptions = { revealThread?: boolean; toast?: boolean; triggerSource?: AutomationTriggerSource };
type StartAutomationThreadResult =
  | { ok: true; threadId: string }
  | { ok: false; error: string };
type ExecuteAutomationResult = StartAutomationThreadResult & { runId?: string };
type CarryoverMessage = { role: 'user' | 'assistant'; content: string };

const CROSS_PROVIDER_HISTORY_CHAR_LIMIT = 14_000;
const CROSS_PROVIDER_RECENT_MESSAGE_COUNT = 8;
const CROSS_PROVIDER_SUMMARY_MESSAGE_LIMIT = 12;
const CROSS_PROVIDER_MESSAGE_CHAR_LIMIT = 500;

function createClaudeMessageId(role: 'user' | 'assistant'): string {
  return `claude-msg-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function compactCarryoverText(text: string, maxChars = CROSS_PROVIDER_MESSAGE_CHAR_LIMIT): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function prepareCarryoverHistory(history: CarryoverMessage[]): {
  history: CarryoverMessage[];
  compacted: boolean;
  compactedMessages: number;
} {
  const normalized = history
    .map((message) => ({
      role: message.role,
      content: compactCarryoverText(message.content, 1_200),
    }))
    .filter((message) => message.content.length > 0);

  const totalChars = normalized.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars <= CROSS_PROVIDER_HISTORY_CHAR_LIMIT) {
    return { history: normalized, compacted: false, compactedMessages: 0 };
  }

  const recent = normalized.slice(-CROSS_PROVIDER_RECENT_MESSAGE_COUNT);
  const earlier = normalized.slice(0, Math.max(0, normalized.length - CROSS_PROVIDER_RECENT_MESSAGE_COUNT));
  const summaryLines = earlier
    .slice(-CROSS_PROVIDER_SUMMARY_MESSAGE_LIMIT)
    .map((message) => `- ${message.role === 'assistant' ? 'Assistant' : 'User'}: ${compactCarryoverText(message.content, 220)}`);

  const summary: CarryoverMessage = {
    role: 'assistant',
    content: [
      `Earlier conversation compacted from ${earlier.length} messages before switching model providers.`,
      'Key carryover points:',
      ...summaryLines,
    ].join('\n'),
  };

  return {
    history: [summary, ...recent],
    compacted: true,
    compactedMessages: earlier.length,
  };
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getLastKanbanThreadTurn(detail: ThreadDetail) {
  const turns = detail.turns;
  return turns && turns.length > 0 ? turns[turns.length - 1] : null;
}

function threadDetailToKanbanExecutionState(detail: ThreadDetail): KanbanExecutionState | null {
  const lastTurn = getLastKanbanThreadTurn(detail);
  if (!lastTurn) return null;
  switch (lastTurn.status) {
    case 'inProgress':
      return 'RUNNING';
    case 'completed':
      return 'SUCCESS';
    case 'failed':
      return 'FAILED';
    case 'interrupted':
      return 'CANCELLED';
    default:
      return null;
  }
}

function threadDetailToAutomationExecutionState(detail: ThreadDetail): AutomationExecutionState | null {
  const lastTurn = getLastKanbanThreadTurn(detail);
  if (!lastTurn) return null;
  switch (lastTurn.status) {
    case 'inProgress':
      return 'RUNNING';
    case 'completed':
      return 'SUCCESS';
    case 'failed':
    case 'interrupted':
      return 'FAILED';
    default:
      return null;
  }
}

function resolveAutomationNextScheduledRunAt(
  row: Pick<AutomationRow, 'next_scheduled_run_at'>,
  scheduleConfig: ReturnType<typeof automationRowToScheduleConfig>,
  baseUnixSeconds: number,
): number {
  if (row.next_scheduled_run_at && row.next_scheduled_run_at > baseUnixSeconds) {
    return row.next_scheduled_run_at;
  }
  return computeNextRun(scheduleConfig, new Date(baseUnixSeconds * 1000));
}

function compactKanbanSummary(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function threadItemTextForSummary(item: ThreadItem): string {
  if (typeof item.text === 'string' && item.text.trim()) {
    return compactKanbanSummary(item.text);
  }
  if (typeof item.summary === 'string' && item.summary.trim()) {
    return compactKanbanSummary(item.summary);
  }
  if (Array.isArray(item.summary) && item.summary.length > 0) {
    return compactKanbanSummary(item.summary.join(' '));
  }
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((entry) => typeof entry === 'string' ? entry : entry?.text ?? '')
      .join(' ')
      .trim();
    if (text) return compactKanbanSummary(text);
  }
  return '';
}

function extractKanbanRunResultSummary(detail: ThreadDetail): string | null {
  const turns = detail.turns ?? [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const items = turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex];
      if (item.type === 'agentMessage' && item.phase === 'final_answer') {
        const summary = threadItemTextForSummary(item);
        if (summary) return summary;
      }
    }
  }

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const items = turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex];
      if (item.type === 'agentMessage') {
        const summary = threadItemTextForSummary(item);
        if (summary) return summary;
      }
    }
  }

  return null;
}

function buildCarryoverTranscript(history: CarryoverMessage[]): string {
  return history
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n\n');
}

function buildCrossProviderCodexPrompt(text: string, history: CarryoverMessage[]): {
  prompt: string;
  compacted: boolean;
  compactedMessages: number;
} {
  const prepared = prepareCarryoverHistory(history);
  if (prepared.history.length === 0) {
    return { prompt: text, compacted: false, compactedMessages: 0 };
  }

  return {
    prompt: [
      'Continue this conversation seamlessly after a model-provider switch.',
      'Use the carryover context below as the prior chat state, then answer the latest user message directly.',
      '',
      '<carryover_context>',
      buildCarryoverTranscript(prepared.history),
      '</carryover_context>',
      '',
      '<latest_user_message>',
      text,
      '</latest_user_message>',
    ].join('\n'),
    compacted: prepared.compacted,
    compactedMessages: prepared.compactedMessages,
  };
}

type AutomationSchedulerEntry = {
  id: string;
  name: string;
  status: string;
  nextRunAt: number | null;
  backgroundNotify: boolean;
};
type AutomationDueEventPayload = {
  id: string;
  nextRunAt: number;
};

const REASONING_OPTIONS: Array<{ value: ReasoningLevel; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'X-High' },
];

const THREAD_DETAIL_CACHE_LIMIT = 12;

function isChatGptBackedAccount(account: AccountInfo): boolean {
  return account?.type === 'chatgpt' || account?.type === 'chatgptAuthTokens';
}

function isCodexClaudeModelId(modelId: string): boolean {
  return modelId.startsWith('claude.');
}

function isBlockedCodexModelForAccount(modelId: string, account: AccountInfo): boolean {
  return isChatGptBackedAccount(account) && isCodexClaudeModelId(modelId);
}

function filterCodexModelsForAccount(models: ModelInfo[], account: AccountInfo): ModelInfo[] {
  return models.filter((model) => !isBlockedCodexModelForAccount(model.id, account));
}

function pickPreferredCodexModel(models: ModelInfo[], preferredModel?: string | null): string {
  if (preferredModel && models.some((model) => model.id === preferredModel)) {
    return preferredModel;
  }

  return models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? '';
}

function getBlockedCodexModelMessage(modelId: string, fallbackModel?: string): string {
  return fallbackModel
    ? `Your ChatGPT account cannot use the Codex model "${modelId}". Switched to "${fallbackModel}" instead.`
    : `Your ChatGPT account cannot use the Codex model "${modelId}". Switch to a GPT model, or choose a Claude model that runs through your local Claude Code setup.`;
}

const appWindow = getCurrentWindow();
const LazyRightSidebar = lazy(async () => {
  const module = await import('./components/RightSidebar');
  return { default: module.RightSidebar };
});

function WindowControls({ className }: { className?: string }) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  return (
    <div className={`window-controls${className ? ` ${className}` : ''}`}>
      <button className="window-ctrl window-ctrl--minimize" onClick={() => appWindow.minimize()} title="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
      <button className="window-ctrl window-ctrl--maximize" onClick={() => appWindow.toggleMaximize()} title={isMaximized ? 'Restore' : 'Maximize'}>
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M2.5 2.5V1.5a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1h-1" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
        )}
      </button>
      <button className="window-ctrl window-ctrl--close" onClick={() => appWindow.close()} title="Close">
        <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" /><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
    </div>
  );
}

function RightSidebarFallback({ width }: { width: number }) {
  return (
    <aside className="right-sidebar" style={{ width }}>
      <div className="rs-resize-handle" />
      <div className="rs-content">
        <div className="fe-loading">Loading sidebar...</div>
      </div>
    </aside>
  );
}

function usePersistedState<T>(key: string, defaultValue: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    getSettingJson<T>(key, defaultValue).then(sqlVal => {
      const localRaw = localStorage.getItem(key);
      const localVal = localRaw ? JSON.parse(localRaw) : null;
      if (JSON.stringify(sqlVal) !== JSON.stringify(localVal) && JSON.stringify(sqlVal) !== JSON.stringify(defaultValue)) {
        setValue(sqlVal);
        try { localStorage.setItem(key, JSON.stringify(sqlVal)); } catch { /* ignore */ }
      }
    }).catch(() => {});
  }, [key]);

  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
    setSettingJson(key, v).catch(() => {});
  }, [key]);

  return [value, set];
}

function applyTheme(mode: ThemeMode) {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
  if (resolved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

type ApprovalRequest = {
  requestId: number;
  method: string;
  threadId: string;
  turnId: string;
  itemId?: string;
  toolName?: string;
  command?: string;
  description?: string;
  kind?: 'exec' | 'permissions' | 'applyPatch' | 'mcpElicitation';
  diff?: string;
  permissions?: string[];
  rawPermissions?: Record<string, unknown>;
  availableDecisions?: unknown[];
};

type UserInputQuestion = {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  allowOther?: boolean;
  isSecret?: boolean;
};

type UserInputRequest = {
  requestId: number;
  threadId: string;
  turnId: string;
  questions: UserInputQuestion[];
};

type McpElicitationOption = {
  value: string;
  label: string;
};

type McpElicitationField =
  | {
      kind: 'string';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      format?: 'email' | 'uri' | 'date' | 'date-time';
      defaultValue?: string;
      minLength?: number;
      maxLength?: number;
    }
  | {
      kind: 'number';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      integer: boolean;
      defaultValue?: number;
      minimum?: number;
      maximum?: number;
    }
  | {
      kind: 'boolean';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      defaultValue?: boolean;
    }
  | {
      kind: 'singleSelect';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      options: McpElicitationOption[];
      defaultValue?: string;
    }
  | {
      kind: 'multiSelect';
      key: string;
      label: string;
      description?: string;
      required: boolean;
      options: McpElicitationOption[];
      defaultValue?: string[];
      minItems?: number;
      maxItems?: number;
    };

type McpElicitationRequest =
  | {
      requestId: number;
      threadId: string;
      turnId: string | null;
      serverName: string;
      mode: 'form';
      message: string;
      fields: McpElicitationField[];
      meta?: unknown;
    }
  | {
      requestId: number;
      threadId: string;
      turnId: string | null;
      serverName: string;
      mode: 'url';
      message: string;
      url: string;
      elicitationId?: string;
      meta?: unknown;
    };

type DynamicToolCallRequest = {
  requestId: number;
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
};

type AuthRefreshRequest = {
  requestId: number;
  reason: ChatgptAuthTokensRefreshReason;
  previousAccountId?: string | null;
};

type ApprovalPolicyValue = 'untrusted' | 'on-failure' | 'on-request' | 'never' | 'granular';
type SandboxModeValue = 'read-only' | 'workspace-write' | 'danger-full-access';
type AutonomyModeValue = 'suggest' | 'auto-edit' | 'full-auto' | 'custom';

type PendingMessage = {
  id: string;
  threadId: string;
  text: string;
};

const EMPTY_APPROVAL_REQUESTS: ApprovalRequest[] = [];
const EMPTY_USER_INPUT_REQUESTS: UserInputRequest[] = [];
const EMPTY_MCP_ELICITATION_REQUESTS: McpElicitationRequest[] = [];
const EMPTY_DYNAMIC_TOOL_CALL_REQUESTS: DynamicToolCallRequest[] = [];
const EMPTY_PENDING_MESSAGES: PendingMessage[] = [];

type RateLimitWindowState = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type CreditsSnapshotState = {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
};

type RateLimitSnapshotState = {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: RateLimitWindowState | null;
  secondary: RateLimitWindowState | null;
  credits: CreditsSnapshotState | null;
};

const AUTONOMY_PRESETS: Record<Exclude<AutonomyModeValue, 'custom'>, { approvalPolicy: ApprovalPolicyValue; sandboxMode: SandboxModeValue }> = {
  suggest: {
    approvalPolicy: 'untrusted',
    sandboxMode: 'read-only',
  },
  'auto-edit': {
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write',
  },
  'full-auto': {
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
  },
};

function folderName(cwd?: string): string {
  if (!cwd) return '';
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function normalizeCwd(cwd?: string | null): string {
  return cwd ? cwd.replace(/\\/g, '/').replace(/\/$/, '') : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function storeThreadDetailCacheEntry(cache: Map<string, ThreadDetail>, detail: ThreadDetail | null) {
  if (!detail?.id) {
    return;
  }

  cache.delete(detail.id);
  cache.set(detail.id, detail);

  if (cache.size <= THREAD_DETAIL_CACHE_LIMIT) {
    return;
  }

  const oldestKey = cache.keys().next().value;
  if (typeof oldestKey === 'string') {
    cache.delete(oldestKey);
  }
}

function createThreadShell(summary: ThreadSummary | null): ThreadDetail | null {
  if (!summary) {
    return null;
  }

  return {
    ...summary,
    turns: [],
  };
}

function buildThreadContinuation(config: ChatConfig | null | undefined): ThreadContinuation | null {
  const sourceThreadId = config?.continuation_source_thread_id?.trim();
  if (!sourceThreadId) {
    return null;
  }

  return {
    sourceThreadId,
    sourceProvider: config?.continuation_source_provider ?? null,
    sourceThreadName: config?.continuation_source_name ?? null,
    compactedMessages: typeof config?.continuation_compacted_messages === 'number'
      ? config.continuation_compacted_messages
      : null,
  };
}

function applyThreadConfig<T extends ThreadSummary | ThreadDetail>(thread: T, config: ChatConfig | null | undefined): T {
  const continuation = buildThreadContinuation(config);
  if (!continuation) {
    return thread;
  }
  return { ...thread, continuation };
}

function toOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toRateLimitWindow(value: unknown): RateLimitWindowState | null {
  if (!isObject(value) || typeof value.usedPercent !== 'number') {
    return null;
  }

  return {
    usedPercent: value.usedPercent,
    windowDurationMins: toNullableNumber(value.windowDurationMins),
    resetsAt: toNullableNumber(value.resetsAt),
  };
}

function toCreditsSnapshot(value: unknown): CreditsSnapshotState | null {
  if (!isObject(value) || typeof value.hasCredits !== 'boolean' || typeof value.unlimited !== 'boolean') {
    return null;
  }

  return {
    hasCredits: value.hasCredits,
    unlimited: value.unlimited,
    balance: toOptionalString(value.balance),
  };
}

function toRateLimitSnapshot(value: unknown): RateLimitSnapshotState | null {
  if (!isObject(value)) {
    return null;
  }

  return {
    limitId: toOptionalString(value.limitId),
    limitName: toOptionalString(value.limitName),
    planType: toOptionalString(value.planType),
    primary: toRateLimitWindow(value.primary),
    secondary: toRateLimitWindow(value.secondary),
    credits: toCreditsSnapshot(value.credits),
  };
}

function flattenPermissionLabels(profile: unknown): string[] {
  if (!isObject(profile)) {
    return [];
  }

  const labels: string[] = [];
  const network = isObject(profile.network) ? profile.network : null;
  const fileSystem = isObject(profile.fileSystem) ? profile.fileSystem : null;
  const macos = isObject(profile.macos) ? profile.macos : null;

  if (network && network.enabled === true) {
    labels.push('network');
  }

  if (fileSystem && Array.isArray(fileSystem.roots) && fileSystem.roots.length > 0) {
    labels.push(
      ...fileSystem.roots
        .filter((root): root is string => typeof root === 'string')
        .map((root) => `fs:${root}`),
    );
  }

  if (macos) {
    labels.push('macos');
  }

  return labels;
}

function getConfigRoot(config: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!config) {
    return null;
  }

  if (isObject(config.config)) {
    return config.config;
  }

  return config;
}

function getConfigOrigins(config: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!config || !isObject(config.origins)) {
    return null;
  }

  return config.origins;
}

function getBooleanConfigValue(config: Record<string, unknown> | null, path: string): boolean | undefined {
  const value = getConfigValue(config, path);
  return typeof value === 'boolean' ? value : undefined;
}

function getStringConfigValue(config: Record<string, unknown> | null, path: string): string | undefined {
  const value = getConfigValue(config, path);
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function hasConfigOrigin(config: Record<string, unknown> | null, path: string): boolean {
  const origins = getConfigOrigins(config);
  return !!origins && path in origins;
}

function getConfigOriginFile(config: Record<string, unknown> | null, path: string): string | null {
  const origins = getConfigOrigins(config);
  if (!origins) {
    return null;
  }

  const entry = origins[path];
  if (!isObject(entry) || !isObject(entry.name)) {
    return null;
  }

  return typeof entry.name.file === 'string' && entry.name.file.trim().length > 0 ? entry.name.file : null;
}

function hasLegacyCollabFeature(config: Record<string, unknown> | null): boolean {
  return hasConfigOrigin(config, 'features.collab') || typeof getBooleanConfigValue(config, 'features.collab') === 'boolean';
}

function isLegacyCollabConfigError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('collab') && normalized.includes('deprecated') && normalized.includes('multi_agent');
}

function extractLegacyCollabConfigPathFromError(message: string): string | null {
  const normalized = message.replace(/\r?\n/g, ' ');
  const patterns = [
    /([A-Za-z]:[\\/][^"'`]*?config\.toml)/i,
    /(\/[^"'`]*?config\.toml)/i,
    /(~\/[^"'`]*?config\.toml)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (typeof match?.[1] === 'string' && match[1].trim().length > 0) {
      return match[1].trim().replace(/\\/g, '/');
    }
  }

  return null;
}

function getLegacyCollabConfigPath(config: Record<string, unknown> | null, fallbackPath?: string | null): string {
  const rawPath = (
    getConfigOriginFile(config, 'features.collab') ??
    getConfigOriginFile(config, 'features.multi_agent') ??
    fallbackPath ??
    '~/.codex/config.toml'
  );
  return rawPath.replace(/\\/g, '/');
}

function toUserInputQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((question): UserInputQuestion | null => {
      if (!isObject(question) || typeof question.id !== 'string' || typeof question.question !== 'string') {
        return null;
      }

      const options = Array.isArray(question.options)
        ? question.options.reduce<Array<{ label: string; description?: string }>>((acc, option) => {
            if (!isObject(option) || typeof option.label !== 'string') {
              return acc;
            }

            acc.push({
              label: option.label,
              description: typeof option.description === 'string' ? option.description : undefined,
            });
            return acc;
          }, [])
        : undefined;

      return {
        id: question.id,
        header: typeof question.header === 'string' ? question.header : undefined,
        question: question.question,
        options,
        allowOther: question.isOther === true,
        isSecret: question.isSecret === true,
      };
    })
    .filter((question): question is UserInputQuestion => question != null);
}

function humanizeFieldKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function toMcpOptions(schema: Record<string, unknown>): McpElicitationOption[] {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf
      .map((option) => {
        if (!isObject(option) || typeof option.const !== 'string') {
          return null;
        }

        return {
          value: option.const,
          label: typeof option.title === 'string' ? option.title : option.const,
        };
      })
      .filter((entry): entry is McpElicitationOption => entry != null);
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf
      .map((option) => {
        if (!isObject(option) || typeof option.const !== 'string') {
          return null;
        }

        return {
          value: option.const,
          label: typeof option.title === 'string' ? option.title : option.const,
        };
      })
      .filter((entry): entry is McpElicitationOption => entry != null);
  }

  if (Array.isArray(schema.enum)) {
    const values = toStringList(schema.enum);
    const labels = Array.isArray(schema.enumNames) ? schema.enumNames : [];

    return values.map((value, index) => ({
      value,
      label: typeof labels[index] === 'string' ? String(labels[index]) : value,
    }));
  }

  return [];
}

function toMcpElicitationFields(schema: unknown): McpElicitationField[] {
  if (!isObject(schema) || schema.type !== 'object' || !isObject(schema.properties)) {
    return [];
  }

  const requiredKeys = new Set(toStringList(schema.required));
  const properties = Object.entries(schema.properties);

  return properties.flatMap(([key, property]): McpElicitationField[] => {
    if (!isObject(property) || typeof property.type !== 'string') {
      return [];
    }

    const label = typeof property.title === 'string' ? property.title : humanizeFieldKey(key);
    const description = typeof property.description === 'string' ? property.description : undefined;
    const required = requiredKeys.has(key);

    if (property.type === 'string') {
      const options = toMcpOptions(property);
      if (options.length > 0) {
        return [
          {
            kind: 'singleSelect',
            key,
            label,
            description,
            required,
            options,
            defaultValue: typeof property.default === 'string' ? property.default : undefined,
          },
        ];
      }

      return [
        {
          kind: 'string',
          key,
          label,
          description,
          required,
          format:
            property.format === 'email' || property.format === 'uri' || property.format === 'date' || property.format === 'date-time'
              ? property.format
              : undefined,
          defaultValue: typeof property.default === 'string' ? property.default : undefined,
          minLength: toOptionalNumber(property.minLength),
          maxLength: toOptionalNumber(property.maxLength),
        },
      ];
    }

    if (property.type === 'number' || property.type === 'integer') {
      return [
        {
          kind: 'number',
          key,
          label,
          description,
          required,
          integer: property.type === 'integer',
          defaultValue: toOptionalNumber(property.default),
          minimum: toOptionalNumber(property.minimum),
          maximum: toOptionalNumber(property.maximum),
        },
      ];
    }

    if (property.type === 'boolean') {
      return [
        {
          kind: 'boolean',
          key,
          label,
          description,
          required,
          defaultValue: typeof property.default === 'boolean' ? property.default : undefined,
        },
      ];
    }

    if (property.type === 'array' && isObject(property.items)) {
      const options = toMcpOptions(property.items);
      if (options.length === 0) {
        return [];
      }

      return [
        {
          kind: 'multiSelect',
          key,
          label,
          description,
          required,
          options,
          defaultValue: toStringList(property.default),
          minItems: toOptionalNumber(property.minItems),
          maxItems: toOptionalNumber(property.maxItems),
        },
      ];
    }

    return [];
  });
}

function toMcpElicitationRequest(requestId: number, params: Record<string, unknown>): McpElicitationRequest | null {
  const threadId = typeof params.threadId === 'string' ? params.threadId : null;
  const turnId = typeof params.turnId === 'string' ? params.turnId : null;
  const serverName = typeof params.serverName === 'string' ? params.serverName : null;
  const mode = params.mode;
  const message = typeof params.message === 'string' ? params.message : '';

  if (!threadId || !serverName || (mode !== 'form' && mode !== 'url')) {
    return null;
  }

  if (mode === 'form') {
    return {
      requestId,
      threadId,
      turnId,
      serverName,
      mode: 'form',
      message,
      fields: toMcpElicitationFields(params.requestedSchema),
      meta: params._meta,
    };
  }

  if (typeof params.url !== 'string') {
    return null;
  }

  return {
    requestId,
    threadId,
    turnId,
    serverName,
    mode: 'url',
    message,
    url: params.url,
    elicitationId: typeof params.elicitationId === 'string' ? params.elicitationId : undefined,
    meta: params._meta,
  };
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type McpDraftValue = string | string[] | boolean;

function getMcpFieldInitialValue(field: McpElicitationField): McpDraftValue {
  switch (field.kind) {
    case 'string':
      return field.defaultValue ?? '';
    case 'number':
      return field.defaultValue != null ? String(field.defaultValue) : '';
    case 'boolean':
      return field.defaultValue ?? false;
    case 'singleSelect':
      return field.defaultValue ?? '';
    case 'multiSelect':
      return field.defaultValue ?? [];
  }
}

function isMcpFieldValueValid(field: McpElicitationField, value: McpDraftValue | undefined): boolean {
  switch (field.kind) {
    case 'string':
      return field.required ? typeof value === 'string' && value.trim().length > 0 : true;
    case 'number':
      if (typeof value !== 'string' || value.trim().length === 0) {
        return !field.required;
      }
      return Number.isFinite(Number(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'singleSelect':
      return field.required ? typeof value === 'string' && value.length > 0 : true;
    case 'multiSelect': {
      if (!Array.isArray(value)) {
        return !field.required;
      }

      if (field.required && value.length === 0) {
        return false;
      }

      if (field.minItems != null && value.length < field.minItems) {
        return false;
      }

      if (field.maxItems != null && value.length > field.maxItems) {
        return false;
      }

      return true;
    }
  }
}

function buildMcpElicitationContent(
  fields: McpElicitationField[],
  draft: Record<string, McpDraftValue>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};

  for (const field of fields) {
    const value = draft[field.key];

    switch (field.kind) {
      case 'string':
      case 'singleSelect': {
        if (typeof value === 'string' && value.trim().length > 0) {
          content[field.key] = value.trim();
        }
        break;
      }
      case 'number': {
        if (typeof value === 'string' && value.trim().length > 0) {
          content[field.key] = field.integer ? Math.trunc(Number(value)) : Number(value);
        }
        break;
      }
      case 'boolean':
        if (typeof value === 'boolean') {
          content[field.key] = value;
        }
        break;
      case 'multiSelect':
        if (Array.isArray(value) && value.length > 0) {
          content[field.key] = value;
        }
        break;
    }
  }

  return content;
}

type ThreadGroup = {
  folder: string;
  cwd: string;
  threads: ThreadSummary[];
};

type ThreadProviderId = 'claude' | 'codex' | 'unknown';

type ProviderTimelineEntry = {
  threadId: string;
  provider: ThreadProviderId;
  label: string;
  compactedMessages: number | null;
};

type ModelSwitchPreview = {
  mode: 'fresh' | 'same-thread' | 'handoff';
  currentProviderLabel: string | null;
  targetProviderLabel: string;
  turnCount: number;
  willCompact: boolean;
  compactedMessages: number;
};

function normalizeThreadProvider(provider?: string | null): ThreadProviderId {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  return 'unknown';
}

function getThreadProviderLabel(provider?: ThreadProviderId | string | null): string {
  const normalized = normalizeThreadProvider(provider);
  if (normalized === 'claude') return 'Claude';
  if (normalized === 'codex') return 'Codex';
  return 'Unknown';
}

function buildProviderTimeline(
  thread: Pick<ThreadSummary, 'id' | 'modelProvider' | 'continuation'> | Pick<ThreadDetail, 'id' | 'modelProvider' | 'continuation'> | null,
  lookup: ReadonlyMap<string, ThreadSummary | ThreadDetail>,
): ProviderTimelineEntry[] {
  if (!thread) {
    return [];
  }

  const lineage: Array<ThreadSummary | ThreadDetail> = [];
  const seen = new Set<string>();
  let current: ThreadSummary | ThreadDetail | null = (lookup.get(thread.id) ?? thread) as ThreadSummary | ThreadDetail;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    lineage.unshift(current);
    const sourceThreadId: string | null = current.continuation?.sourceThreadId ?? null;
    current = sourceThreadId ? lookup.get(sourceThreadId) ?? null : null;
  }

  return lineage.map((entry, index) => ({
    threadId: entry.id,
    provider: normalizeThreadProvider(entry.modelProvider),
    label: getThreadProviderLabel(entry.modelProvider),
    compactedMessages: index === 0 ? null : entry.continuation?.compactedMessages ?? null,
  }));
}

export function App() {
  const clientRef = useRef(new CodexClient());
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  const [url, setUrl] = usePersistedState('codex-ws-url', 'ws://127.0.0.1:4500');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isAgentActive, setIsAgentActive] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'error' | 'info' } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [reasoning, setReasoning] = usePersistedState<ReasoningLevel>('codex-reasoning', 'high');
  const [theme, setTheme] = usePersistedState<ThemeMode>('codex-theme', 'dark');
  const [codexConfig, setCodexConfig] = useState<Record<string, unknown> | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedThreadFamilies, setCollapsedThreadFamilies] = useState<Set<string>>(new Set());
  const [modelSwitchPreview, setModelSwitchPreview] = useState<ModelSwitchPreview | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [threadSearch, setThreadSearch] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [accountInfo, setAccountInfo] = useState<AccountInfo>(null);
  const [rateLimits, setRateLimits] = useState<RateLimitSnapshotState | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renamingThreadValue, setRenamingThreadValue] = useState('');
  const [sidebarView, setSidebarView] = useState<'threads' | 'settings' | 'automations' | 'skills' | 'usage' | 'providers' | 'history' | 'kanban'>('threads');
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const sidebarResizing = useRef(false);
  const sidebarResizeStartX = useRef(0);
  const sidebarResizeStartWidth = useRef(0);
  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarResizing.current = true;
    sidebarResizeStartX.current = e.clientX;
    sidebarResizeStartWidth.current = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!sidebarResizing.current) return;
      const delta = ev.clientX - sidebarResizeStartX.current;
      setSidebarWidth(Math.min(Math.max(sidebarResizeStartWidth.current + delta, 160), 520));
    };
    const onMouseUp = () => {
      sidebarResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);
  const [showArchived, setShowArchived] = useState(false);
  const [kanbanThreadIds, setKanbanThreadIds] = useState<Set<string>>(new Set());
  const [kanbanExecutionRevision, setKanbanExecutionRevision] = useState(0);
  const [folderMenu, setFolderMenu] = useState<{ cwd: string; x: number; y: number } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [folderAlias, setFolderAlias] = usePersistedState<Record<string, string>>('codex-folder-aliases', {});
  const [skills, setSkills] = useState<Array<{ name: string; path: string }>>([]);
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; status: string }>>([]);
  const [turnStartTime, setTurnStartTime] = useState<number | null>(null);
  const [composerHistorySeed, setComposerHistorySeed] = useState<string[]>([]);
  const [userInputRequests, setUserInputRequests] = useState<UserInputRequest[]>([]);
  const [mcpElicitationRequests, setMcpElicitationRequests] = useState<McpElicitationRequest[]>([]);
  const [dynamicToolCallRequests, setDynamicToolCallRequests] = useState<DynamicToolCallRequest[]>([]);
  const [authRefreshRequests, setAuthRefreshRequests] = useState<AuthRefreshRequest[]>([]);
  const [contextUsage, setContextUsage] = useState<{ percent: number; usedTokens: number } | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSuggestions, setShowSuggestions] = usePersistedState('codex-show-suggestions', true);
  const [activeProjectCwd, setActiveProjectCwd] = useState<string | null>(null);
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [isThreadTurnsLoading, setIsThreadTurnsLoading] = useState(false);
  const [threadLoadError, setThreadLoadError] = useState<string | null>(null);
  const [lastResolvedThreadDetail, setLastResolvedThreadDetail] = useState<ThreadDetail | null>(null);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const [autonomyMode, setAutonomyMode] = useState<AutonomyModeValue>('suggest');
  const [isUpdatingAutonomy, setIsUpdatingAutonomy] = useState(false);
  const [gitInfo, setGitInfo] = useState<{ branch: string; isDirty: boolean; addedLines: number; removedLines: number; ahead: number; behind: number; lastCommitSha?: string; lastCommitMsg?: string } | null>(null);

  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [historyEntries, setHistoryEntries] = useState<import('./lib/db').ChatHistoryEntry[]>([]);
  const [pinnedThreads, setPinnedThreads] = usePersistedState<string[]>('codex-pinned-threads', []);
  const [threadCtxMenu, setThreadCtxMenu] = useState<{ threadId: string; x: number; y: number } | null>(null);

  const [rightSidebarOpen, setRightSidebarOpen] = usePersistedState('codex-right-sidebar-open', false);
  const [rightSidebarTab, setRightSidebarTab] = usePersistedState<RightSidebarTab>('codex-right-sidebar-tab', 'git');
  const [rightSidebarWidth, setRightSidebarWidth] = usePersistedState('codex-right-sidebar-width', 320);
  const [overlayView, setOverlayView] = useState<OverlayView>(null);
  const [addedProjects, setAddedProjects] = usePersistedState<string[]>('codex-added-projects', []);
  const [hiddenProjects, setHiddenProjects] = usePersistedState<string[]>('codex-hidden-projects', []);
  const [threadViewMode, setThreadViewMode] = usePersistedState<'project' | 'timeline'>('codex-thread-view-mode', 'project');
  const [threadSortBy, setThreadSortBy] = usePersistedState<'updated' | 'created'>('codex-thread-sort-by', 'updated');
  const [appPhase, setAppPhase] = useState<'startup' | 'main'>('main');
  const [showServerDialog, setShowServerDialog] = useState(false);
  const [serverStarting, setServerStarting] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);
  const [serverLog, setServerLog] = useState('');
  const serverManagedRef = useRef(false);
  const automationRunPollsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const kanbanRunPollsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const [codexBinPath, setCodexBinPath] = usePersistedState('codex-bin-path', '');
  const [codexCandidates, setCodexCandidates] = useState<string[]>([]);
  const codexBinPathRef = useRef(codexBinPath);

  // ── Claude support ──
  const claudeClientRef = useRef(getClaudeClient());
  const claudeModels = useMemo(() => claudeClientRef.current.listModels(), []);
  const isClaudeModel = useCallback((modelId?: string | null) => isClaudeModelId(modelId), []);
  const availableCodexModels = useMemo(
    () => filterCodexModelsForAccount(models, accountInfo),
    [models, accountInfo],
  );
  const [uiFontSize, setUiFontSize] = usePersistedState<number>('codex-ui-font-size', 14);
  const [codeFontSize, setCodeFontSize] = usePersistedState<number>('codex-code-font-size', 13);
  const [notificationPref, setNotificationPref] = usePersistedState<'always' | 'unfocused' | 'never'>('codex-notification-pref', 'unfocused');
  const [themePreset, setThemePreset] = usePersistedState<string>('codex-theme-preset', DEFAULT_THEME_PRESET);
  const [themeConfig, setThemeConfig] = usePersistedState<ChromeThemeConfig>('codex-theme-config', getDefaultThemeConfig('dark'));
  const [pointerCursor, setPointerCursor] = usePersistedState<boolean>('codex-pointer-cursor', false);
  const notificationPrefRef = useRef(notificationPref);
  const urlRef = useRef(url);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const selectedThreadRef = useRef<string | null>(null);
  const threadDetailRef = useRef<ThreadDetail | null>(null);
  const threadDetailCacheRef = useRef(new Map<string, ThreadDetail>());
  const composerRef = useRef<ChatComposerHandle>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const pendingDeltaEventsRef = useRef<Array<{ method: string; params: Record<string, unknown> }>>([]);
  const deltaFlushScheduledRef = useRef(false);
  const showArchivedRef = useRef(showArchived);
  const lastAutoFlushedPendingIdRef = useRef<string | null>(null);
  const threadsRef = useRef<ThreadSummary[]>([]);
  const sidebarViewRef = useRef(sidebarView);
  const skillsRef = useRef<Array<{ name: string; path: string }>>([]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const automationSweepInFlightRef = useRef(false);
  const pendingAutomationDueIdsRef = useRef<Set<string>>(new Set());
  const deferredThreadSearch = useDeferredValue(threadSearch);
  const deferredHistorySearchQuery = useDeferredValue(historySearchQuery);
  const tryHandleBuiltinDynamicToolCallRef = useRef<(request: DynamicToolCallRequest) => Promise<boolean>>(async () => false);
  const cacheThreadDetail = useCallback((detail: ThreadDetail | null) => {
    storeThreadDetailCacheEntry(threadDetailCacheRef.current, detail);
  }, []);
  const getCachedThreadDetail = useCallback((threadId: string) => {
    const activeDetail = threadDetailRef.current;
    if (activeDetail?.id === threadId) {
      return activeDetail;
    }
    return threadDetailCacheRef.current.get(threadId) ?? null;
  }, []);
  const getThreadProvider = useCallback((threadId: string): 'claude' | 'codex' | null => {
    const activeDetail = threadDetailRef.current;
    if (activeDetail?.id === threadId) {
      return activeDetail.modelProvider === 'claude' ? 'claude' : 'codex';
    }

    const cachedDetail = threadDetailCacheRef.current.get(threadId);
    if (cachedDetail) {
      return cachedDetail.modelProvider === 'claude' ? 'claude' : 'codex';
    }

    const summary = threadsRef.current.find((thread) => thread.id === threadId);
    if (summary) {
      return summary.modelProvider === 'claude' ? 'claude' : 'codex';
    }

    return null;
  }, []);

  useEffect(() => { notificationPrefRef.current = notificationPref; }, [notificationPref]);
  useEffect(() => { urlRef.current = url; }, [url]);
  useEffect(() => { selectedThreadRef.current = selectedThread; }, [selectedThread]);
  useEffect(() => {
    if (!selectedThread) {
      setIsThreadTurnsLoading(false);
    }
  }, [selectedThread]);
  useEffect(() => { threadDetailRef.current = threadDetail; }, [threadDetail]);
  useEffect(() => { setModelSwitchPreview(null); }, [selectedThread, threadDetail?.id]);
  useEffect(() => {
    if (threadDetail) {
      if (!isThreadTurnsLoading) {
        cacheThreadDetail(threadDetail);
      }
      setLastResolvedThreadDetail(threadDetail);
    }
  }, [cacheThreadDetail, isThreadTurnsLoading, threadDetail]);
  useEffect(() => { showArchivedRef.current = showArchived; }, [showArchived]);
  useEffect(() => { lastAutoFlushedPendingIdRef.current = null; }, [selectedThread]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);
  useEffect(() => { sidebarViewRef.current = sidebarView; }, [sidebarView]);
  useEffect(() => { skillsRef.current = skills; }, [skills]);
  useEffect(() => { setShowRawJson(false); setOverlayView(null); }, [selectedThread, sidebarView]);

  // Toast 鑷姩娑堝け
  useEffect(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (!toast) return;
    const ms = toast.type === 'error' ? 6000 : 3000;
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [toast]);

  // History panel: load data when switching to the history tab.
  useEffect(() => {
    if (sidebarView !== 'history') return;
    const load = async () => {
      const query = deferredHistorySearchQuery.trim();
      if (query) {
        const result = await searchChatHistory(query);
        setHistoryEntries(result);
      } else {
        const result = await getAllChatHistory();
        setHistoryEntries(result);
      }
    };
    void load();
  }, [sidebarView, deferredHistorySearchQuery]);

  useEffect(() => {
    if (!selectedThread) {
      setComposerHistorySeed([]);
      return;
    }
    getChatMessages(selectedThread, 50).then(msgs => {
      setComposerHistorySeed([...msgs].reverse());
    }).catch(() => {});
  }, [selectedThread]);

  useEffect(() => {
    if (!projectDropdownOpen) return;
    const close = (e: MouseEvent) => {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) setProjectDropdownOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [projectDropdownOpen]);

  useEffect(() => {
    if (!selectedThread || !selectedModel) return;
    const provider = getThreadProvider(selectedThread);
    if (!provider) return;

    if (provider === 'claude') {
      if (!isClaudeModel(selectedModel)) return;
      saveChatConfig({
        thread_id: selectedThread,
        model: normalizeClaudeModelId(selectedModel),
        reasoning,
      }).catch(() => {});
      return;
    }

    if (isClaudeModel(selectedModel)) return;
    saveChatConfig({ thread_id: selectedThread, model: selectedModel, reasoning }).catch(() => {});
  }, [getThreadProvider, isClaudeModel, reasoning, selectedModel, selectedThread]);

  useEffect(() => {
    if (!selectedModel || !isClaudeModel(selectedModel)) {
      return;
    }
    const normalizedModel = normalizeClaudeModelId(selectedModel);
    if (normalizedModel !== selectedModel) {
      setSelectedModel(normalizedModel);
    }
  }, [isClaudeModel, selectedModel]);

  useEffect(() => {
    if (!selectedModel || models.length === 0 || isClaudeModel(selectedModel)) {
      return;
    }

    if (availableCodexModels.some((model) => model.id === selectedModel)) {
      return;
    }

    const fallbackModel = pickPreferredCodexModel(availableCodexModels);
    if (!fallbackModel || fallbackModel === selectedModel) {
      return;
    }

    if (isBlockedCodexModelForAccount(selectedModel, accountInfo)) {
      setToast({ msg: getBlockedCodexModelMessage(selectedModel, fallbackModel), type: 'info' });
    }

    setSelectedModel(fallbackModel);
  }, [accountInfo, availableCodexModels, isClaudeModel, models.length, selectedModel]);

  useEffect(() => {
    if (!isAgentActive && !isSending) {
      setTurnStartTime(null);
      return;
    }
    if (!turnStartTime) setTurnStartTime(Date.now());
  }, [isAgentActive, isSending, turnStartTime]);

  useEffect(() => {
    applyTheme(theme);
    const v = resolveThemeVariant(theme);
    applyThemeConfig(themeConfig, v);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') { applyTheme('system'); applyThemeConfig(themeConfig, resolveThemeVariant('system')); } };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme, themeConfig]);

  useEffect(() => {
    applyFontSizes(uiFontSize, codeFontSize);
  }, [uiFontSize, codeFontSize]);

  useEffect(() => {
    document.documentElement.classList.toggle('use-pointer-cursor', pointerCursor);
  }, [pointerCursor]);

  useEffect(() => {
    setAutonomyMode(deriveAutonomyModeFromConfig(codexConfig));
  }, [codexConfig]);

  useEffect(() => {
    const title = threadDetail
      ? `${threadDetail.name || threadDetail.preview || 'Thread'} - Codex`
      : 'Codex Desktop';
    appWindow.setTitle(title).catch(() => {});
  }, [threadDetail?.id, threadDetail?.name, threadDetail?.preview]);

  useEffect(() => {
    isPermissionGranted().then(async (granted) => {
      if (!granted) {
        await requestPermission();
      }
    }).catch(() => {});
  }, []);

  const threadGroups = useMemo<ThreadGroup[]>(() => {
    const sourceThreads = threads.filter((t) => !kanbanThreadIds.has(t.id));
    const searchLower = deferredThreadSearch.toLowerCase();
    const addedProjectSet = new Set(addedProjects.map((project) => normalizeCwd(project)).filter(Boolean));
    const hiddenProjectSet = new Set(hiddenProjects.map((project) => normalizeCwd(project)).filter(Boolean));
    const projectFiltered = sourceThreads.filter((thread) => {
      const normalizedCwd = normalizeCwd(thread.cwd);
      if (!normalizedCwd) return true;
      if (hiddenProjectSet.has(normalizedCwd)) return false;
      return addedProjectSet.size === 0 || addedProjectSet.has(normalizedCwd);
    });

    const filtered = searchLower
      ? projectFiltered.filter((t) => {
          const name = (t.name || t.preview || '').toLowerCase();
          const folder = folderName(t.cwd).toLowerCase();
          return name.includes(searchLower) || folder.includes(searchLower);
        })
      : projectFiltered;

    const grouped = new Map<string, ThreadSummary[]>();
    const ungrouped: ThreadSummary[] = [];

    for (const t of filtered) {
      if (t.cwd) {
        const key = t.cwd;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(t);
      } else {
        ungrouped.push(t);
      }
    }

    const groups: ThreadGroup[] = [];
    for (const [cwd, items] of grouped) {
      groups.push({ folder: folderName(cwd), cwd, threads: items });
    }
    groups.sort((a, b) => {
      const aTime = Math.max(...a.threads.map(t => t.updatedAt ?? t.createdAt));
      const bTime = Math.max(...b.threads.map(t => t.updatedAt ?? t.createdAt));
      return bTime - aTime;
    });
    if (ungrouped.length > 0) {
      groups.push({ folder: '', cwd: '', threads: ungrouped });
    }
    return groups;
  }, [threads, deferredThreadSearch, addedProjects, hiddenProjects, kanbanThreadIds]);

  const automationProjects = useMemo(
    () =>
      threadGroups
        .filter((group) => group.cwd && group.folder)
        .map((group) => ({
          cwd: group.cwd,
          label: folderAlias[group.cwd] || group.folder,
        })),
    [folderAlias, threadGroups],
  );

  const kanbanProjects = useMemo<KanbanProject[]>(() => {
    const cwdMap = new Map<string, string>();
    for (const t of threads) {
      if (t.cwd) cwdMap.set(t.cwd, folderAlias[t.cwd] || folderName(t.cwd));
    }
    return Array.from(cwdMap.entries()).map(([id, name]) => ({ id, name }));
  }, [threads, folderAlias]);

  const refreshKanbanThreadIds = useCallback(async () => {
    try {
      const ids = await getKanbanLinkedThreadIds();
      setKanbanThreadIds(ids);
    } catch { /* ignore */ }
  }, []);

  const clearKanbanRunPoll = useCallback((runId: string) => {
    const active = kanbanRunPollsRef.current.get(runId);
    if (!active) return;
    clearInterval(active);
    kanbanRunPollsRef.current.delete(runId);
  }, []);

  const syncKanbanRunFromThread = useCallback(async (params: {
    runId: string;
    issueId: string;
    detail: ThreadDetail;
  }): Promise<boolean> => {
    const nextState = threadDetailToKanbanExecutionState(params.detail);
    if (!nextState || nextState === 'RUNNING') return false;

    const lastTurn = getLastKanbanThreadTurn(params.detail);
    const finishedAt = nowUnixSeconds();
    const lastError = nextState === 'FAILED' || nextState === 'CANCELLED'
      ? lastTurn?.error?.message ?? null
      : null;
    const resultSummary = nextState === 'SUCCESS'
      ? extractKanbanRunResultSummary(params.detail)
      : null;

    await updateKanbanIssueRun(params.runId, {
      status: nextState,
      finishedAt,
      errorMessage: lastError,
      resultSummary,
    });
    await updateKanbanIssueExecution(params.issueId, {
      lastRunStatus: nextState,
      lastFinishedAt: finishedAt,
      lastError,
      lastResultSummary: resultSummary,
    });
    setKanbanExecutionRevision((prev) => prev + 1);
    return true;
  }, []);

  const startKanbanRunPolling = useCallback((params: {
    runId: string;
    issueId: string;
    threadId: string;
  }) => {
    if (kanbanRunPollsRef.current.has(params.runId)) return;
    const interval = setInterval(async () => {
      try {
        const detail = await clientRef.current.readThread(params.threadId);
        const settled = await syncKanbanRunFromThread({
          runId: params.runId,
          issueId: params.issueId,
          detail,
        });
        if (settled) {
          clearKanbanRunPoll(params.runId);
        }
      } catch {
        // Best-effort background sync; we'll retry on the next polling tick.
      }
    }, 3000);
    kanbanRunPollsRef.current.set(params.runId, interval);
  }, [clearKanbanRunPoll, syncKanbanRunFromThread]);

  const reconcileKanbanRunPolls = useCallback(async () => {
    try {
      const runningRuns = await listRunningKanbanIssueRuns();
      const activeRunIds = new Set(runningRuns.map((run) => run.id));

      for (const runId of kanbanRunPollsRef.current.keys()) {
        if (!activeRunIds.has(runId)) {
          clearKanbanRunPoll(runId);
        }
      }

      for (const run of runningRuns) {
        if (!run.thread_id) continue;
        startKanbanRunPolling({
          runId: run.id,
          issueId: run.issue_id,
          threadId: run.thread_id,
        });
      }
    } catch {
      // Ignore background reconcile failures; future ticks will retry.
    }
  }, [clearKanbanRunPoll, startKanbanRunPolling]);

  useEffect(() => {
    void reconcileKanbanRunPolls();
    const interval = setInterval(() => {
      void reconcileKanbanRunPolls();
    }, 5000);

    return () => {
      clearInterval(interval);
      for (const active of kanbanRunPollsRef.current.values()) {
        clearInterval(active);
      }
      kanbanRunPollsRef.current.clear();
    };
  }, [reconcileKanbanRunPolls]);

  const refreshAccountInfo = useCallback(async () => {
    try {
      const { account } = await clientRef.current.readAccount();
      setAccountInfo(account);
      return account;
    } catch {
      setAccountInfo(null);
      return null;
    }
  }, []);

  const refreshMcpServers = useCallback(async () => {
    try {
      const result = await clientRef.current.listMcpServers() as { data?: Array<{ name: string; status: string }> };
      setMcpServers(result?.data ?? []);
      return result?.data ?? [];
    } catch {
      setMcpServers([]);
      return null;
    }
  }, []);

  const refreshSkills = useCallback(async () => {
    try {
      const cwds = [...new Set(
        threadsRef.current
          .map((thread) => thread.cwd)
          .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0),
      )];
      const result = await clientRef.current.listSkills(cwds.length > 0 ? cwds : ['.']) as {
        skills?: Array<{ name: string; path: string }>;
      };
      setSkills(result?.skills ?? []);
      return result?.skills ?? [];
    } catch {
      setSkills([]);
      return null;
    }
  }, []);

  useEffect(() => {
    const projectCwds = threadGroups.filter((group) => group.cwd && group.folder).map((group) => group.cwd);

    if (threadDetail?.cwd) {
      if (activeProjectCwd !== threadDetail.cwd) {
        setActiveProjectCwd(threadDetail.cwd);
      }
      return;
    }

    if (projectCwds.length === 0) {
      if (activeProjectCwd !== null) {
        setActiveProjectCwd(null);
      }
      return;
    }

    if (!activeProjectCwd || !projectCwds.includes(activeProjectCwd)) {
      setActiveProjectCwd(projectCwds[0]);
    }
  }, [activeProjectCwd, threadDetail?.cwd, threadGroups]);

  useEffect(() => {
    const cwd = threadDetail?.cwd || (threadGroups.length > 0 ? threadGroups[0]?.cwd : null);
    if (!cwd) return;
    let fetching = false;
    let cancelled = false;
    const fetchGitInfo = async () => {
      if (fetching || cancelled) return;
      fetching = true;
      try {
        const info = await invoke<{ branch: string; isDirty: boolean; addedLines: number; removedLines: number; ahead: number; behind: number; lastCommitSha?: string; lastCommitMsg?: string }>('get_git_info', { cwd });
        if (!cancelled) setGitInfo(info);
      } catch { /* ignore */ }
      finally { fetching = false; }
    };
    fetchGitInfo();
    const interval = setInterval(fetchGitInfo, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [threadDetail?.cwd, threadGroups]);

  const refreshThreadDetail = useCallback(async (threadId: string) => {
    try {
      const result = await clientRef.current.readThread(threadId, true);
      const config = await getChatConfig(threadId).catch(() => null);
      const merged = applyThreadConfig(
        mergeThreadDetailWithLocalState(getCachedThreadDetail(threadId), result),
        config,
      );
      cacheThreadDetail(merged);
      if (selectedThreadRef.current === threadId) {
        threadDetailRef.current = merged;
        setThreadDetail(merged);
        setIsAgentActive(merged.status?.type === 'active');
      }
      return merged;
    } catch {
      return null;
    }
  }, [cacheThreadDetail, getCachedThreadDetail]);

  const startPolling = useCallback((threadId: string) => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    const poll = async () => {
      if (selectedThreadRef.current !== threadId) return;
      const detail = await refreshThreadDetail(threadId);
      if (!detail) return;
      const isActive = detail.status?.type === 'active';
      const lastTurn = detail.turns?.[detail.turns.length - 1];
      if (isActive || lastTurn?.status === 'inProgress') {
        pollTimerRef.current = setTimeout(poll, 2000);
      }
    };
    pollTimerRef.current = setTimeout(poll, 1500);
  }, [refreshThreadDetail]);

  const applySelectedThreadEvent = useCallback((method: string, params: Record<string, unknown>) => {
    const selectedId = selectedThreadRef.current;
    if (!selectedId) {
      return;
    }

    const threadId =
      typeof params.threadId === 'string'
        ? params.threadId
        : isObject(params.thread) && typeof params.thread.id === 'string'
        ? params.thread.id
        : undefined;

    if (!threadId || threadId !== selectedId) {
      return;
    }

    setThreadDetail((prev) => applyServerEventToThreadDetail(prev, method, params));
  }, []);

  useEffect(() => {
    return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    const unsub = client.onStateChange((state) => {
      setConnState(state);
      if (state === 'connected') {
        setAppPhase('main');
        setShowServerDialog(false);
        setServerLog('');
        reconnectAttemptRef.current = 0;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      } else if (state === 'disconnected') {
        const attempt = reconnectAttemptRef.current;
        const delay = Math.min(2000 * Math.pow(1.5, attempt), 15000);
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(async () => {
          reconnectTimerRef.current = null;
          reconnectAttemptRef.current = attempt + 1;
          const currentUrl = urlRef.current;
          try {
            await client.connect(currentUrl, { autoReconnect: false });
            const result = await client.listThreads({ limit: 50 });
            startTransition(() => {
              setThreads(result.data);
              setNextCursor(result.nextCursor);
            });
            try { setModels(await client.listModels()); } catch { /* optional */ }
            try { await refreshAccountInfo(); } catch { /* optional */ }
          } catch {
            // will retry on next backoff cycle via state change
          }
        }, delay);
      }
    });
    const unsubNotif = client.onNotification((method, params) => {
      const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
      const selectedId = selectedThreadRef.current;
      const isSelectedThread = !!threadId && threadId === selectedId;

      if (method === 'thread/started' && isObject(params.thread)) {
        const thread = params.thread as ThreadSummary;
        startTransition(() => {
          setThreads((prev) => [thread, ...prev.filter((entry) => entry.id !== thread.id)]);
        });
      }

      if (method === 'thread/status/changed') {
        if (threadId) {
          startTransition(() => {
            setThreads((prev) =>
              prev.map((thread) =>
                thread.id === threadId ? { ...thread, status: params.status as ThreadSummary['status'] } : thread,
              ),
            );
          });
        }

        applySelectedThreadEvent(method, params);

        if (isSelectedThread && isObject(params.status)) {
          const isActive = params.status.type === 'active';
          setIsAgentActive(isActive);
          if (threadId && isActive) {
            startPolling(threadId);
          }
        }
      }

      const isDeltaEvent =
        method === 'item/agentMessage/delta' ||
        method === 'item/plan/delta' ||
        method === 'command/exec/outputDelta' ||
        method === 'item/reasoning/summaryTextDelta' ||
        method === 'item/reasoning/summaryPartAdded' ||
        method === 'item/reasoning/textDelta' ||
        method === 'item/commandExecution/outputDelta' ||
        method === 'item/commandExecution/terminalInteraction' ||
        method === 'item/fileChange/outputDelta' ||
        method === 'item/mcpToolCall/progress' ||
        method === 'thread/realtime/outputAudio/delta';

      const isStructuralEvent =
        method === 'thread/name/updated' ||
        method === 'turn/started' ||
        method === 'turn/completed' ||
        method === 'hook/started' ||
        method === 'hook/completed' ||
        method === 'turn/diff/updated' ||
        method === 'item/started' ||
        method === 'item/completed' ||
        method === 'rawResponseItem/completed' ||
        method === 'turn/plan/updated' ||
        method === 'thread/realtime/started' ||
        method === 'thread/realtime/itemAdded' ||
        method === 'thread/realtime/error' ||
        method === 'thread/realtime/closed' ||
        method === 'thread/compacted' ||
        method === 'error';

      if (isStructuralEvent) {
        applySelectedThreadEvent(method, params);
      } else if (isDeltaEvent && isSelectedThread) {
        pendingDeltaEventsRef.current.push({ method, params });
        if (!deltaFlushScheduledRef.current) {
          deltaFlushScheduledRef.current = true;
          requestAnimationFrame(() => {
            deltaFlushScheduledRef.current = false;
            const events = pendingDeltaEventsRef.current;
            if (events.length === 0) return;
            pendingDeltaEventsRef.current = [];
            const selectedId = selectedThreadRef.current;
            if (!selectedId) return;
            setThreadDetail((prev) => {
              let state = prev;
              for (const ev of events) {
                state = applyServerEventToThreadDetail(state, ev.method, ev.params);
              }
              return state;
            });
          });
        }
      }

      if (method === 'turn/started') {
        const turn = isObject(params.turn) ? params.turn : null;
        if (turn && typeof turn.id === 'string') {
          activeTurnIdRef.current = turn.id;
        }
        if (isSelectedThread) {
          setIsAgentActive(true);
          if (threadId) {
            startPolling(threadId);
          }
        }
      }

      if (method === 'turn/completed') {
        const turn = isObject(params.turn) ? params.turn : null;
        const turnStatus = turn && typeof turn.status === 'string' ? turn.status : 'completed';
        activeTurnIdRef.current = null;

        if (isSelectedThread) {
          setIsAgentActive(false);
        }

        const pref = notificationPrefRef.current;
        if (pref !== 'never') {
          if (pref === 'always') {
            sendNotification({ title: 'Codex', body: `Turn ${turnStatus}` });
          } else {
            appWindow
              .isFocused()
              .then((focused) => {
                if (!focused) {
                  sendNotification({ title: 'Codex', body: `Turn ${turnStatus}` });
                }
              })
              .catch(() => {});
          }
        }
      }

      if (method === 'thread/tokenUsage/updated' && isSelectedThread && isObject(params.tokenUsage)) {
        const tokenUsage = params.tokenUsage;
        const total = isObject(tokenUsage.total) && typeof tokenUsage.total.totalTokens === 'number'
          ? tokenUsage.total.totalTokens
          : 0;
        const modelContextWindow =
          typeof tokenUsage.modelContextWindow === 'number' ? tokenUsage.modelContextWindow : null;

        if (modelContextWindow && modelContextWindow > 0) {
          const percent = Math.max(0, Math.min(100, Math.round((1 - total / modelContextWindow) * 100)));
          setContextUsage({ percent, usedTokens: total });
        }
      }

      if (method === 'serverRequest/resolved') {
        const requestId = typeof params.requestId === 'number' ? params.requestId : null;
        if (requestId != null) {
          setApprovals((prev) => prev.filter((request) => request.requestId !== requestId));
          setUserInputRequests((prev) => prev.filter((request) => request.requestId !== requestId));
          setMcpElicitationRequests((prev) => prev.filter((request) => request.requestId !== requestId));
          setDynamicToolCallRequests((prev) => prev.filter((request) => request.requestId !== requestId));
          setAuthRefreshRequests((prev) => prev.filter((request) => request.requestId !== requestId));
        }
      }

      if (method === 'thread/name/updated' || method === 'thread/archived' || method === 'thread/unarchived') {
        clientRef.current
          .listThreads({ limit: 50, archived: showArchivedRef.current })
          .then((result) => {
            startTransition(() => {
              setThreads(result.data);
              setNextCursor(result.nextCursor);
            });
          })
          .catch(() => {});

        if (threadId && threadId === selectedThreadRef.current) {
          const shouldClearSelection =
            (method === 'thread/archived' && !showArchivedRef.current) ||
            (method === 'thread/unarchived' && showArchivedRef.current);

          if (shouldClearSelection) {
            setSelectedThread(null);
            setThreadDetail(null);
            setIsAgentActive(false);
          }
        }
      }

      if (method === 'thread/closed') {
        if (threadId) {
          startTransition(() => {
            setThreads((prev) => prev.filter((thread) => thread.id !== threadId));
          });
          setPendingMessages((prev) => prev.filter((message) => message.threadId !== threadId));
        }

        if (threadId && threadId === selectedThreadRef.current) {
          setSelectedThread(null);
          setThreadDetail(null);
          setIsAgentActive(false);
        }
      }

      if (method === 'account/updated') {
        void refreshAccountInfo();
      }

      if (method === 'account/login/completed') {
        const success = params.success === true;
        const errorMessage = typeof params.error === 'string' ? params.error : null;
        if (success) {
          void refreshAccountInfo();
          setToast({ msg: 'Account login completed.', type: 'info' });
        } else if (errorMessage) {
          setToast({ msg: `Account login failed: ${errorMessage}`, type: 'error' });
        }
      }

      if (method === 'hook/completed' && isObject(params.run)) {
        const status = typeof params.run.status === 'string' ? params.run.status : 'completed';
        const eventName = typeof params.run.eventName === 'string' ? params.run.eventName : 'hook';
        if (status === 'failed' || status === 'blocked' || status === 'stopped') {
          const statusMessage =
            typeof params.run.statusMessage === 'string' && params.run.statusMessage
              ? `: ${params.run.statusMessage}`
              : '';
          setToast({ msg: `Hook ${eventName} ${status}${statusMessage}`, type: 'error' });
        }
      }

      if (method === 'account/rateLimits/updated') {
        const snapshot = toRateLimitSnapshot(params.rateLimits);
        if (snapshot) {
          setRateLimits(snapshot);
        }
      }

      if (method === 'mcpServer/oauthLogin/completed') {
        const serverName = typeof params.name === 'string' ? params.name : 'MCP server';
        const success = params.success === true;
        const errorMessage = typeof params.error === 'string' ? params.error : null;
        void refreshMcpServers();
        setToast({
          msg: success
            ? `MCP OAuth completed for ${serverName}.`
            : `MCP OAuth failed for ${serverName}${errorMessage ? `: ${errorMessage}` : ''}`,
          type: success ? 'info' : 'error',
        });
      }

      if (method === 'skills/changed') {
        if (sidebarViewRef.current === 'skills' || skillsRef.current.length > 0) {
          void refreshSkills();
        }
        setToast({ msg: 'Local skills changed. Skill metadata refreshed.', type: 'info' });
      }

      if (method === 'error' && isObject(params.error) && typeof params.error.message === 'string') {
        setToast({
          msg: params.willRetry === true ? `Agent error, retrying: ${params.error.message}` : `Agent error: ${params.error.message}`,
          type: 'error',
        });
      }

      if (method === 'model/rerouted') {
        const fromModel = typeof params.fromModel === 'string' ? params.fromModel : 'unknown';
        const toModel = typeof params.toModel === 'string' ? params.toModel : 'unknown';
        const reason = typeof params.reason === 'string' ? params.reason : null;
        setToast({
          msg: `Model rerouted: ${fromModel} -> ${toModel}${reason ? ` (${reason})` : ''}.`,
          type: 'info',
        });
      }

      if (method === 'deprecationNotice' && typeof params.summary === 'string') {
        const details = typeof params.details === 'string' && params.details.trim() ? ` ${params.details.trim()}` : '';
        setToast({ msg: `${params.summary}${details}`, type: 'info' });
      }

      if (method === 'configWarning' && typeof params.summary === 'string') {
        const details = typeof params.details === 'string' && params.details.trim() ? ` ${params.details.trim()}` : '';
        const path = typeof params.path === 'string' ? ` (${params.path})` : '';
        setToast({ msg: `${params.summary}${path}${details}`, type: 'error' });
      }

      if (method === 'app/list/updated' && Array.isArray(params.data)) {
        setToast({ msg: `App list updated (${params.data.length} app${params.data.length === 1 ? '' : 's'}).`, type: 'info' });
      }

      if (method === 'fuzzyFileSearch/sessionUpdated') {
        const query = typeof params.query === 'string' ? params.query : 'search';
        const count = Array.isArray(params.files) ? params.files.length : 0;
        setToast({ msg: `Fuzzy search "${query}" updated (${count} result${count === 1 ? '' : 's'}).`, type: 'info' });
      }

      if (method === 'fuzzyFileSearch/sessionCompleted') {
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId : 'unknown';
        setToast({ msg: `Fuzzy search session completed (${sessionId}).`, type: 'info' });
      }

      if (method === 'thread/realtime/started') {
        const sessionId = typeof params.sessionId === 'string' && params.sessionId ? ` (${params.sessionId})` : '';
        setToast({ msg: `Realtime session started${sessionId}.`, type: 'info' });
      }

      if (method === 'thread/realtime/error' && typeof params.message === 'string') {
        setToast({ msg: `Realtime error: ${params.message}`, type: 'error' });
      }

      if (method === 'thread/realtime/closed') {
        const reason = typeof params.reason === 'string' && params.reason ? `: ${params.reason}` : '';
        setToast({ msg: `Realtime session closed${reason}`, type: 'info' });
      }

      if (method === 'windows/worldWritableWarning') {
        const count = Array.isArray(params.samplePaths) ? params.samplePaths.length : 0;
        const extraCount = typeof params.extraCount === 'number' ? params.extraCount : 0;
        const suffix = extraCount > 0 ? ` (+${extraCount} more)` : '';
        const failedScan = params.failedScan === true ? ' Scan incomplete.' : '';
        setToast({ msg: `World-writable Windows paths detected (${count}${suffix}).${failedScan}`, type: 'error' });
      }

      if (method === 'windowsSandbox/setupCompleted') {
        const mode = typeof params.mode === 'string' ? params.mode : 'windows-sandbox';
        const success = params.success === true;
        const errorMessage = typeof params.error === 'string' ? params.error : null;
        setToast({
          msg: success ? `Windows sandbox setup completed (${mode}).` : `Windows sandbox setup failed (${mode})${errorMessage ? `: ${errorMessage}` : ''}`,
          type: success ? 'info' : 'error',
        });
      }
    });
    const unsubRequest = client.onServerRequest((request) => {
      const params = (request.params ?? {}) as Record<string, unknown>;

      if (request.method === 'item/commandExecution/requestApproval' || request.method === 'execCommandApproval') {
        const approval: ApprovalRequest = {
          requestId: request.id,
          method: request.method,
          threadId: typeof params.threadId === 'string' ? params.threadId : '',
          turnId: typeof params.turnId === 'string' ? params.turnId : '',
          itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
          toolName: typeof params.toolName === 'string' ? params.toolName : undefined,
          command: typeof params.command === 'string' ? params.command : undefined,
          description:
            typeof params.reason === 'string'
              ? params.reason
              : typeof params.description === 'string'
              ? params.description
              : undefined,
          kind: 'exec',
          permissions: flattenPermissionLabels(params.additionalPermissions),
          rawPermissions: isObject(params.additionalPermissions) ? params.additionalPermissions : undefined,
          availableDecisions: Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined,
        };
        setApprovals((prev) => [...prev.filter((entry) => entry.requestId !== approval.requestId), approval]);
        return;
      }

      if (request.method === 'item/fileChange/requestApproval' || request.method === 'applyPatchApproval') {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId : '';
        const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
        const threadItem = findThreadItem(threadDetailRef.current, turnId, itemId);
        const diff =
          typeof params.diff === 'string'
            ? params.diff
            : threadItem?.changes
                ?.map((change) => change.diff)
                .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
                .join('\n\n');

        const approval: ApprovalRequest = {
          requestId: request.id,
          method: request.method,
          threadId,
          turnId,
          itemId,
          description:
            typeof params.reason === 'string'
              ? params.reason
              : typeof params.description === 'string'
              ? params.description
              : undefined,
          kind: 'applyPatch',
          diff,
        };
        setApprovals((prev) => [...prev.filter((entry) => entry.requestId !== approval.requestId), approval]);
        return;
      }

      if (request.method === 'item/permissions/requestApproval') {
        const approval: ApprovalRequest = {
          requestId: request.id,
          method: request.method,
          threadId: typeof params.threadId === 'string' ? params.threadId : '',
          turnId: typeof params.turnId === 'string' ? params.turnId : '',
          itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
          description: typeof params.reason === 'string' ? params.reason : undefined,
          kind: 'permissions',
          permissions: flattenPermissionLabels(params.permissions),
          rawPermissions: isObject(params.permissions) ? params.permissions : {},
        };
        setApprovals((prev) => [...prev.filter((entry) => entry.requestId !== approval.requestId), approval]);
        return;
      }

      if (request.method === 'item/tool/requestUserInput') {
        const questions = toUserInputQuestions(params.questions);
        const req: UserInputRequest = {
          requestId: request.id,
          threadId: typeof params.threadId === 'string' ? params.threadId : '',
          turnId: typeof params.turnId === 'string' ? params.turnId : '',
          questions,
        };
        setUserInputRequests((prev) => [...prev.filter((entry) => entry.requestId !== req.requestId), req]);
        return;
      }

      if (request.method === 'mcpServer/elicitation/request') {
        const elicitation = toMcpElicitationRequest(request.id, params);
        if (!elicitation) {
          void clientRef.current
            .rejectServerRequest(request.id, 'Invalid MCP elicitation request payload', -32602)
            .catch(() => {});
          return;
        }

        setMcpElicitationRequests((prev) => [
          ...prev.filter((entry) => entry.requestId !== elicitation.requestId),
          elicitation,
        ]);
        return;
      }

      if (request.method === 'item/tool/call') {
        const toolCall =
          typeof params.threadId === 'string' &&
          typeof params.turnId === 'string' &&
          typeof params.callId === 'string' &&
          typeof params.tool === 'string'
            ? {
                requestId: request.id,
                threadId: params.threadId,
                turnId: params.turnId,
                callId: params.callId,
                tool: params.tool,
                arguments: params.arguments,
              }
            : null;

        if (!toolCall) {
          void clientRef.current
            .rejectServerRequest(request.id, 'Invalid dynamic tool call payload', -32602)
            .catch(() => {});
          return;
        }

        void (async () => {
          const handled = await tryHandleBuiltinDynamicToolCallRef.current(toolCall);
          if (handled) {
            return;
          }

          setDynamicToolCallRequests((prev) => [
            ...prev.filter((entry) => entry.requestId !== toolCall.requestId),
            toolCall,
          ]);
        })();
        return;
      }

      if (request.method === 'account/chatgptAuthTokens/refresh') {
        const reason = params.reason === 'unauthorized' ? params.reason : null;
        if (!reason) {
          void clientRef.current
            .rejectServerRequest(request.id, 'Invalid ChatGPT auth refresh payload', -32602)
            .catch(() => {});
          return;
        }

        setAuthRefreshRequests((prev) => [
          ...prev.filter((entry) => entry.requestId !== request.id),
          {
            requestId: request.id,
            reason,
            previousAccountId:
              typeof params.previousAccountId === 'string' ? params.previousAccountId : null,
          },
        ]);
        return;
      }

      void clientRef.current
        .rejectServerRequest(request.id, `Unsupported desktop client request: ${request.method}`, -32601)
        .catch(() => {});
      setToast({ msg: `Unsupported request from Codex: ${request.method}`, type: 'error' });
    });
    return () => { unsub(); unsubNotif(); unsubRequest(); };
  }, [applySelectedThreadEvent, refreshAccountInfo, refreshMcpServers, refreshSkills, startPolling]);

  const refreshCodexConfig = useCallback(async () => {
    try {
      const config = await clientRef.current.readConfig({ includeLayers: true }) as Record<string, unknown>;
      setCodexConfig(config);
      return config;
    } catch {
      return null;
    }
  }, []);

  const resolveLegacyCollabConfigPath = useCallback(async (options?: {
    configSnapshot?: Record<string, unknown> | null;
    fallbackPath?: string | null;
    force?: boolean;
  }): Promise<string | null> => {
    const snapshot = options?.configSnapshot ?? codexConfig ?? await refreshCodexConfig();
    if (!options?.force && (!snapshot || !hasLegacyCollabFeature(snapshot))) {
      return null;
    }

    return getLegacyCollabConfigPath(snapshot, options?.fallbackPath);
  }, [codexConfig, refreshCodexConfig]);

  const startThreadWithConfigRecovery = useCallback(async (params?: { cwd?: string }) => {
    try {
      return await clientRef.current.startThread({
        ...params,
        dynamicTools: DESKTOP_DYNAMIC_TOOL_SPECS,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isLegacyCollabConfigError(msg)) {
        throw err;
      }

      const configPath = await resolveLegacyCollabConfigPath({
        fallbackPath: extractLegacyCollabConfigPathFromError(msg),
        force: true,
      });
      throw new Error(
        configPath
          ? `Your config at ${configPath} still uses [features].collab. Remove it and use [features].multi_agent instead.`
          : 'Your config.toml still uses [features].collab. Remove it and use [features].multi_agent instead.',
      );
    }
  }, [resolveLegacyCollabConfigPath]);

  const resolveDynamicToolCwd = useCallback((threadId: string): string | null => {
    if (threadDetailRef.current?.id === threadId && threadDetailRef.current.cwd) {
      return threadDetailRef.current.cwd;
    }

    const cached = threadDetailCacheRef.current.get(threadId);
    if (cached?.cwd) {
      return cached.cwd;
    }

    const thread = threadsRef.current.find((entry) => entry.id === threadId);
    return thread?.cwd ?? null;
  }, []);

  const tryHandleBuiltinDynamicToolCall = useCallback(async (request: DynamicToolCallRequest): Promise<boolean> => {
    const response = await executeDesktopDynamicToolCall(request, resolveDynamicToolCwd(request.threadId));
    if (!response) {
      return false;
    }

    try {
      await clientRef.current.respondToDynamicToolCall(request.requestId, response.contentItems, response.success);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to respond to dynamic tool call: ${msg}`, type: 'error' });
      return false;
    }
  }, [resolveDynamicToolCwd]);

  useEffect(() => {
    tryHandleBuiltinDynamicToolCallRef.current = tryHandleBuiltinDynamicToolCall;
  }, [tryHandleBuiltinDynamicToolCall]);

  const writeConfigValueWithFallback = useCallback(async (primaryKey: string, fallbackKey: string | null, value: unknown) => {
    try {
      await clientRef.current.writeConfigValue(primaryKey, value);
    } catch (primaryErr) {
      if (!fallbackKey) throw primaryErr;
      await clientRef.current.writeConfigValue(fallbackKey, value);
    }
  }, []);

  const handleAutonomyModeChange = useCallback(async (nextMode: string) => {
    if (isUpdatingAutonomy) return;
    if (nextMode === 'custom') {
      setToast({ msg: 'Custom mode reflects a non-standard approval/sandbox combination. Edit config.toml if you need a bespoke setup.', type: 'info' });
      return;
    }
    if (!(nextMode in AUTONOMY_PRESETS)) return;
    if (nextMode === autonomyMode) return;

    const preset = AUTONOMY_PRESETS[nextMode as Exclude<AutonomyModeValue, 'custom'>];
    const previousMode = autonomyMode;

    setAutonomyMode(nextMode as AutonomyModeValue);
    setIsUpdatingAutonomy(true);
    try {
      if (clientRef.current.state === 'connected') {
        await writeConfigValueWithFallback('approval_policy', 'approvalPolicy', preset.approvalPolicy);
        await writeConfigValueWithFallback('sandbox_mode', 'sandboxMode', preset.sandboxMode);
        const refreshedConfig = await refreshCodexConfig();
        setAutonomyMode(deriveAutonomyModeFromConfig(refreshedConfig));
      } else {
        await invoke('write_codex_config', { key: 'approval_policy', value: preset.approvalPolicy });
        await invoke('write_codex_config', { key: 'sandbox', value: preset.sandboxMode });
      }
      setToast({
        msg: `Permission mode updated to ${formatAutonomyModeLabel(nextMode as AutonomyModeValue)}.`,
        type: 'info',
      });
    } catch (err) {
      if (clientRef.current.state === 'connected') {
        const refreshedConfig = await refreshCodexConfig();
        setAutonomyMode(refreshedConfig ? deriveAutonomyModeFromConfig(refreshedConfig) : previousMode);
      } else {
        setAutonomyMode(previousMode);
      }
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to update permission mode: ${msg}`, type: 'error' });
    } finally {
      setIsUpdatingAutonomy(false);
    }
  }, [autonomyMode, isUpdatingAutonomy, refreshCodexConfig, writeConfigValueWithFallback]);

  const autonomyOptions = useMemo(() => {
    const baseOptions = [
      { value: 'suggest', label: 'Suggest' },
      { value: 'auto-edit', label: 'Auto Edit' },
      { value: 'full-auto', label: 'Full Auto' },
    ];
    return autonomyMode === 'custom'
      ? [...baseOptions, { value: 'custom', label: 'Custom' }]
      : baseOptions;
  }, [autonomyMode]);

  const handleConnect = async (connectUrl?: string) => {
    try {
      await clientRef.current.connect(connectUrl ?? url, { autoReconnect: true });
      const result = await clientRef.current.listThreads({ limit: 50 });
      startTransition(() => {
        setThreads(result.data);
        setNextCursor(result.nextCursor);
      });
      let availableModels: ModelInfo[] = [];
      try {
        const m = await clientRef.current.listModels();
        availableModels = m;
        setModels(m);
      } catch { /* models optional */ }
      let account: AccountInfo = null;
      try {
        account = await refreshAccountInfo();
      } catch { /* account optional */ }
      try {
        await refreshMcpServers();
      } catch { /* mcp optional */ }
      const config = await refreshCodexConfig();
      const configuredModel = getStringConfigValue(config, 'model');
      const nextModel = pickPreferredCodexModel(
        filterCodexModelsForAccount(availableModels, account),
        configuredModel,
      );
      const activeThreadId = selectedThreadRef.current;
      if (nextModel && (!activeThreadId || getThreadProvider(activeThreadId) !== 'claude')) {
        setSelectedModel(nextModel);
      }
    } catch { /* handled by state listener */ }
  };

  const extractPort = useCallback((wsUrl: string): number => {
    try {
      const u = new URL(wsUrl);
      return parseInt(u.port, 10) || 4500;
    } catch {
      return 4500;
    }
  }, []);

  const waitForServerReady = useCallback(async (wsUrl: string, maxAttempts = 20, delayMs = 500): Promise<boolean> => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(wsUrl);
          const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 2000);
          ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(); };
          ws.onerror = () => { clearTimeout(timer); ws.close(); reject(new Error('error')); };
        });
        return true;
      } catch {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return false;
  }, []);

  const startHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = setInterval(async () => {
      if (!serverManagedRef.current) return;
      const currentUrl = urlRef.current;
      try {
        const status = await invoke<{ running: boolean; pid: number | null }>('get_codex_server_status');
        setServerRunning(status.running);
        if (!status.running) {
          setServerLog('Server process exited, restarting...');
          try {
            const port = extractPort(currentUrl);
            const restart = await invoke<{ running: boolean; pid: number | null }>('start_codex_server', { port });
            if (restart.running) {
              setServerLog('Server restarted, reconnecting...');
              const ready = await waitForServerReady(currentUrl, 15, 600);
              if (ready) {
                setServerLog('');
                await handleConnect(currentUrl);
              } else {
                setServerLog('Server restarted but connection timed out');
              }
            }
          } catch (err) {
            setServerLog(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (clientRef.current.state !== 'connected' && clientRef.current.state !== 'connecting') {
          setServerLog('Connection lost, reconnecting...');
          try {
            await handleConnect(currentUrl);
            setServerLog('');
          } catch {
            // auto-reconnect in CodexClient will keep trying
          }
        }
      } catch {
        // invoke failed, tauri layer issue
      }
    }, 5000);
  }, [extractPort, waitForServerReady, handleConnect]);

  useEffect(() => { codexBinPathRef.current = codexBinPath; }, [codexBinPath]);

  const fetchCodexCandidates = useCallback(async () => {
    try {
      const paths = await invoke<string[]>('find_codex_candidates');
      setCodexCandidates(paths);
    } catch { /* ignore */ }
  }, []);

  const handleBrowseCodexBinary = useCallback(async () => {
    try {
      const selected = await invoke<string | null>('pick_codex_binary');
      if (selected) {
        setCodexBinPath(selected);
      }
    } catch { /* ignore */ }
  }, [setCodexBinPath]);

  const handleStartServer = useCallback(async () => {
    setServerStarting(true);
    setServerLog('Starting codex server...');
    try {
      const port = extractPort(url);
      const codexPath = codexBinPathRef.current || undefined;
      const result = await invoke<{ running: boolean; pid: number | null }>('start_codex_server', { port, codexPath });
      if (result.running) {
        serverManagedRef.current = true;
        setServerRunning(true);
        setServerLog('Server started, waiting for it to be ready...');
        const ready = await waitForServerReady(url, 20, 500);
        if (ready) {
          setServerLog('Connecting...');
          try {
            await handleConnect(url);
            setShowServerDialog(false);
            setServerLog('');
            startHeartbeat();
          } catch {
            setServerLog('Server is ready but connection failed. Click "Retry Connection" to try again.');
          }
        } else {
          setServerLog('Server started but not responding. Try again or check logs.');
        }
      } else {
        setServerLog('Failed to start server process.');
      }
    } catch (err) {
      setServerLog(`Error: ${err instanceof Error ? err.message : String(err)}`);
      fetchCodexCandidates();
    } finally {
      setServerStarting(false);
    }
  }, [url, extractPort, waitForServerReady, handleConnect, startHeartbeat, fetchCodexCandidates]);

  const handleStopServer = useCallback(async () => {
    try {
      await invoke('stop_codex_server');
      serverManagedRef.current = false;
      setServerRunning(false);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    } catch { /* ignore */ }
  }, []);

  // Auto-connect on startup: try connecting, if fails auto-start server
  useEffect(() => {
    let cancelled = false;

    const autoStartServer = async (retries = 2) => {
      if (cancelled) return;
      setServerStarting(true);
      for (let attempt = 0; attempt <= retries && !cancelled; attempt++) {
        try {
          const port = extractPort(url);
          const codexPath = codexBinPathRef.current || undefined;
          const result = await invoke<{ running: boolean; pid: number | null }>('start_codex_server', { port, codexPath });
          if (cancelled) return;
          if (result.running) {
            serverManagedRef.current = true;
            setServerRunning(true);
            const ready = await waitForServerReady(url, 20, 500);
            if (cancelled) return;
            if (ready) {
              try {
                await handleConnect(url);
                if (!cancelled) {
                  setServerLog('');
                  startHeartbeat();
                  return;
                }
              } catch {
                if (!cancelled && attempt < retries) {
                  await new Promise(r => setTimeout(r, 1500));
                  continue;
                }
              }
            } else if (attempt < retries) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
          } else if (attempt < retries) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
        } catch {
          if (!cancelled) fetchCodexCandidates();
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
        }
      }
      if (!cancelled) setServerStarting(false);
    };

    (async () => {
      // First try a quick probe without auto-reconnect to avoid flooding errors
      try {
        await clientRef.current.connect(url, { autoReconnect: false });
        // Connection succeeded - server is already running
        if (cancelled) return;
        const result = await clientRef.current.listThreads({ limit: 50 });
        startTransition(() => {
          setThreads(result.data);
          setNextCursor(result.nextCursor);
        });
        let availableModels: ModelInfo[] = [];
        try {
          const m = await clientRef.current.listModels();
          availableModels = m;
          setModels(m);
        } catch { /* models optional */ }
        let account: AccountInfo = null;
        try {
          account = await refreshAccountInfo();
        } catch { /* account optional */ }
        try {
          await refreshMcpServers();
        } catch { /* mcp optional */ }
        const config = await refreshCodexConfig();
        const configuredModel = getStringConfigValue(config, 'model');
        const nextModel = pickPreferredCodexModel(
          filterCodexModelsForAccount(availableModels, account),
          configuredModel,
        );
        const activeThreadId = selectedThreadRef.current;
        if (nextModel && (!activeThreadId || getThreadProvider(activeThreadId) !== 'claude')) {
          setSelectedModel(nextModel);
        }
        // Check if we're managing this server process
        try {
          const status = await invoke<{ running: boolean; pid: number | null }>('get_codex_server_status');
          if (!cancelled && status.running) {
            serverManagedRef.current = true;
            setServerRunning(true);
            startHeartbeat();
          }
        } catch { /* ignore */ }
      } catch {
        // Connection failed - stop the client to prevent reconnect loops
        clientRef.current.disconnect();
        if (cancelled) return;
        try {
          const status = await invoke<{ running: boolean; pid: number | null }>('get_codex_server_status');
          if (cancelled) return;
          if (status.running) {
            serverManagedRef.current = true;
            setServerRunning(true);
            const ready = await waitForServerReady(url, 15, 600);
            if (!cancelled && ready) {
              try {
                await handleConnect(url);
                if (!cancelled) {
                  setServerLog('');
                  startHeartbeat();
                }
              } catch { /* auto-reconnect will handle */ }
            }
          } else {
            // Server not running - auto-start it
            await autoStartServer();
          }
        } catch {
          if (!cancelled) {
            await autoStartServer();
          }
        }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  const handleDisconnect = () => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    clientRef.current.disconnect();
    setThreads([]);
    setSelectedThread(null);
    setThreadDetail(null);
    setModels([]);
    setIsSending(false);
    setIsAgentActive(false);
    setSidebarView('threads');
    setApprovals([]);
    setUserInputRequests([]);
    setMcpElicitationRequests([]);
    setDynamicToolCallRequests([]);
    setAuthRefreshRequests([]);
    setPendingMessages([]);
    setNextCursor(null);
    setAccountInfo(null);
    setRateLimits(null);
    setCodexConfig(null);
    setIsUpdatingAutonomy(false);
    activeTurnIdRef.current = null;
  };

  const handleListThreads = useCallback(async () => {
    try {
      const [codexResult, claudeThreads] = await Promise.all([
        connState === 'connected'
          ? clientRef.current.listThreads({ limit: 50, archived: showArchived })
          : Promise.resolve({ data: [] as ThreadSummary[], nextCursor: null as string | null }),
        showArchived ? Promise.resolve([] as ThreadSummary[]) : claudeClientRef.current.listSessions(),
      ]);
      const mergedThreads = [...codexResult.data, ...claudeThreads]
        .reduce<ThreadSummary[]>((acc, thread) => {
          if (!acc.some((entry) => entry.id === thread.id)) {
            acc.push(thread);
          }
          return acc;
        }, [])
        .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
      const configs = await Promise.all(
        mergedThreads.map((thread) => getChatConfig(thread.id).catch(() => null)),
      );
      const hydratedThreads = mergedThreads.map((thread, index) => applyThreadConfig(thread, configs[index]));
      startTransition(() => {
        setThreads(hydratedThreads);
        setNextCursor(codexResult.nextCursor);
      });
    } catch { /* ignore */ }
  }, [connState, showArchived]);

  const applyNewThreadSelection = useCallback((thread: ThreadSummary, fallbackCwd?: string) => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    const initialDetail = { ...thread, turns: [] } as ThreadDetail;
    activeTurnIdRef.current = null;
    selectedThreadRef.current = thread.id;
    threadDetailRef.current = initialDetail;
    pendingDeltaEventsRef.current = [];
    setThreadLoadError(null);
    setIsThreadLoading(false);
    setIsThreadTurnsLoading(false);
    setIsAgentActive(false);
    setIsSending(false);
    setSidebarView('threads');
    setEditingName(false);
    setOverlayView(null);
    setShowRawJson(false);
    setSelectedThread(thread.id);
    setThreadDetail(initialDetail);
    startTransition(() => {
      setThreads((prev) => [thread, ...prev.filter((entry) => entry.id !== thread.id)]);
    });
    if (thread.cwd || fallbackCwd) {
      setActiveProjectCwd(thread.cwd ?? fallbackCwd ?? null);
    }
    setTimeout(() => composerRef.current?.focus(), 100);
  }, []);

  useEffect(() => {
    if (connState === 'connected') {
      handleListThreads();
      void refreshKanbanThreadIds();
    }
  }, [showArchived, connState, handleListThreads, refreshKanbanThreadIds]);

  const handleLoadMoreThreads = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await clientRef.current.listThreads({ limit: 50, cursor: nextCursor, archived: showArchived });
      const configs = await Promise.all(
        result.data.map((thread) => getChatConfig(thread.id).catch(() => null)),
      );
      const hydratedThreads = result.data.map((thread, index) => applyThreadConfig(thread, configs[index]));
      startTransition(() => {
        setThreads((prev) => [...prev, ...hydratedThreads]);
        setNextCursor(result.nextCursor);
      });
    } catch { /* ignore */ }
    setLoadingMore(false);
  }, [loadingMore, nextCursor, showArchived]);

  const handleNewThread = useCallback((cwd?: string) => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    selectedThreadRef.current = null;
    threadDetailRef.current = null;
    pendingDeltaEventsRef.current = [];
    activeTurnIdRef.current = null;

    setSelectedThread(null);
    setThreadDetail(null);
    setThreadLoadError(null);
    setIsThreadLoading(false);
    setIsThreadTurnsLoading(false);
    setIsAgentActive(false);
    setIsSending(false);
    setEditingName(false);
    setShowRawJson(false);
    setOverlayView(null);
    setSidebarView('threads');
    setProjectDropdownOpen(false);
    setThreadCtxMenu(null);
    setFolderMenu(null);

    if (cwd) {
      setActiveProjectCwd(cwd);
    }

    setTimeout(() => composerRef.current?.focus(), 100);
  }, []);

  const handleReadThread = useCallback(async (id: string) => {
    if (
      selectedThreadRef.current === id &&
      threadDetailRef.current?.id === id &&
      !isThreadLoading &&
      !isThreadTurnsLoading
    ) {
      return;
    }

    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    const cachedDetail = getCachedThreadDetail(id);
    const threadSummary = threadsRef.current.find((thread) => thread.id === id) ?? null;
    const shellDetail = createThreadShell(threadSummary ?? cachedDetail);
    const isClaudeThread =
      threadSummary?.modelProvider === 'claude' ||
      cachedDetail?.modelProvider === 'claude';
    const configPromise = getChatConfig(id).catch(() => null);

    selectedThreadRef.current = id;
    threadDetailRef.current = shellDetail;
    pendingDeltaEventsRef.current = [];
    setSelectedThread(id);
    setOverlayView(null);
    setSidebarView('threads');
    setShowRawJson(false);
    setThreadLoadError(null);
    setThreadDetail(shellDetail);
    setIsThreadLoading(!shellDetail);
    setIsThreadTurnsLoading(!!shellDetail);
    setIsAgentActive(shellDetail?.status?.type === 'active');

    if (shellDetail?.cwd) {
      setActiveProjectCwd(shellDetail.cwd);
    }

    void configPromise.then((config) => {
      if (!config || selectedThreadRef.current !== id) {
        if (isClaudeThread && selectedThreadRef.current === id) {
          setSelectedModel(claudeClientRef.current.getDefaultModel());
        }
        return;
      }

      if (isClaudeThread) {
        const nextClaudeModel = isClaudeModel(config.model)
          ? normalizeClaudeModelId(config.model)
          : claudeClientRef.current.getDefaultModel();
        setSelectedModel(nextClaudeModel);
      } else if (config.model) {
        setSelectedModel(config.model);
      }
      if (config.reasoning) {
        setReasoning(config.reasoning as ReasoningLevel);
      }
      const enrichedShellDetail = shellDetail ? applyThreadConfig(shellDetail, config) : shellDetail;
      if (selectedThreadRef.current === id && enrichedShellDetail) {
        threadDetailRef.current = enrichedShellDetail;
        setThreadDetail(enrichedShellDetail);
      }
    });

    const loadThreadShell = async () => {
      const lightResult = await clientRef.current.readThread(id, false);
      const config = await configPromise;
      const nextShell: ThreadDetail = applyThreadConfig({
        ...lightResult,
        turns: [],
      }, config);

      if (selectedThreadRef.current === id) {
        threadDetailRef.current = nextShell;
        setThreadDetail(nextShell);
        setIsThreadLoading(false);
        setIsThreadTurnsLoading(true);
        setIsAgentActive(nextShell.status?.type === 'active');
        if (nextShell.cwd) {
          setActiveProjectCwd(nextShell.cwd);
        }
      }

      return nextShell;
    };

    const loadFreshThread = async () => {
      try {
        if (isClaudeThread) {
          const [detail, config] = await Promise.all([
            claudeClientRef.current.getSession(id),
            configPromise,
          ]);
          if (!detail) {
            throw new Error('Failed to load Claude thread');
          }
          const enrichedDetail = applyThreadConfig(detail, config);

          cacheThreadDetail(enrichedDetail);
          if (selectedThreadRef.current === id) {
            threadDetailRef.current = enrichedDetail;
            setThreadDetail(enrichedDetail);
            setIsThreadLoading(false);
            setIsThreadTurnsLoading(false);
            setIsAgentActive(claudeClientRef.current.isStreaming() && selectedThreadRef.current === id);
            if (enrichedDetail.cwd) {
              setActiveProjectCwd(enrichedDetail.cwd);
            }
          }
          return;
        }

        if (!shellDetail) {
          await loadThreadShell();
        }

        const result = await refreshThreadDetail(id);
        if (!result) {
          throw new Error('Failed to load thread');
        }

        if (selectedThreadRef.current === id) {
          setIsThreadLoading(false);
          setIsThreadTurnsLoading(false);
        }

        if (result.cwd) {
          setActiveProjectCwd(result.cwd);
        }
        if (result.status?.type === 'active') {
          startPolling(id);
        }
      } catch (err) {
        if (selectedThreadRef.current === id) {
          const msg = err instanceof Error ? err.message : String(err);
          threadDetailRef.current = cachedDetail;
          setThreadDetail(cachedDetail);
          setThreadLoadError(msg);
          setIsThreadLoading(false);
          setIsThreadTurnsLoading(false);
          setIsAgentActive(cachedDetail?.status?.type === 'active');
        }
      }
    };

    void loadFreshThread();
  }, [cacheThreadDetail, getCachedThreadDetail, isThreadLoading, isThreadTurnsLoading, refreshThreadDetail, setReasoning, startPolling]);

  const handleOpenInExplorer = useCallback(async (cwd: string) => {
    try {
      await invoke('open_in_explorer', { path: cwd });
    } catch { /* ignore */ }
    setFolderMenu(null);
  }, []);

  const handleAddProject = useCallback(async () => {
    try {
      const selected = await invoke<string | null>('pick_folder');
      if (selected) {
        const normalized = normalizeCwd(selected);
        const alreadyExists = addedProjects.some((project) => normalizeCwd(project) === normalized);
        if (!alreadyExists) {
          setAddedProjects([...addedProjects, selected]);
        }
        if (hiddenProjects.some((project) => normalizeCwd(project) === normalized)) {
          setHiddenProjects(hiddenProjects.filter((project) => normalizeCwd(project) !== normalized));
        }
        setActiveProjectCwd(selected);
      }
    } catch { /* ignore */ }
  }, [addedProjects, hiddenProjects, setAddedProjects, setHiddenProjects]);

  const handleRemoveProject = useCallback((cwd: string) => {
    const normalized = normalizeCwd(cwd);
    const nextAddedProjects = addedProjects.filter((project) => normalizeCwd(project) !== normalized);
    setAddedProjects(nextAddedProjects);
    if (!hiddenProjects.some((project) => normalizeCwd(project) === normalized)) {
      setHiddenProjects([...hiddenProjects, cwd]);
    }
    if (normalizeCwd(activeProjectCwd) === normalized) {
      setActiveProjectCwd(nextAddedProjects[0] ?? null);
    }
    setFolderMenu(null);
  }, [activeProjectCwd, addedProjects, hiddenProjects, setAddedProjects, setHiddenProjects]);

  const handleRemoveFolder = useCallback((cwd: string) => {
    startTransition(() => {
      setThreads(prev => prev.filter(t => t.cwd !== cwd));
    });
    setFolderMenu(null);
  }, []);

  const handleRenameFolder = useCallback((cwd: string) => {
    setRenamingFolder(cwd);
    setFolderMenu(null);
  }, []);

  const handleSaveFolderAlias = useCallback((cwd: string, alias: string) => {
    const trimmed = alias.trim();
    if (trimmed) {
      setFolderAlias({ ...folderAlias, [cwd]: trimmed });
    } else {
      const next = { ...folderAlias };
      delete next[cwd];
      setFolderAlias(next);
    }
    setRenamingFolder(null);
  }, [folderAlias, setFolderAlias]);

  const enqueuePendingMessage = useCallback((threadId: string, text: string) => {
    const id = `pending-${threadId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPendingMessages((prev) => [...prev, { id, threadId, text }]);
  }, []);

  const handleSendMessage = useCallback(async (text: string): Promise<boolean> => {
    if (!selectedThread || !threadDetail) return false;
    if (selectedModel && !isClaudeModel(selectedModel) && isBlockedCodexModelForAccount(selectedModel, accountInfo)) {
      setToast({ msg: getBlockedCodexModelMessage(selectedModel), type: 'error' });
      return false;
    }
    setIsSending(true);
    setThreadDetail((prev) => {
      if (!prev) return prev;
      const optimisticItem = {
        type: 'userMessage' as const,
        id: `optimistic-${Date.now()}`,
        content: [{ type: 'text', text }],
      };
      const turns = prev.turns ? [...prev.turns] : [];
      const optimisticTurn = {
        id: `optimistic-turn-${Date.now()}`,
        status: 'inProgress' as const,
        items: [optimisticItem],
      };
      turns.push(optimisticTurn);
      return { ...prev, turns };
    });
    try {
      const opts: { model?: string; reasoningEffort?: string } = {};
      if (selectedModel) opts.model = selectedModel;
      if (reasoning) opts.reasoningEffort = reasoning;
      const startedTurn = await clientRef.current.startTurn(selectedThread, text, opts);
      activeTurnIdRef.current = startedTurn.id;
      setThreadDetail((prev) =>
        applyServerEventToThreadDetail(prev, 'turn/started', {
          threadId: selectedThread,
          turn: startedTurn,
        } as Record<string, unknown>),
      );
      setIsAgentActive(true);
      startPolling(selectedThread);
      return true;
    } catch (err) {
      await refreshThreadDetail(selectedThread);
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Send failed: ${msg}`, type: 'error' });
      return false;
    }
    finally { setIsSending(false); }
  }, [accountInfo, isClaudeModel, selectedThread, threadDetail, selectedModel, reasoning, startPolling, refreshThreadDetail]);

  const handleInterrupt = useCallback(async () => {
    if (isClaudeModel(selectedModel)) {
      await claudeClientRef.current.interrupt();
      setIsAgentActive(false);
      return;
    }
    if (!selectedThread) return;
    const turnId = activeTurnIdRef.current;
    const lastTurn = threadDetail?.turns?.[threadDetail.turns.length - 1];
    const tid = turnId ?? lastTurn?.id;
    if (!tid) return;
    try {
      await clientRef.current.interruptTurn(selectedThread, tid);
      setIsAgentActive(false);
    } catch { /* ignore */ }
  }, [selectedThread, threadDetail, selectedModel, isClaudeModel]);

  // ── Claude in-thread helpers ──

  const extractThreadHistory = useCallback((): CarryoverMessage[] => {
    const detail = threadDetailRef.current;
    if (!detail?.turns) return [];
    const msgs: CarryoverMessage[] = [];
    for (const turn of detail.turns) {
      for (const item of turn.items) {
        if (item.type === 'userMessage') {
          const text = item.content?.map((contentItem) => typeof contentItem === 'string' ? contentItem : contentItem.text ?? '').join('') ?? '';
          if (text) msgs.push({ role: 'user', content: text });
        } else if (item.type === 'agentMessage' && item.text) {
          msgs.push({ role: 'assistant', content: item.text });
        }
      }
    }
    return msgs;
  }, []);

  const buildModelSwitchPreview = useCallback((nextModel: string): ModelSwitchPreview | null => {
    if (!nextModel) {
      return null;
    }

    const targetProvider: ThreadProviderId = isClaudeModel(nextModel) ? 'claude' : 'codex';
    const targetProviderLabel = getThreadProviderLabel(targetProvider);
    const currentThreadId = selectedThreadRef.current;

    if (!currentThreadId) {
      return {
        mode: 'fresh',
        currentProviderLabel: null,
        targetProviderLabel,
        turnCount: 0,
        willCompact: false,
        compactedMessages: 0,
      };
    }

    const currentProvider = normalizeThreadProvider(getThreadProvider(currentThreadId));
    const currentProviderLabel = getThreadProviderLabel(currentProvider);
    const turnCount = threadDetailRef.current?.turns?.length ?? 0;

    if (currentProvider === targetProvider) {
      return {
        mode: 'same-thread',
        currentProviderLabel,
        targetProviderLabel,
        turnCount,
        willCompact: false,
        compactedMessages: 0,
      };
    }

    const prepared = prepareCarryoverHistory(extractThreadHistory());
    return {
      mode: 'handoff',
      currentProviderLabel,
      targetProviderLabel,
      turnCount,
      willCompact: prepared.compacted,
      compactedMessages: prepared.compactedMessages,
    };
  }, [extractThreadHistory, getThreadProvider, isClaudeModel]);

  const handleSelectModel = useCallback((nextModel: string) => {
    if (!nextModel) {
      return;
    }

    setShowModelPicker(false);
    if (nextModel === selectedModel) {
      setModelSwitchPreview(null);
      return;
    }

    setSelectedModel(nextModel);
    setModelSwitchPreview(buildModelSwitchPreview(nextModel));
  }, [buildModelSwitchPreview, selectedModel]);

  const handleClaudeSendInThread = useCallback(async (
    text: string,
    options?: {
      threadId?: string;
      history?: CarryoverMessage[];
      workingDirectory?: string | null;
    },
  ): Promise<boolean> => {
    const targetThreadId = options?.threadId ?? selectedThread;
    if (!targetThreadId) {
      return false;
    }

    const priorHistory = options?.history ?? extractThreadHistory();
    const threadConfig = await getChatConfig(targetThreadId).catch(() => null);
    const workingDirectory = options?.workingDirectory ?? threadDetailRef.current?.cwd ?? activeProjectCwd ?? null;
    const persistedClaudeModel = isClaudeModel(threadConfig?.model)
      ? normalizeClaudeModelId(threadConfig?.model)
      : claudeClientRef.current.getDefaultModel();
    const effectiveClaudeModel = normalizeClaudeModelId(
      isClaudeModel(selectedModel)
        ? selectedModel
        : persistedClaudeModel,
    );
    if (effectiveClaudeModel !== selectedModel) {
      setSelectedModel(effectiveClaudeModel);
    }
    const userMessageId = createClaudeMessageId('user');
    const assistantMessageId = createClaudeMessageId('assistant');
    void saveChatConfig({
      thread_id: targetThreadId,
      model: effectiveClaudeModel,
      reasoning,
    }).catch(() => {});
    await addClaudeMessage({
      id: userMessageId,
      sessionId: targetThreadId,
      role: 'user',
      content: text,
    }).catch(() => {});
    void setSettingJson('claude-debug-last-stage', {
      stage: 'handleClaudeSendInThread:start',
      targetThreadId,
      selectedModel: effectiveClaudeModel,
      selectedThread,
      workingDirectory,
      hasResumeSession: !!threadConfig?.claude_session_id,
      ts: Date.now(),
    });

    setIsSending(true);
    setIsAgentActive(true);

    setThreadDetail((prev) => {
      if (!prev || prev.id !== targetThreadId) return prev;
      const turns = prev.turns ? [...prev.turns] : [];
      turns.push({
        id: `claude-turn-${Date.now()}`,
        status: 'inProgress',
        items: [{ type: 'userMessage', id: userMessageId, content: [{ type: 'text', text }] }],
      });
      return { ...prev, turns };
    });

    let accumulated = '';
    const sessionId = `claude-inline-${Date.now()}`;
    let chunkUnlisten: (() => void) | null = null;
    let doneUnlisten: (() => void) | null = null;
    let errorUnlisten: (() => void) | null = null;

    try {
      void setSettingJson('claude-debug-last-stage', {
        stage: 'handleClaudeSendInThread:listening',
        sessionId,
        targetThreadId,
        ts: Date.now(),
      });
      chunkUnlisten = await listen<{ session_id: string; event_type: string; data: string }>('claude-stream-chunk', (event) => {
        if (event.payload.session_id !== sessionId) return;
        if (event.payload.event_type === 'text') {
          accumulated += event.payload.data;
          setThreadDetail((prev) => {
            if (!prev?.turns || prev.id !== targetThreadId) return prev;
            const turns = [...prev.turns];
            const lastTurn = turns[turns.length - 1];
            if (!lastTurn) return prev;
            const hasAgent = lastTurn.items.some(it => it.type === 'agentMessage');
            if (hasAgent) {
              turns[turns.length - 1] = { ...lastTurn, items: lastTurn.items.map(it => it.type === 'agentMessage' ? { ...it, text: accumulated } : it) };
            } else {
              turns[turns.length - 1] = { ...lastTurn, items: [...lastTurn.items, { type: 'agentMessage', id: assistantMessageId, text: accumulated }] };
            }
            return { ...prev, turns };
          });
        } else if (event.payload.event_type === 'error') {
          setToast({ msg: `Claude error: ${event.payload.data}`, type: 'error' });
        }
      });

      doneUnlisten = await listen<{
        session_id: string;
        input_tokens?: number;
        output_tokens?: number;
        model?: string;
        stop_reason?: string;
        claude_session_id?: string | null;
      }>('claude-stream-done', (event) => {
        if (event.payload.session_id !== sessionId) return;
        if (event.payload.claude_session_id) {
          void saveChatConfig({ thread_id: targetThreadId, claude_session_id: event.payload.claude_session_id });
        }
        if (accumulated.trim()) {
          void addClaudeMessage({
            id: assistantMessageId,
            sessionId: targetThreadId,
            role: 'assistant',
            content: accumulated,
            tokenUsage: {
              input_tokens: event.payload.input_tokens ?? 0,
              output_tokens: event.payload.output_tokens ?? 0,
            },
          }).catch(() => {});
        }
        setThreadDetail((prev) => {
          if (!prev?.turns || prev.id !== targetThreadId) return prev;
          const turns = [...prev.turns];
          const last = turns[turns.length - 1];
          if (last?.status === 'inProgress') {
            turns[turns.length - 1] = { ...last, status: 'completed' };
          }
          return { ...prev, turns };
        });
        setIsAgentActive(false);
        setIsSending(false);
      });

      errorUnlisten = await listen<{ session_id: string; error: string }>('claude-stream-error', (event) => {
        if (event.payload.session_id !== sessionId) return;
        setToast({ msg: `Claude error: ${event.payload.error}`, type: 'error' });
        setThreadDetail((prev) => {
          if (!prev?.turns || prev.id !== targetThreadId) return prev;
          const turns = [...prev.turns];
          const last = turns[turns.length - 1];
          if (last?.status === 'inProgress') {
            turns[turns.length - 1] = { ...last, status: 'failed' };
          }
          return { ...prev, turns };
        });
        setIsAgentActive(false);
        setIsSending(false);
      });

      void setSettingJson('claude-debug-last-stage', {
        stage: 'handleClaudeSendInThread:invoke',
        sessionId,
        targetThreadId,
        selectedModel: effectiveClaudeModel,
        ts: Date.now(),
      });
      await invoke('claude_send_message', {
        config: {
          model: effectiveClaudeModel,
          prompt: text,
          history: priorHistory,
          system_prompt: null,
          session_id: sessionId,
          claude_session_id: threadConfig?.claude_session_id ?? null,
          working_directory: workingDirectory,
          permission_mode: 'acceptEdits',
          env: {},
        },
      });
    } catch (e) {
      void setSettingJson('claude-debug-last-stage', {
        stage: 'handleClaudeSendInThread:catch',
        sessionId,
        targetThreadId,
        error: String(e),
        ts: Date.now(),
      });
      console.error('Claude send failed', e);
      setToast({ msg: `Claude error: ${String(e)}`, type: 'error' });
      setThreadDetail((prev) => {
        if (!prev?.turns || prev.id !== targetThreadId) return prev;
        const turns = [...prev.turns];
        const last = turns[turns.length - 1];
        if (last?.status === 'inProgress') {
          turns[turns.length - 1] = { ...last, status: 'failed' };
        }
        return { ...prev, turns };
      });
      setIsAgentActive(false);
      setIsSending(false);
    } finally {
      chunkUnlisten?.();
      doneUnlisten?.();
      errorUnlisten?.();
    }

    return true;
  }, [activeProjectCwd, extractThreadHistory, reasoning, selectedModel, selectedThread, isClaudeModel]);

  const handleApproval = useCallback(async (request: ApprovalRequest, decision: ApprovalDecision) => {
    try {
      if (request.method === 'item/permissions/requestApproval') {
        if (decision === 'accept' || decision === 'acceptForSession') {
          await clientRef.current.respondToPermissionsRequest(
            request.requestId,
            request.rawPermissions ?? {},
            decision === 'acceptForSession' ? 'session' : 'turn',
          );
        } else {
          await clientRef.current.respondToPermissionsRequest(request.requestId, {}, 'turn');
        }
      } else {
        await clientRef.current.respondToApproval(request.requestId, decision);
      }
    } catch { /* ignore */ }
    setApprovals((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
  }, []);

  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        if (connState === 'connected') void handleNewThread();
      }
      if (e.key === 'Escape') {
        if (editingName) setEditingName(false);
      }
        const activeApproval = approvals.find((approval) => approval.threadId === selectedThread);
        if (activeApproval && !editingName && !(document.activeElement instanceof HTMLTextAreaElement) && !(document.activeElement instanceof HTMLInputElement)) {
          if (e.key === 'y' || e.key === 'Y') {
            e.preventDefault();
            void handleApproval(activeApproval, 'accept');
          } else if (e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            void handleApproval(activeApproval, 'acceptForSession');
          } else if (e.key === 'n' || e.key === 'N') {
            e.preventDefault();
            void handleApproval(activeApproval, 'decline');
          }
        }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>('.sidebar-search-input');
        searchInput?.focus();
      }
      if (e.key === '?' && !editingName && !(document.activeElement instanceof HTMLTextAreaElement) && !(document.activeElement instanceof HTMLInputElement)) {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [approvals, connState, editingName, handleApproval, handleNewThread, selectedThread]);

  const handleArchiveThread = useCallback(async (threadId: string) => {
    try {
      if (getThreadProvider(threadId) === 'claude') {
        await claudeClientRef.current.archiveSession(threadId);
      } else {
        await clientRef.current.archiveThread(threadId);
      }
      startTransition(() => {
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
      });
      setPendingMessages((prev) => prev.filter((message) => message.threadId !== threadId));
      if (selectedThread === threadId) {
        setSelectedThread(null);
        setThreadDetail(null);
      }
    } catch { /* ignore */ }
  }, [getThreadProvider, selectedThread]);

  const handleRenameThread = useCallback(async () => {
    if (!selectedThread || !editNameValue.trim()) return;
    try {
      if (getThreadProvider(selectedThread) === 'claude') {
        await claudeClientRef.current.renameSession(selectedThread, editNameValue.trim());
        setThreadDetail((prev) => (
          prev && prev.id === selectedThread
            ? { ...prev, name: editNameValue.trim(), preview: editNameValue.trim() }
            : prev
        ));
        startTransition(() => {
          setThreads((prev) => prev.map((thread) => (
            thread.id === selectedThread
              ? { ...thread, name: editNameValue.trim(), preview: editNameValue.trim() }
              : thread
          )));
        });
      } else {
        await clientRef.current.setThreadName(selectedThread, editNameValue.trim());
        await refreshThreadDetail(selectedThread);
        await handleListThreads();
      }
      setEditingName(false);
    } catch { /* ignore */ }
  }, [selectedThread, editNameValue, getThreadProvider, refreshThreadDetail, handleListThreads]);

  const handleRollback = useCallback(async (numTurns: number) => {
    if (!selectedThread) return;
    try {
      const result = await clientRef.current.rollbackThread(selectedThread, numTurns);
      setThreadDetail(result);
    } catch { /* ignore */ }
  }, [selectedThread]);

  const forkThreadById = useCallback(async (threadId: string) => {
    const forked = await clientRef.current.forkThread(threadId, { model: selectedModel || undefined });
    await handleListThreads();
    setSelectedThread(forked.id);
    setThreadDetail(forked);
    setSidebarView('threads');
    if (forked.cwd) {
      setActiveProjectCwd(forked.cwd);
    }
  }, [handleListThreads, selectedModel]);

  const handleForkThread = useCallback(async () => {
    if (!selectedThread) return;
    try {
      await forkThreadById(selectedThread);
    } catch { /* ignore */ }
  }, [forkThreadById, selectedThread]);

  const handleOpenThreadContextMenu = useCallback((threadId: string, x: number, y: number) => {
    setThreadCtxMenu({ threadId, x, y });
  }, []);

  const handlePinThread = useCallback((threadId: string) => {
    setPinnedThreads(
      pinnedThreads.includes(threadId)
        ? pinnedThreads.filter((id) => id !== threadId)
        : [...pinnedThreads, threadId],
    );
    setThreadCtxMenu(null);
  }, [pinnedThreads, setPinnedThreads]);

  const handleCtxRenameThread = useCallback(async (threadId: string) => {
    setThreadCtxMenu(null);
    const t = threadsRef.current.find((t) => t.id === threadId);
    setRenamingThreadId(threadId);
    setRenamingThreadValue(t?.name || t?.preview || '');
  }, []);

  const handleSaveThreadRename = useCallback(async () => {
    if (!renamingThreadId || !renamingThreadValue.trim()) {
      setRenamingThreadId(null);
      return;
    }
    try {
      if (getThreadProvider(renamingThreadId) === 'claude') {
        await claudeClientRef.current.renameSession(renamingThreadId, renamingThreadValue.trim());
        startTransition(() => {
          setThreads((prev) => prev.map((thread) => (
            thread.id === renamingThreadId
              ? { ...thread, name: renamingThreadValue.trim(), preview: renamingThreadValue.trim() }
              : thread
          )));
        });
        if (selectedThread === renamingThreadId) {
          setThreadDetail((prev) => (
            prev && prev.id === renamingThreadId
              ? { ...prev, name: renamingThreadValue.trim(), preview: renamingThreadValue.trim() }
              : prev
          ));
        }
      } else {
        await clientRef.current.setThreadName(renamingThreadId, renamingThreadValue.trim());
        await handleListThreads();
        if (selectedThread === renamingThreadId) {
          await refreshThreadDetail(renamingThreadId);
        }
      }
    } catch { /* ignore */ }
    setRenamingThreadId(null);
  }, [renamingThreadId, renamingThreadValue, getThreadProvider, selectedThread, handleListThreads, refreshThreadDetail]);

  const handleCancelThreadRename = useCallback(() => {
    setRenamingThreadId(null);
  }, []);

  const handleCtxArchiveThread = useCallback(async (threadId: string) => {
    setThreadCtxMenu(null);
    await handleArchiveThread(threadId);
  }, [handleArchiveThread]);

  const handleCtxForkThread = useCallback(async (threadId: string) => {
    setThreadCtxMenu(null);
    try {
      await forkThreadById(threadId);
    } catch { /* ignore */ }
  }, [forkThreadById]);

  const handleShellCommand = useCallback(async (command: string) => {
    if (!selectedThread) return;
    try {
      await clientRef.current.runShellCommand(selectedThread, command);
      startPolling(selectedThread);
    } catch { /* ignore */ }
  }, [selectedThread, startPolling]);

  const handleCompactThread = useCallback(async () => {
    if (!selectedThread) return;
    try {
      await clientRef.current.startThreadCompaction(selectedThread);
      startPolling(selectedThread);
    } catch { /* ignore */ }
  }, [selectedThread, startPolling]);

  const handleCommitChanges = useCallback(async () => {
    if (!selectedThread || !threadDetail) return;
    const text = 'Please review the current changes, propose a commit message, and ask for confirmation before running git commit.';
    composerRef.current?.setDraftText(text);
    setToast({ msg: 'Commit helper now prepares a safe prompt instead of committing immediately.', type: 'info' });
  }, [selectedThread, threadDetail]);

  const handleStartNewThreadWithMessage = useCallback(async (
    text: string,
    options?: {
      history?: CarryoverMessage[];
      sourceThreadId?: string | null;
    },
  ) => {
    if (selectedModel && !isClaudeModel(selectedModel) && isBlockedCodexModelForAccount(selectedModel, accountInfo)) {
      setToast({ msg: getBlockedCodexModelMessage(selectedModel), type: 'error' });
      return;
    }
    try {
      const carryoverPrompt = options?.history?.length
        ? buildCrossProviderCodexPrompt(text, options.history)
        : { prompt: text, compacted: false, compactedMessages: 0 };
      const sourceThreadNameSnapshot = options?.sourceThreadId
        ? threadsRef.current.find((entry) => entry.id === options.sourceThreadId)?.name
          ?? threadsRef.current.find((entry) => entry.id === options.sourceThreadId)?.preview
          ?? null
        : null;
      const preferredThreadName =
        options?.sourceThreadId
          ? threadsRef.current.find((entry) => entry.id === options.sourceThreadId)?.name
            ?? threadsRef.current.find((entry) => entry.id === options.sourceThreadId)?.preview
            ?? (text.length > 60 ? `${text.slice(0, 60)}...` : text)
          : null;
      const continuationConfig: ChatConfig | null = options?.sourceThreadId
        ? {
          thread_id: '',
          model: selectedModel,
          reasoning,
          continuation_source_thread_id: options.sourceThreadId,
          continuation_source_provider: 'claude',
          continuation_source_name: sourceThreadNameSnapshot,
          continuation_compacted_messages: carryoverPrompt.compactedMessages,
        }
        : null;
      const params = activeProjectCwd ? { cwd: activeProjectCwd } : undefined;
      const thread = await startThreadWithConfigRecovery(params);
      if (!thread?.id) {
        setToast({ msg: 'Failed to create thread: no ID returned', type: 'error' });
        return;
      }
      if (options?.sourceThreadId) {
        await saveChatConfig({
          thread_id: thread.id,
          model: selectedModel,
          reasoning,
          continuation_source_thread_id: options.sourceThreadId,
          continuation_source_provider: 'claude',
          continuation_source_name: sourceThreadNameSnapshot,
          continuation_compacted_messages: carryoverPrompt.compactedMessages,
        }).catch(() => {});
      }
      const nextThread = continuationConfig
        ? applyThreadConfig({ ...thread }, { ...continuationConfig, thread_id: thread.id })
        : thread;
      applyNewThreadSelection(nextThread, activeProjectCwd ?? undefined);

      const optimisticUserItem = {
        type: 'userMessage' as const,
        id: `optimistic-user-${Date.now()}`,
        content: [{ type: 'text', text }],
      };
      const optimisticTurn = {
        id: `optimistic-turn-${Date.now()}`,
        status: 'inProgress' as const,
        items: [optimisticUserItem],
      };
      setThreadDetail({ ...nextThread, turns: [optimisticTurn] } as ThreadDetail);
      threadDetailRef.current = { ...nextThread, turns: [optimisticTurn] } as ThreadDetail;
      setIsAgentActive(true);
      if (thread.cwd) setActiveProjectCwd(thread.cwd);
      if (preferredThreadName) {
        await clientRef.current.setThreadName(thread.id, preferredThreadName).catch(() => {});
        setThreadDetail((prev) => (
          prev && prev.id === thread.id
            ? { ...prev, name: preferredThreadName, preview: preferredThreadName }
            : prev
        ));
        startTransition(() => {
          setThreads((prev) => prev.map((entry) => (
            entry.id === thread.id
              ? { ...entry, name: preferredThreadName, preview: preferredThreadName }
              : entry
          )));
        });
      }

      const opts: { model?: string; reasoningEffort?: string } = {};
      if (selectedModel) opts.model = selectedModel;
      if (reasoning) opts.reasoningEffort = reasoning;
      const startedTurn = await clientRef.current.startTurn(thread.id, carryoverPrompt.prompt, opts);
      activeTurnIdRef.current = startedTurn.id;
      setThreadDetail((prev) =>
        applyServerEventToThreadDetail(prev, 'turn/started', {
          threadId: thread.id,
          turn: startedTurn,
        } as Record<string, unknown>),
      );
      startPolling(thread.id);
      if (carryoverPrompt.compacted) {
        setToast({
          msg: `Auto-compacted ${carryoverPrompt.compactedMessages} earlier messages for the model handoff.`,
          type: 'info',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Send failed: ${msg}`, type: 'error' });
      setIsAgentActive(false);
    }
  }, [accountInfo, isClaudeModel, selectedModel, reasoning, startPolling, applyNewThreadSelection, activeProjectCwd, startThreadWithConfigRecovery]);

  const handleStartNewClaudeThreadWithMessage = useCallback(async (
    text: string,
    options?: {
      history?: CarryoverMessage[];
      sourceThreadId?: string | null;
    },
  ) => {
    try {
      const workingDirectory = activeProjectCwd ?? threadDetailRef.current?.cwd ?? null;
      const initialClaudeModel = normalizeClaudeModelId(
        isClaudeModel(selectedModel) ? selectedModel : claudeClientRef.current.getDefaultModel(),
      );
      const threadId = await claudeClientRef.current.createSession({
        title: text.length > 60 ? `${text.slice(0, 60)}...` : text,
        model: initialClaudeModel,
        workingDirectory: workingDirectory ?? undefined,
      });
      const sourceThreadNameSnapshot = options?.sourceThreadId
        ? threadsRef.current.find((entry) => entry.id === options.sourceThreadId)?.name
          ?? threadsRef.current.find((entry) => entry.id === options.sourceThreadId)?.preview
          ?? null
        : null;
      const preparedHistory = options?.history?.length
        ? prepareCarryoverHistory(options.history)
        : { history: [] as CarryoverMessage[], compacted: false, compactedMessages: 0 };
      const continuationConfig: ChatConfig | null = options?.sourceThreadId
        ? {
          thread_id: threadId,
          model: initialClaudeModel,
          reasoning,
          continuation_source_thread_id: options.sourceThreadId,
          continuation_source_provider: 'codex',
          continuation_source_name: sourceThreadNameSnapshot,
          continuation_compacted_messages: preparedHistory.compactedMessages,
        }
        : null;
      await saveChatConfig({
        thread_id: threadId,
        model: initialClaudeModel,
        continuation_source_thread_id: options?.sourceThreadId ?? null,
        continuation_source_provider: options?.sourceThreadId ? 'codex' : null,
        continuation_source_name: sourceThreadNameSnapshot,
        continuation_compacted_messages: options?.sourceThreadId ? preparedHistory.compactedMessages : null,
        reasoning,
      }).catch(() => {});
      const thread = await claudeClientRef.current.getSession(threadId);
      if (!thread?.id) {
        setToast({ msg: 'Failed to create thread: no ID returned', type: 'error' });
        return;
      }
      const nextThread = continuationConfig
        ? applyThreadConfig(thread, continuationConfig)
        : thread;

      cacheThreadDetail(nextThread);
      applyNewThreadSelection(nextThread, workingDirectory ?? undefined);
      threadDetailRef.current = nextThread;
      setThreadDetail(nextThread);
      setSelectedModel(initialClaudeModel);
      if (nextThread.cwd || workingDirectory) {
        setActiveProjectCwd(nextThread.cwd ?? workingDirectory);
      }

      if (text) {
        addChatMessage(nextThread.id, text).catch(() => {});
      }

      const ok = await handleClaudeSendInThread(text, {
        threadId: nextThread.id,
        history: preparedHistory.history,
        workingDirectory: nextThread.cwd ?? workingDirectory,
      });

      if (!ok) {
        setIsAgentActive(false);
        return;
      }

      if (preparedHistory.compacted) {
        setToast({
          msg: `Auto-compacted ${preparedHistory.compactedMessages} earlier messages for the model handoff.`,
          type: 'info',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Claude error: ${msg}`, type: 'error' });
      setIsAgentActive(false);
    }
  }, [activeProjectCwd, applyNewThreadSelection, cacheThreadDetail, handleClaudeSendInThread, isClaudeModel, reasoning, selectedModel]);

  const handleUserInputResponse = useCallback(async (requestId: number, answers: Array<{ selectedOption?: number | null; notes?: string }>) => {
    const request = userInputRequests.find((entry) => entry.requestId === requestId);
    try {
      if (request) {
        const payload = Object.fromEntries(
          request.questions.map((question, index) => {
            const answer = answers[index];
            const selectedOption = typeof answer?.selectedOption === 'number' ? answer.selectedOption : null;
            const selectedLabel =
              selectedOption != null && selectedOption >= 0
                ? question.options?.[selectedOption]?.label
                : undefined;

            const notes = answer?.notes?.trim();
            const values = [
              ...(typeof selectedLabel === 'string' && selectedLabel.length > 0 ? [selectedLabel] : []),
              ...(notes ? [notes] : []),
            ];

            return [question.id, { answers: values }];
          }),
        );

        await clientRef.current.respondToUserInput(requestId, payload);
      }
      setUserInputRequests((prev) => prev.filter((r) => r.requestId !== requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to submit user input: ${msg}`, type: 'error' });
    }
  }, [userInputRequests]);

  const handleUserInputCancel = useCallback(async (requestId: number) => {
    try {
      await clientRef.current.rejectServerRequest(requestId, 'User cancelled input request', -32000);
      setUserInputRequests((prev) => prev.filter((request) => request.requestId !== requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to cancel user input request: ${msg}`, type: 'error' });
    }
  }, []);

  const handleMcpElicitationResponse = useCallback(async (
    request: McpElicitationRequest,
    response: { action: 'accept' | 'decline' | 'cancel'; content: unknown },
  ) => {
    try {
      await clientRef.current.respondToMcpElicitation(
        request.requestId,
        response.action,
        response.content,
        request.meta ?? null,
      );
      setMcpElicitationRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to respond to MCP elicitation: ${msg}`, type: 'error' });
    }
  }, []);

  const handleDynamicToolCallResponse = useCallback(async (
    request: DynamicToolCallRequest,
    response: {
      contentItems: DynamicToolCallContentItem[];
      success: boolean;
    },
  ) => {
    try {
      await clientRef.current.respondToDynamicToolCall(request.requestId, response.contentItems, response.success);
      setDynamicToolCallRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to respond to dynamic tool call: ${msg}`, type: 'error' });
    }
  }, []);

  const handleDynamicToolCallReject = useCallback(async (request: DynamicToolCallRequest) => {
    try {
      await clientRef.current.rejectServerRequest(request.requestId, 'Dynamic tool call rejected by desktop user', -32000);
      setDynamicToolCallRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to reject dynamic tool call: ${msg}`, type: 'error' });
    }
  }, []);

  const handleAuthRefreshResponse = useCallback(async (
    request: AuthRefreshRequest,
    response: ChatgptAuthTokensRefreshResponse,
  ) => {
    try {
      await clientRef.current.respondToChatgptAuthTokensRefresh(request.requestId, response);

      let nextAccount: AccountInfo = {
        type: 'chatgptAuthTokens',
        planType: response.chatgptPlanType ?? undefined,
      };

      try {
        const { account } = await clientRef.current.readAccount();
        if (account) {
          nextAccount = account;
        }
      } catch {
        /* best effort */
      }

      setAccountInfo(nextAccount);
      setAuthRefreshRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
      setToast({ msg: 'ChatGPT auth tokens refreshed.', type: 'info' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to refresh ChatGPT auth tokens: ${msg}`, type: 'error' });
    }
  }, []);

  const handleAuthRefreshReject = useCallback(async (request: AuthRefreshRequest) => {
    try {
      await clientRef.current.rejectServerRequest(request.requestId, 'ChatGPT auth token refresh rejected by desktop user', -32000);
      setAuthRefreshRequests((prev) => prev.filter((entry) => entry.requestId !== request.requestId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setToast({ msg: `Failed to reject ChatGPT auth refresh: ${msg}`, type: 'error' });
    }
  }, []);

  const handleComposerSubmit = useCallback(async ({
    text,
    attachedImages,
  }: {
    text: string;
    attachedImages: Array<{ dataUrl: string; name: string }>;
  }) => {
    setModelSwitchPreview(null);
    void setSettingJson('claude-debug-last-submit', {
      stage: 'handleComposerSubmit:start',
      text,
      attachedImages: attachedImages.length,
      selectedThread,
      selectedModel,
      isSending,
      isAgentActive,
      ts: Date.now(),
    });
    if (!text && attachedImages.length === 0) {
      return;
    }

    const finalText = attachedImages.length > 0
      ? `${text}\n\n${attachedImages.map((image) => `![${image.name}](${image.dataUrl})`).join('\n')}`.trim()
      : text;

    const usingClaude = isClaudeModel(selectedModel);
    const selectedThreadProvider = selectedThread ? getThreadProvider(selectedThread) : null;

    if (finalText.startsWith('!') && selectedThread && !usingClaude && selectedThreadProvider !== 'claude') {
      await handleShellCommand(finalText.slice(1).trim());
      return;
    }

    // Claude model selected: send via Claude API with thread context carryover
    if (usingClaude) {
      if (isSending) {
        setToast({ msg: 'Claude is still responding. Please wait.', type: 'info' });
        return;
      }
      if (!selectedThread) {
        await handleStartNewClaudeThreadWithMessage(finalText);
        return;
      }

      if (selectedThreadProvider !== 'claude') {
        await handleStartNewClaudeThreadWithMessage(finalText, {
          history: extractThreadHistory(),
          sourceThreadId: selectedThread,
        });
        return;
      }

      if (text) {
        addChatMessage(selectedThread, text).catch(() => {});
      }
      await handleClaudeSendInThread(finalText);
      return;
    }

    if (selectedThreadProvider === 'claude') {
      await handleStartNewThreadWithMessage(finalText, {
        history: extractThreadHistory(),
        sourceThreadId: selectedThread,
      });
      return;
    }

    // Codex model: steer active turn with follow-up
    if (isAgentActive && selectedThread && threadDetail) {
      const activeTurn = threadDetail.turns?.find((turn) => turn.status === 'inProgress');
      if (activeTurn) {
        const optimisticSteerItem: ThreadItem = {
          type: 'userMessage',
          id: `optimistic-steer-${Date.now()}`,
          content: [{ type: 'text', text: finalText }],
        };
        setThreadDetail((prev) =>
          applyServerEventToThreadDetail(prev, 'item/completed', {
            threadId: selectedThread,
            turnId: activeTurn.id,
            item: optimisticSteerItem,
          } as Record<string, unknown>),
        );
        try {
          await clientRef.current.steerTurn(selectedThread, finalText, activeTurn.id);
        } catch {
          await refreshThreadDetail(selectedThread);
          enqueuePendingMessage(selectedThread, finalText);
        }
        return;
      }
    }

    if (isSending && selectedThread) {
      enqueuePendingMessage(selectedThread, finalText);
      return;
    }

    if (!selectedThread) {
      await handleStartNewThreadWithMessage(finalText);
      return;
    }

    if (text) {
      addChatMessage(selectedThread, text).catch(() => {});
    }

    await handleSendMessage(finalText);
  }, [
    enqueuePendingMessage,
    handleClaudeSendInThread,
    handleSendMessage,
    handleShellCommand,
    handleStartNewClaudeThreadWithMessage,
    handleStartNewThreadWithMessage,
    isAgentActive,
    isClaudeModel,
    isSending,
    getThreadProvider,
    refreshThreadDetail,
    selectedModel,
    selectedThread,
    threadDetail,
  ]);

  const handleComposerCommand = useCallback(async (command: string) => {
    if (command === 'model') {
      setShowModelPicker(true);
      return;
    }

    if (command === 'clear' && selectedThread) {
      await handleRollback(threadDetail?.turns?.length ?? 0);
      return;
    }

    if (command === 'compact' && selectedThread) {
      await handleCompactThread();
      return;
    }

    if (command === 'fork' && selectedThread) {
      await handleForkThread();
      return;
    }

    if (command === 'review' && selectedThread) {
      await handleSendMessage('/review');
      return;
    }

    if (command === 'diff' && selectedThread) {
      await handleSendMessage('/diff');
      return;
    }

    if (command === 'status' && selectedThread) {
      await handleSendMessage('/status');
      return;
    }

    if (command === 'rename') {
      setEditingName(true);
      setEditNameValue(threadDetail?.name || threadDetail?.preview || '');
      return;
    }

    if (command === 'skills') {
      setSidebarView('skills');
      await refreshSkills();
      return;
    }

    if (command === 'plan' && selectedThread) {
      await handleSendMessage('Switch to planning mode. Analyze the situation and create a detailed plan before making any changes.');
      return;
    }

    if (command === 'new') {
      await handleNewThread();
      return;
    }

    if (command === 'help') {
      const helpLines = [
        '**Slash commands** (type /):',
        '',
        '  `/model` - Choose model and reasoning effort',
        '  `/skills` - Browse and manage skills',
        '  `/review` - Review current changes and find issues',
        '  `/compact` - Summarize conversation to save context',
        '  `/clear` - Clear terminal and start a new chat',
        '  `/rename` - Rename the current thread',
        '  `/diff` - Show git diff including untracked files',
        '  `/status` - Show session configuration and token usage',
        '  `/plan` - Switch to Plan mode',
        '  `/fork` - Fork or branch this conversation',
        '  `/new` - Start a new chat',
        '  `/help` - Show available commands and skills',
        '',
        '**Skill mentions** (type $):',
        '',
        skills.length > 0
          ? skills.map((skill) => `  \`$${skill.name}\``).join(', ')
          : '  No skills loaded. Connect to Codex and navigate to a project.',
        '',
        '**Shell commands** (type !):',
        '',
        '  `!command` - Execute a shell command in the thread context (e.g. `!ls -la`)',
      ];
      setThreadDetail((prev) => {
        if (!prev) {
          return prev;
        }
        const helpItem = {
          type: 'agentMessage' as const,
          id: `help-${Date.now()}`,
          content: [{ type: 'text', text: helpLines.join('\n') }],
        };
        const turns = prev.turns ? [...prev.turns] : [];
        turns.push({ id: `help-turn-${Date.now()}`, status: 'completed' as const, items: [helpItem] });
        return { ...prev, turns };
      });
    }
  }, [
    handleCompactThread,
    handleForkThread,
    handleNewThread,
    handleRollback,
    handleSendMessage,
    refreshSkills,
    selectedThread,
    skills,
    threadDetail,
  ]);

  const toggleGroup = useCallback((cwd: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }, []);

  const toggleThreadFamily = useCallback((threadId: string) => {
    setCollapsedThreadFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  const lastTurn = threadDetail?.turns?.[threadDetail.turns.length - 1];
  const displayedThread = threadDetail ?? (isThreadLoading ? lastResolvedThreadDetail : null);
  const providerTimeline = useMemo<ProviderTimelineEntry[]>(() => {
    if (!displayedThread) {
      return [];
    }

    const lookup = new Map<string, ThreadSummary | ThreadDetail>();
    for (const entry of threads) {
      lookup.set(entry.id, entry);
    }
    for (const entry of Array.from(threadDetailCacheRef.current.values())) {
      lookup.set(entry.id, entry);
    }
    lookup.set(displayedThread.id, displayedThread);

    return buildProviderTimeline(displayedThread, lookup);
  }, [displayedThread, threads]);
  const selectedThreadSummary = useMemo(
    () => (selectedThread ? threads.find((thread) => thread.id === selectedThread) ?? null : null),
    [selectedThread, threads],
  );
  const isShowingPreviousThreadWhileLoading =
    isThreadLoading &&
    !!selectedThread &&
    !!displayedThread &&
    displayedThread.id !== selectedThread;
  const isSelectedThreadTurnsLoading =
    isThreadTurnsLoading &&
    !!selectedThread &&
    !!displayedThread &&
    displayedThread.id === selectedThread;
  const isProcessing = !isShowingPreviousThreadWhileLoading && (isSending || isAgentActive || lastTurn?.status === 'inProgress');
  const selectedThreadPendingMessages = useMemo(
    () => {
      if (!selectedThread) {
        return EMPTY_PENDING_MESSAGES;
      }
      const matches = pendingMessages.filter((message) => message.threadId === selectedThread);
      return matches.length > 0 ? matches : EMPTY_PENDING_MESSAGES;
    },
    [pendingMessages, selectedThread],
  );
  const selectedThreadApprovals = useMemo(() => {
    if (!selectedThread) {
      return EMPTY_APPROVAL_REQUESTS;
    }
    const matches = approvals.filter((approval) => approval.threadId === selectedThread);
    return matches.length > 0 ? matches : EMPTY_APPROVAL_REQUESTS;
  }, [approvals, selectedThread]);
  const selectedThreadUserInputRequests = useMemo(() => {
    if (!selectedThread) {
      return EMPTY_USER_INPUT_REQUESTS;
    }
    const matches = userInputRequests.filter((request) => request.threadId === selectedThread);
    return matches.length > 0 ? matches : EMPTY_USER_INPUT_REQUESTS;
  }, [selectedThread, userInputRequests]);
  const selectedThreadMcpElicitationRequests = useMemo(() => {
    if (!selectedThread) {
      return EMPTY_MCP_ELICITATION_REQUESTS;
    }
    const matches = mcpElicitationRequests.filter((request) => request.threadId === selectedThread);
    return matches.length > 0 ? matches : EMPTY_MCP_ELICITATION_REQUESTS;
  }, [mcpElicitationRequests, selectedThread]);
  const selectedThreadDynamicToolCallRequests = useMemo(() => {
    if (!selectedThread) {
      return EMPTY_DYNAMIC_TOOL_CALL_REQUESTS;
    }
    const matches = dynamicToolCallRequests.filter((request) => request.threadId === selectedThread);
    return matches.length > 0 ? matches : EMPTY_DYNAMIC_TOOL_CALL_REQUESTS;
  }, [dynamicToolCallRequests, selectedThread]);
  const pinnedThreadIdSet = useMemo(() => new Set(pinnedThreads), [pinnedThreads]);
  const modelSelectOptions = useMemo(() => {
    const codexOpts = availableCodexModels.map((model) => ({ value: model.id, label: model.displayName, group: 'Codex' }));
    const claudeOpts = claudeModels.map((model) => ({ value: model.id, label: model.displayName, group: 'Claude' }));
    return [...codexOpts, ...claudeOpts];
  }, [availableCodexModels, claudeModels]);
  const pinnedSidebarThreads = useMemo(
    () => threads.filter((thread) => pinnedThreadIdSet.has(thread.id)),
    [threads, pinnedThreadIdSet],
  );
  const codexNotReady = connState !== 'connected' && !isClaudeModel(selectedModel);
  const codexReconnecting = codexNotReady && (connState === 'connecting' || reconnectAttemptRef.current > 0);
  const composerDisabled = isShowingPreviousThreadWhileLoading || codexNotReady;
  const composerPlaceholder = codexNotReady
    ? (codexReconnecting ? 'Connecting to Codex server...' : 'Codex server not connected')
    : isShowingPreviousThreadWhileLoading
    ? 'Loading selected thread...'
    : isProcessing
      ? `Send a follow-up while ${isClaudeModel(selectedModel) ? 'Claude' : 'Codex'} keeps working...`
      : isClaudeModel(selectedModel)
        ? 'Message Claude... (/ commands)'
        : 'Message Codex... (/ commands, $ skills)';
  const statusHint = selectedThreadPendingMessages.length > 0
    ? `Queued ${selectedThreadPendingMessages.length} follow-up${selectedThreadPendingMessages.length === 1 ? '' : 's'}`
    : isProcessing
      ? 'Enter to follow up, Esc to interrupt'
      : null;
  const autonomyDetail = autonomyMode === 'custom' ? getAutonomyModeSummary(codexConfig) : null;
  const activeBranchLabel = gitInfo?.branch || displayedThread?.gitInfo?.branch || 'master';
  const emptyBranchLabel = gitInfo?.branch || 'main';
  const maybeSendAutomationNotification = useCallback(async (title: string, body: string) => {
    const pref = notificationPrefRef.current;
    if (pref === 'never') return;

    if (pref === 'always') {
      try {
        await sendNotification({ title, body });
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      const focused = await appWindow.isFocused();
      if (!focused) {
        await sendNotification({ title, body });
      }
    } catch {
      /* ignore */
    }
  }, []);
  const syncAutomationScheduler = useCallback(async () => {
    try {
      const rows = await listAutomations();
      const entries: AutomationSchedulerEntry[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        nextRunAt: row.next_run_at,
        backgroundNotify: row.background_notify === 1,
      }));
      await invoke('sync_automation_scheduler', { entries });
    } catch {
      /* ignore */
    }
  }, []);
  const clearAutomationRunPoll = useCallback((runId: string) => {
    const active = automationRunPollsRef.current.get(runId);
    if (!active) return;
    clearInterval(active);
    automationRunPollsRef.current.delete(runId);
  }, []);
  const syncAutomationRunFromThread = useCallback(async (params: {
    run: AutomationRunRow;
    detail: ThreadDetail;
    suppressNotifications?: boolean;
  }): Promise<boolean> => {
    const nextState = threadDetailToAutomationExecutionState(params.detail);
    if (!nextState || nextState === 'RUNNING') return false;

    const finishedAt = nowUnixSeconds();
    const lastTurn = getLastKanbanThreadTurn(params.detail);
    const lastError = nextState === 'FAILED'
      ? lastTurn?.error?.message ?? 'Automation run failed'
      : null;
    const automation = await getAutomation(params.run.automation_id).catch(() => null);

    if (!automation) {
      await updateAutomationRun({
        id: params.run.id,
        status: nextState === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
        finishedAt,
        retryScheduledFor: null,
        errorMessage: lastError,
      });
      await syncAutomationScheduler();
      return true;
    }

    const scheduleConfig = automationRowToScheduleConfig(automation);

    if (nextState === 'SUCCESS') {
      let nextRunAt: number | null = null;
      let nextScheduledRunAt: number | null = automation.next_scheduled_run_at ?? null;

      if (automation.status === 'PAUSED') {
        nextRunAt = null;
      } else if (
        params.run.trigger_source === 'manual' &&
        automation.next_scheduled_run_at &&
        automation.next_scheduled_run_at > finishedAt
      ) {
        nextRunAt = automation.next_scheduled_run_at;
        nextScheduledRunAt = automation.next_scheduled_run_at;
      } else {
        const nextScheduled = resolveAutomationNextScheduledRunAt(automation, scheduleConfig, finishedAt);
        nextRunAt = nextScheduled;
        nextScheduledRunAt = nextScheduled;
      }

      await updateAutomation({
        id: automation.id,
        nextRunAt,
        nextScheduledRunAt,
        pendingRunKind: 'schedule',
        retryCount: 0,
        lastRunStatus: 'SUCCESS',
        lastError: null,
      });
      await updateAutomationRun({
        id: params.run.id,
        status: 'SUCCESS',
        finishedAt,
        retryScheduledFor: null,
        errorMessage: null,
      });

      if (!params.suppressNotifications && automation.background_notify === 1) {
        await maybeSendAutomationNotification('Automation completed', `"${automation.name}" finished successfully.`);
      }

      await syncAutomationScheduler();
      return true;
    }

    const retriesUsed = params.run.trigger_source === 'retry' ? automation.retry_count : 0;
    const canRetry =
      params.run.trigger_source !== 'manual' &&
      automation.status === 'ACTIVE' &&
      automation.retry_enabled === 1 &&
      retriesUsed < automation.retry_max_attempts;

    let nextRunAt: number | null = null;
    let nextScheduledRunAt: number | null = automation.next_scheduled_run_at ?? null;
    let pendingRunKind: 'schedule' | 'retry' = 'schedule';
    let retryCount = 0;
    let lastRunStatus: AutomationExecutionState = 'FAILED';
    let retryScheduledFor: number | null = null;

    if (canRetry) {
      retryCount = retriesUsed + 1;
      retryScheduledFor = finishedAt + computeRetryDelaySeconds(automation.retry_backoff_minutes, retryCount);
      nextRunAt = retryScheduledFor;
      nextScheduledRunAt = resolveAutomationNextScheduledRunAt(automation, scheduleConfig, finishedAt);
      pendingRunKind = 'retry';
      lastRunStatus = 'RETRYING';
    } else if (automation.status === 'PAUSED') {
      nextRunAt = null;
    } else {
      const nextScheduled = resolveAutomationNextScheduledRunAt(automation, scheduleConfig, finishedAt);
      nextRunAt = nextScheduled;
      nextScheduledRunAt = nextScheduled;
    }

    await updateAutomation({
      id: automation.id,
      nextRunAt,
      nextScheduledRunAt,
      pendingRunKind,
      retryCount,
      lastRunStatus,
      lastError: lastError,
    });
    await updateAutomationRun({
      id: params.run.id,
      status: 'FAILED',
      finishedAt,
      retryScheduledFor,
      errorMessage: lastError,
    });

    if (!params.suppressNotifications && automation.background_notify === 1) {
      await maybeSendAutomationNotification(
        retryScheduledFor ? 'Automation retry scheduled' : 'Automation failed',
        retryScheduledFor
          ? `"${automation.name}" failed and will retry automatically.`
          : `"${automation.name}" failed: ${lastError ?? 'Unknown error'}`,
      );
    }

    await syncAutomationScheduler();
    return true;
  }, [maybeSendAutomationNotification, syncAutomationScheduler]);
  const startAutomationRunPolling = useCallback((params: {
    run: AutomationRunRow;
    suppressNotifications?: boolean;
  }) => {
    if (!params.run.thread_id || automationRunPollsRef.current.has(params.run.id)) return;
    const interval = setInterval(async () => {
      try {
        const detail = await clientRef.current.readThread(params.run.thread_id!);
        const settled = await syncAutomationRunFromThread({
          run: params.run,
          detail,
          suppressNotifications: params.suppressNotifications,
        });
        if (settled) {
          clearAutomationRunPoll(params.run.id);
        }
      } catch {
        // Best-effort background sync; we'll retry on the next polling tick.
      }
    }, 3000);
    automationRunPollsRef.current.set(params.run.id, interval);
  }, [clearAutomationRunPoll, syncAutomationRunFromThread]);
  const reconcileAutomationRunPolls = useCallback(async () => {
    try {
      const runningRuns = await listRunningAutomationRuns();
      const activeRunIds = new Set(runningRuns.map((run) => run.id));

      for (const runId of automationRunPollsRef.current.keys()) {
        if (!activeRunIds.has(runId)) {
          clearAutomationRunPoll(runId);
        }
      }

      for (const run of runningRuns) {
        if (!run.thread_id) continue;
        startAutomationRunPolling({ run });
      }
    } catch {
      // Ignore background reconcile failures; future ticks will retry.
    }
  }, [clearAutomationRunPoll, startAutomationRunPolling]);
  useEffect(() => {
    void reconcileAutomationRunPolls();
    const interval = setInterval(() => {
      void reconcileAutomationRunPolls();
    }, 5000);

    return () => {
      clearInterval(interval);
      for (const active of automationRunPollsRef.current.values()) {
        clearInterval(active);
      }
      automationRunPollsRef.current.clear();
    };
  }, [reconcileAutomationRunPolls]);
  const handleOpenAutomationsView = useCallback(() => {
    setSidebarView('automations');
  }, []);
  const startAutomationThread = useCallback(
    async (
      prompt: string,
      name: string,
      cwd?: string | null,
      options?: StartAutomationThreadOptions,
    ): Promise<StartAutomationThreadResult> => {
      const revealThread = options?.revealThread ?? true;
      const showToast = options?.toast ?? revealThread;

      if (connState !== 'connected') {
        if (showToast) {
          setToast({ msg: `Failed to run automation "${name}": not connected`, type: 'error' });
        }
        return { ok: false, error: 'Not connected' };
      }

      const resolvedCwd = cwd === undefined ? activeProjectCwd ?? null : cwd;

      try {
        const thread = await startThreadWithConfigRecovery(resolvedCwd ? { cwd: resolvedCwd } : undefined);
        if (!thread?.id) {
          throw new Error('No thread ID returned');
        }

        await clientRef.current.setThreadName(thread.id, `[Auto] ${name}`);
        await clientRef.current.startTurn(thread.id, prompt);
        await handleListThreads();

        if (revealThread) {
          applyNewThreadSelection(thread, resolvedCwd ?? undefined);
          setIsAgentActive(true);
          startPolling(thread.id);
        }

        if (showToast) {
          setToast({ msg: `Automation "${name}" started`, type: 'info' });
        }

        return { ok: true, threadId: thread.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (showToast) {
          setToast({ msg: `Failed to run automation "${name}": ${msg}`, type: 'error' });
        }
        return { ok: false, error: msg };
      }
    },
    [activeProjectCwd, applyNewThreadSelection, connState, handleListThreads, startPolling, startThreadWithConfigRecovery],
  );
  const executeAutomation = useCallback(
    async (row: AutomationRow, options?: ExecuteAutomationOptions): Promise<ExecuteAutomationResult> => {
      const revealThread = options?.revealThread ?? true;
      const showToast = options?.toast ?? revealThread;
      const triggerSource = options?.triggerSource ?? 'manual';
      const executedAt = Math.floor(Date.now() / 1000);
      const runId = `autorun-${executedAt}-${Math.random().toString(36).slice(2, 8)}`;
      const retriesUsed = triggerSource === 'retry' ? row.retry_count : 0;
      const attemptNumber = triggerSource === 'retry' ? retriesUsed + 1 : 1;
      const scheduleConfig = automationRowToScheduleConfig(row);

      await createAutomationRun({
        id: runId,
        automationId: row.id,
        automationName: row.name,
        triggerSource,
        status: 'RUNNING',
        attemptNumber,
        startedAt: executedAt,
        scheduledFor: triggerSource === 'manual' ? null : row.next_run_at,
      });
      await updateAutomation({
        id: row.id,
        lastRunAt: executedAt,
        nextRunAt: null,
        lastRunStatus: 'RUNNING',
        lastError: null,
      });

      const result = await startAutomationThread(row.prompt, row.name, row.project_cwd, {
        revealThread,
        toast: showToast,
      });

      if (result.ok) {
        await updateAutomation({
          id: row.id,
          lastThreadId: result.threadId,
        });
        await updateAutomationRun({
          id: runId,
          threadId: result.threadId,
        });
        await syncAutomationScheduler();
        startAutomationRunPolling({
          run: {
            id: runId,
            automation_id: row.id,
            automation_name: row.name,
            trigger_source: triggerSource,
            status: 'RUNNING',
            attempt_number: attemptNumber,
            started_at: executedAt,
            finished_at: null,
            scheduled_for: triggerSource === 'manual' ? null : row.next_run_at,
            retry_scheduled_for: null,
            thread_id: result.threadId,
            error_message: null,
            created_at: executedAt,
          },
          suppressNotifications: revealThread && triggerSource === 'manual',
        });
        return { ok: true, threadId: result.threadId, runId };
      }

      const error = result.error;
      const canRetry =
        triggerSource !== 'manual' &&
        row.status === 'ACTIVE' &&
        row.retry_enabled === 1 &&
        retriesUsed < row.retry_max_attempts;

      let nextRunAt: number | null = row.next_run_at;
      let nextScheduledRunAt: number | null = row.next_scheduled_run_at;
      let pendingRunKind: 'schedule' | 'retry' = 'schedule';
      let retryCount = 0;
      let lastRunStatus: 'FAILED' | 'RETRYING' = 'FAILED';
      let retryScheduledFor: number | null = null;

      if (canRetry) {
        retryCount = retriesUsed + 1;
        retryScheduledFor = executedAt + computeRetryDelaySeconds(row.retry_backoff_minutes, retryCount);
        nextRunAt = retryScheduledFor;
        nextScheduledRunAt = row.next_scheduled_run_at ?? computeNextRun(scheduleConfig, new Date(executedAt * 1000));
        pendingRunKind = 'retry';
        lastRunStatus = 'RETRYING';
      } else if (triggerSource === 'manual' && row.status === 'PAUSED') {
        nextRunAt = null;
        nextScheduledRunAt = row.next_scheduled_run_at ?? row.next_run_at ?? null;
      } else {
        const nextScheduled = row.next_scheduled_run_at ?? computeNextRun(scheduleConfig, new Date(executedAt * 1000));
        nextRunAt = row.status === 'PAUSED' ? null : nextScheduled;
        nextScheduledRunAt = nextScheduled;
      }

      await updateAutomation({
        id: row.id,
        nextRunAt,
        nextScheduledRunAt,
        pendingRunKind,
        retryCount,
        lastRunStatus,
        lastError: error,
      });
      await updateAutomationRun({
        id: runId,
        status: 'FAILED',
        finishedAt: executedAt,
        retryScheduledFor,
        threadId: null,
        errorMessage: error,
      });

      if (!revealThread || triggerSource !== 'manual') {
        await maybeSendAutomationNotification(
          retryScheduledFor ? 'Automation retry scheduled' : 'Automation failed',
          retryScheduledFor
            ? `"${row.name}" failed and will retry automatically.`
            : `"${row.name}" failed: ${error}`,
        );
      }

      await syncAutomationScheduler();
      return { ok: false, error, runId };
    },
    [maybeSendAutomationNotification, startAutomationRunPolling, startAutomationThread, syncAutomationScheduler],
  );
  const processDueAutomations = useCallback(async (dueIds?: Set<string>) => {
    if (dueIds) {
      dueIds.forEach((id) => pendingAutomationDueIdsRef.current.add(id));
    }
    if (connState !== 'connected' || automationSweepInFlightRef.current) return;

    automationSweepInFlightRef.current = true;
    try {
      const queuedIds = pendingAutomationDueIdsRef.current.size > 0 ? new Set(pendingAutomationDueIdsRef.current) : null;
      pendingAutomationDueIdsRef.current.clear();
      const now = Math.floor(Date.now() / 1000);
      const rows = await listAutomations();

      for (const row of rows) {
        if (queuedIds && !queuedIds.has(row.id)) continue;
        if (row.status !== 'ACTIVE' || !row.next_run_at || row.next_run_at > now) {
          continue;
        }

        await executeAutomation(row, {
          revealThread: false,
          toast: false,
          triggerSource: row.pending_run_kind === 'retry' ? 'retry' : 'schedule',
        });
      }

      await syncAutomationScheduler();
    } catch {
      /* ignore */
    } finally {
      automationSweepInFlightRef.current = false;
      if (pendingAutomationDueIdsRef.current.size > 0) {
        void processDueAutomations();
      }
    }
  }, [connState, executeAutomation, syncAutomationScheduler]);
  useEffect(() => {
    if (connState !== 'connected') return;

    void processDueAutomations();
    const intervalId = setInterval(() => {
      void processDueAutomations();
    }, 120_000);

    return () => {
      clearInterval(intervalId);
    };
  }, [connState, processDueAutomations]);
  useEffect(() => {
    void syncAutomationScheduler();
    const intervalId = setInterval(() => {
      void syncAutomationScheduler();
    }, 15_000);

    return () => {
      clearInterval(intervalId);
    };
  }, [syncAutomationScheduler]);
  useEffect(() => {
    let active = true;
    let unlistenFn: (() => void) | null = null;

    void listen<AutomationDueEventPayload>('automation://due', (event) => {
      if (!active || !event.payload?.id) return;
      void processDueAutomations(new Set([event.payload.id]));
    }).then((dispose) => {
      if (!active) {
        dispose();
        return;
      }
      unlistenFn = dispose;
    }).catch(() => {});

    return () => {
      active = false;
      unlistenFn?.();
    };
  }, [processDueAutomations]);
  const handleOpenSkillsView = useCallback(() => {
    setSidebarView('skills');
    void refreshSkills();
  }, [refreshSkills]);
  const handleOpenUsageView = useCallback(() => {
    setSidebarView('usage');
  }, []);
  const handleOpenProvidersView = useCallback(() => {
    setSidebarView('providers');
  }, []);
  const handleOpenHistoryView = useCallback(() => {
    setSidebarView('history');
  }, []);
  const handleOpenKanbanView = useCallback(() => {
    setSidebarView('kanban');
  }, []);
  const handleOpenSettingsView = useCallback(() => {
    setSidebarView('settings');
  }, []);
  const focusComposer = useCallback(() => {
    composerRef.current?.focus();
  }, []);
  const setComposerDraft = useCallback((text: string) => {
    composerRef.current?.setDraftText(text);
  }, []);
  const handleToggleArchived = useCallback(() => {
    setShowArchived((prev) => !prev);
  }, []);
  const handleThreadSearchChange = useCallback((value: string) => {
    setThreadSearch(value);
  }, []);
  const handleClearThreadSearch = useCallback(() => {
    setThreadSearch('');
  }, []);
  const handleToggleFolderMenu = useCallback((cwd: string, x: number, y: number) => {
    setFolderMenu((prev) => (prev?.cwd === cwd ? null : { cwd, x, y }));
  }, []);
  const handleCloseFolderMenu = useCallback(() => {
    setFolderMenu(null);
  }, []);
  const handleCancelFolderRename = useCallback(() => {
    setRenamingFolder(null);
  }, []);
  const handleCloseThreadContextMenu = useCallback(() => {
    setThreadCtxMenu(null);
  }, []);
  const toggleRawJson = useCallback(() => {
    setShowRawJson(!showRawJson);
  }, [showRawJson]);
  const handleInsertPrompt = useCallback((text: string) => {
    setComposerDraft(text);
  }, [setComposerDraft]);
  const handleResendToComposer = useCallback((text: string) => {
    composerRef.current?.setDraftText(text);
    composerRef.current?.focus();
  }, []);
  const handleStartRenameThread = useCallback(() => {
    if (!threadDetail || isShowingPreviousThreadWhileLoading) {
      return;
    }

    setEditNameValue(threadDetail.name || '');
    setEditingName(true);
  }, [isShowingPreviousThreadWhileLoading, threadDetail]);
  const handleCancelRenameThread = useCallback(() => {
    setEditingName(false);
  }, []);
  const handleResumeSelectedThread = useCallback(() => {
    if (!threadDetail || threadDetail.status?.type === 'active') {
      return;
    }

    clientRef.current.resumeThread(threadDetail.id).then(() => {
      refreshThreadDetail(threadDetail.id);
    }).catch(() => {});
  }, [refreshThreadDetail, threadDetail]);
  const handleRollbackLastTurn = useCallback(() => {
    void handleRollback(1);
  }, [handleRollback]);
  const handleArchiveSelectedThread = useCallback(() => {
    if (!threadDetail) {
      return;
    }

    void handleArchiveThread(threadDetail.id);
  }, [handleArchiveThread, threadDetail]);
  const handleOpenContinuationSource = useCallback(async (threadId: string) => {
    if (!threadId || threadId === selectedThread) {
      return;
    }
    await handleReadThread(threadId);
  }, [handleReadThread, selectedThread]);
  const toggleRightSidebar = useCallback(() => {
    setRightSidebarOpen(!rightSidebarOpen);
  }, [rightSidebarOpen, setRightSidebarOpen]);

  useEffect(() => {
    if (sidebarView !== 'threads') {
      setRightSidebarOpen(false);
    }
  }, [sidebarView, setRightSidebarOpen]);

  useEffect(() => {
    if (isProcessing || !selectedThread) return;

    const nextPending = pendingMessages.find((message) => message.threadId === selectedThread);
    if (!nextPending || lastAutoFlushedPendingIdRef.current === nextPending.id) return;

    lastAutoFlushedPendingIdRef.current = nextPending.id;
    let cancelled = false;

    void (async () => {
      const sent = await handleSendMessage(nextPending.text);
      if (cancelled) return;

      if (sent) {
        setPendingMessages((prev) => prev.filter((message) => message.id !== nextPending.id));
        lastAutoFlushedPendingIdRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handleSendMessage, isProcessing, pendingMessages, selectedThread]);

  const rightSidebarEl = useMemo(() => {
    if (!rightSidebarOpen) {
      return null;
    }

    return (
      <Suspense fallback={<RightSidebarFallback width={rightSidebarWidth} />}>
        <LazyRightSidebar
          cwd={activeProjectCwd}
          activeTab={rightSidebarTab}
          onTabChange={setRightSidebarTab}
          onOverlayView={setOverlayView}
          onInsertPrompt={handleInsertPrompt}
          width={rightSidebarWidth}
          onWidthChange={setRightSidebarWidth}
        />
      </Suspense>
    );
  }, [activeProjectCwd, handleInsertPrompt, rightSidebarOpen, rightSidebarTab, rightSidebarWidth, setRightSidebarWidth]);

  const activeThreadMainBody = useMemo(() => {
    if (!displayedThread) {
      return null;
    }

    return (
      <div className="main-content-body">
        <div className="main-content-primary">
          {selectedThreadApprovals.map((approval) => (
            <div key={approval.requestId} className="approval-overlay-card">
              <div className="approval-overlay-header">
                <span className="approval-overlay-icon">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--status-warning)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 2L2 16h14L9 2z" />
                    <line x1="9" y1="7" x2="9" y2="11" />
                    <circle cx="9" cy="13.5" r="0.5" fill="var(--status-warning)" />
                  </svg>
                </span>
                <span className="approval-overlay-title">
                  {approval.kind === 'applyPatch' ? 'Apply file changes?' :
                   approval.kind === 'permissions' ? 'Grant permissions?' :
                   approval.kind === 'mcpElicitation' ? 'MCP server approval' :
                   approval.command ? 'Run this command?' : 'Approval required'}
                </span>
              </div>
              {approval.command && (
                <div className="approval-overlay-command">
                  <code>{approval.command}</code>
                </div>
              )}
              {approval.description && (
                <div className="approval-overlay-desc">{approval.description}</div>
              )}
              {approval.diff && (
                <div className="approval-overlay-diff">
                  <pre>{approval.diff}</pre>
                </div>
              )}
              {approval.permissions && approval.permissions.length > 0 && (
                <div className="approval-overlay-permissions">
                  {approval.permissions.map((permission, index) => (
                    <span key={index} className="approval-perm-tag">{permission}</span>
                  ))}
                </div>
              )}
              <div className="approval-overlay-actions">
                <button className="btn-approve" onClick={() => handleApproval(approval, 'accept')}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3,7 6,10 11,4" />
                  </svg>
                  Approve
                </button>
                <button className="btn-approve-session" onClick={() => handleApproval(approval, 'acceptForSession')}>Always Approve</button>
                <button className="btn-decline" onClick={() => handleApproval(approval, 'decline')}>Decline</button>
              </div>
              <div className="approval-overlay-hint">
                <kbd>Y</kbd> approve &nbsp; <kbd>A</kbd> always &nbsp; <kbd>N</kbd> decline
              </div>
            </div>
          ))}

          {selectedThreadUserInputRequests.map((request) => (
            <UserInputModal
              key={request.requestId}
              request={request}
              onSubmit={handleUserInputResponse}
              onCancel={() => { void handleUserInputCancel(request.requestId); }}
            />
          ))}

          {selectedThreadMcpElicitationRequests.map((request) => (
            <McpElicitationModal
              key={request.requestId}
              request={request}
              onSubmit={handleMcpElicitationResponse}
            />
          ))}

          {selectedThreadDynamicToolCallRequests.map((request) => (
            <DynamicToolCallModal
              key={request.requestId}
              request={request}
              onSubmit={handleDynamicToolCallResponse}
              onReject={handleDynamicToolCallReject}
            />
          ))}

          {authRefreshRequests.map((request) => (
            <AuthRefreshModal
              key={request.requestId}
              request={request}
              onSubmit={handleAuthRefreshResponse}
              onReject={handleAuthRefreshReject}
            />
          ))}

          <ThreadWorkspace
            key={displayedThread.id}
            thread={displayedThread}
            isSending={isShowingPreviousThreadWhileLoading ? false : isSending}
            isAgentActive={isShowingPreviousThreadWhileLoading ? false : isAgentActive}
            isTurnsLoading={isSelectedThreadTurnsLoading}
            showRawJson={showRawJson}
            onToggleRawJson={toggleRawJson}
            overrideIsProcessing={isShowingPreviousThreadWhileLoading ? false : undefined}
            pendingMessages={selectedThreadPendingMessages}
            statusHint={statusHint}
            contextUsage={contextUsage}
            turnStartTime={turnStartTime}
            onResend={handleResendToComposer}
          />
          <ChatComposer
            ref={composerRef}
            className="bottom-bar"
            disabled={composerDisabled}
            isProcessing={isProcessing}
            placeholder={composerPlaceholder}
            historyKey={selectedThread ?? 'new-thread'}
            historySeed={composerHistorySeed}
            skills={skills}
            modelOptions={modelSelectOptions}
            selectedModel={selectedModel}
            onSelectModel={handleSelectModel}
            modelSwitchPreview={modelSwitchPreview}
            reasoning={reasoning}
            reasoningOptions={REASONING_OPTIONS}
            onSelectReasoning={(value) => setReasoning(value as ReasoningLevel)}
            autonomyMode={autonomyMode}
            autonomyOptions={autonomyOptions}
            onSelectAutonomyMode={handleAutonomyModeChange}
            isUpdatingAutonomy={isUpdatingAutonomy}
            autonomyDetail={autonomyDetail}
            branchLabel={activeBranchLabel}
            contextUsage={contextUsage}
            onSubmit={handleComposerSubmit}
            onExecuteCommand={handleComposerCommand}
            onInterrupt={isProcessing ? handleInterrupt : undefined}
            backendType={isClaudeModel(selectedModel) ? 'claude' : 'codex'}
          />
        </div>
        {rightSidebarEl}
      </div>
    );
  }, [
    activeBranchLabel,
    authRefreshRequests,
    autonomyDetail,
    autonomyMode,
    autonomyOptions,
    composerDisabled,
    composerHistorySeed,
    composerPlaceholder,
    contextUsage,
    displayedThread,
    handleApproval,
    handleAuthRefreshReject,
    handleAuthRefreshResponse,
    handleAutonomyModeChange,
    handleComposerCommand,
    handleComposerSubmit,
    handleDynamicToolCallReject,
    handleDynamicToolCallResponse,
    handleInterrupt,
    handleMcpElicitationResponse,
    handleResendToComposer,
    handleSelectModel,
    handleUserInputCancel,
    handleUserInputResponse,
    isAgentActive,
    isProcessing,
    isSelectedThreadTurnsLoading,
    isSending,
    isShowingPreviousThreadWhileLoading,
    isUpdatingAutonomy,
    modelSwitchPreview,
    modelSelectOptions,
    reasoning,
    rightSidebarEl,
    selectedModel,
    selectedThread,
    selectedThreadApprovals,
    selectedThreadDynamicToolCallRequests,
    selectedThreadMcpElicitationRequests,
    selectedThreadPendingMessages,
    selectedThreadUserInputRequests,
    showRawJson,
    skills,
    statusHint,
    turnStartTime,
    toggleRawJson,
    isClaudeModel,
    selectedModel,
  ]);

  return (
    <>
      {appPhase !== 'startup' && (<>
      <div className="app-layout">
        {/* Sidebar */}
        <ThreadSidebar
          width={sidebarWidth}
          onResizeStart={handleSidebarResizeStart}
          connState={connState}
          sidebarView={sidebarView}
          onShowThreadHome={handleNewThread}
          onOpenAutomations={handleOpenAutomationsView}
          onOpenSkills={handleOpenSkillsView}
          onOpenUsage={handleOpenUsageView}
          onOpenProviders={handleOpenProvidersView}
          onOpenHistory={handleOpenHistoryView}
          onOpenKanban={handleOpenKanbanView}
          onOpenSettings={handleOpenSettingsView}
          onAddProject={handleAddProject}
          showArchived={showArchived}
          onToggleArchived={handleToggleArchived}
          onRefreshThreads={handleListThreads}
          threadSearch={threadSearch}
          onThreadSearchChange={handleThreadSearchChange}
          onClearThreadSearch={handleClearThreadSearch}
          threadCount={threads.length}
          pinnedThreads={pinnedSidebarThreads}
          threadGroups={threadGroups}
          pinnedThreadIds={pinnedThreadIdSet}
          selectedThreadId={selectedThread}
          collapsedGroups={collapsedGroups}
          collapsedThreadFamilies={collapsedThreadFamilies}
          folderAlias={folderAlias}
          renamingFolder={renamingFolder}
          onToggleGroup={toggleGroup}
          onToggleThreadFamily={toggleThreadFamily}
          onRenameFolderStart={handleRenameFolder}
          onSaveFolderAlias={handleSaveFolderAlias}
          onCancelFolderRename={handleCancelFolderRename}
          onSelectThread={handleReadThread}
          onOpenThreadContextMenu={handleOpenThreadContextMenu}
          onNewThreadInFolder={handleNewThread}
          folderMenu={folderMenu}
          onToggleFolderMenu={handleToggleFolderMenu}
          onCloseFolderMenu={handleCloseFolderMenu}
          onOpenInExplorer={handleOpenInExplorer}
          onRemoveProject={handleRemoveProject}
          onRemoveFolder={handleRemoveFolder}
          nextCursor={nextCursor}
          loadingMore={loadingMore}
          onLoadMoreThreads={handleLoadMoreThreads}
          threadContextMenu={threadCtxMenu}
          onCloseThreadContextMenu={handleCloseThreadContextMenu}
          onRenameThreadFromContext={handleCtxRenameThread}
          renamingThreadId={renamingThreadId}
          renamingThreadValue={renamingThreadValue}
          onRenamingThreadValueChange={setRenamingThreadValue}
          onSaveThreadRename={handleSaveThreadRename}
          onCancelThreadRename={handleCancelThreadRename}
          onPinThread={handlePinThread}
          onForkThreadFromContext={handleCtxForkThread}
          onArchiveThreadFromContext={handleCtxArchiveThread}
          viewMode={threadViewMode}
          onViewModeChange={setThreadViewMode}
          sortBy={threadSortBy}
          onSortByChange={setThreadSortBy}
        />

        {/* Main Content */}
        <main className="main-content">
          {(sidebarView === 'settings' || sidebarView === 'providers' || sidebarView === 'automations' || sidebarView === 'skills' || sidebarView === 'usage' || sidebarView === 'history' || sidebarView === 'kanban') && <WindowControls className="window-controls--floating" />}
          {sidebarView === 'settings' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <SettingsView url={url} onUrlChange={setUrl} connState={connState} accountInfo={accountInfo} rateLimits={rateLimits} mcpServers={mcpServers} client={clientRef.current} theme={theme} onThemeChange={setTheme} codexConfig={codexConfig} onWriteConfig={async (key, value) => { await writeConfigValueWithFallback(key, null, value); await refreshCodexConfig(); }} onRefreshMcp={refreshMcpServers} onConnect={(wsUrl) => void handleConnect(wsUrl)} onDisconnect={handleDisconnect} uiFontSize={uiFontSize} onUiFontSizeChange={setUiFontSize} codeFontSize={codeFontSize} onCodeFontSizeChange={setCodeFontSize} notificationPref={notificationPref} onNotificationPrefChange={setNotificationPref} themePreset={themePreset} onThemePresetChange={setThemePreset} themeConfig={themeConfig} onThemeConfigChange={setThemeConfig} pointerCursor={pointerCursor} onPointerCursorChange={setPointerCursor} onAutonomyModeChange={handleAutonomyModeChange} autonomyMode={autonomyMode} isUpdatingAutonomy={isUpdatingAutonomy} serverStarting={serverStarting} serverRunning={serverRunning} serverLog={serverLog} codexBinPath={codexBinPath} onCodexBinPathChange={setCodexBinPath} codexCandidates={codexCandidates} onStartServer={handleStartServer} onStopServer={handleStopServer} onBrowseCodexBinary={handleBrowseCodexBinary} />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'automations' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <AutomationsPanel
                  projects={automationProjects}
                  activeProjectCwd={activeProjectCwd}
                  onExecuteAutomation={executeAutomation}
                  onAutomationsChanged={syncAutomationScheduler}
                  onOpenThread={handleReadThread}
                />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'skills' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <SkillsView skills={skills} onRefresh={async () => { await refreshSkills(); }} />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'usage' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <UsagePanel />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'providers' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <ProvidersPanel onToast={(msg, type) => setToast({ msg, type: type === 'error' ? 'error' : 'info' })} />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'history' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <HistoryPanel
                  entries={historyEntries}
                  searchQuery={historySearchQuery}
                  onSearchChange={setHistorySearchQuery}
                  threads={threads}
                  onSelectMessage={(msg) => {
                    setSidebarView('threads');
                    setTimeout(() => composerRef.current?.setDraftText(msg), 100);
                  }}
                />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'kanban' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <KanbanPanel
                  projects={kanbanProjects}
                  executionSyncVersion={kanbanExecutionRevision}
                  execCallbacks={{
                    startThread: startThreadWithConfigRecovery,
                    startTurn: (threadId, text) => clientRef.current.startTurn(threadId, text),
                    readThread: (threadId) => clientRef.current.readThread(threadId),
                    onRunStarted: ({ runId, issueId, threadId }) => {
                      startKanbanRunPolling({ runId, issueId, threadId });
                    },
                    onThreadCreated: () => { void refreshKanbanThreadIds(); void handleListThreads(); },
                  }}
                />
              </div>
              {rightSidebarEl}
            </div>
          ) : overlayView ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <CodeViewer
                  overlay={overlayView}
                  onClose={() => setOverlayView(null)}
                  extraToolbarRight={
                    <>
                      <button className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`} onClick={toggleRightSidebar} title={rightSidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="10" y1="2.5" x2="10" y2="13.5" /></svg>
                      </button>
                      <div className="toolbar-divider" />
                      <WindowControls />
                    </>
                  }
                />
              </div>
              {rightSidebarEl}
            </div>
          ) : displayedThread ? (
            <>
              <ThreadToolbar
                threadDetail={threadDetail}
                displayedThread={displayedThread}
                providerTimeline={providerTimeline}
                editingName={editingName}
                editNameValue={editNameValue}
                onEditNameValueChange={setEditNameValue}
                onConfirmRename={handleRenameThread}
                onCancelRename={handleCancelRenameThread}
                onStartRename={handleStartRenameThread}
                isProcessing={isProcessing}
                isShowingPreviousThreadWhileLoading={isShowingPreviousThreadWhileLoading}
                isSelectedThreadTurnsLoading={isSelectedThreadTurnsLoading}
                showRawJson={showRawJson}
                rightSidebarOpen={rightSidebarOpen}
                gitInfo={gitInfo}
                onInterrupt={handleInterrupt}
                onResume={handleResumeSelectedThread}
                onCommitChanges={handleCommitChanges}
                onForkThread={handleForkThread}
                onToggleRawJson={toggleRawJson}
                onRollbackLastTurn={handleRollbackLastTurn}
                onArchiveThread={handleArchiveSelectedThread}
                onOpenContinuationSource={handleOpenContinuationSource}
                onToggleRightSidebar={toggleRightSidebar}
                WindowControlsComponent={WindowControls}
              />

              {activeThreadMainBody}
            </>
          ) : selectedThread ? (
            isThreadLoading ? (
              <div className="tv-container">
                <div className="thread-toolbar" data-tauri-drag-region>
                  <div className="thread-toolbar-left">
                    <div className="skeleton-line skeleton-line--medium" style={{ height: 14 }} />
                  </div>
                  <div className="thread-toolbar-right">
                    <button className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`} onClick={toggleRightSidebar} title={rightSidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="10" y1="2.5" x2="10" y2="13.5" /></svg>
                    </button>
                    <div className="toolbar-divider" />
                    <WindowControls />
                  </div>
                </div>
                <div className="main-content-body">
                  <div className="main-content-primary">
                    <div className="tv-messages">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="skeleton-row">
                          <div className="skeleton-avatar" />
                          <div className="skeleton-block" style={{ flex: 1 }}>
                            <div className={`skeleton-line skeleton-line--${i === 1 ? 'long' : i === 2 ? 'medium' : 'short'}`} />
                            <div className="skeleton-line skeleton-line--long" />
                            <div className="skeleton-line skeleton-line--medium" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {rightSidebarEl}
                </div>
              </div>
            ) : (
              <div className="main-empty">
                <div className="empty-toolbar" data-tauri-drag-region>
                  <div className="empty-toolbar-left">
                    <button className="empty-toolbar-title" onClick={focusComposer}>
                      Thread Unavailable
                    </button>
                  </div>
                  <div className="empty-toolbar-right">
                    <button className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`} onClick={toggleRightSidebar} title={rightSidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="10" y1="2.5" x2="10" y2="13.5" /></svg>
                    </button>
                    <div className="toolbar-divider" />
                    <WindowControls />
                  </div>
                </div>
                <div className="main-content-body">
                  <div className="main-content-primary">
                    <div className="empty-body">
                      <div className="empty-hero">
                        <svg className="empty-logo" width="48" height="48" viewBox="0 0 48 48" fill="none">
                          <path d="M24 4C12.95 4 4 12.95 4 24s8.95 20 20 20 20-8.95 20-20S35.05 4 24 4z" stroke="var(--text-tertiary)" strokeWidth="1.5" />
                          <path d="M24 14v10" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" />
                          <circle cx="24" cy="31" r="2" fill="var(--text-tertiary)" />
                        </svg>
                        <h2 className="empty-title">Unable to open thread</h2>
                        <p className="settings-desc" style={{ maxWidth: 520, textAlign: 'center' }}>
                          {threadLoadError || 'The selected thread could not be loaded. Try refreshing or open it again.'}
                        </p>
                        <button className="btn-primary" onClick={() => void handleReadThread(selectedThread)}>
                          Retry
                        </button>
                      </div>
                    </div>
                  </div>
                  {rightSidebarEl}
                </div>
              </div>
            )
          ) : (
            <div className="main-empty">
              <div className="empty-toolbar" data-tauri-drag-region>
                <div className="empty-toolbar-left">
                  <button className="empty-toolbar-title" onClick={focusComposer}>New Thread</button>
                  {connState !== 'connected' && !isClaudeModel(selectedModel) && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 8 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: connState === 'connecting' ? 'var(--status-warning, orange)' : 'var(--status-error, #f44)', flexShrink: 0, animation: connState === 'connecting' ? 'pulse 1.5s ease-in-out infinite' : undefined }} />
                      {connState === 'connecting' ? 'Connecting...' : 'Disconnected'}
                    </span>
                  )}
                </div>
                <div className="empty-toolbar-right">
                  <button className={`toolbar-icon-btn${rightSidebarOpen ? ' toolbar-icon-btn--active' : ''}`} onClick={toggleRightSidebar} title={rightSidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><line x1="10" y1="2.5" x2="10" y2="13.5" /></svg>
                  </button>
                  <div className="toolbar-divider" />
                  <WindowControls />
                </div>
              </div>

              <div className="main-content-body">
                <div className="main-content-primary">
              <div className="empty-body">
                <div className="empty-hero">
                  <svg className="empty-logo" width="48" height="48" viewBox="0 0 48 48" fill="none">
                    <path d="M24 4C12.95 4 4 12.95 4 24s8.95 20 20 20 20-8.95 20-20S35.05 4 24 4z" stroke="var(--text-tertiary)" strokeWidth="1.5" />
                    <circle cx="17" cy="22" r="2" fill="var(--text-tertiary)" />
                    <circle cx="31" cy="22" r="2" fill="var(--text-tertiary)" />
                    <path d="M17 30c2 3 5 4 7 4s5-1 7-4" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  <h2 className="empty-title">Start Building</h2>
                  {(() => {
                    const projectFolders = threadGroups.filter(g => g.cwd && g.folder);
                    const activeProject = projectFolders.find(g => g.cwd === activeProjectCwd) || projectFolders[0];
                    const activeLabel = activeProject ? (folderAlias[activeProject.cwd] || activeProject.folder) : 'No project';
                    return (
                      <div className="empty-project-wrapper" ref={projectDropdownRef}>
                        <button className="empty-project-btn" onClick={() => { if (projectFolders.length > 0) setProjectDropdownOpen(!projectDropdownOpen); }}>
                          {activeLabel}
                          {projectFolders.length > 0 && (
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 4l2 2 2-2" />
                            </svg>
                          )}
                        </button>
                        {projectDropdownOpen && projectFolders.length > 0 && (
                          <div className="empty-project-menu">
                            {projectFolders.map(g => {
                              const label = folderAlias[g.cwd] || g.folder;
                              const isActive = g.cwd === (activeProjectCwd || projectFolders[0]?.cwd);
                              return (
                                <button
                                  key={g.cwd}
                                  className={`empty-project-option${isActive ? ' empty-project-option--active' : ''}`}
                                  onClick={() => { setActiveProjectCwd(g.cwd); setProjectDropdownOpen(false); }}
                                >
                                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                                  </svg>
                                  <span>{label}</span>
                                  {isActive && (
                                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M2.5 6l2.5 2.5 4.5-5" />
                                    </svg>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>

              <div className="empty-footer">
                  {connState === 'connected' && showSuggestions && (
                    <div className="empty-suggestions">
                      <div className="suggestions-header">
                        <span className="suggestions-header-label">Explore more</span>
                        <button className="suggestions-close" onClick={() => setShowSuggestions(false)}>
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
                          </svg>
                        </button>
                      </div>
                      <div className="suggestion-cards">
                        {[
                          { icon: '🎮', text: 'Build a classic Snake game in this repo.' },
                          { icon: '📄', text: 'Create a one-page $pdf that summarizes this app.' },
                          { icon: '✍️', text: 'Create a plan to refactor the codebase.' },
                        ].map((s, i) => (
                          <button key={i} className="suggestion-card" onClick={() => setComposerDraft(s.text)}>
                            <span className="suggestion-card-icon">{s.icon}</span>
                            <span className="suggestion-card-text">{s.text}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {connState !== 'connected' && !isClaudeModel(selectedModel) && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '6px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {connState === 'connecting' || reconnectAttemptRef.current > 0 ? (
                        <>
                          <span className="server-startup-badge-dot" />
                          <span>Connecting to server...</span>
                        </>
                      ) : (
                        <>
                          <span>Not connected</span>
                          <span style={{ margin: '0 2px' }}>·</span>
                          <button
                            style={{ background: 'none', border: 'none', color: 'var(--accent-green)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                            onClick={() => { setSidebarView('settings'); }}
                          >
                            Settings
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  <ChatComposer
                    ref={composerRef}
                    className="bottom-bar empty-bottom-bar"
                    disabled={codexNotReady}
                    placeholder={codexNotReady ? (codexReconnecting ? 'Connecting to Codex server...' : 'Codex server not connected') : composerPlaceholder}
                    historyKey="new-thread"
                    historySeed={composerHistorySeed}
                    skills={skills}
                    modelOptions={modelSelectOptions}
                    selectedModel={selectedModel}
                    onSelectModel={handleSelectModel}
                    modelSwitchPreview={modelSwitchPreview}
                    reasoning={reasoning}
                    reasoningOptions={REASONING_OPTIONS}
                    onSelectReasoning={(value) => setReasoning(value as ReasoningLevel)}
                    autonomyMode={autonomyMode}
                    autonomyOptions={autonomyOptions}
                    onSelectAutonomyMode={handleAutonomyModeChange}
                    isUpdatingAutonomy={isUpdatingAutonomy}
                    autonomyDetail={autonomyDetail}
                    branchLabel={emptyBranchLabel}
                    contextUsage={null}
                    onSubmit={handleComposerSubmit}
                    onExecuteCommand={handleComposerCommand}
                    backendType={isClaudeModel(selectedModel) ? 'claude' : 'codex'}
                  />
                  {/*
                        title="娣诲姞鏂囦欢鎴栧浘鐗?
                        title="鎻掑叆鏂滄潬鍛戒护"
                  */}
                </div>
                </div>
                {rightSidebarEl}
              </div>
            </div>
          )}
        </main>
      </div>

      {showModelPicker && (
        <div className="modal-overlay" onClick={() => setShowModelPicker(false)}>
          <div className="modal-card model-picker" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Select Model</h3>
              <button className="modal-close" onClick={() => setShowModelPicker(false)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" />
                </svg>
              </button>
            </div>
            <div className="model-picker-list">
              {availableCodexModels.length > 0 && <div className="csel-group-header">Codex</div>}
              {availableCodexModels.map(m => (
                <button
                  key={m.id}
                  className={`model-picker-item${selectedModel === m.id ? ' model-picker-item--active' : ''}`}
                  onClick={() => { handleSelectModel(m.id); }}
                >
                  <span className="model-picker-name">{m.displayName}</span>
                  {m.isDefault && <span className="model-picker-badge">default</span>}
                  {selectedModel === m.id && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3,7 6,10 11,4" />
                    </svg>
                  )}
                </button>
              ))}
              <div className="csel-group-header">Claude</div>
              {claudeModels.map(m => (
                <button
                  key={m.id}
                  className={`model-picker-item${selectedModel === m.id ? ' model-picker-item--active' : ''}`}
                  onClick={() => { handleSelectModel(m.id); }}
                >
                  <span className="model-picker-name">{m.displayName}</span>
                  {m.isDefault && <span className="model-picker-badge">default</span>}
                  {selectedModel === m.id && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3,7 6,10 11,4" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
            <div className="model-picker-reasoning">
              <span className="model-picker-reasoning-label">Reasoning Effort</span>
              <div className="model-picker-reasoning-options">
                {(['low', 'medium', 'high', 'xhigh'] as ReasoningLevel[]).map(r => (
                  <button
                    key={r}
                    className={`model-picker-reasoning-btn${reasoning === r ? ' model-picker-reasoning-btn--active' : ''}`}
                    onClick={() => setReasoning(r)}
                  >
                    {r === 'xhigh' ? 'Max' : r.charAt(0).toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showShortcuts && (
        <div className="modal-overlay" onClick={() => setShowShortcuts(false)}>
          <div className="modal-card shortcuts-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Keyboard Shortcuts</h3>
              <button className="modal-close" onClick={() => setShowShortcuts(false)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" />
                </svg>
              </button>
            </div>
            <div className="shortcuts-list">
              <div className="shortcuts-group">
                <h4>General</h4>
                <div className="shortcut-row"><kbd>Ctrl+N</kbd><span>New thread</span></div>
                <div className="shortcut-row"><kbd>Ctrl+K</kbd><span>Search threads</span></div>
                <div className="shortcut-row"><kbd>?</kbd><span>Show shortcuts</span></div>
                <div className="shortcut-row"><kbd>Esc</kbd><span>Cancel / Close</span></div>
              </div>
              <div className="shortcuts-group">
                <h4>Chat</h4>
                <div className="shortcut-row"><kbd>Enter</kbd><span>Send message</span></div>
                <div className="shortcut-row"><kbd>Shift+Enter</kbd><span>New line</span></div>
                <div className="shortcut-row"><kbd>&uarr;</kbd><span>Previous message (when empty)</span></div>
                <div className="shortcut-row"><kbd>&darr;</kbd><span>Next message (in history)</span></div>
                <div className="shortcut-row"><kbd>/</kbd><span>Slash commands</span></div>
                <div className="shortcut-row"><kbd>$</kbd><span>Skill mentions</span></div>
                <div className="shortcut-row"><kbd>!</kbd><span>Shell command (e.g. !ls -la)</span></div>
              </div>
              <div className="shortcuts-group">
                <h4>Approvals</h4>
                <div className="shortcut-row"><kbd>Y</kbd><span>Approve</span></div>
                <div className="shortcut-row"><kbd>A</kbd><span>Always approve</span></div>
                <div className="shortcut-row"><kbd>N</kbd><span>Decline</span></div>
              </div>
            </div>
          </div>
        </div>
      )}
      </>)}

      {(appPhase === 'startup' || showServerDialog) && (
        <div className={appPhase === 'startup' ? 'server-startup-page' : 'server-startup-overlay'}>
          <WindowControls className="window-controls--floating" />
          <div className="server-startup-card" onClick={e => e.stopPropagation()}>
            <div className="server-startup-header">
              <div className="server-startup-brand">
                <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
                  <path d="M14 2L3 8v12l11 6 11-6V8L14 2z" fill="var(--accent-green)" opacity="0.12" stroke="var(--accent-green)" strokeWidth="1.2" />
                  <path d="M14 8v12M8 11l6 3.5L20 11" stroke="var(--accent-green)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="server-startup-brand-text">Codex Desktop</span>
              </div>
              {serverStarting ? (
                <div className="server-startup-badge server-startup-badge--loading">
                  <span className="server-startup-badge-dot" />
                  Starting
                </div>
              ) : serverRunning ? (
                <div className="server-startup-badge server-startup-badge--ok">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <path d="M3.5 7l2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Connected
                </div>
              ) : (
                <div className="server-startup-badge server-startup-badge--err">
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M7 4.5v3M7 9v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  Failed
                </div>
              )}
            </div>

            {serverStarting && (
              <div className="server-startup-progress">
                <div className="server-startup-progress-track">
                  <div className="server-startup-progress-bar" />
                </div>
              </div>
            )}

            <h3 className="server-startup-title">
              {serverStarting ? 'Starting App Server...' : serverRunning ? 'Establishing Connection...' : 'Unable to Start Server'}
            </h3>
            <p className="server-startup-desc">
              {serverStarting
                ? 'Launching the codex app-server process'
                : serverRunning
                ? 'Server is running, connecting to WebSocket'
                : 'The codex binary was not found in PATH.'}
            </p>

            {serverLog && (
              <code className="server-startup-log">{serverLog}</code>
            )}

            {!serverStarting && !serverRunning && (
              <button className="server-startup-launch-btn" onClick={handleStartServer}>
                <div className="server-startup-launch-btn-icon">
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                    <path d="M4 2.5l13 7.5-13 7.5z" fill="currentColor" />
                  </svg>
                </div>
                <div className="server-startup-launch-btn-text">
                  <span className="server-startup-launch-btn-title">Start Server</span>
                  <span className="server-startup-launch-btn-sub">
                    {codexBinPath
                      ? codexBinPath.length > 45 ? '...' + codexBinPath.slice(-42) : codexBinPath
                      : 'Launch codex app-server as child process'}
                  </span>
                </div>
              </button>
            )}

            <div className="server-startup-config">
              {!serverStarting && !serverRunning && (
                <div className="server-startup-config-row">
                  <span className="server-startup-config-label">Binary</span>
                  <div className="server-startup-config-field">
                    <input
                      type="text"
                      className="server-startup-pathpicker-input"
                      placeholder="codex (from PATH)"
                      value={codexBinPath}
                      onChange={e => setCodexBinPath(e.target.value)}
                      spellCheck={false}
                    />
                    <button className="server-startup-pathpicker-browse" onClick={handleBrowseCodexBinary} title="Browse for codex binary">
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M2 3.5h3.5l1.5 1.5H12v6.5H2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
              <div className="server-startup-config-row">
                <span className="server-startup-config-label">Endpoint</span>
                <code className="server-startup-config-value">{url}</code>
              </div>
              {!serverStarting && !serverRunning && codexCandidates.length > 0 && (
                <div className="server-startup-config-row server-startup-config-row--top">
                  <span className="server-startup-config-label">Detected</span>
                  <div className="server-startup-candidates">
                    {codexCandidates.map(p => (
                      <button
                        key={p}
                        className="server-startup-candidate"
                        onClick={() => setCodexBinPath(p)}
                        title={p}
                      >
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                          <path d="M2 6l3 3 5-5.5" stroke="var(--accent-green)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span className="server-startup-candidate-path">{p}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {!serverStarting && (
              <div className="server-startup-actions">
                {serverRunning && connState !== 'connected' && (
                  <button className="btn-primary server-startup-btn" onClick={() => void handleConnect(url)}>
                    Reconnect
                  </button>
                )}
                <button className="server-startup-btn-ghost" onClick={() => { setShowServerDialog(false); setAppPhase('main'); }}>
                  Manual Setup
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast toast--${toast.type}`} onClick={() => setToast(null)}>
          <span>{toast.msg}</span>
          <button className="toast-close" onClick={() => setToast(null)}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}

function UserInputModal({ request, onSubmit, onCancel }: {
  request: UserInputRequest;
  onSubmit: (requestId: number, answers: Array<{ selectedOption?: number | null; notes?: string }>) => void;
  onCancel: () => void;
}) {
  type UserInputDraftAnswer = {
    selectedOption: number | null;
    notes: string;
  };

  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState<UserInputDraftAnswer[]>(
    () => request.questions.map(() => ({ selectedOption: null, notes: '' }))
  );
  const [secretVisible, setSecretVisible] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const q = request.questions[currentQ];
  const answer = answers[currentQ];
  const isLast = currentQ === request.questions.length - 1;
  const hasOptions = Boolean(q?.options && q.options.length > 0);
  const isOtherSelected = answer?.selectedOption === -1;
  const shouldShowNotes = !hasOptions || q?.allowOther || Boolean(answer?.notes);
  const notesLabel = !hasOptions ? 'Answer' : isOtherSelected ? 'Other answer' : 'Additional notes';
  const notesPlaceholder = q?.isSecret
    ? 'Enter secret answer...'
    : !hasOptions
      ? 'Type your answer...'
      : isOtherSelected
        ? 'Type your custom answer...'
        : 'Additional notes (optional)...';
  const trimmedNotes = answer?.notes.trim() ?? '';

  useEffect(() => {
    setValidationError(null);
    setSecretVisible(false);
  }, [currentQ, request.requestId]);

  const selectOption = (idx: number) => {
    setAnswers(prev => {
      const next = [...prev];
      const curr = next[currentQ];
      next[currentQ] = {
        ...curr,
        selectedOption: curr.selectedOption === idx ? null : idx,
      };
      return next;
    });
    setValidationError(null);
  };

  const validateCurrentAnswer = () => {
    if (!q) {
      return false;
    }

    const hasSelectedOption = typeof answer?.selectedOption === 'number';
    const hasFreeformAnswer = trimmedNotes.length > 0;

    if (!hasOptions) {
      if (!hasFreeformAnswer) {
        setValidationError('This question requires an answer.');
        return false;
      }
      return true;
    }

    if (q.allowOther && isOtherSelected && !hasFreeformAnswer) {
      setValidationError('Please provide the custom answer before continuing.');
      return false;
    }

    if (!hasSelectedOption && !hasFreeformAnswer) {
      setValidationError('Select an option or provide an answer before continuing.');
      return false;
    }

    return true;
  };

  const handleNext = () => {
    if (!validateCurrentAnswer()) {
      return;
    }

    if (isLast) {
      onSubmit(request.requestId, answers.map(a => ({
        selectedOption: a.selectedOption,
        notes: a.notes.trim() || undefined,
      })));
    } else {
      setCurrentQ(prev => prev + 1);
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!q) {
        return;
      }

      const activeElement = document.activeElement;
      const isTextareaFocused = activeElement instanceof HTMLTextAreaElement;
      const isInputFocused = activeElement instanceof HTMLInputElement;
      const isTypingInField = isTextareaFocused || isInputFocused;

      if (!event.ctrlKey && !event.metaKey && !event.altKey && !isTypingInField && hasOptions) {
        if (/^[1-9]$/.test(event.key)) {
          const rawIndex = Number(event.key) - 1;
          const optionCount = q.options?.length ?? 0;
          const otherIndex = q.allowOther ? optionCount : -1;
          if (rawIndex < optionCount) {
            event.preventDefault();
            selectOption(rawIndex);
            return;
          }
          if (rawIndex === otherIndex) {
            event.preventDefault();
            selectOption(-1);
            return;
          }
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }

      if (event.key !== 'Enter' || event.shiftKey) {
        return;
      }

      if (isTextareaFocused && !q.isSecret) {
        return;
      }

      event.preventDefault();
      handleNext();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [answer?.selectedOption, currentQ, handleNext, hasOptions, onCancel, q, selectOption, trimmedNotes]);

  return (
    <div className="user-input-overlay">
      <div className="user-input-card">
        <div className="user-input-header">
          <span className="user-input-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="9" r="7.5" />
              <line x1="9" y1="6" x2="9" y2="10" />
              <circle cx="9" cy="12.5" r="0.5" fill="var(--accent-blue)" />
            </svg>
          </span>
          <span className="user-input-title">Agent needs your input</span>
          {request.questions.length > 1 && (
            <span className="user-input-progress">Question {currentQ + 1} of {request.questions.length}</span>
          )}
        </div>
        {q?.header && <div className="user-input-progress">{q.header}</div>}
        <div className="user-input-question">{q?.question}</div>
        {q?.options && q.options.length > 0 && (
          <div className="user-input-options">
            {q.options.map((opt, i) => (
              <button
                key={i}
                className={`user-input-option${answer.selectedOption === i ? ' user-input-option--selected' : ''}`}
                onClick={() => selectOption(i)}
              >
                <span className="user-input-option-num">{i + 1}</span>
                <span className="user-input-option-text">
                  {opt.label}
                  {opt.description ? <small style={{ display: 'block', opacity: 0.7, marginTop: 4 }}>{opt.description}</small> : null}
                </span>
              </button>
            ))}
            {q.allowOther && (
              <button
                className={`user-input-option user-input-option--other${answer.selectedOption === -1 ? ' user-input-option--selected' : ''}`}
                onClick={() => selectOption(-1)}
              >
                <span className="user-input-option-num">{(q.options?.length ?? 0) + 1}</span>
                <span className="user-input-option-text">Other</span>
              </button>
            )}
          </div>
        )}
        {shouldShowNotes && (
          <div className="user-input-notes">
            <label className="user-input-notes-label">{notesLabel}</label>
            <div className={`user-input-notes-field${q?.isSecret ? ' user-input-notes-field--secret' : ''}`}>
              {q?.isSecret ? (
                <input
                  type={secretVisible ? 'text' : 'password'}
                  value={answer.notes}
                  onChange={(e) => {
                    setAnswers(prev => {
                      const next = [...prev];
                      next[currentQ] = { ...next[currentQ], notes: e.target.value };
                      return next;
                    });
                    setValidationError(null);
                  }}
                  placeholder={notesPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : (
                <textarea
                  value={answer.notes}
                  onChange={(e) => {
                    setAnswers(prev => {
                      const next = [...prev];
                      next[currentQ] = { ...next[currentQ], notes: e.target.value };
                      return next;
                    });
                    setValidationError(null);
                  }}
                  placeholder={notesPlaceholder}
                  rows={2}
                />
              )}
              {q?.isSecret && (
                <button
                  type="button"
                  className="user-input-secret-toggle"
                  onClick={() => setSecretVisible((prev) => !prev)}
                >
                  {secretVisible ? 'Hide' : 'Show'}
                </button>
              )}
            </div>
          </div>
        )}
        {validationError && (
          <div className="elicitation-error">{validationError}</div>
        )}
        <div className="user-input-actions">
          <button className="btn-primary" onClick={handleNext}>
            {isLast ? 'Submit' : 'Next'}
          </button>
          {currentQ > 0 && (
            <button className="btn-secondary" onClick={() => setCurrentQ(prev => prev - 1)}>Back</button>
          )}
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
        <div className="user-input-hint">
          Press <kbd>Enter</kbd> to {isLast ? 'submit' : 'continue'}
          {hasOptions ? <span> &middot; <kbd>1</kbd>-<kbd>9</kbd> to select</span> : null}
          {q?.isSecret ? <span> &middot; <kbd>Esc</kbd> to cancel</span> : null}
        </div>
      </div>
    </div>
  );
}

function McpElicitationModal({
  request,
  onSubmit,
}: {
  request: McpElicitationRequest;
  onSubmit: (
    request: McpElicitationRequest,
    response: { action: 'accept' | 'decline' | 'cancel'; content: unknown },
  ) => void;
}) {
  const [draft, setDraft] = useState<Record<string, McpDraftValue>>(() => {
    if (request.mode !== 'form') {
      return {};
    }

    return Object.fromEntries(
      request.fields.map((field) => [field.key, getMcpFieldInitialValue(field)]),
    ) as Record<string, McpDraftValue>;
  });
  const [error, setError] = useState<string | null>(null);

  const submitForm = () => {
    if (request.mode !== 'form') {
      return;
    }

    const invalidFields = request.fields.filter((field) => !isMcpFieldValueValid(field, draft[field.key]));
    if (invalidFields.length > 0) {
      setError(`Please complete: ${invalidFields.map((field) => field.label).join(', ')}`);
      return;
    }

    setError(null);
    onSubmit(request, {
      action: 'accept',
      content: buildMcpElicitationContent(request.fields, draft),
    });
  };

  return (
    <div className="user-input-overlay">
      <div className="user-input-card elicitation-card">
        <div className="user-input-header">
          <span className="user-input-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 2.5l6 3.2v6.6L9 15.5l-6-3.2V5.7L9 2.5z" />
              <path d="M6.5 8.5h5" />
              <path d="M6.5 11h3.5" />
            </svg>
          </span>
          <span className="user-input-title">MCP server needs input</span>
          <span className="user-input-progress">{request.serverName}</span>
        </div>

        <div className="user-input-question">{request.message}</div>

        {request.mode === 'url' ? (
          <div className="elicitation-url-block">
            <div className="approval-overlay-command">
              <code>{request.url}</code>
            </div>
            <div className="elicitation-url-actions">
              <a className="btn-secondary" href={request.url} target="_blank" rel="noreferrer">
                Open link
              </a>
            </div>
          </div>
        ) : (
          <div className="elicitation-fields">
            {request.fields.map((field) => {
              const value = draft[field.key];
              const description = field.description;

              if (field.kind === 'boolean') {
                return (
                  <label key={field.key} className="elicitation-checkbox-row">
                    <input
                      type="checkbox"
                      checked={typeof value === 'boolean' ? value : false}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [field.key]: event.target.checked,
                        }))
                      }
                    />
                    <span className="elicitation-checkbox-copy">
                      <span className="elicitation-label">
                        {field.label}
                        {field.required ? ' *' : ''}
                      </span>
                      {description ? <span className="elicitation-help">{description}</span> : null}
                    </span>
                  </label>
                );
              }

              if (field.kind === 'multiSelect') {
                const selectedValues = Array.isArray(value) ? value : [];
                return (
                  <div key={field.key} className="elicitation-field">
                    <div className="elicitation-label">
                      {field.label}
                      {field.required ? ' *' : ''}
                    </div>
                    {description ? <div className="elicitation-help">{description}</div> : null}
                    <div className="elicitation-choice-list">
                      {field.options.map((option) => {
                        const selected = selectedValues.includes(option.value);
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={`user-input-option${selected ? ' user-input-option--selected' : ''}`}
                            onClick={() =>
                              setDraft((prev) => {
                                const current = Array.isArray(prev[field.key]) ? (prev[field.key] as string[]) : [];
                                const next = current.includes(option.value)
                                  ? current.filter((entry) => entry !== option.value)
                                  : [...current, option.value];
                                return {
                                  ...prev,
                                  [field.key]: next,
                                };
                              })
                            }
                          >
                            <span className="user-input-option-num">{selected ? 'v' : '+'}</span>
                            <span className="user-input-option-text">{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              if (field.kind === 'singleSelect') {
                return (
                  <div key={field.key} className="elicitation-field">
                    <label className="elicitation-label">
                      {field.label}
                      {field.required ? ' *' : ''}
                    </label>
                    {description ? <div className="elicitation-help">{description}</div> : null}
                    <select
                      className="elicitation-input"
                      value={typeof value === 'string' ? value : ''}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [field.key]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Select...</option>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              }

              const inputType =
                field.kind === 'number'
                  ? 'number'
                  : field.format === 'email'
                  ? 'email'
                  : field.format === 'uri'
                  ? 'url'
                  : field.format === 'date'
                  ? 'date'
                  : field.format === 'date-time'
                  ? 'datetime-local'
                  : 'text';
              const textValue = typeof value === 'string' ? value : '';
              const useTextarea =
                field.kind === 'string' &&
                !field.format &&
                (field.maxLength == null || field.maxLength > 120);

              return (
                <div key={field.key} className="elicitation-field">
                  <label className="elicitation-label">
                    {field.label}
                    {field.required ? ' *' : ''}
                  </label>
                  {description ? <div className="elicitation-help">{description}</div> : null}
                  {useTextarea ? (
                    <textarea
                      className="elicitation-input elicitation-textarea"
                      value={textValue}
                      minLength={field.kind === 'string' ? field.minLength : undefined}
                      maxLength={field.kind === 'string' ? field.maxLength : undefined}
                      rows={3}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  ) : (
                    <input
                      className="elicitation-input"
                      type={inputType}
                      value={textValue}
                      min={field.kind === 'number' ? field.minimum : undefined}
                      max={field.kind === 'number' ? field.maximum : undefined}
                      minLength={field.kind === 'string' ? field.minLength : undefined}
                      maxLength={field.kind === 'string' ? field.maxLength : undefined}
                      step={field.kind === 'number' ? (field.integer ? 1 : 'any') : undefined}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {error ? <div className="elicitation-error">{error}</div> : null}

        <div className="user-input-actions">
          {request.mode === 'form' ? (
            <button className="btn-primary" onClick={submitForm}>
              Submit
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={() => onSubmit(request, { action: 'accept', content: null })}
            >
              I&apos;ve completed this
            </button>
          )}
          <button
            className="btn-secondary"
            onClick={() => onSubmit(request, { action: 'decline', content: null })}
          >
            Decline
          </button>
          <button
            className="btn-secondary"
            onClick={() => onSubmit(request, { action: 'cancel', content: null })}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function AuthRefreshModal({
  request,
  onSubmit,
  onReject,
}: {
  request: AuthRefreshRequest;
  onSubmit: (request: AuthRefreshRequest, response: ChatgptAuthTokensRefreshResponse) => void;
  onReject: (request: AuthRefreshRequest) => void;
}) {
  const [accessToken, setAccessToken] = useState('');
  const [accountId, setAccountId] = useState(request.previousAccountId ?? '');
  const [planType, setPlanType] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const trimmedToken = accessToken.trim();
    const trimmedAccountId = accountId.trim();

    if (!trimmedToken || !trimmedAccountId) {
      setError('Access token and workspace/account ID are required.');
      return;
    }

    setError(null);
    onSubmit(request, {
      accessToken: trimmedToken,
      chatgptAccountId: trimmedAccountId,
      chatgptPlanType: planType.trim() || null,
    });
  };

  return (
    <div className="user-input-overlay">
      <div className="user-input-card auth-refresh-card">
        <div className="user-input-header">
          <span className="user-input-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--accent-blue)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 5.5A5.5 5.5 0 0 0 4.2 4.4" />
              <path d="M4 2.5v2.8h2.8" />
              <path d="M4 12.5A5.5 5.5 0 0 0 13.8 13.6" />
              <path d="M14 15.5v-2.8h-2.8" />
            </svg>
          </span>
          <span className="user-input-title">Refresh ChatGPT auth tokens</span>
          <span className="user-input-progress">{request.reason}</span>
        </div>

        <div className="user-input-question">
          Codex needs a fresh ChatGPT access token to continue the current session.
        </div>

        {request.previousAccountId ? (
          <div className="auth-refresh-note">
            Previous workspace/account ID: <code>{request.previousAccountId}</code>
          </div>
        ) : null}

        <div className="elicitation-fields">
          <div className="elicitation-field">
            <label className="elicitation-label">Access token *</label>
            <div className="elicitation-help">
              Paste a fresh ChatGPT access token JWT from your external auth provider or session broker.
            </div>
            <textarea
              className="elicitation-input elicitation-textarea auth-refresh-token"
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              rows={4}
              spellCheck={false}
              autoComplete="off"
              placeholder="eyJhbGciOi..."
            />
          </div>

          <div className="elicitation-field">
            <label className="elicitation-label">Workspace/account ID *</label>
            <div className="elicitation-help">
              Use the ChatGPT workspace/account identifier that should own the refreshed token.
            </div>
            <input
              className="elicitation-input auth-refresh-account-id"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="acc_..."
            />
          </div>

          <div className="elicitation-field">
            <label className="elicitation-label">Plan type</label>
            <div className="elicitation-help">
              Optional. Leave blank to let Codex infer the plan type from the token claims.
            </div>
            <input
              className="elicitation-input auth-refresh-plan-type"
              value={planType}
              onChange={(event) => setPlanType(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="plus / pro / team / enterprise"
            />
          </div>
        </div>

        {error ? <div className="elicitation-error">{error}</div> : null}

        <div className="user-input-actions">
          <button className="btn-primary" onClick={handleSubmit}>
            Submit token
          </button>
          <button className="btn-secondary" onClick={() => onReject(request)}>
            Reject request
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryPanel({
  entries,
  searchQuery,
  onSearchChange,
  threads,
  onSelectMessage,
}: {
  entries: ChatHistoryEntry[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  threads: import('@codex-mobile/shared').ThreadSummary[];
  onSelectMessage: (msg: string) => void;
}) {
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const todayTs = today.getTime() / 1000;
  const yesterdayTs = yesterday.getTime() / 1000;

  const grouped = entries.reduce<{ today: ChatHistoryEntry[]; yesterday: ChatHistoryEntry[]; earlier: ChatHistoryEntry[] }>(
    (acc, entry) => {
      if (entry.created_at >= todayTs) acc.today.push(entry);
      else if (entry.created_at >= yesterdayTs) acc.yesterday.push(entry);
      else acc.earlier.push(entry);
      return acc;
    },
    { today: [], yesterday: [], earlier: [] }
  );

  const threadMap = Object.fromEntries(threads.map(t => [t.id, t.name || t.preview || t.id]));

  const renderGroup = (label: string, items: ChatHistoryEntry[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label} className="history-group">
        <div className="history-group-label">{label}</div>
        {items.map(entry => (
          <div key={entry.id} className="history-card" onClick={() => onSelectMessage(entry.message)}>
            <div className="history-card-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
              </svg>
            </div>
            <div className="history-card-info">
              <div className="history-card-msg">{entry.message.length > 80 ? `${entry.message.slice(0, 80)}...` : entry.message}</div>
              {entry.thread_id && threadMap[entry.thread_id] && (
                <div className="history-card-thread">{threadMap[entry.thread_id]}</div>
              )}
            </div>
            <div className="history-card-actions">
              <button className="history-action-btn" title="Use this message">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="6,3 14,8 6,13" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="providers-panel">
      <div className="providers-header" data-tauri-drag-region>
        <h2>History</h2>
      </div>

      <div className="providers-toolbar">
        <div className="history-toolbar-search">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search history..."
          />
          {searchQuery && (
            <button className="history-search-clear" onClick={() => onSearchChange('')}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="providers-list">
        {entries.length === 0 ? (
          <div className="provider-empty-state">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="20" cy="20" r="14" />
              <path d="M20 12v8l5 3" />
            </svg>
            <div>鏆傛棤鍘嗗彶璁板綍</div>
            <div>Your chat history will appear here.</div>
          </div>
        ) : (
          <>
            {renderGroup('浠婂ぉ', grouped.today)}
            {renderGroup('鏄ㄥぉ', grouped.yesterday)}
            {renderGroup('鏇存棭', grouped.earlier)}
          </>
        )}
      </div>
    </div>
  );
}

function DynamicToolCallModal({
  request,
  onSubmit,
  onReject,
}: {
  request: DynamicToolCallRequest;
  onSubmit: (
    request: DynamicToolCallRequest,
    response: {
      contentItems: DynamicToolCallContentItem[];
      success: boolean;
    },
  ) => void;
  onReject: (request: DynamicToolCallRequest) => void;
}) {
  const [textOutput, setTextOutput] = useState('');
  const [imageUrls, setImageUrls] = useState('');

  const buildResponse = (success: boolean) => {
    const contentItems: DynamicToolCallContentItem[] = [];
    const text = textOutput.trim();
    const urls = imageUrls
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (text) {
      contentItems.push({ type: 'inputText', text });
    }

    contentItems.push(...urls.map((imageUrl) => ({ type: 'inputImage' as const, imageUrl })));

    onSubmit(request, {
      contentItems,
      success,
    });
  };

  return (
    <div className="user-input-overlay">
      <div className="user-input-card dynamic-tool-card">
        <div className="user-input-header">
          <span className="user-input-icon">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--status-warning)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="12" height="12" rx="2" />
              <path d="M6 9h6" />
              <path d="M9 6v6" />
            </svg>
          </span>
          <span className="user-input-title">Dynamic tool call</span>
          <span className="user-input-progress">{request.tool}</span>
        </div>

        <div className="user-input-question">Codex requested a client-side tool result. Review the arguments below and return the result payload manually.</div>

        <div className="dynamic-tool-section">
          <div className="elicitation-label">Arguments</div>
          <pre className="dynamic-tool-json">{stringifyForDisplay(request.arguments)}</pre>
        </div>

        <div className="dynamic-tool-section">
          <label className="elicitation-label">Text output</label>
          <textarea
            className="elicitation-input elicitation-textarea"
            value={textOutput}
            onChange={(event) => setTextOutput(event.target.value)}
            rows={4}
            placeholder="Return text content for the dynamic tool call..."
          />
        </div>

        <div className="dynamic-tool-section">
          <label className="elicitation-label">Image URLs</label>
          <textarea
            className="elicitation-input elicitation-textarea"
            value={imageUrls}
            onChange={(event) => setImageUrls(event.target.value)}
            rows={3}
            placeholder="One image URL or data URL per line (optional)..."
          />
        </div>

        <div className="user-input-actions">
          <button className="btn-primary" onClick={() => buildResponse(true)}>
            Return success
          </button>
          <button className="btn-secondary" onClick={() => buildResponse(false)}>
            Return failure
          </button>
          <button className="btn-secondary" onClick={() => onReject(request)}>
            Reject request
          </button>
        </div>

        <div className="user-input-hint">Leave both fields empty to return an empty <code>contentItems</code> array.</div>
      </div>
    </div>
  );
}

/* Old AutomationsView removed - replaced by AutomationsPanel component */

type SkillDetail = { name: string; path: string; description?: string; tags?: string[] };

function SkillsView({ skills, onRefresh }: { skills: SkillDetail[]; onRefresh?: () => void }) {
  const [search, setSearch] = useState('');
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  const filtered = search
    ? skills.filter(s => {
        const q = search.toLowerCase();
        return s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q) || (s.description?.toLowerCase().includes(q));
      })
    : skills;

  const grouped = useMemo(() => {
    const groups = new Map<string, SkillDetail[]>();
    for (const s of filtered) {
      const parts = s.path.replace(/\\/g, '/').split('/');
      const project = parts.length > 2 ? parts[parts.length - 3] : parts[0] || 'Project';
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project)!.push(s);
    }
    return Array.from(groups.entries());
  }, [filtered]);

  return (
    <div className="providers-panel">
      <div className="providers-header" data-tauri-drag-region>
        <h2>Skills</h2>
      </div>

      <div className="providers-toolbar">
        <div className="history-toolbar-search">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="7" cy="7" r="5" /><path d="M11 11l3.5 3.5" />
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search skills..." />
          {search && (
            <button className="history-search-clear" onClick={() => setSearch('')}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg>
            </button>
          )}
        </div>
        {onRefresh && (
          <button className="providers-toolbar-btn" onClick={onRefresh}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 7a5.5 5.5 0 0 1 9.3-4" /><path d="M12.5 7a5.5 5.5 0 0 1-9.3 4" />
              <polyline points="11,1 11,4 8,4" /><polyline points="3,13 3,10 6,10" />
            </svg>
            Refresh
          </button>
        )}
      </div>

      <div className="providers-list">
        {filtered.length === 0 ? (
          <div className="provider-empty-state">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="6" width="12" height="12" rx="3" /><rect x="22" y="6" width="12" height="12" rx="3" />
              <rect x="6" y="22" width="12" height="12" rx="3" /><rect x="22" y="22" width="12" height="12" rx="3" />
            </svg>
            <div>{search ? 'No matching skills' : 'No skills found'}</div>
            <div>{search ? 'Try a different search term.' : 'Create a SKILL.md in your project to get started.'}</div>
          </div>
        ) : (
          grouped.map(([project, items]) => (
            <div key={project} className="skills-group">
              <div className="skills-group-header">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4.5V12a1.5 1.5 0 001.5 1.5h9A1.5 1.5 0 0014 12V6.5A1.5 1.5 0 0012.5 5H8L6.5 3H3.5A1.5 1.5 0 002 4.5z" />
                </svg>
                <span>{project}</span>
                <span className="skills-group-count">{items.length}</span>
              </div>
              {items.map((s, i) => {
                const isExpanded = expandedSkill === `${project}-${i}`;
                return (
                  <div
                    key={i}
                    className={`provider-card skill-provider-card${isExpanded ? ' provider-card--active' : ''}`}
                    onClick={() => setExpandedSkill(isExpanded ? null : `${project}-${i}`)}
                    style={{ cursor: 'pointer', flexDirection: 'column', alignItems: 'stretch' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div className="provider-card-icon" style={{ background: 'var(--accent-green-muted)', border: 'none' }}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--accent-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" />
                        </svg>
                      </div>
                      <div className="provider-card-info">
                        <div className="provider-card-name">{s.name}</div>
                        {s.description && !isExpanded && <div className="provider-card-url">{s.description}</div>}
                      </div>
                      {s.tags && s.tags.length > 0 && (
                        <span className="provider-card-badge">{s.tags[0]}</span>
                      )}
                      <svg className={`skill-card-chevron${isExpanded ? ' skill-card-chevron--open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 1.5l4 3.5-4 3.5" />
                      </svg>
                    </div>
                    {isExpanded && (
                      <div className="skill-card-detail">
                        <div className="skill-detail-row"><span className="skill-detail-label">Path</span><span className="skill-detail-value mono">{s.path}</span></div>
                        {s.description && <div className="skill-detail-row"><span className="skill-detail-label">Description</span><span className="skill-detail-value">{s.description}</span></div>}
                        {s.tags && s.tags.length > 0 && (
                          <div className="skill-detail-row"><span className="skill-detail-label">Tags</span><div className="skill-tags">{s.tags.map((t, ti) => <span key={ti} className="skill-tag">{t}</span>)}</div></div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConnectionsPanel({ currentUrl, connState, onConnect, onDisconnect, serverStarting, serverRunning, serverLog, codexBinPath, onCodexBinPathChange, codexCandidates, onStartServer, onStopServer, onBrowseCodexBinary }: {
  currentUrl: string;
  connState: ConnectionState;
  onConnect: (url: string) => void;
  onDisconnect: () => void;
  serverStarting?: boolean;
  serverRunning?: boolean;
  serverLog?: string;
  codexBinPath?: string;
  onCodexBinPathChange?: (path: string) => void;
  codexCandidates?: string[];
  onStartServer?: () => void;
  onStopServer?: () => void;
  onBrowseCodexBinary?: () => void;
}) {
  const [connections, setConnections] = useState<SavedConnectionRow[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('4500');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setConnections(await listConnections()); } catch { /* ignore */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const connectedUrl = connState === 'connected' ? currentUrl : null;

  const resetForm = () => {
    setLabel(''); setHost('127.0.0.1'); setPort('4500');
    setShowAdd(false); setEditingId(null);
  };

  const handleSave = async (makeDefault = false) => {
    const trimLabel = label.trim() || `${host}:${port}`;
    const id = editingId ?? `conn-${Date.now()}`;
    const portNum = parseInt(port, 10) || 4500;
    await saveConnection({ id, label: trimLabel, host: host.trim() || '127.0.0.1', port: portNum, isDefault: makeDefault });
    resetForm();
    await refresh();
  };

  const handleDelete = async (id: string) => {
    await deleteConnection(id);
    setConfirmDelete(null);
    await refresh();
  };

  const handleSetDefault = async (id: string) => {
    await setDefaultConnection(id);
    await refresh();
  };

  const buildUrl = (c: SavedConnectionRow) => `ws://${c.host}:${c.port}`;

  const startEdit = (c: SavedConnectionRow) => {
    setEditingId(c.id);
    setLabel(c.label);
    setHost(c.host);
    setPort(String(c.port));
    setShowAdd(true);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12,
    background: 'var(--bg-secondary)', color: 'var(--text-primary)',
    border: '1px solid var(--border-default)', borderRadius: 6,
    padding: '6px 10px', boxSizing: 'border-box',
  };

  return (
    <div className="settings-panel">
      <h2>Connections</h2>
      <p className="settings-desc">Manage connections to Codex app-server instances. You can run multiple servers on different ports or remote hosts.</p>

      <div className="settings-section">
        <h3>Server</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span className={`sidebar-conn-dot sidebar-conn-dot--${connState === 'connected' ? 'connected' : serverRunning ? 'connecting' : 'disconnected'}`} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {connState === 'connected' ? 'Connected' : serverStarting ? 'Starting...' : serverRunning ? 'Running (not connected)' : 'Stopped'}
          </span>
        </div>
        {serverLog && (
          <code style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', borderRadius: 6, padding: '6px 10px', marginBottom: 10, wordBreak: 'break-all' }}>{serverLog}</code>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Binary Path</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 6, padding: '6px 10px', boxSizing: 'border-box' as const }}
                placeholder="codex (from PATH)"
                value={codexBinPath ?? ''}
                onChange={e => onCodexBinPathChange?.(e.target.value)}
                spellCheck={false}
              />
              {onBrowseCodexBinary && (
                <button className="btn-small" onClick={onBrowseCodexBinary} title="Browse for codex binary" style={{ fontSize: 11, flexShrink: 0 }}>Browse</button>
              )}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Endpoint</label>
            <code style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{currentUrl}</code>
          </div>
        </div>
        {codexCandidates && codexCandidates.length > 0 && !serverRunning && !serverStarting && (
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Detected Binaries</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {codexCandidates.map(p => (
                <button key={p} className="btn-small" style={{ fontSize: 11, textAlign: 'left', justifyContent: 'flex-start' }} onClick={() => onCodexBinPathChange?.(p)} title={p}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {!serverRunning && !serverStarting && onStartServer && (
            <button className="btn-small btn-primary" onClick={onStartServer} style={{ fontSize: 11 }}>Start Server</button>
          )}
          {serverRunning && onStopServer && (
            <button className="btn-small" onClick={onStopServer} style={{ fontSize: 11 }}>Stop Server</button>
          )}
          {serverRunning && connState !== 'connected' && (
            <button className="btn-small btn-primary" onClick={() => onConnect(currentUrl)} style={{ fontSize: 11 }}>Reconnect</button>
          )}
        </div>
      </div>

      {connections.length > 0 ? (
        <div className="settings-section">
          <h3>Saved Connections</h3>
          {connections.map((c) => {
            const wsUrl = buildUrl(c);
            const isConnected = connectedUrl === wsUrl;
            return (
              <div key={c.id} className="settings-row" style={{ alignItems: 'center', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                  <span className={`sidebar-conn-dot sidebar-conn-dot--${isConnected ? 'connected' : 'disconnected'}`} />
                  <div style={{ minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.label}
                      {c.is_default ? <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 6 }}>DEFAULT</span> : null}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{wsUrl}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                  {isConnected ? (
                    <button className="btn-small" onClick={onDisconnect} style={{ fontSize: 11 }}>Disconnect</button>
                  ) : (
                    <button className="btn-small btn-primary" onClick={() => onConnect(wsUrl)} style={{ fontSize: 11 }}>Connect</button>
                  )}
                  <button className="btn-small" onClick={() => startEdit(c)} style={{ fontSize: 11 }}>Edit</button>
                  {!c.is_default && (
                    <button className="btn-small" onClick={() => handleSetDefault(c.id)} style={{ fontSize: 11 }}>Set Default</button>
                  )}
                  {confirmDelete === c.id ? (
                    <div style={{ display: 'flex', gap: 3 }}>
                      <button className="btn-small" style={{ fontSize: 11, color: 'var(--status-error)' }} onClick={() => handleDelete(c.id)}>Confirm</button>
                      <button className="btn-small" style={{ fontSize: 11 }} onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button className="btn-small" onClick={() => setConfirmDelete(c.id)} style={{ fontSize: 11 }}>脳</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-section-card">
          <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
            No saved connections. Add one below to get started.
          </span>
        </div>
      )}

      <div className="settings-section">
        {showAdd ? (
          <>
            <h3>{editingId ? 'Edit Connection' : 'Add Connection'}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Label</label>
                <input style={inputStyle} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Local Server" />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Host</label>
                  <input style={inputStyle} value={host} onChange={e => setHost(e.target.value)} placeholder="127.0.0.1" />
                </div>
                <div style={{ width: 100 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Port</label>
                  <input style={inputStyle} value={port} onChange={e => setPort(e.target.value)} placeholder="4500" type="number" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-small btn-primary" onClick={() => handleSave(false)}>
                  {editingId ? 'Update' : 'Save'}
                </button>
                {!editingId && <button className="btn-small" onClick={() => handleSave(true)}>Save as Default</button>}
                <button className="btn-small" onClick={resetForm}>Cancel</button>
              </div>
            </div>
          </>
        ) : (
          <button className="btn-small btn-primary" onClick={() => { resetForm(); setShowAdd(true); }} style={{ marginTop: 4 }}>
            + Add Connection
          </button>
        )}
      </div>

      <div className="settings-section">
        <h3>Quick Connect</h3>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 8px' }}>
          Connect directly without saving. The current URL from the General tab is used.
        </p>
        <div className="settings-row">
          <label style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{currentUrl}</label>
          {connState === 'connected' ? (
            <button className="btn-small" onClick={onDisconnect}>Disconnect</button>
          ) : (
            <button className="btn-small btn-primary" onClick={() => onConnect(currentUrl)}>Connect</button>
          )}
        </div>
      </div>
    </div>
  );
}

function McpSettingsPanel({ mcpServers, client, onRefresh }: {
  mcpServers: Array<{ name: string; status: string }>;
  client: CodexClient;
  onRefresh: () => Promise<void>;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState('');
  const [addType, setAddType] = useState<'stdio' | 'sse'>('stdio');
  const [addCommand, setAddCommand] = useState('');
  const [addArgs, setAddArgs] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addEnvText, setAddEnvText] = useState('');
  const [saving, setSaving] = useState(false);
  const [togglingServer, setTogglingServer] = useState<string | null>(null);
  const [removingServer, setRemovingServer] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setAddName('');
    setAddCommand('');
    setAddArgs('');
    setAddUrl('');
    setAddEnvText('');
    setAddType('stdio');
    setShowAddForm(false);
    setError(null);
  };

  const handleAdd = async () => {
    const key = addName.trim().replace(/\s+/g, '-').toLowerCase();
    if (!key) { setError('Server name is required'); return; }

    const config: Record<string, unknown> = {};
    if (addType === 'stdio') {
      if (!addCommand.trim()) { setError('Command is required for stdio servers'); return; }
      config.command = addCommand.trim();
      if (addArgs.trim()) {
        config.args = addArgs.split(/\s+/).filter(Boolean);
      }
    } else {
      if (!addUrl.trim()) { setError('URL is required for SSE servers'); return; }
      config.url = addUrl.trim();
    }

    if (addEnvText.trim()) {
      const env: Record<string, string> = {};
      for (const line of addEnvText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key) env[key] = val;
      }
      if (Object.keys(env).length > 0) config.env = env;
    }

    setSaving(true);
    setError(null);
    try {
      await client.addMcpServer(key, config as { command?: string; args?: string[]; url?: string; env?: Record<string, string> });
      resetForm();
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add server');
    }
    setSaving(false);
  };

  const handleToggle = async (serverName: string, currentStatus: string) => {
    setTogglingServer(serverName);
    try {
      const shouldEnable = currentStatus === 'disabled' || currentStatus === 'stopped';
      await client.enableMcpServer(serverName, shouldEnable);
      await onRefresh();
    } catch { /* ignore */ }
    setTogglingServer(null);
  };

  const handleRemove = async (serverName: string) => {
    setRemovingServer(serverName);
    try {
      await client.removeMcpServer(serverName);
      setConfirmRemove(null);
      await onRefresh();
    } catch { /* ignore */ }
    setRemovingServer(null);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12,
    background: 'var(--bg-secondary)', color: 'var(--text-primary)',
    border: '1px solid var(--border-default)', borderRadius: 6,
    padding: '6px 10px', boxSizing: 'border-box',
  };

  return (
    <div className="settings-panel">
      <h2>MCP Servers</h2>
      <p className="settings-desc">Connect external tools and data sources via the Model Context Protocol.</p>

      {mcpServers.length > 0 ? (
        <div className="settings-section">
          <h3>Servers ({mcpServers.length})</h3>
          {mcpServers.map((s) => (
            <div key={s.name} className="settings-row" style={{ alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                <span className={`sidebar-conn-dot sidebar-conn-dot--${s.status === 'running' ? 'connected' : 'disconnected'}`} />
                <label style={{ fontFamily: 'var(--font-mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</label>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: s.status === 'running' ? 'var(--status-active)' : 'var(--text-tertiary)', textTransform: 'capitalize', minWidth: 52, textAlign: 'right' }}>
                  {s.status}
                </span>
                <button
                  className="btn-small"
                  disabled={togglingServer === s.name}
                  onClick={() => handleToggle(s.name, s.status)}
                  style={{ minWidth: 60, fontSize: 11 }}
                >
                  {togglingServer === s.name ? '...' : s.status === 'running' ? 'Disable' : 'Enable'}
                </button>
                {confirmRemove === s.name ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn-small" style={{ fontSize: 11, color: 'var(--status-error)' }} disabled={removingServer === s.name} onClick={() => handleRemove(s.name)}>
                      {removingServer === s.name ? '...' : 'Confirm'}
                    </button>
                    <button className="btn-small" style={{ fontSize: 11 }} onClick={() => setConfirmRemove(null)}>Cancel</button>
                  </div>
                ) : (
                  <button className="btn-small" style={{ fontSize: 11 }} onClick={() => setConfirmRemove(s.name)}>Remove</button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-section-card">
          <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
            No MCP servers configured. Add one below or configure servers in your Codex config.
          </span>
        </div>
      )}

      <div className="settings-section">
        {showAddForm ? (
          <>
            <h3>Add MCP Server</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Server Name *</label>
                  <input style={inputStyle} value={addName} onChange={e => setAddName(e.target.value)} placeholder="e.g. my-server" />
                </div>
                <div style={{ width: 120 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Type</label>
                  <select value={addType} onChange={e => setAddType(e.target.value as 'stdio' | 'sse')} style={{ ...inputStyle, cursor: 'pointer' }}>
                    <option value="stdio">stdio</option>
                    <option value="sse">SSE (HTTP)</option>
                  </select>
                </div>
              </div>

              {addType === 'stdio' ? (
                <>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Command *</label>
                    <input style={inputStyle} value={addCommand} onChange={e => setAddCommand(e.target.value)} placeholder="e.g. npx, uvx, node" />
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Arguments (space-separated)</label>
                    <input style={inputStyle} value={addArgs} onChange={e => setAddArgs(e.target.value)} placeholder="e.g. -y @modelcontextprotocol/server-filesystem ." />
                  </div>
                </>
              ) : (
                <div>
                  <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>URL *</label>
                  <input style={inputStyle} value={addUrl} onChange={e => setAddUrl(e.target.value)} placeholder="e.g. http://localhost:3001/sse" />
                </div>
              )}

              <div>
                <label style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>Environment Variables (one per line: KEY=VALUE)</label>
                <textarea
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 48 }}
                  rows={2}
                  value={addEnvText}
                  onChange={e => setAddEnvText(e.target.value)}
                  placeholder="API_KEY=sk-..."
                />
              </div>

              {error && <div style={{ color: 'var(--status-error)', fontSize: 12 }}>{error}</div>}

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-small btn-primary" disabled={saving} onClick={handleAdd}>
                  {saving ? 'Adding...' : 'Add Server'}
                </button>
                <button className="btn-small" onClick={resetForm}>Cancel</button>
              </div>
            </div>
          </>
        ) : (
          <button className="btn-small btn-primary" onClick={() => setShowAddForm(true)} style={{ marginTop: 4 }}>
            + Add MCP Server
          </button>
        )}
      </div>

      <div className="settings-section">
        <h3>Recommended</h3>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 8px' }}>
          Popular MCP servers you can add with one click.
        </p>
        {[
          { name: 'filesystem', desc: 'File system access', cmd: 'npx', args: '-y @modelcontextprotocol/server-filesystem .' },
          { name: 'playwright', desc: 'Browser automation', cmd: 'npx', args: '-y @playwright/mcp@latest' },
          { name: 'memory', desc: 'Persistent memory store', cmd: 'npx', args: '-y @modelcontextprotocol/server-memory' },
        ].map((rec) => {
          const isInstalled = mcpServers.some(s => s.name === rec.name);
          return (
            <div key={rec.name} className="settings-row">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <label style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{rec.name}</label>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{rec.desc}</span>
              </div>
              <button
                className="btn-small"
                disabled={isInstalled}
                onClick={async () => {
                  try {
                    await client.addMcpServer(rec.name, {
                      command: rec.cmd,
                      args: rec.args.split(' ').filter(Boolean),
                    });
                    await onRefresh();
                  } catch { /* ignore */ }
                }}
              >
                {isInstalled ? 'Installed' : 'Add'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type SettingsTab = 'general' | 'connections' | 'appearance' | 'config' | 'personalization' | 'mcp' | 'git' | 'archived';

const SETTINGS_TAB_KEYS: { id: SettingsTab; key: string }[] = [
  { id: 'general', key: 'settings.general' },
  { id: 'connections', key: 'settings.connections' },
  { id: 'appearance', key: 'settings.appearance' },
  { id: 'config', key: 'settings.configuration' },
  { id: 'personalization', key: 'settings.personalization' },
  { id: 'mcp', key: 'settings.mcpServers' },
  { id: 'git', key: 'settings.git' },
  { id: 'archived', key: 'settings.archivedThreads' },
];

function getConfigValue(config: Record<string, unknown> | null, path: string): unknown {
  const root = getConfigRoot(config);
  if (!root) return undefined;
  const parts = path.split('.');
  let obj: unknown = root;
  for (const p of parts) {
    if (obj && typeof obj === 'object' && p in (obj as Record<string, unknown>)) {
      obj = (obj as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return obj;
}

function getApprovalPolicyValue(config: Record<string, unknown> | null): ApprovalPolicyValue | undefined {
  const raw = getConfigValue(config, 'approvalPolicy') ?? getConfigValue(config, 'approval_policy');
  if (typeof raw === 'string') {
    if (raw === 'untrusted' || raw === 'on-failure' || raw === 'on-request' || raw === 'never') {
      return raw;
    }
    return undefined;
  }
  if (raw && typeof raw === 'object' && 'granular' in (raw as Record<string, unknown>)) {
    return 'granular';
  }
  return undefined;
}

function getSandboxModeValue(config: Record<string, unknown> | null): SandboxModeValue | undefined {
  const raw = getConfigValue(config, 'sandboxMode') ?? getConfigValue(config, 'sandbox_mode') ?? getConfigValue(config, 'sandbox');
  if (raw === 'read-only' || raw === 'workspace-write' || raw === 'danger-full-access') {
    return raw;
  }
  return undefined;
}

function getEffectiveApprovalPolicyValue(config: Record<string, unknown> | null): ApprovalPolicyValue {
  return getApprovalPolicyValue(config) ?? 'untrusted';
}

function getEffectiveSandboxModeValue(config: Record<string, unknown> | null): SandboxModeValue {
  return getSandboxModeValue(config) ?? 'read-only';
}

function deriveAutonomyModeFromConfig(config: Record<string, unknown> | null): AutonomyModeValue {
  if (!config) return 'suggest';

  const approvalPolicy = getEffectiveApprovalPolicyValue(config);
  const sandboxMode = getEffectiveSandboxModeValue(config);

  if (approvalPolicy === AUTONOMY_PRESETS.suggest.approvalPolicy && sandboxMode === AUTONOMY_PRESETS.suggest.sandboxMode) {
    return 'suggest';
  }
  if (approvalPolicy === AUTONOMY_PRESETS['auto-edit'].approvalPolicy && sandboxMode === AUTONOMY_PRESETS['auto-edit'].sandboxMode) {
    return 'auto-edit';
  }
  if (
    sandboxMode === AUTONOMY_PRESETS['full-auto'].sandboxMode &&
    (approvalPolicy === AUTONOMY_PRESETS['full-auto'].approvalPolicy || approvalPolicy === 'on-failure')
  ) {
    return 'full-auto';
  }
  return 'custom';
}

function formatAutonomyModeLabel(mode: AutonomyModeValue): string {
  switch (mode) {
    case 'suggest':
      return 'Suggest';
    case 'auto-edit':
      return 'Auto Edit';
    case 'full-auto':
      return 'Full Auto';
    default:
      return 'Custom';
  }
}

function formatAutonomyModeDetail(config: Record<string, unknown> | null, mode: AutonomyModeValue): string | null {
  if (mode !== 'custom') return null;

  const approvalPolicy = getApprovalPolicyValue(config) ?? 'unknown';
  const sandboxMode = getSandboxModeValue(config) ?? 'unknown';
  return `${approvalPolicy} 路 ${sandboxMode}`;
}

function getAutonomyModeSummary(config: Record<string, unknown> | null): string {
  const approvalPolicy = getEffectiveApprovalPolicyValue(config);
  const sandboxMode = getEffectiveSandboxModeValue(config);
  return `${approvalPolicy} / ${sandboxMode}`;
}

function formatRateLimitResetTime(unixSec: number | null): string {
  if (typeof unixSec !== 'number' || !Number.isFinite(unixSec)) {
    return 'Unknown';
  }
  return new Date(unixSec * 1000).toLocaleString();
}

type NotificationPref = 'always' | 'unfocused' | 'never';
interface ChromeThemeConfig {
  accent: string;
  surface: string;
  ink: string;
  contrast: number;
  fonts: { ui: string | null; code: string | null };
  opaqueWindows: boolean;
  semanticColors: { diffAdded: string; diffRemoved: string; skill: string };
}

interface ThemePreset {
  id: string;
  label: string;
  dark: { accent: string; surface: string; ink: string };
  light: { accent: string; surface: string; ink: string };
  previewColor: string;
}

const THEME_PRESETS: ThemePreset[] = [
  { id: 'codex', label: 'Codex', dark: { accent: '#0169cc', surface: '#111111', ink: '#fcfcfc' }, light: { accent: '#0169cc', surface: '#ffffff', ink: '#1a1a1b' }, previewColor: '#0169cc' },
  { id: 'linear', label: 'Linear', dark: { accent: '#5e6ad2', surface: '#17181d', ink: '#e6e9ef' }, light: { accent: '#5e6ad2', surface: '#ffffff', ink: '#1a1a1b' }, previewColor: '#5e6ad2' },
  { id: 'absolutely', label: 'Absolutely', dark: { accent: '#cc7d5e', surface: '#2d2d2b', ink: '#f9f9f7' }, light: { accent: '#cc7d5e', surface: '#f9f9f7', ink: '#2d2d2b' }, previewColor: '#cc7d5e' },
  { id: 'ayu', label: 'Ayu', dark: { accent: '#e6b450', surface: '#0b0e14', ink: '#bfbdb6' }, light: { accent: '#e6b450', surface: '#fafafa', ink: '#575f66' }, previewColor: '#e6b450' },
  { id: 'catppuccin', label: 'Catppuccin', dark: { accent: '#cba6f7', surface: '#1e1e2e', ink: '#cdd6f4' }, light: { accent: '#8839ef', surface: '#eff1f5', ink: '#4c4f69' }, previewColor: '#cba6f7' },
  { id: 'dracula', label: 'Dracula', dark: { accent: '#bd93f9', surface: '#282a36', ink: '#f8f8f2' }, light: { accent: '#7c3aed', surface: '#f8f8f2', ink: '#282a36' }, previewColor: '#bd93f9' },
  { id: 'everforest', label: 'Everforest', dark: { accent: '#a7c080', surface: '#2d353b', ink: '#d3c6aa' }, light: { accent: '#8da101', surface: '#fdf6e3', ink: '#5c6a72' }, previewColor: '#a7c080' },
  { id: 'github', label: 'GitHub', dark: { accent: '#1f6feb', surface: '#0d1117', ink: '#e6edf3' }, light: { accent: '#0969da', surface: '#ffffff', ink: '#1f2328' }, previewColor: '#1f6feb' },
  { id: 'gruvbox', label: 'Gruvbox', dark: { accent: '#d79921', surface: '#282828', ink: '#ebdbb2' }, light: { accent: '#b57614', surface: '#fbf1c7', ink: '#3c3836' }, previewColor: '#d79921' },
  { id: 'material', label: 'Material', dark: { accent: '#82aaff', surface: '#212121', ink: '#eeffff' }, light: { accent: '#6182b8', surface: '#fafafa', ink: '#90a4ae' }, previewColor: '#82aaff' },
  { id: 'monokai', label: 'Monokai', dark: { accent: '#a6e22e', surface: '#272822', ink: '#f8f8f2' }, light: { accent: '#78a21a', surface: '#fafaf8', ink: '#49483e' }, previewColor: '#a6e22e' },
  { id: 'nord', label: 'Nord', dark: { accent: '#88c0d0', surface: '#2e3440', ink: '#eceff4' }, light: { accent: '#5e81ac', surface: '#eceff4', ink: '#2e3440' }, previewColor: '#88c0d0' },
  { id: 'notion', label: 'Notion', dark: { accent: '#3183d8', surface: '#191919', ink: '#d9d9d8' }, light: { accent: '#2383e2', surface: '#ffffff', ink: '#37352f' }, previewColor: '#3183d8' },
  { id: 'one-dark', label: 'One Dark', dark: { accent: '#61afef', surface: '#282c34', ink: '#abb2bf' }, light: { accent: '#4078f2', surface: '#fafafa', ink: '#383a42' }, previewColor: '#61afef' },
  { id: 'rose-pine', label: 'Ros茅 Pine', dark: { accent: '#c4a7e7', surface: '#232136', ink: '#e0def4' }, light: { accent: '#907aa9', surface: '#faf4ed', ink: '#575279' }, previewColor: '#c4a7e7' },
  { id: 'solarized', label: 'Solarized', dark: { accent: '#2aa198', surface: '#002b36', ink: '#839496' }, light: { accent: '#2aa198', surface: '#fdf6e3', ink: '#657b83' }, previewColor: '#2aa198' },
  { id: 'tokyo-night', label: 'Tokyo Night', dark: { accent: '#7aa2f7', surface: '#1a1b26', ink: '#a9b1d6' }, light: { accent: '#34548a', surface: '#d5d6db', ink: '#343b58' }, previewColor: '#7aa2f7' },
  { id: 'sentry', label: 'Sentry', dark: { accent: '#7055f6', surface: '#2d2935', ink: '#e6dff9' }, light: { accent: '#6c5fc7', surface: '#f5f3f7', ink: '#2d2935' }, previewColor: '#7055f6' },
  { id: 'lobster', label: 'Lobster', dark: { accent: '#ff5c5c', surface: '#111827', ink: '#e4e4e7' }, light: { accent: '#dc2626', surface: '#ffffff', ink: '#111827' }, previewColor: '#ff5c5c' },
  { id: 'matrix', label: 'Matrix', dark: { accent: '#1eff5a', surface: '#040805', ink: '#b8ffca' }, light: { accent: '#00a240', surface: '#f0fff4', ink: '#0a3d19' }, previewColor: '#1eff5a' },
];

const DEFAULT_THEME_PRESET = 'codex';

function getDefaultThemeConfig(variant: 'dark' | 'light'): ChromeThemeConfig {
  const preset = THEME_PRESETS.find(p => p.id === DEFAULT_THEME_PRESET) ?? THEME_PRESETS[0];
  const colors = variant === 'dark' ? preset.dark : preset.light;
  return {
    ...colors,
    contrast: 60,
    fonts: { ui: null, code: null },
    opaqueWindows: true,
    semanticColors: variant === 'dark'
      ? { diffAdded: '#40c977', diffRemoved: '#fa423e', skill: '#ad7bf9' }
      : { diffAdded: '#00a240', diffRemoved: '#ba2623', skill: '#924ff7' },
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

function mixHex(c1: string, c2: string, amount: number): string {
  const [r1, g1, b1] = hexToRgb(c1);
  const [r2, g2, b2] = hexToRgb(c2);
  return rgbToHex(r1 + (r2 - r1) * amount, g1 + (g2 - g1) * amount, b1 + (b2 - b1) * amount);
}

function hexAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

const THEME_STRING_PREFIX = 'codex-theme-v1:';

function exportThemeString(config: ChromeThemeConfig, variant: 'dark' | 'light'): string {
  return THEME_STRING_PREFIX + JSON.stringify({ variant, theme: config });
}

function importThemeString(str: string): { variant: 'dark' | 'light'; theme: ChromeThemeConfig } | null {
  try {
    const trimmed = str.trim();
    if (!trimmed.startsWith(THEME_STRING_PREFIX)) return null;
    const json = trimmed.slice(THEME_STRING_PREFIX.length);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const v = parsed.variant;
    if (v !== 'dark' && v !== 'light') return null;
    const t = parsed.theme;
    if (!t || typeof t.accent !== 'string' || typeof t.surface !== 'string' || typeof t.ink !== 'string') return null;
    const defaults = getDefaultThemeConfig(v);
    return {
      variant: v,
      theme: {
        accent: t.accent,
        surface: t.surface,
        ink: t.ink,
        contrast: typeof t.contrast === 'number' ? Math.max(0, Math.min(100, t.contrast)) : 60,
        fonts: { ui: t.fonts?.ui ?? null, code: t.fonts?.code ?? null },
        opaqueWindows: typeof t.opaqueWindows === 'boolean' ? t.opaqueWindows : true,
        semanticColors: {
          diffAdded: t.semanticColors?.diffAdded ?? defaults.semanticColors.diffAdded,
          diffRemoved: t.semanticColors?.diffRemoved ?? defaults.semanticColors.diffRemoved,
          skill: t.semanticColors?.skill ?? defaults.semanticColors.skill,
        },
      },
    };
  } catch {
    return null;
  }
}

function applyThemeConfig(config: ChromeThemeConfig, variant: 'dark' | 'light') {
  const root = document.documentElement;
  const { accent, surface, ink, contrast } = config;
  const c = contrast / 100;

  root.style.setProperty('--bg-primary', surface);
  root.style.setProperty('--bg-secondary', mixHex(surface, ink, 0.03 + c * 0.02));
  root.style.setProperty('--bg-tertiary', mixHex(surface, ink, 0.06 + c * 0.03));
  root.style.setProperty('--bg-elevated', mixHex(surface, ink, 0.09 + c * 0.04));
  root.style.setProperty('--bg-hover', mixHex(surface, ink, 0.10 + c * 0.05));
  root.style.setProperty('--bg-input', mixHex(surface, ink, 0.04 + c * 0.02));
  root.style.setProperty('--surface-secondary', mixHex(surface, ink, 0.03 + c * 0.02));

  root.style.setProperty('--text-primary', ink);
  root.style.setProperty('--text-secondary', mixHex(ink, surface, 0.35 - c * 0.1));
  root.style.setProperty('--text-tertiary', mixHex(ink, surface, 0.55 - c * 0.1));
  root.style.setProperty('--text-inverse', surface);

  root.style.setProperty('--accent-green', accent);
  root.style.setProperty('--accent-green-hover', mixHex(accent, variant === 'dark' ? '#ffffff' : '#000000', 0.1));
  root.style.setProperty('--accent-green-muted', hexAlpha(accent, 0.15));
  root.style.setProperty('--accent-green-border', hexAlpha(accent, 0.3));
  root.style.setProperty('--accent-green-subtle', hexAlpha(accent, 0.08));
  root.style.setProperty('--accent-green-hover-bg', hexAlpha(accent, 0.25));
  root.style.setProperty('--accent-green-soft', hexAlpha(accent, 0.12));
  root.style.setProperty('--accent-green-faint', hexAlpha(accent, 0.04));
  root.style.setProperty('--accent-blue', accent);
  root.style.setProperty('--accent-blue-muted', hexAlpha(accent, 0.12));
  root.style.setProperty('--accent-blue-subtle', hexAlpha(accent, 0.06));
  root.style.setProperty('--accent-blue-border', hexAlpha(accent, 0.3));
  root.style.setProperty('--accent-blue-soft', hexAlpha(accent, 0.1));
  root.style.setProperty('--accent-blue-border-soft', hexAlpha(accent, 0.25));
  root.style.setProperty('--accent-blue-hover', hexAlpha(accent, 0.2));
  root.style.setProperty('--accent-blue-faint', hexAlpha(accent, 0.08));
  root.style.setProperty('--accent-blue-strong', hexAlpha(accent, 0.4));

  const borderAlpha = 0.06 + c * 0.04;
  root.style.setProperty('--border-primary', mixHex(surface, ink, borderAlpha));
  root.style.setProperty('--border-secondary', mixHex(surface, ink, borderAlpha * 1.5));
  root.style.setProperty('--border-subtle', mixHex(surface, ink, borderAlpha * 0.6));

  root.style.setProperty('--status-active', accent);
  root.style.setProperty('--status-info', accent);
  root.style.setProperty('--border-active', accent);

  root.style.setProperty('--diff-added', config.semanticColors.diffAdded);
  root.style.setProperty('--diff-removed', config.semanticColors.diffRemoved);
  root.style.setProperty('--skill-color', config.semanticColors.skill);
  root.style.setProperty('--accent-emerald', config.semanticColors.diffAdded);
  root.style.setProperty('--accent-emerald-muted', hexAlpha(config.semanticColors.diffAdded, 0.12));
  root.style.setProperty('--accent-emerald-subtle', hexAlpha(config.semanticColors.diffAdded, 0.08));

  if (config.fonts.ui) {
    root.style.setProperty('--font-sans', config.fonts.ui);
  } else {
    root.style.removeProperty('--font-sans');
  }
  if (config.fonts.code) {
    root.style.setProperty('--font-mono', config.fonts.code);
  } else {
    root.style.removeProperty('--font-mono');
  }

  root.style.setProperty('--shadow-focus', `0 0 0 3px ${hexAlpha(accent, 0.15)}`);
  root.style.setProperty('--shadow-focus-blue', `0 0 0 2px ${hexAlpha(accent, 0.25)}`);
}

function applyFontSizes(uiSize: number, codeSize: number) {
  document.documentElement.style.setProperty('--ui-font-size', `${uiSize}px`);
  document.documentElement.style.setProperty('--code-font-size', `${codeSize}px`);
  document.body.style.fontSize = `${uiSize}px`;
}

function resolveThemeVariant(theme: ThemeMode): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme === 'light' ? 'light' : 'dark';
}

function SettingsView({
  url,
  onUrlChange,
  connState,
  accountInfo,
  rateLimits,
  mcpServers,
  client,
  theme,
  onThemeChange,
  codexConfig,
  onWriteConfig,
  onRefreshMcp,
  onConnect,
  onDisconnect,
  uiFontSize,
  onUiFontSizeChange,
  codeFontSize,
  onCodeFontSizeChange,
  notificationPref,
  onNotificationPrefChange,
  themePreset,
  onThemePresetChange,
  themeConfig,
  onThemeConfigChange,
  pointerCursor,
  onPointerCursorChange,
  onAutonomyModeChange,
  autonomyMode: externalAutonomyMode,
  isUpdatingAutonomy,
  serverStarting,
  serverRunning,
  serverLog,
  codexBinPath,
  onCodexBinPathChange,
  codexCandidates,
  onStartServer,
  onStopServer,
  onBrowseCodexBinary,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  connState: ConnectionState;
  accountInfo: AccountInfo;
  rateLimits: RateLimitSnapshotState | null;
  mcpServers: Array<{ name: string; status: string }>;
  client: CodexClient;
  theme: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
  codexConfig: Record<string, unknown> | null;
  onWriteConfig?: (key: string, value: unknown) => Promise<void>;
  onRefreshMcp?: () => Promise<unknown>;
  onConnect?: (url: string) => void;
  onDisconnect?: () => void;
  uiFontSize: number;
  onUiFontSizeChange: (size: number) => void;
  codeFontSize: number;
  onCodeFontSizeChange: (size: number) => void;
  notificationPref: NotificationPref;
  onNotificationPrefChange: (pref: NotificationPref) => void;
  themePreset: string;
  onThemePresetChange: (presetId: string) => void;
  themeConfig: ChromeThemeConfig;
  onThemeConfigChange: (config: ChromeThemeConfig) => void;
  pointerCursor: boolean;
  onPointerCursorChange: (enabled: boolean) => void;
  onAutonomyModeChange?: (mode: string) => void;
  autonomyMode: AutonomyModeValue;
  isUpdatingAutonomy?: boolean;
  serverStarting?: boolean;
  serverRunning?: boolean;
  serverLog?: string;
  codexBinPath?: string;
  onCodexBinPathChange?: (path: string) => void;
  codexCandidates?: string[];
  onStartServer?: () => void;
  onStopServer?: () => void;
  onBrowseCodexBinary?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<SettingsTab>('general');
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [instructionsValue, setInstructionsValue] = useState('');
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [editingBranchPrefix, setEditingBranchPrefix] = useState(false);
  const [branchPrefixValue, setBranchPrefixValue] = useState('');
  const [savingBranchPrefix, setSavingBranchPrefix] = useState(false);
  const [editingCommitInstructions, setEditingCommitInstructions] = useState(false);
  const [commitInstructionsValue, setCommitInstructionsValue] = useState('');
  const [savingCommitInstructions, setSavingCommitInstructions] = useState(false);
  const [editingProfileName, setEditingProfileName] = useState(false);
  const [profileNameValue, setProfileNameValue] = useState('');
  const [savingProfileName, setSavingProfileName] = useState(false);
  const [editingResponseLang, setEditingResponseLang] = useState(false);
  const [responseLangValue, setResponseLangValue] = useState('');
  const [savingResponseLang, setSavingResponseLang] = useState(false);
  const [themeImportOpen, setThemeImportOpen] = useState(false);
  const [themeImportValue, setThemeImportValue] = useState('');
  const [presetDropdownOpen, setPresetDropdownOpen] = useState(false);
  const presetDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!presetDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (presetDropdownRef.current && !presetDropdownRef.current.contains(e.target as Node)) {
        setPresetDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [presetDropdownOpen]);

  const activeVariant = resolveThemeVariant(theme);
  const patch = (p: Partial<ChromeThemeConfig>) => onThemeConfigChange({ ...themeConfig, ...p });
  const patchFonts = (p: Partial<ChromeThemeConfig['fonts']>) => onThemeConfigChange({ ...themeConfig, fonts: { ...themeConfig.fonts, ...p } });
  const patchSemantic = (p: Partial<ChromeThemeConfig['semanticColors']>) => onThemeConfigChange({ ...themeConfig, semanticColors: { ...themeConfig.semanticColors, ...p } });

  const handlePresetSelect = (presetId: string) => {
    const preset = THEME_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    onThemePresetChange(presetId);
    const colors = activeVariant === 'dark' ? preset.dark : preset.light;
    onThemeConfigChange({ ...themeConfig, accent: colors.accent, surface: colors.surface, ink: colors.ink });
    setPresetDropdownOpen(false);
  };

  const handleThemeVariantChange = (t: ThemeMode) => {
    onThemeChange(t);
    const newVariant = t === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : (t === 'light' ? 'light' : 'dark');
    const preset = THEME_PRESETS.find(p => p.id === themePreset);
    if (preset) {
      const colors = newVariant === 'dark' ? preset.dark : preset.light;
      onThemeConfigChange({ ...themeConfig, accent: colors.accent, surface: colors.surface, ink: colors.ink });
    }
  };

  const colorRow = (label: string, value: string, onSet: (v: string) => void) => (
    <div className="settings-row">
      <label>{label}</label>
      <div className="settings-color-input">
        <input type="color" value={value} onChange={e => onSet(e.target.value)} className="settings-color-native" />
        <input
          type="text"
          value={value}
          onChange={e => { const v = e.target.value; if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onSet(v); }}
          onBlur={e => { if (!/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onSet(value); }}
          className="settings-color-hex"
          spellCheck={false}
        />
      </div>
    </div>
  );

  const currentPreset = THEME_PRESETS.find(p => p.id === themePreset) ?? THEME_PRESETS[0];

  useEffect(() => {
    if (tab === 'archived' && connState === 'connected') {
      setLoadingArchived(true);
      (async () => {
        try {
          const result = await client.listThreads({ limit: 50, archived: true });
          setArchivedThreads(result.data);
        } catch {
          setArchivedThreads([]);
        }
        setLoadingArchived(false);
      })();
    }
  }, [tab, connState, client]);

  return (
    <div className="settings-layout">
      <nav className="settings-tabs">
        {SETTINGS_TAB_KEYS.map((tabDef) => (
          <button
            key={tabDef.id}
            className={`settings-tab${tab === tabDef.id ? ' settings-tab--active' : ''}`}
            onClick={() => setTab(tabDef.id)}
          >
            {t(tabDef.key)}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {tab === 'general' && (
          <div className="settings-panel">
            <h2>{t('settings.general')}</h2>
            <div className="settings-section">
              <h3>{t('settings.language')}</h3>
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                {t('settings.languageDesc')}
              </p>
              <div className="settings-row">
                <label>{t('settings.language')}</label>
                <select
                  className="settings-select"
                  value={i18n.language}
                  onChange={(e) => { void i18n.changeLanguage(e.target.value); }}
                >
                  <option value="en">{t('settings.languageOptions.en')}</option>
                  <option value="zh">{t('settings.languageOptions.zh')}</option>
                </select>
              </div>
            </div>
            <div className="settings-section">
              <h3>{t('settings.connection')}</h3>
              <div className="settings-row">
                <label>{t('settings.webSocketUrl')}</label>
                <input
                  className="settings-input"
                  value={url}
                  onChange={(e) => onUrlChange(e.target.value)}
                  disabled={connState === 'connected'}
                />
              </div>
              <div className="settings-row">
                <label>{t('settings.status')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontSize: 13,
                    color: connState === 'connected' ? 'var(--status-active)' : connState === 'connecting' ? 'var(--status-warning)' : 'var(--text-tertiary)',
                    textTransform: 'capitalize',
                  }}>
                    {connState}
                  </span>
                  {connState === 'connected' ? (
                    <button className="btn-small btn-danger" onClick={() => onDisconnect?.()}>{t('settings.disconnect')}</button>
                  ) : connState !== 'connecting' ? (
                    <button className="btn-small btn-primary" onClick={() => onConnect?.(url)}>{t('settings.connect')}</button>
                  ) : null}
                </div>
              </div>
            </div>
            {accountInfo && (
              <div className="settings-section">
                <h3>{t('settings.account')}</h3>
                <div className="settings-row">
                  <label>{t('settings.authType')}</label>
                  <span className="settings-value">{accountInfo.type}</span>
                </div>
                {accountInfo.email && (
                  <div className="settings-row">
                    <label>{t('settings.email')}</label>
                    <span className="settings-value">{accountInfo.email}</span>
                  </div>
                )}
                {accountInfo.planType && (
                  <div className="settings-row">
                    <label>{t('settings.plan')}</label>
                    <span className="settings-value" style={{ textTransform: 'capitalize' }}>
                      {accountInfo.planType}
                    </span>
                  </div>
                )}
              </div>
            )}
            {rateLimits && (
              <div className="settings-section">
                <h3>{t('settings.rateLimits')}</h3>
                {rateLimits.limitName && (
                  <div className="settings-row">
                    <label>{t('settings.limit')}</label>
                    <span className="settings-value">{rateLimits.limitName}</span>
                  </div>
                )}
                {rateLimits.planType && (
                  <div className="settings-row">
                    <label>{t('settings.planSnapshot')}</label>
                    <span className="settings-value" style={{ textTransform: 'capitalize' }}>
                      {rateLimits.planType}
                    </span>
                  </div>
                )}
                {rateLimits.primary && (
                  <>
                    <div className="settings-row">
                      <label>{t('settings.primaryWindow')}</label>
                      <span className="settings-value">
                        {Math.round(rateLimits.primary.usedPercent)}% used
                        {rateLimits.primary.windowDurationMins ? ` / ${rateLimits.primary.windowDurationMins} min` : ''}
                      </span>
                    </div>
                    <div className="settings-row">
                      <label>{t('settings.primaryReset')}</label>
                      <span className="settings-value">{formatRateLimitResetTime(rateLimits.primary.resetsAt)}</span>
                    </div>
                  </>
                )}
                {rateLimits.secondary && (
                  <>
                    <div className="settings-row">
                      <label>{t('settings.secondaryWindow')}</label>
                      <span className="settings-value">
                        {Math.round(rateLimits.secondary.usedPercent)}% used
                        {rateLimits.secondary.windowDurationMins ? ` / ${rateLimits.secondary.windowDurationMins} min` : ''}
                      </span>
                    </div>
                    <div className="settings-row">
                      <label>{t('settings.secondaryReset')}</label>
                      <span className="settings-value">{formatRateLimitResetTime(rateLimits.secondary.resetsAt)}</span>
                    </div>
                  </>
                )}
                {rateLimits.credits && (
                  <div className="settings-row">
                    <label>{t('settings.credits')}</label>
                    <span className="settings-value">
                      {rateLimits.credits.unlimited
                        ? t('settings.unlimited')
                        : rateLimits.credits.balance
                        ? rateLimits.credits.balance
                        : rateLimits.credits.hasCredits
                        ? t('settings.available')
                        : t('settings.unavailable')}
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="settings-section">
              <h3>{t('settings.notifications')}</h3>
              <div className="settings-row">
                <label>{t('settings.turnCompletion')}</label>
                <select
                  className="settings-select"
                  value={notificationPref}
                  onChange={(e) => onNotificationPrefChange(e.target.value as NotificationPref)}
                >
                  <option value="always">{t('settings.always')}</option>
                  <option value="unfocused">{t('settings.whenAppUnfocused')}</option>
                  <option value="never">{t('settings.never')}</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {tab === 'connections' && (
          <ConnectionsPanel
            currentUrl={url}
            connState={connState}
            onConnect={(wsUrl) => { onUrlChange(wsUrl); onConnect?.(wsUrl); }}
            onDisconnect={() => onDisconnect?.()}
            serverStarting={serverStarting}
            serverRunning={serverRunning}
            serverLog={serverLog}
            codexBinPath={codexBinPath}
            onCodexBinPathChange={onCodexBinPathChange}
            codexCandidates={codexCandidates}
            onStartServer={onStartServer}
            onStopServer={onStopServer}
            onBrowseCodexBinary={onBrowseCodexBinary}
          />
        )}

        {tab === 'appearance' && (
          <div className="settings-panel">
            <h2>{t('settings.appearance')}</h2>
            <div className="settings-section">
              <h3>{t('settings.theme')}</h3>
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                {t('settings.themeDesc')}
              </p>
              <div className="settings-theme-row">
                {(['dark', 'light', 'system'] as ThemeMode[]).map((mode) => (
                  <button
                    key={mode}
                    className={`settings-theme-option${theme === mode ? ' settings-theme-option--active' : ''}`}
                    onClick={() => handleThemeVariantChange(mode)}
                  >
                    <div className={`settings-theme-preview settings-theme-preview--${mode}`} />
                    <span>{t(`settings.${mode}`)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-variant-header">
                <h3>{activeVariant === 'dark' ? t('settings.darkTheme') : t('settings.lightTheme')}</h3>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-small" onClick={() => { setThemeImportOpen(true); setThemeImportValue(''); }}>{t('common.import')}</button>
                  <button className="btn-small" onClick={() => {
                    const str = exportThemeString(themeConfig, activeVariant);
                    navigator.clipboard.writeText(str).catch(() => {});
                  }}>{t('settings.copyTheme')}</button>
                  <div className="settings-preset-dropdown" ref={presetDropdownRef}>
                    <button
                      className="settings-preset-trigger"
                      onClick={() => setPresetDropdownOpen(!presetDropdownOpen)}
                    >
                      <span className="settings-preset-swatch" style={{ background: currentPreset.previewColor }} />
                      <span>{currentPreset.label}</span>
                      <span className="settings-preset-chevron">{presetDropdownOpen ? 'v' : '>'}</span>
                    </button>
                    {presetDropdownOpen && (
                      <div className="settings-preset-menu">
                        {THEME_PRESETS.map((p) => (
                          <button
                            key={p.id}
                            className={`settings-preset-item${themePreset === p.id ? ' settings-preset-item--active' : ''}`}
                            onClick={() => handlePresetSelect(p.id)}
                          >
                            <span className="settings-preset-swatch" style={{ background: p.previewColor }} />
                            <span>{p.label}</span>
                            {themePreset === p.id && <span style={{ marginLeft: 'auto' }} aria-hidden="true">&#10003;</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {themeImportOpen && (
                <div className="settings-import-row">
                  <input
                    className="settings-input"
                    placeholder={t('settings.pasteThemeString')}
                    value={themeImportValue}
                    onChange={e => setThemeImportValue(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="btn-small btn-primary" onClick={() => {
                    const result = importThemeString(themeImportValue);
                    if (result) {
                      onThemeConfigChange(result.theme);
                      setThemeImportOpen(false);
                      setThemeImportValue('');
                    }
                  }}>{t('common.apply')}</button>
                  <button className="btn-small" onClick={() => { setThemeImportOpen(false); setThemeImportValue(''); }}>{t('common.cancel')}</button>
                </div>
              )}
              {colorRow(t('settings.accent'), themeConfig.accent, v => patch({ accent: v }))}
              {colorRow(t('settings.background'), themeConfig.surface, v => patch({ surface: v }))}
              {colorRow(t('settings.foreground'), themeConfig.ink, v => patch({ ink: v }))}
              <div className="settings-row">
                <label>{t('settings.uiFont')}</label>
                <input
                  className="settings-input settings-font-input"
                  value={themeConfig.fonts.ui ?? ''}
                  onChange={e => patchFonts({ ui: e.target.value || null })}
                  placeholder='"DM Sans", system-ui, sans-serif'
                  spellCheck={false}
                />
              </div>
              <div className="settings-row">
                <label>{t('settings.codeFont')}</label>
                <input
                  className="settings-input settings-font-input"
                  value={themeConfig.fonts.code ?? ''}
                  onChange={e => patchFonts({ code: e.target.value || null })}
                  placeholder='ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
                  spellCheck={false}
                />
              </div>
              <div className="settings-row">
                <label>{t('settings.translucentSidebar')}</label>
                <button
                  className={`settings-toggle${!themeConfig.opaqueWindows ? ' settings-toggle--on' : ''}`}
                  onClick={() => patch({ opaqueWindows: !themeConfig.opaqueWindows })}
                />
              </div>
              <div className="settings-row">
                <label>{t('settings.contrast')}</label>
                <div className="settings-slider-row">
                  <input
                    type="range"
                    className="settings-slider"
                    min={0} max={100} step={1}
                    value={themeConfig.contrast}
                    onChange={e => patch({ contrast: Number(e.target.value) })}
                  />
                  <span className="settings-slider-value">{themeConfig.contrast}</span>
                </div>
              </div>
              <details style={{ marginTop: 4 }}>
                <summary style={{ fontSize: 11, color: 'var(--text-tertiary)', cursor: 'pointer', userSelect: 'none' }}>{t('settings.semanticColors')}</summary>
                <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {colorRow(t('settings.diffAdded'), themeConfig.semanticColors.diffAdded, v => patchSemantic({ diffAdded: v }))}
                  {colorRow(t('settings.diffRemoved'), themeConfig.semanticColors.diffRemoved, v => patchSemantic({ diffRemoved: v }))}
                  {colorRow('Skill', themeConfig.semanticColors.skill, v => patchSemantic({ skill: v }))}
                </div>
              </details>
            </div>
            <div className="settings-section">
              <h3>{t('settings.general')}</h3>
              <div className="settings-row">
                <div>
                  <label>{t('settings.pointerCursor')}</label>
                  <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {t('settings.pointerCursorDesc')}
                  </p>
                </div>
                <button
                  className={`settings-toggle${pointerCursor ? ' settings-toggle--on' : ''}`}
                  onClick={() => onPointerCursorChange(!pointerCursor)}
                />
              </div>
              <div className="settings-row">
                <div>
                  <label>{t('settings.uiFontSize')}</label>
                  <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {t('settings.uiFontSizeDesc')}
                  </p>
                </div>
                <div className="settings-stepper">
                  <button disabled={uiFontSize <= 10} onClick={() => { const v = Math.max(10, uiFontSize - 1); onUiFontSizeChange(v); applyFontSizes(v, codeFontSize); }}>-</button>
                  <span className="settings-stepper-value">{uiFontSize}px</span>
                  <button disabled={uiFontSize >= 22} onClick={() => { const v = Math.min(22, uiFontSize + 1); onUiFontSizeChange(v); applyFontSizes(v, codeFontSize); }}>+</button>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <label>{t('settings.codeFontSize')}</label>
                  <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {t('settings.codeFontSizeDesc')}
                  </p>
                </div>
                <div className="settings-stepper">
                  <button disabled={codeFontSize <= 10} onClick={() => { const v = Math.max(10, codeFontSize - 1); onCodeFontSizeChange(v); applyFontSizes(uiFontSize, v); }}>-</button>
                  <span className="settings-stepper-value">{codeFontSize}px</span>
                  <button disabled={codeFontSize >= 22} onClick={() => { const v = Math.min(22, codeFontSize + 1); onCodeFontSizeChange(v); applyFontSizes(uiFontSize, v); }}>+</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'config' && (
          <div className="settings-panel">
            <h2>{t('settings.configuration')}</h2>
            <p className="settings-desc">{t('settings.configureApproval')}</p>
            <div className="settings-section">
              <h3>{t('settings.autonomyPreset')}</h3>
              <div className="settings-row">
                <label>{t('settings.preset')}</label>
                {onAutonomyModeChange ? (
                  <select
                    className="settings-select"
                    value={externalAutonomyMode}
                    disabled={isUpdatingAutonomy}
                    onChange={(e) => onAutonomyModeChange(e.target.value)}
                  >
                    <option value="suggest">{t('settings.suggest')}</option>
                    <option value="auto-edit">{t('settings.autoEdit')}</option>
                    <option value="full-auto">{t('settings.fullAuto')}</option>
                    {externalAutonomyMode === 'custom' && <option value="custom">{t('settings.custom')}</option>}
                  </select>
                ) : (
                  <span className="settings-value">
                    {formatAutonomyModeLabel(deriveAutonomyModeFromConfig(codexConfig))}
                  </span>
                )}
              </div>
              {externalAutonomyMode !== 'custom' && (
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
                  Preset sets both approval policy and sandbox mode together.
                </p>
              )}
              {(() => {
                const detail = formatAutonomyModeDetail(codexConfig, externalAutonomyMode);
                return detail ? (
                  <p style={{ fontSize: 11, color: 'var(--status-warning)', marginTop: 4 }}>
                    Custom: {detail}
                  </p>
                ) : null;
              })()}
            </div>
            <div className="settings-section">
              <h3>{t('settings.approvalPolicy')}</h3>
              <div className="settings-row">
                <label>{t('settings.policy')}</label>
                {onWriteConfig ? (
                  <select
                    className="settings-select"
                    value={getEffectiveApprovalPolicyValue(codexConfig)}
                    onChange={async (e) => {
                      try {
                        await onWriteConfig('approval_policy', e.target.value);
                      } catch { /* ignore */ }
                    }}
                  >
                    <option value="untrusted">{t('settings.untrusted')}</option>
                    <option value="on-failure">{t('settings.onFailure')}</option>
                    <option value="on-request">{t('settings.onRequest')}</option>
                    <option value="never">{t('settings.never')}</option>
                  </select>
                ) : (
                  <span className="settings-value">
                    {getAutonomyModeSummary(codexConfig).split(' / ')[0]}
                  </span>
                )}
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                Controls when Codex asks for user approval before executing commands.
              </p>
            </div>
            <div className="settings-section">
              <h3>{t('settings.sandbox')}</h3>
              <div className="settings-row">
                <label>{t('settings.sandboxMode')}</label>
                {onWriteConfig ? (
                  <select
                    className="settings-select"
                    value={getEffectiveSandboxModeValue(codexConfig)}
                    onChange={async (e) => {
                      try {
                        await onWriteConfig('sandbox_mode', e.target.value);
                      } catch { /* ignore */ }
                    }}
                  >
                    <option value="read-only">{t('settings.readOnly')}</option>
                    <option value="workspace-write">{t('settings.workspaceWrite')}</option>
                    <option value="danger-full-access">{t('settings.fullAccess')}</option>
                  </select>
                ) : (
                  <span className="settings-value settings-value--accent">
                    {getAutonomyModeSummary(codexConfig).split(' / ')[1]}
                  </span>
                )}
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                Controls what level of filesystem access Codex has.
              </p>
            </div>
            {codexConfig && Array.isArray((codexConfig as Record<string, unknown>).layers) && (
              <div className="settings-section">
                <h3>Config Layers</h3>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 8px' }}>
                  Configuration is merged from these sources (highest priority first):
                </p>
                {((codexConfig as Record<string, unknown>).layers as Array<Record<string, unknown>>).map((layer, i) => {
                  const name = (layer.name as Record<string, unknown> | undefined);
                  const layerType = typeof name?.type === 'string' ? name.type : 'unknown';
                  const file = typeof name?.file === 'string' ? name.file : null;
                  const dotCodexFolder = typeof name?.dotCodexFolder === 'string' ? name.dotCodexFolder : null;
                  const filePath = file ?? (dotCodexFolder ? `${dotCodexFolder}/config.toml` : null);
                  return (
                    <div key={i} className="settings-row" style={{ alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <label style={{ textTransform: 'capitalize', fontWeight: 500 }}>{layerType}</label>
                        {filePath && (
                          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{filePath}</span>
                        )}
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                        {layer.version != null ? `v${layer.version}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {codexConfig && typeof (codexConfig as Record<string, unknown>).origins === 'object' && (codexConfig as Record<string, unknown>).origins != null && (
              <div className="settings-section">
                <h3>Config Origins</h3>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '0 0 8px' }}>
                  Shows which layer each config key originates from.
                </p>
                {Object.entries((codexConfig as Record<string, unknown>).origins as Record<string, unknown>)
                  .filter(([, v]) => v != null)
                  .slice(0, 30)
                  .map(([key, origin]) => {
                    const o = origin as Record<string, unknown> | null;
                    const originName = o?.name as Record<string, unknown> | undefined;
                    const originType = typeof originName?.type === 'string' ? originName.type : '?';
                    return (
                      <div key={key} className="settings-row">
                        <label style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{key}</label>
                        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'capitalize' }}>{originType}</span>
                      </div>
                    );
                  })}
              </div>
            )}
            {codexConfig && (
              <div className="settings-section">
                <h3>Effective Config</h3>
                <pre className="settings-text-block" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {JSON.stringify(getConfigRoot(codexConfig) ?? codexConfig, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {tab === 'personalization' && (
          <div className="settings-panel">
            <h2>{t('settings.personalization')}</h2>
            <p className="settings-desc">{t('settings.personalizeDesc')}</p>
            <div className="settings-section">
              <h3>{t('settings.profileName')}</h3>
              {editingProfileName ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    value={profileNameValue}
                    onChange={e => setProfileNameValue(e.target.value)}
                    placeholder={t('settings.profileNamePlaceholder')}
                    style={{ fontFamily: 'var(--font-sans)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '5px 10px', width: 200 }}
                  />
                  <button className="btn-small btn-primary" disabled={savingProfileName} onClick={async () => {
                    if (!onWriteConfig) return;
                    setSavingProfileName(true);
                    try { await onWriteConfig('profileName', profileNameValue); setEditingProfileName(false); } catch {}
                    setSavingProfileName(false);
                  }}>{savingProfileName ? '...' : t('common.save')}</button>
                  <button className="btn-small" onClick={() => setEditingProfileName(false)}>{t('common.cancel')}</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="settings-value">
                    {String(getConfigValue(codexConfig, 'profileName') ?? t('settings.notSet'))}
                  </span>
                  {onWriteConfig && (
                    <button className="btn-small" onClick={() => {
                      const current = getConfigValue(codexConfig, 'profileName');
                      setProfileNameValue(typeof current === 'string' ? current : '');
                      setEditingProfileName(true);
                    }}>{t('common.edit')}</button>
                  )}
                </div>
              )}
            </div>
            <div className="settings-section">
              <h3>{t('settings.responseLang')}</h3>
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>
                {t('settings.responseLangDesc')}
              </p>
              {editingResponseLang ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    value={responseLangValue}
                    onChange={e => setResponseLangValue(e.target.value)}
                    placeholder={t('settings.responseLangPlaceholder')}
                    style={{ fontFamily: 'var(--font-sans)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '5px 10px', width: 200 }}
                  />
                  <button className="btn-small btn-primary" disabled={savingResponseLang} onClick={async () => {
                    if (!onWriteConfig) return;
                    setSavingResponseLang(true);
                    try { await onWriteConfig('responseLanguage', responseLangValue); setEditingResponseLang(false); } catch {}
                    setSavingResponseLang(false);
                  }}>{savingResponseLang ? '...' : t('common.save')}</button>
                  <button className="btn-small" onClick={() => setEditingResponseLang(false)}>{t('common.cancel')}</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="settings-value">
                    {String(getConfigValue(codexConfig, 'responseLanguage') ?? t('settings.notSet'))}
                  </span>
                  {onWriteConfig && (
                    <button className="btn-small" onClick={() => {
                      const current = getConfigValue(codexConfig, 'responseLanguage');
                      setResponseLangValue(typeof current === 'string' ? current : '');
                      setEditingResponseLang(true);
                    }}>{t('common.edit')}</button>
                  )}
                </div>
              )}
            </div>
            <div className="settings-section">
              <h3>{t('settings.customInstructions')}</h3>
              {editingInstructions ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <textarea
                    value={instructionsValue}
                    onChange={e => setInstructionsValue(e.target.value)}
                    rows={10}
                    style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 6, padding: '8px 10px', resize: 'vertical', boxSizing: 'border-box' }}
                    placeholder={t('settings.customInstructionsPlaceholder')}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-small btn-primary" disabled={savingInstructions} onClick={async () => {
                      if (!onWriteConfig) return;
                      setSavingInstructions(true);
                      try { await onWriteConfig('instructions', instructionsValue); setEditingInstructions(false); } catch {}
                      setSavingInstructions(false);
                    }}>{savingInstructions ? t('settings.saving') : t('common.save')}</button>
                    <button className="btn-small" onClick={() => setEditingInstructions(false)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : (() => {
                const instructions = getConfigValue(codexConfig, 'instructions') ?? getConfigValue(codexConfig, 'customInstructions');
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {instructions ? (
                      <pre className="settings-text-block" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {typeof instructions === 'string' ? instructions : JSON.stringify(instructions, null, 2)}
                      </pre>
                    ) : (
                      <div className="settings-text-block">{t('settings.noCustomInstructions')}</div>
                    )}
                    {onWriteConfig && (
                      <button className="btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => {
                        const current = getConfigValue(codexConfig, 'instructions') ?? getConfigValue(codexConfig, 'customInstructions');
                        setInstructionsValue(typeof current === 'string' ? current : '');
                        setEditingInstructions(true);
                      }}>{t('common.edit')}</button>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {tab === 'mcp' && (
          <McpSettingsPanel mcpServers={mcpServers} client={client} onRefresh={async () => {
            if (onRefreshMcp) await onRefreshMcp();
          }} />
        )}

        {tab === 'git' && (
          <div className="settings-panel">
            <h2>{t('settings.git')}</h2>
            <div className="settings-section">
              <h3>{t('settings.branchPrefix')}</h3>
              <div className="settings-row">
                <label>{t('settings.branchPrefixLabel')}</label>
                {editingBranchPrefix ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      value={branchPrefixValue}
                      onChange={e => setBranchPrefixValue(e.target.value)}
                      style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '3px 8px', width: 140 }}
                    />
                    <button className="btn-small btn-primary" disabled={savingBranchPrefix} onClick={async () => {
                      if (!onWriteConfig) return;
                      setSavingBranchPrefix(true);
                      try { await onWriteConfig('git.branchPrefix', branchPrefixValue); setEditingBranchPrefix(false); } catch {}
                      setSavingBranchPrefix(false);
                    }}>{savingBranchPrefix ? '...' : t('common.save')}</button>
                    <button className="btn-small" onClick={() => setEditingBranchPrefix(false)}>{t('common.cancel')}</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="settings-value" style={{ fontFamily: 'var(--font-mono)' }}>
                      {String(getConfigValue(codexConfig, 'git.branchPrefix') ?? getConfigValue(codexConfig, 'branchPrefix') ?? 'codex/')}
                    </span>
                    {onWriteConfig && (
                      <button className="btn-small" onClick={() => {
                        const current = getConfigValue(codexConfig, 'git.branchPrefix') ?? getConfigValue(codexConfig, 'branchPrefix') ?? 'codex/';
                        setBranchPrefixValue(String(current));
                        setEditingBranchPrefix(true);
                      }}>{t('common.edit')}</button>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="settings-section">
              <h3>{t('settings.pushSettings')}</h3>
              <div className="settings-row">
                <label>{t('settings.forcePushLease')}</label>
                {onWriteConfig ? (
                  <button className="btn-small" onClick={() => onWriteConfig('git.forcePush', !(getConfigValue(codexConfig, 'git.forcePush') === true))}>
                    {getConfigValue(codexConfig, 'git.forcePush') === true ? t('settings.on') : t('settings.off')}
                  </button>
                ) : (
                  <span className="settings-value">{getConfigValue(codexConfig, 'git.forcePush') === true ? t('settings.on') : t('settings.off')}</span>
                )}
              </div>
              <div className="settings-row">
                <label>{t('settings.draftPullRequests')}</label>
                {onWriteConfig ? (
                  <button className="btn-small" onClick={() => onWriteConfig('git.draftPullRequests', !(getConfigValue(codexConfig, 'git.draftPullRequests') === true))}>
                    {getConfigValue(codexConfig, 'git.draftPullRequests') === true ? t('settings.on') : t('settings.off')}
                  </button>
                ) : (
                  <span className="settings-value">{getConfigValue(codexConfig, 'git.draftPullRequests') === true ? t('settings.on') : t('settings.off')}</span>
                )}
              </div>
            </div>
            <div className="settings-section">
              <h3>{t('settings.commitInstructions')}</h3>
              {editingCommitInstructions ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <textarea
                    value={commitInstructionsValue}
                    onChange={e => setCommitInstructionsValue(e.target.value)}
                    rows={6}
                    style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 6, padding: '8px 10px', resize: 'vertical', boxSizing: 'border-box' }}
                    placeholder={t('settings.commitInstructionsPlaceholder')}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-small btn-primary" disabled={savingCommitInstructions} onClick={async () => {
                      if (!onWriteConfig) return;
                      setSavingCommitInstructions(true);
                      try { await onWriteConfig('git.commitInstructions', commitInstructionsValue); setEditingCommitInstructions(false); } catch {}
                      setSavingCommitInstructions(false);
                    }}>{savingCommitInstructions ? t('settings.saving') : t('common.save')}</button>
                    <button className="btn-small" onClick={() => setEditingCommitInstructions(false)}>{t('common.cancel')}</button>
                  </div>
                </div>
              ) : (() => {
                const commitInstructions = getConfigValue(codexConfig, 'git.commitInstructions') ?? getConfigValue(codexConfig, 'commitInstructions');
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {commitInstructions ? (
                      <pre className="settings-text-block" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {String(commitInstructions)}
                      </pre>
                    ) : (
                      <div className="settings-text-block">
                        {t('settings.commitInstructionsHint')}
                      </div>
                    )}
                    {onWriteConfig && (
                      <button className="btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => {
                        const current = getConfigValue(codexConfig, 'git.commitInstructions') ?? getConfigValue(codexConfig, 'commitInstructions');
                        setCommitInstructionsValue(typeof current === 'string' ? current : '');
                        setEditingCommitInstructions(true);
                      }}>{t('common.edit')}</button>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {tab === 'archived' && (
          <div className="settings-panel">
            <h2>{t('settings.archivedThreads')}</h2>
            {loadingArchived ? (
              <div className="settings-text-block">{t('settings.loadingArchived')}</div>
            ) : archivedThreads.length === 0 ? (
              <div className="empty-section-card">
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                  {t('settings.noArchivedThreads')}
                </span>
              </div>
            ) : (
              <div className="archived-list">
                {archivedThreads.map((th) => (
                  <div key={th.id} className="archived-item">
                    <div className="archived-info">
                      <span className="archived-name">{th.name || th.preview || t('sidebar.untitled')}</span>
                      <span className="archived-meta">
                        {new Date((th.updatedAt ?? th.createdAt) * 1000).toLocaleDateString()}
                        {th.cwd && ` · ${folderName(th.cwd)}`}
                      </span>
                    </div>
                    <button className="btn-small" onClick={async () => {
                      try {
                        await client.unarchiveThread(th.id);
                        setArchivedThreads((prev) => prev.filter((x) => x.id !== th.id));
                      } catch { /* ignore */ }
                    }}>
                      {t('settings.unarchive')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
