/**
 * Thin facade over Rust-backed database commands.
 * Delegates to `./rustBridge` invoke wrappers — no direct SQL or
 * `@tauri-apps/plugin-sql` usage.  All interfaces and function signatures
 * are preserved so consuming components need zero changes.
 */
import {
  dbGetSetting,
  dbSetSetting,
  dbGetAllSettings,
  dbGetChatConfig,
  dbSaveChatConfig,
  dbDeleteChatConfig,
  dbAddChatMessage,
  dbGetChatMessages,
  dbGetAllChatHistory,
  dbSearchChatHistory,
  dbListConnections,
  dbSaveConnection,
  dbDeleteConnection,
  dbSetDefaultConnection,
  dbListProviders,
  dbGetCurrentProviderId,
  dbAddProvider,
  dbUpdateProvider,
  dbDeleteProvider,
  dbSwitchProvider,
  dbListAutomations,
  dbGetAutomation,
  dbCreateAutomation,
  dbUpdateAutomation,
  dbDeleteAutomation,
  dbListAutomationRuns,
  dbListRunningAutomationRuns,
  dbCreateAutomationRun,
  dbUpdateAutomationRun,
  dbCreateClaudeSession,
  dbListClaudeSessions,
  dbGetClaudeSession,
  dbUpdateClaudeSession,
  dbDeleteClaudeSession,
  dbAddClaudeMessage,
  dbGetClaudeMessages,
  dbDeleteClaudeMessage,
} from './rustBridge';

// ── Key-casing helper ───────────────────────────────────────────────────────

/** Converts camelCase → snake_case (e.g. "threadId" → "thread_id"). */
function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
}

/**
 * Shallow-converts all camelCase keys of a Rust-serialised object to the
 * snake_case keys the existing frontend interfaces expect.
 */
function snakeKeys<T>(obj: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[toSnake(k)] = v;
  return out as T;
}

// ── Chat Config ─────────────────────────────────────────────────────────────

export interface ChatConfig {
  thread_id: string;
  model?: string;
  claude_session_id?: string | null;
  continuation_source_thread_id?: string | null;
  continuation_source_provider?: string | null;
  continuation_source_name?: string | null;
  continuation_compacted_messages?: number | null;
  reasoning?: string;
  temperature?: number;
  max_tokens?: number;
}

export async function getChatConfig(threadId: string): Promise<ChatConfig | null> {
  const row = await dbGetChatConfig(threadId);
  return row ? snakeKeys<ChatConfig>(row as unknown as Record<string, unknown>) : null;
}

export async function saveChatConfig(config: ChatConfig): Promise<void> {
  return dbSaveChatConfig({
    threadId: config.thread_id,
    model: config.model,
    claudeSessionId: config.claude_session_id,
    continuationSourceThreadId: config.continuation_source_thread_id,
    continuationSourceProvider: config.continuation_source_provider,
    continuationSourceName: config.continuation_source_name,
    continuationCompactedMessages: config.continuation_compacted_messages,
    reasoning: config.reasoning,
    temperature: config.temperature,
    maxTokens: config.max_tokens,
  });
}

export async function deleteChatConfig(threadId: string): Promise<void> {
  return dbDeleteChatConfig(threadId);
}

// ── App Settings ────────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  return dbGetSetting(key);
}

export async function setSetting(key: string, value: string): Promise<void> {
  return dbSetSetting(key, value);
}

