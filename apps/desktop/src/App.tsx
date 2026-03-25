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
} from '@whats-coder/shared';
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
import { KanbanPanel, type KanbanProject } from './components/kanban';
import { WorkspacePanel, type WorkspaceDraftPrefill, type WorkspaceSectionId } from './components/WorkspacePanel';
import {
  getKanbanLinkedThreadIds,
  listRunningKanbanIssueRuns,
  updateKanbanIssueExecution,
  updateKanbanIssueRun,
  type KanbanExecutionState,
} from './lib/kanbanDb';
import { WindowControls } from './components/WindowControls';
import { HistoryPanel } from './components/HistoryPanel';
import { SkillsView } from './components/SkillsView';
import { SettingsView } from './components/SettingsView';
import {
  type ThemeMode, type ApprovalPolicyValue, type SandboxModeValue, type AutonomyModeValue,
  type RateLimitSnapshotState, type RateLimitWindowState, type CreditsSnapshotState,
  type NotificationPref, type ChromeThemeConfig, type SkillDetail,
  AUTONOMY_PRESETS, THEME_PRESETS, DEFAULT_THEME_PRESET,
  folderName, isObject, getConfigRoot, getConfigValue,
  getEffectiveApprovalPolicyValue, getEffectiveSandboxModeValue,
  deriveAutonomyModeFromConfig, formatAutonomyModeLabel, getAutonomyModeSummary,
  applyThemeConfig, applyFontSizes,
  resolveThemeVariant, getDefaultThemeConfig, hexAlpha, mixHex,
} from './lib/settingsHelpers';

type ReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh';
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

function useStableCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
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



function normalizeCwd(cwd?: string | null): string {
  return cwd ? cwd.replace(/\\/g, '/').replace(/\/$/, '') : '';
}