/** Corrupt or non-JSON values should not break startup; fall back to the default. */
export async function getSettingJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await getSetting(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function setSettingJson<T>(key: string, value: T): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await dbGetAllSettings();
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

// ── Saved Connections ───────────────────────────────────────────────────────

export interface SavedConnectionRow {
  id: string;
  label: string;
  host: string;
  port: number;
  is_default: number;
  created_at: number;
}

export async function ensureConnectionsTable(): Promise<void> { /* no-op: Rust handles schema */ }

export async function listConnections(): Promise<SavedConnectionRow[]> {
  const rows = await dbListConnections();
  return rows.map(r => snakeKeys<SavedConnectionRow>(r as unknown as Record<string, unknown>));
}

export async function saveConnection(conn: {
  id: string;
  label: string;
  host: string;
  port: number;
  isDefault?: boolean;
}): Promise<void> {
  return dbSaveConnection({
    id: conn.id,
    label: conn.label,
    host: conn.host,
    port: conn.port,
    isDefault: conn.isDefault ?? false,
  });
}

export async function deleteConnection(id: string): Promise<void> {
  return dbDeleteConnection(id);
}

export async function setDefaultConnection(id: string): Promise<void> {
  return dbSetDefaultConnection(id);
}

// ── Chat History (input history for up/down arrow) ──────────────────────────

export async function addChatMessage(threadId: string, message: string): Promise<void> {
  return dbAddChatMessage(threadId, message);
}

export async function getChatMessages(threadId: string, limit = 200): Promise<string[]> {
  return dbGetChatMessages(threadId, limit);
}

export interface ChatHistoryEntry {
  id: number;
  thread_id: string;
  message: string;
  created_at: number;
}

export async function getAllChatHistory(limit = 500): Promise<ChatHistoryEntry[]> {
  const rows = await dbGetAllChatHistory(limit);
  return rows.map(r => snakeKeys<ChatHistoryEntry>(r as unknown as Record<string, unknown>));
}

export async function searchChatHistory(query: string, limit = 200): Promise<ChatHistoryEntry[]> {
  const rows = await dbSearchChatHistory(query, limit);
  return rows.map(r => snakeKeys<ChatHistoryEntry>(r as unknown as Record<string, unknown>));
}

// ── Providers (CC-Switch) ───────────────────────────────────────────────────

export type ProviderAppType = 'claude' | 'codex';

export interface ProviderRow {
  id: string;
  name: string;
  app_type: ProviderAppType;
  settings_config: string;
  website_url: string | null;
  category: string | null;
  icon: string | null;
  icon_color: string | null;
  notes: string | null;
  is_current: number;
  sort_index: number;
  created_at: number;
}

export async function listProviders(appType: ProviderAppType): Promise<ProviderRow[]> {
  const rows = await dbListProviders(appType);
  return rows.map(r => snakeKeys<ProviderRow>(r as unknown as Record<string, unknown>));
}

export async function getCurrentProviderId(appType: ProviderAppType): Promise<string | null> {
  return dbGetCurrentProviderId(appType);
}

export async function addProvider(provider: {
  id: string;
  name: string;
  appType: ProviderAppType;
  settingsConfig: string;
  websiteUrl?: string;
  category?: string;
  icon?: string;
  iconColor?: string;
  notes?: string;
}): Promise<void> {
  return dbAddProvider({
    id: provider.id,
    name: provider.name,
    appType: provider.appType,
    settingsConfig: provider.settingsConfig,
    websiteUrl: provider.websiteUrl,
    category: provider.category,
    icon: provider.icon,
    iconColor: provider.iconColor,
    notes: provider.notes,
  });
}

export async function updateProvider(provider: {
  id: string;
  name: string;
  settingsConfig: string;
  websiteUrl?: string;
  category?: string;
  icon?: string;
  iconColor?: string;
  notes?: string;
}): Promise<void> {
  return dbUpdateProvider({
    id: provider.id,
    name: provider.name,
    settingsConfig: provider.settingsConfig,
    websiteUrl: provider.websiteUrl,
    category: provider.category,
    icon: provider.icon,
    iconColor: provider.iconColor,
    notes: provider.notes,
  });
}

export async function deleteProvider(id: string): Promise<void> {
  return dbDeleteProvider(id);
}

export async function switchCurrentProvider(id: string, appType: ProviderAppType): Promise<void> {
  return dbSwitchProvider(id, appType);
}

// ── Automations ─────────────────────────────────────────────────────────────

export type AutomationStatus = 'ACTIVE' | 'PAUSED' | 'DELETED';
export type ScheduleMode = 'daily' | 'weekly' | 'weekdays' | 'custom';
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';
export type AutomationExecutionState = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'RETRYING';
export type AutomationRunStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';
export type AutomationTriggerSource = 'manual' | 'schedule' | 'retry';
export type AutomationPendingRunKind = 'schedule' | 'retry';

export interface AutomationScheduleConfig {
  mode: ScheduleMode;
  weekdays: Weekday[];
  time: string;
  intervalHours?: number;
  customRrule?: string;
}

export interface AutomationRow {
  id: string;
  name: string;
  prompt: string;
  project_cwd: string | null;
  retry_enabled: number;
  retry_max_attempts: number;
  retry_backoff_minutes: number;
  retry_count: number;
  pending_run_kind: AutomationPendingRunKind;
  status: AutomationStatus;
  schedule_mode: ScheduleMode;
  schedule_weekdays: string;
  schedule_time: string;
  schedule_interval_hours: number;
  schedule_custom_rrule: string;
  last_run_at: number | null;
  next_run_at: number | null;
  next_scheduled_run_at: number | null;
  last_thread_id: string | null;
  last_run_status: AutomationExecutionState | null;
  last_error: string | null;
  background_notify: number;
  template_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationRunRow {
  id: string;
  automation_id: string;
  automation_name: string;
  trigger_source: AutomationTriggerSource;
  status: AutomationRunStatus;
  attempt_number: number;
  started_at: number;
  finished_at: number | null;
  scheduled_for: number | null;
  retry_scheduled_for: number | null;
  thread_id: string | null;
  error_message: string | null;
  created_at: number;
}

export async function ensureAutomationsTable(): Promise<void> { /* no-op: Rust handles schema */ }

export async function listAutomations(): Promise<AutomationRow[]> {
  const rows = await dbListAutomations();
  return rows.map(r => snakeKeys<AutomationRow>(r as unknown as Record<string, unknown>));
}

export async function getAutomation(id: string): Promise<AutomationRow | null> {
  const row = await dbGetAutomation(id);
  return row ? snakeKeys<AutomationRow>(row as unknown as Record<string, unknown>) : null;
}

export async function createAutomation(auto: {
  id: string;
  name: string;
  prompt: string;
  projectCwd?: string | null;
  retryEnabled?: boolean;
  retryMaxAttempts?: number;
  retryBackoffMinutes?: number;
  backgroundNotify?: boolean;
  status?: AutomationStatus;
  scheduleConfig: AutomationScheduleConfig;
  templateId?: string;
}): Promise<void> {
  return dbCreateAutomation({
    id: auto.id,
    name: auto.name,
    prompt: auto.prompt,
    projectCwd: auto.projectCwd,
    retryEnabled: auto.retryEnabled,
    retryMaxAttempts: auto.retryMaxAttempts,
    retryBackoffMinutes: auto.retryBackoffMinutes,
    backgroundNotify: auto.backgroundNotify,
    status: auto.status,
    scheduleMode: auto.scheduleConfig.mode,
    scheduleWeekdays: auto.scheduleConfig.weekdays.join(','),
    scheduleTime: auto.scheduleConfig.time,
    scheduleIntervalHours: auto.scheduleConfig.intervalHours,
    scheduleCustomRrule: auto.scheduleConfig.customRrule,
    templateId: auto.templateId,
  });
}

export async function updateAutomation(auto: {
  id: string;
  name?: string;
  prompt?: string;
  projectCwd?: string | null;
  retryEnabled?: boolean;
  retryMaxAttempts?: number;
  retryBackoffMinutes?: number;
  retryCount?: number;
  pendingRunKind?: AutomationPendingRunKind;
  status?: AutomationStatus;
  scheduleConfig?: AutomationScheduleConfig;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  nextScheduledRunAt?: number | null;
  lastThreadId?: string | null;
  lastRunStatus?: AutomationExecutionState | null;
  lastError?: string | null;
  backgroundNotify?: boolean;
}): Promise<void> {
  const payload: Record<string, unknown> = { id: auto.id };
  if (auto.name !== undefined) payload.name = auto.name;
  if (auto.prompt !== undefined) payload.prompt = auto.prompt;
  if (auto.projectCwd !== undefined) payload.projectCwd = auto.projectCwd;
  if (auto.retryEnabled !== undefined) payload.retryEnabled = auto.retryEnabled;
  if (auto.retryMaxAttempts !== undefined) payload.retryMaxAttempts = auto.retryMaxAttempts;
  if (auto.retryBackoffMinutes !== undefined) payload.retryBackoffMinutes = auto.retryBackoffMinutes;
  if (auto.retryCount !== undefined) payload.retryCount = auto.retryCount;
  if (auto.pendingRunKind !== undefined) payload.pendingRunKind = auto.pendingRunKind;
  if (auto.status !== undefined) payload.status = auto.status;
  if (auto.scheduleConfig !== undefined) {
    payload.scheduleMode = auto.scheduleConfig.mode;
    payload.scheduleWeekdays = auto.scheduleConfig.weekdays.join(',');
    payload.scheduleTime = auto.scheduleConfig.time;
    payload.scheduleIntervalHours = auto.scheduleConfig.intervalHours ?? 24;
    payload.scheduleCustomRrule = auto.scheduleConfig.customRrule ?? '';
  }
  if (auto.lastRunAt !== undefined) payload.lastRunAt = auto.lastRunAt;
  if (auto.nextRunAt !== undefined) payload.nextRunAt = auto.nextRunAt;
  if (auto.nextScheduledRunAt !== undefined) payload.nextScheduledRunAt = auto.nextScheduledRunAt;
  if (auto.lastThreadId !== undefined) payload.lastThreadId = auto.lastThreadId;
  if (auto.lastRunStatus !== undefined) payload.lastRunStatus = auto.lastRunStatus;
  if (auto.lastError !== undefined) payload.lastError = auto.lastError;
  if (auto.backgroundNotify !== undefined) payload.backgroundNotify = auto.backgroundNotify;
  return dbUpdateAutomation(JSON.stringify(payload));
}

export async function deleteAutomation(id: string): Promise<void> {
  return dbDeleteAutomation(id);
}

export async function ensureAutomationRunsTable(): Promise<void> { /* no-op: Rust handles schema */ }

export async function listAutomationRuns(options?: {
  automationId?: string;
  limit?: number;
}): Promise<AutomationRunRow[]> {
  const rows = await dbListAutomationRuns(options?.automationId, options?.limit);
  return rows.map(r => snakeKeys<AutomationRunRow>(r as unknown as Record<string, unknown>));
}

export async function listRunningAutomationRuns(): Promise<AutomationRunRow[]> {
  const rows = await dbListRunningAutomationRuns();
  return rows.map(r => snakeKeys<AutomationRunRow>(r as unknown as Record<string, unknown>));
}

export async function createAutomationRun(run: {
  id: string;
  automationId: string;
  automationName: string;
  triggerSource: AutomationTriggerSource;
  status: AutomationRunStatus;
  attemptNumber: number;
  startedAt: number;
  scheduledFor?: number | null;
  retryScheduledFor?: number | null;
  threadId?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  return dbCreateAutomationRun({
    id: run.id,
    automationId: run.automationId,
    automationName: run.automationName,
    triggerSource: run.triggerSource,
    status: run.status,
    attemptNumber: run.attemptNumber,
    startedAt: run.startedAt,
    scheduledFor: run.scheduledFor,
    retryScheduledFor: run.retryScheduledFor,
    threadId: run.threadId,
    errorMessage: run.errorMessage,
  });
}

export async function updateAutomationRun(run: {
  id: string;
  status?: AutomationRunStatus;
  finishedAt?: number | null;
  retryScheduledFor?: number | null;
  threadId?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  const payload: Record<string, unknown> = { id: run.id };
  if (run.status !== undefined) payload.status = run.status;
  if (run.finishedAt !== undefined) payload.finishedAt = run.finishedAt;
  if (run.retryScheduledFor !== undefined) payload.retryScheduledFor = run.retryScheduledFor;
  if (run.threadId !== undefined) payload.threadId = run.threadId;
  if (run.errorMessage !== undefined) payload.errorMessage = run.errorMessage;
  return dbUpdateAutomationRun(JSON.stringify(payload));
}

// ── Claude Sessions ─────────────────────────────────────────────────────────

export interface ClaudeSessionRow {
  id: string;
  title: string;
  model: string | null;
  provider_id: string | null;
  working_directory: string | null;
  system_prompt: string | null;
  is_archived: number;
  created_at: number;
  updated_at: number;
}

export async function createClaudeSession(session: {
  id: string;
  title?: string;
  model?: string;
  providerId?: string;
  workingDirectory?: string;
  systemPrompt?: string;
}): Promise<void> {
  return dbCreateClaudeSession({
    id: session.id,
    title: session.title,
    model: session.model,
    providerId: session.providerId,
    workingDirectory: session.workingDirectory,
    systemPrompt: session.systemPrompt,
  });
}

export async function listClaudeSessions(): Promise<ClaudeSessionRow[]> {
  const rows = await dbListClaudeSessions();
  return rows.map(r => snakeKeys<ClaudeSessionRow>(r as unknown as Record<string, unknown>));
}

export async function getClaudeSession(id: string): Promise<ClaudeSessionRow | null> {
  const row = await dbGetClaudeSession(id);
  return row ? snakeKeys<ClaudeSessionRow>(row as unknown as Record<string, unknown>) : null;
}

export async function updateClaudeSession(id: string, updates: {
  title?: string;
  model?: string;
  isArchived?: boolean;
}): Promise<void> {
  const payload: Record<string, unknown> = { id };
  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.model !== undefined) payload.model = updates.model;
  if (updates.isArchived !== undefined) payload.isArchived = updates.isArchived;
  return dbUpdateClaudeSession(JSON.stringify(payload));
}

export async function deleteClaudeSession(id: string): Promise<void> {
  return dbDeleteClaudeSession(id);
}

// ── Claude Messages ─────────────────────────────────────────────────────────

export interface ClaudeMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  token_usage: string | null;
  created_at: number;
}

export async function addClaudeMessage(msg: {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  tokenUsage?: { input_tokens: number; output_tokens: number };
}): Promise<void> {
  return dbAddClaudeMessage({
    id: msg.id,
    sessionId: msg.sessionId,
    role: msg.role,
    content: msg.content,
    tokenUsage: msg.tokenUsage ? JSON.stringify(msg.tokenUsage) : null,
  });
}

export async function getClaudeMessages(sessionId: string): Promise<ClaudeMessageRow[]> {
  const rows = await dbGetClaudeMessages(sessionId);
  return rows.map(r => snakeKeys<ClaudeMessageRow>(r as unknown as Record<string, unknown>));
}

export async function deleteClaudeMessage(id: string): Promise<void> {
  return dbDeleteClaudeMessage(id);
}