function mergeUniqueCwds(cwds: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const cwd of cwds) {
    if (typeof cwd !== 'string') {
      continue;
    }

    const trimmed = cwd.trim();
    const normalized = normalizeCwd(trimmed);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    merged.push(trimmed);
  }

  return merged;
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
  const [url, setUrl] = usePersistedState('codex-ws-url', 'ws://localhost:6188/ws');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isAgentActive, setIsAgentActive] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'error' | 'info'; exiting?: boolean } | null>(null);
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
  const [sidebarView, setSidebarView] = useState<'threads' | 'settings' | 'automations' | 'skills' | 'usage' | 'providers' | 'history' | 'workspace'>('threads');
  const [workspaceSection, setWorkspaceSection] = usePersistedState<WorkspaceSectionId>('codex-workspace-panel-section-v1', 'overview');
  const [workspacePrefill, setWorkspacePrefill] = useState<WorkspaceDraftPrefill | null>(null);
  const [workspaceIssueContext, setWorkspaceIssueContext] = useState<{
    projectId: string | null;
    issueId: string | null;
    issueLabel: string | null;
  }>({
    projectId: null,
    issueId: null,
    issueLabel: null,
  });
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const sidebarResizing = useRef(false);
  const sidebarResizeStartX = useRef(0);
  const sidebarResizeStartWidth = useRef(0);
  const observedKanbanThreadIdRef = useRef<string | null>(null);
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
  const [observedKanbanThreadId, setObservedKanbanThreadId] = useState<string | null>(null);
  const [observedKanbanThreadDetail, setObservedKanbanThreadDetail] = useState<ThreadDetail | null>(null);
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
  const [workspaceRootsHydrated, setWorkspaceRootsHydrated] = usePersistedState<boolean>('codex-active-workspace-roots-hydrated-v2', false);
  const [activeWorkspaceRoots, setActiveWorkspaceRoots] = useState<string[]>([]);
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
  const requestDismissToast = useCallback(() => {
    setToast(prev => {
      if (!prev || prev.exiting) return prev;
      return { ...prev, exiting: true };
    });
  }, []);

  useEffect(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    if (!toast || toast.exiting) return;
    const ms = toast.type === 'error' ? 6000 : 3000;
    toastTimerRef.current = setTimeout(() => requestDismissToast(), ms);
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); };
  }, [toast, requestDismissToast]);

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
    let cancelled = false;

    invoke<string[]>('read_active_workspace_roots')
      .then((roots) => {
        if (!cancelled) {
          setActiveWorkspaceRoots(mergeUniqueCwds(roots));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActiveWorkspaceRoots([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (workspaceRootsHydrated) {
      return;
    }

    const visibleRoots = mergeUniqueCwds(activeWorkspaceRoots).filter((cwd) => {
      const normalized = normalizeCwd(cwd);
      return normalized && !hiddenProjects.some((project) => normalizeCwd(project) === normalized);
    });
    if (visibleRoots.length === 0) {
      if (addedProjects.length > 0) {
        setWorkspaceRootsHydrated(true);
      }
      return;
    }

    setAddedProjects(visibleRoots);

    if (visibleRoots.length > 0) {
      const normalizedActive = normalizeCwd(activeProjectCwd);
      if (!normalizedActive || !visibleRoots.some((cwd) => normalizeCwd(cwd) === normalizedActive)) {
        setActiveProjectCwd(visibleRoots[0]);
      }
    }

    setWorkspaceRootsHydrated(true);
  }, [
    activeProjectCwd,
    addedProjects,
    activeWorkspaceRoots,
    hiddenProjects,
    setAddedProjects,
    setWorkspaceRootsHydrated,
    workspaceRootsHydrated,
  ]);

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
      if (!normalizedCwd) return addedProjectSet.size === 0;
      if (hiddenProjectSet.has(normalizedCwd)) return false;
      return addedProjectSet.has(normalizedCwd);
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
    const groupedProjectSet = new Set<string>();
    for (const [cwd, items] of grouped) {
      groupedProjectSet.add(normalizeCwd(cwd));
      groups.push({ folder: folderName(cwd), cwd, threads: items });
    }
    if (!searchLower) {
      for (const project of addedProjects) {
        const normalized = normalizeCwd(project);
        if (!normalized || hiddenProjectSet.has(normalized) || groupedProjectSet.has(normalized)) {
          continue;
        }
        groups.push({ folder: folderName(project), cwd: project, threads: [] });
      }
    }
    groups.sort((a, b) => {
      const aTime = a.threads.length > 0 ? Math.max(...a.threads.map(t => t.updatedAt ?? t.createdAt)) : -1;
      const bTime = b.threads.length > 0 ? Math.max(...b.threads.map(t => t.updatedAt ?? t.createdAt)) : -1;
      if (aTime !== bTime) {
        return bTime - aTime;
      }
      return a.folder.localeCompare(b.folder);
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

  const workspaceProjects = useMemo(
    () => automationProjects.map((project) => ({ id: project.cwd, name: project.label })),
    [automationProjects],
  );

  const kanbanProjects = useMemo<KanbanProject[]>(() => {
    const cwdMap = new Map<string, string>();
    for (const t of threads) {
      if (t.cwd) cwdMap.set(t.cwd, folderAlias[t.cwd] || folderName(t.cwd));
    }
    return Array.from(cwdMap.entries()).map(([id, name]) => ({ id, name }));
  }, [threads, folderAlias]);

  const kanbanExecutionModelLabel = useMemo(() => {
    if (!selectedModel) return null;
    const info = models.find((m) => m.id === selectedModel);
    return info?.displayName ?? selectedModel;
  }, [models, selectedModel]);

  const refreshKanbanThreadIds = useCallback(async () => {
    try {
      const ids = await getKanbanLinkedThreadIds();
      setKanbanThreadIds(ids);
    } catch { /* ignore */ }
  }, []);

  const setObservedKanbanThread = useCallback((params: {
    threadId: string | null;
    detail?: ThreadDetail | null;
  }) => {
    observedKanbanThreadIdRef.current = params.threadId;
    setObservedKanbanThreadId(params.threadId);
    setObservedKanbanThreadDetail(params.detail ?? null);
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

  const handleKanbanThreadObserved = useCallback(async (params: {
    threadId: string;
    detail: ThreadDetail;
    runId?: string;
    issueId?: string;
  }) => {
    if (observedKanbanThreadIdRef.current === params.threadId) {
      setObservedKanbanThreadDetail(params.detail);
    }
    if (params.runId && params.issueId) {
      await syncKanbanRunFromThread({
        runId: params.runId,
        issueId: params.issueId,
        detail: params.detail,
      });
    }
  }, [syncKanbanRunFromThread]);

  const readKanbanThreadDetail = useCallback(async (threadId: string) => {
    try {
      await clientRef.current.resumeThread(threadId);
    } catch {
      /* thread may already be loaded */
    }
    return clientRef.current.readThread(threadId, true);
  }, []);

  const startKanbanRunPolling = useCallback((params: {
    runId: string;
    issueId: string;
    threadId: string;
  }) => {
    if (kanbanRunPollsRef.current.has(params.runId)) return;
    const interval = setInterval(async () => {
      try {
        const detail = await readKanbanThreadDetail(params.threadId);
        if (observedKanbanThreadIdRef.current === params.threadId) {
          setObservedKanbanThreadDetail(detail);
        }
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
  }, [clearKanbanRunPoll, readKanbanThreadDetail, syncKanbanRunFromThread]);

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
      if (u.pathname === '/ws' || u.pathname === '/ws/') return 4500;
      return parseInt(u.port, 10) || 4500;
    } catch {
      return 4500;
    }
  }, []);

  const waitForServerReady = useCallback(async (_wsUrl: string, maxAttempts = 20, delayMs = 500): Promise<boolean> => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch('/readyz', { method: 'GET', signal: AbortSignal.timeout(2000) });
        if (res.ok) return true;
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, delayMs));
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
      console.log('[auto-start] Starting auto-start flow, retries:', retries);
      setServerStarting(true);
      for (let attempt = 0; attempt <= retries && !cancelled; attempt++) {
        try {
          const port = extractPort(url);
          const codexPath = codexBinPathRef.current || undefined;
          console.log(`[auto-start] Attempt ${attempt + 1}/${retries + 1}: port=${port}, codexPath=${codexPath ?? 'default'}`);
          const result = await invoke<{ running: boolean; pid: number | null }>('start_codex_server', { port, codexPath });
          console.log('[auto-start] start_codex_server result:', result);
          if (cancelled) return;
          if (result.running) {
            serverManagedRef.current = true;
            setServerRunning(true);
            console.log('[auto-start] Server spawned, waiting for ready...');
            const ready = await waitForServerReady(url, 20, 500);
            console.log('[auto-start] Server ready:', ready);
            if (cancelled) return;
            if (ready) {
              try {
                console.log('[auto-start] Connecting to', url);
                await handleConnect(url);
                if (!cancelled) {
                  console.log('[auto-start] Connected successfully!');
                  setServerLog('');
                  startHeartbeat();
                  return;
                }
              } catch (connectErr) {
                console.error('[auto-start] Connect failed:', connectErr);
                if (!cancelled && attempt < retries) {
                  await new Promise(r => setTimeout(r, 1500));
                  continue;
                }
              }
            } else if (attempt < retries) {
              console.log('[auto-start] Server not ready, retrying in 2s...');
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
          } else if (attempt < retries) {
            console.log('[auto-start] Server not running, retrying in 2s...');
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
        } catch (err) {
          console.error(`[auto-start] Attempt ${attempt + 1} failed:`, err);
          if (!cancelled) fetchCodexCandidates();
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
        }
      }
      console.log('[auto-start] All attempts exhausted');
      if (!cancelled) setServerStarting(false);
    };

    (async () => {
      console.log('[startup] Probing server at', url);
      try {
        await clientRef.current.connect(url, { autoReconnect: false });
        console.log('[startup] Connection probe succeeded - server already running');
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
      } catch (probeErr) {
        console.log('[startup] Probe failed, server not running:', probeErr);
        clientRef.current.disconnect();
        if (cancelled) return;
        console.log('[startup] Checking if server process exists...');
        try {
          const status = await invoke<{ running: boolean; pid: number | null }>('get_codex_server_status');
          console.log('[startup] Server process status:', status);
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
            console.log('[startup] Server process not found, auto-starting...');
            await autoStartServer();
          }
        } catch (statusErr) {
          console.error('[startup] get_codex_server_status failed:', statusErr);
          if (!cancelled) {
            console.log('[startup] Falling back to auto-start...');
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

  const handleSelectModelStable = useStableCallback(handleSelectModel);
  const handleSelectReasoningStable = useStableCallback((value: string) => {
    setReasoning(value as ReasoningLevel);
  });
  const handleAutonomyModeChangeStable = useStableCallback(handleAutonomyModeChange);
  const handleComposerSubmitStable = useStableCallback(handleComposerSubmit);
  const handleComposerCommandStable = useStableCallback(handleComposerCommand);
  const handleInterruptStable = useStableCallback(handleInterrupt);

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
  const handleOpenWorkspaceView = useCallback(() => {
    setSidebarView('workspace');
  }, []);
  const handleOpenWorkspaceSection = useCallback((section: WorkspaceSectionId) => {
    setWorkspaceSection(section);
    setSidebarView('workspace');
  }, [setWorkspaceSection]);
  const handleSelectWorkspaceProject = useCallback((projectId: string) => {
    setActiveProjectCwd(projectId);
    setWorkspaceIssueContext({
      projectId: null,
      issueId: null,
      issueLabel: null,
    });
    setWorkspacePrefill(null);
  }, []);
  const handleOpenWorkspaceFromKanban = useCallback((params: {
    projectId: string;
    section: WorkspaceSectionId;
    prefill?: WorkspaceDraftPrefill;
  }) => {
    setActiveProjectCwd(params.projectId);
    setWorkspaceIssueContext({
      projectId: params.prefill?.issueId ? params.projectId : null,
      issueId: params.prefill?.issueId ?? null,
      issueLabel: params.prefill?.issueLabel ?? params.prefill?.linkedIssue ?? null,
    });
    setWorkspaceSection(params.section);
    setWorkspacePrefill(params.prefill ?? null);
    setSidebarView('workspace');
  }, [setWorkspaceSection]);
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
            onSelectModel={handleSelectModelStable}
            modelSwitchPreview={modelSwitchPreview}
            reasoning={reasoning}
            reasoningOptions={REASONING_OPTIONS}
            onSelectReasoning={handleSelectReasoningStable}
            autonomyMode={autonomyMode}
            autonomyOptions={autonomyOptions}
            onSelectAutonomyMode={handleAutonomyModeChangeStable}
            isUpdatingAutonomy={isUpdatingAutonomy}
            autonomyDetail={autonomyDetail}
            branchLabel={activeBranchLabel}
            contextUsage={contextUsage}
            onSubmit={handleComposerSubmitStable}
            onExecuteCommand={handleComposerCommandStable}
            onInterrupt={isProcessing ? handleInterruptStable : undefined}
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
      handleAutonomyModeChangeStable,
      handleComposerCommandStable,
      handleComposerSubmitStable,
      handleDynamicToolCallReject,
      handleDynamicToolCallResponse,
      handleInterruptStable,
      handleMcpElicitationResponse,
      handleResendToComposer,
      handleSelectModelStable,
      handleSelectReasoningStable,
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
          onOpenWorkspace={handleOpenWorkspaceView}
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
          {sidebarView === 'settings' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <SettingsView url={url} onUrlChange={setUrl} connState={connState} accountInfo={accountInfo} rateLimits={rateLimits} mcpServers={mcpServers} client={clientRef.current} theme={theme} onThemeChange={setTheme} codexConfig={codexConfig} onWriteConfig={async (key, value) => { await writeConfigValueWithFallback(key, null, value); await refreshCodexConfig(); }} onRefreshMcp={refreshMcpServers} onConnect={(wsUrl) => void handleConnect(wsUrl)} onDisconnect={handleDisconnect} uiFontSize={uiFontSize} onUiFontSizeChange={setUiFontSize} codeFontSize={codeFontSize} onCodeFontSizeChange={setCodeFontSize} notificationPref={notificationPref} onNotificationPrefChange={setNotificationPref} themePreset={themePreset} onThemePresetChange={setThemePreset} themeConfig={themeConfig} onThemeConfigChange={setThemeConfig} pointerCursor={pointerCursor} onPointerCursorChange={setPointerCursor} onAutonomyModeChange={handleAutonomyModeChange} autonomyMode={autonomyMode} isUpdatingAutonomy={isUpdatingAutonomy} serverStarting={serverStarting} serverRunning={serverRunning} serverLog={serverLog} codexBinPath={codexBinPath} onCodexBinPathChange={setCodexBinPath} codexCandidates={codexCandidates} onStartServer={handleStartServer} onStopServer={handleStopServer} onBrowseCodexBinary={handleBrowseCodexBinary} windowControls={<WindowControls />} />
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
                  windowControls={<WindowControls />}
                />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'skills' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <SkillsView skills={skills} onRefresh={async () => { await refreshSkills(); }} windowControls={<WindowControls />} />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'usage' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <UsagePanel windowControls={<WindowControls />} />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'providers' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <ProvidersPanel onToast={(msg, type) => setToast({ msg, type: type === 'error' ? 'error' : 'info' })} windowControls={<WindowControls />} />
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
                  windowControls={<WindowControls />}
                />
              </div>
              {rightSidebarEl}
            </div>
          ) : sidebarView === 'workspace' ? (
            <div className="main-content-body">
              <div className="main-content-primary">
                <WorkspacePanel
                  projects={workspaceProjects}
                  activeProjectId={activeProjectCwd}
                  activeIssueId={workspaceIssueContext.projectId === activeProjectCwd ? workspaceIssueContext.issueId : null}
                  activeIssueLabel={workspaceIssueContext.projectId === activeProjectCwd ? workspaceIssueContext.issueLabel : null}
                  section={workspaceSection}
                  prefill={workspacePrefill}
                  kanbanContent={(
                    <KanbanPanel
                      embedded
                      projects={kanbanProjects}
                      activeProjectId={activeProjectCwd}
                      onProjectSelect={handleSelectWorkspaceProject}
                      executionSyncVersion={kanbanExecutionRevision}
                      executionModelLabel={kanbanExecutionModelLabel}
                      observedThreadId={observedKanbanThreadId}
                      observedThreadDetail={observedKanbanThreadDetail}
                      onOpenWorkspace={handleOpenWorkspaceFromKanban}
                      execCallbacks={{
                        startThread: startThreadWithConfigRecovery,
                        startTurn: (threadId, text) => {
                          const opts: { model?: string; reasoningEffort?: string } = {};
                          if (selectedModel) opts.model = selectedModel;
                          if (reasoning) opts.reasoningEffort = reasoning;
                          return clientRef.current.startTurn(threadId, text, opts);
                        },
                        readThread: readKanbanThreadDetail,
                        onRunStarted: ({ runId, issueId, threadId }) => {
                          startKanbanRunPolling({ runId, issueId, threadId });
                        },
                        onThreadObserved: handleKanbanThreadObserved,
                        setObservedThread: setObservedKanbanThread,
                        onThreadCreated: () => { void refreshKanbanThreadIds(); void handleListThreads(); },
                      }}
                    />
                  )}
                  onPrefillConsumed={(seedId) => {
                    setWorkspacePrefill((current) => (current?.seedId === seedId ? null : current));
                  }}
                  onSectionChange={setWorkspaceSection}
                  onProjectSelect={handleSelectWorkspaceProject}
                  windowControls={<WindowControls />}
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
                    onSelectModel={handleSelectModelStable}
                    modelSwitchPreview={modelSwitchPreview}
                    reasoning={reasoning}
                    reasoningOptions={REASONING_OPTIONS}
                    onSelectReasoning={handleSelectReasoningStable}
                    autonomyMode={autonomyMode}
                    autonomyOptions={autonomyOptions}
                    onSelectAutonomyMode={handleAutonomyModeChangeStable}
                    isUpdatingAutonomy={isUpdatingAutonomy}
                    autonomyDetail={autonomyDetail}
                    branchLabel={emptyBranchLabel}
                    contextUsage={null}
                    onSubmit={handleComposerSubmitStable}
                    onExecuteCommand={handleComposerCommandStable}
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
        <div
          className={`toast toast--${toast.type}${toast.exiting ? ' toast--exiting' : ''}`}
          onClick={requestDismissToast}
          onAnimationEnd={(e) => {
            if (e.animationName === 'toastOut') setToast(null);
          }}
        >
          <span>{toast.msg}</span>
          <button
            type="button"
            className="toast-close"
            onClick={(ev) => {
              ev.stopPropagation();
              requestDismissToast();
            }}
          >
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
