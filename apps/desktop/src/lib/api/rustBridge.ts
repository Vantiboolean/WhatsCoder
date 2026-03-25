/**
 * Thin typed wrappers around Tauri `invoke()` calls to the Rust backend.
 * Accepts camelCase on the TypeScript side; converts to snake_case for the
 * Rust command parameter names.
 */
import { invoke } from '@tauri-apps/api/core';

// ── Return types (match Rust #[serde(rename_all = "camelCase")] output) ─────

interface ChatConfigRow {
  threadId: string;
  model: string | null;
  claudeSessionId: string | null;
  continuationSourceThreadId: string | null;
  continuationSourceProvider: string | null;
  continuationSourceName: string | null;
  continuationCompactedMessages: number | null;
  reasoning: string | null;
  temperature: number | null;
  maxTokens: number | null;
}

interface ChatHistoryRow {
  id: number;
  threadId: string;
  message: string;
  createdAt: number;
}

interface ConnectionRow {
  id: string;
  label: string;
  host: string;
  port: number;
  isDefault: number;
  createdAt: number;
}

interface BridgeProviderRow {
  id: string;
  name: string;
  appType: string;
  settingsConfig: string;
  websiteUrl: string | null;
  category: string | null;
  icon: string | null;
  iconColor: string | null;
  notes: string | null;
  isCurrent: number;
  sortIndex: number;
  createdAt: number;
}

interface BridgeAutomationRow {
  id: string;
  name: string;
  prompt: string;
  projectCwd: string | null;
  retryEnabled: number;
  retryMaxAttempts: number;
  retryBackoffMinutes: number;
  retryCount: number;
  pendingRunKind: string;
  status: string;
  scheduleMode: string;
  scheduleWeekdays: string;
  scheduleTime: string;
  scheduleIntervalHours: number;
  scheduleCustomRrule: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  nextScheduledRunAt: number | null;
  lastThreadId: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  backgroundNotify: number;
  templateId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface BridgeAutomationRunRow {
  id: string;
  automationId: string;
  automationName: string;
  triggerSource: string;
  status: string;
  attemptNumber: number;
  startedAt: number;
  finishedAt: number | null;
  scheduledFor: number | null;
  retryScheduledFor: number | null;
  threadId: string | null;
  errorMessage: string | null;
  createdAt: number;
}

interface BridgeClaudeSessionRow {
  id: string;
  title: string;
  model: string | null;
  providerId: string | null;
  workingDirectory: string | null;
  systemPrompt: string | null;
  isArchived: number;
  createdAt: number;
  updatedAt: number;
}

interface BridgeClaudeMessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  tokenUsage: string | null;
  createdAt: number;
}

interface SettingRow {
  key: string;
  value: string;
}

export interface UsageSummaryRow {
  totalRequests: number;
  totalCost: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  successRate: number;
}

export interface DailyStatsRow {
  date: string;
  requestCount: number;
  totalCost: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
}

export interface ProviderStatsRow {
  providerId: string;
  providerName: string;
  requestCount: number;
  totalTokens: number;
  totalCost: string;
  successRate: number;
  avgLatencyMs: number;
}

export interface ModelStatsRow {
  model: string;
  requestCount: number;
  totalTokens: number;
  totalCost: string;
  avgCostPerRequest: string;
}

export interface RequestLogRow {
  requestId: string;
  providerId: string;
  providerName: string | null;
  appType: string;
  model: string;
  requestModel: string | null;
  costMultiplier: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputCostUsd: string;
  outputCostUsd: string;
  cacheReadCostUsd: string;
  cacheCreationCostUsd: string;
  totalCostUsd: string;
  isStreaming: boolean;
  latencyMs: number;
  firstTokenMs: number | null;
  durationMs: number | null;
  statusCode: number;
  errorMessage: string | null;
  createdAt: number;
}

export interface PaginatedLogsResult {
  data: RequestLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ModelPricingRow {
  modelId: string;
  displayName: string;
  inputCostPerMillion: string;
  outputCostPerMillion: string;
  cacheReadCostPerMillion: string;
  cacheCreationCostPerMillion: string;
}

// ── Settings ────────────────────────────────────────────────────────────────

export function dbGetSetting(key: string): Promise<string | null> {
  return invoke<string | null>('db_get_setting', { key });
}

export function dbSetSetting(key: string, value: string): Promise<void> {
  return invoke<void>('db_set_setting', { key, value });
}

export function dbGetAllSettings(): Promise<SettingRow[]> {
  return invoke<SettingRow[]>('db_get_all_settings');
}

// ── Chat Config ─────────────────────────────────────────────────────────────

export function dbGetChatConfig(threadId: string): Promise<ChatConfigRow | null> {
  return invoke<ChatConfigRow | null>('db_get_chat_config', { thread_id: threadId });
}

export function dbSaveChatConfig(cfg: {
  threadId: string;
  model?: string | null;
  claudeSessionId?: string | null;
  continuationSourceThreadId?: string | null;
  continuationSourceProvider?: string | null;
  continuationSourceName?: string | null;
  continuationCompactedMessages?: number | null;
  reasoning?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
}): Promise<void> {
  return invoke<void>('db_save_chat_config', {
    thread_id: cfg.threadId,
    model: cfg.model ?? null,
    claude_session_id: cfg.claudeSessionId ?? null,
    continuation_source_thread_id: cfg.continuationSourceThreadId ?? null,
    continuation_source_provider: cfg.continuationSourceProvider ?? null,
    continuation_source_name: cfg.continuationSourceName ?? null,
    continuation_compacted_messages: cfg.continuationCompactedMessages ?? null,
    reasoning: cfg.reasoning ?? null,
    temperature: cfg.temperature ?? null,
    max_tokens: cfg.maxTokens ?? null,
  });
}

export function dbDeleteChatConfig(threadId: string): Promise<void> {
  return invoke<void>('db_delete_chat_config', { thread_id: threadId });
}

// ── Chat History ────────────────────────────────────────────────────────────

export function dbAddChatMessage(threadId: string, message: string): Promise<void> {
  return invoke<void>('db_add_chat_message', { thread_id: threadId, message });
}

export function dbGetChatMessages(threadId: string, limit?: number): Promise<string[]> {
  return invoke<string[]>('db_get_chat_messages', {
    thread_id: threadId,
    limit: limit ?? null,
  });
}

export function dbGetAllChatHistory(limit?: number): Promise<ChatHistoryRow[]> {
  return invoke<ChatHistoryRow[]>('db_get_all_chat_history', { limit: limit ?? null });
}

export function dbSearchChatHistory(query: string, limit?: number): Promise<ChatHistoryRow[]> {
  return invoke<ChatHistoryRow[]>('db_search_chat_history', {
    query,
    limit: limit ?? null,
  });
}

// ── Connections ──────────────────────────────────────────────────────────────

export function dbListConnections(): Promise<ConnectionRow[]> {
  return invoke<ConnectionRow[]>('db_list_connections');
}

export function dbSaveConnection(conn: {
  id: string;
  label: string;
  host: string;
  port: number;
  isDefault: boolean;
}): Promise<void> {
  return invoke<void>('db_save_connection', {
    id: conn.id,
    label: conn.label,
    host: conn.host,
    port: conn.port,
    is_default: conn.isDefault,
  });
}

export function dbDeleteConnection(id: string): Promise<void> {
  return invoke<void>('db_delete_connection', { id });
}

export function dbSetDefaultConnection(id: string): Promise<void> {
  return invoke<void>('db_set_default_connection', { id });
}

// ── Providers ───────────────────────────────────────────────────────────────

export function dbListProviders(appType: string): Promise<BridgeProviderRow[]> {
  return invoke<BridgeProviderRow[]>('db_list_providers', { app_type: appType });
}

export function dbGetCurrentProviderId(appType: string): Promise<string | null> {
  return invoke<string | null>('db_get_current_provider_id', { app_type: appType });
}

export function dbAddProvider(p: {
  id: string;
  name: string;
  appType: string;
  settingsConfig: string;
  websiteUrl?: string | null;
  category?: string | null;
  icon?: string | null;
  iconColor?: string | null;
  notes?: string | null;
}): Promise<void> {
  return invoke<void>('db_add_provider', {
    id: p.id,
    name: p.name,
    app_type: p.appType,
    settings_config: p.settingsConfig,
    website_url: p.websiteUrl ?? null,
    category: p.category ?? null,
    icon: p.icon ?? null,
    icon_color: p.iconColor ?? null,
    notes: p.notes ?? null,
  });
}

export function dbUpdateProvider(p: {
  id: string;
  name: string;
  settingsConfig: string;
  websiteUrl?: string | null;
  category?: string | null;
  icon?: string | null;
  iconColor?: string | null;
  notes?: string | null;
}): Promise<void> {
  return invoke<void>('db_update_provider', {
    id: p.id,
    name: p.name,
    settings_config: p.settingsConfig,
    website_url: p.websiteUrl ?? null,
    category: p.category ?? null,
    icon: p.icon ?? null,
    icon_color: p.iconColor ?? null,
    notes: p.notes ?? null,
  });
}

export function dbDeleteProvider(id: string): Promise<void> {
  return invoke<void>('db_delete_provider', { id });
}

export function dbSwitchProvider(id: string, appType: string): Promise<void> {
  return invoke<void>('db_switch_provider', { id, app_type: appType });
}

// ── Automations ─────────────────────────────────────────────────────────────

export function dbListAutomations(): Promise<BridgeAutomationRow[]> {
  return invoke<BridgeAutomationRow[]>('db_list_automations');
}

export function dbGetAutomation(id: string): Promise<BridgeAutomationRow | null> {
  return invoke<BridgeAutomationRow | null>('db_get_automation', { id });
}

export function dbCreateAutomation(a: {
  id: string;
  name: string;
  prompt: string;
  projectCwd?: string | null;
  retryEnabled?: boolean | null;
  retryMaxAttempts?: number | null;
  retryBackoffMinutes?: number | null;
  backgroundNotify?: boolean | null;
  status?: string | null;
  scheduleMode: string;
  scheduleWeekdays: string;
  scheduleTime: string;
  scheduleIntervalHours?: number | null;
  scheduleCustomRrule?: string | null;
  templateId?: string | null;
}): Promise<void> {
  return invoke<void>('db_create_automation', {
    id: a.id,
    name: a.name,
    prompt: a.prompt,
    project_cwd: a.projectCwd ?? null,
    retry_enabled: a.retryEnabled ?? null,
    retry_max_attempts: a.retryMaxAttempts ?? null,
    retry_backoff_minutes: a.retryBackoffMinutes ?? null,
    background_notify: a.backgroundNotify ?? null,
    status: a.status ?? null,
    schedule_mode: a.scheduleMode,
    schedule_weekdays: a.scheduleWeekdays,
    schedule_time: a.scheduleTime,
    schedule_interval_hours: a.scheduleIntervalHours ?? null,
    schedule_custom_rrule: a.scheduleCustomRrule ?? null,
    template_id: a.templateId ?? null,
  });
}

export function dbUpdateAutomation(updatesJson: string): Promise<void> {
  return invoke<void>('db_update_automation', { updates_json: updatesJson });
}

export function dbDeleteAutomation(id: string): Promise<void> {
  return invoke<void>('db_delete_automation', { id });
}

// ── Automation Runs ─────────────────────────────────────────────────────────

export function dbListAutomationRuns(
  automationId?: string | null,
  limit?: number | null,
): Promise<BridgeAutomationRunRow[]> {
  return invoke<BridgeAutomationRunRow[]>('db_list_automation_runs', {
    automation_id: automationId ?? null,
    limit: limit ?? null,
  });
}

export function dbListRunningAutomationRuns(): Promise<BridgeAutomationRunRow[]> {
  return invoke<BridgeAutomationRunRow[]>('db_list_running_automation_runs');
}

export function dbCreateAutomationRun(r: {
  id: string;
  automationId: string;
  automationName: string;
  triggerSource: string;
  status: string;
  attemptNumber: number;
  startedAt: number;
  scheduledFor?: number | null;
  retryScheduledFor?: number | null;
  threadId?: string | null;
  errorMessage?: string | null;
}): Promise<void> {
  return invoke<void>('db_create_automation_run', {
    id: r.id,
    automation_id: r.automationId,
    automation_name: r.automationName,
    trigger_source: r.triggerSource,
    status: r.status,
    attempt_number: r.attemptNumber,
    started_at: r.startedAt,
    scheduled_for: r.scheduledFor ?? null,
    retry_scheduled_for: r.retryScheduledFor ?? null,
    thread_id: r.threadId ?? null,
    error_message: r.errorMessage ?? null,
  });
}

export function dbUpdateAutomationRun(updatesJson: string): Promise<void> {
  return invoke<void>('db_update_automation_run', { updates_json: updatesJson });
}

// ── Claude Sessions ─────────────────────────────────────────────────────────

export function dbCreateClaudeSession(s: {
  id: string;
  title?: string | null;
  model?: string | null;
  providerId?: string | null;
  workingDirectory?: string | null;
  systemPrompt?: string | null;
}): Promise<void> {
  return invoke<void>('db_create_claude_session', {
    id: s.id,
    title: s.title ?? null,
    model: s.model ?? null,
    provider_id: s.providerId ?? null,
    working_directory: s.workingDirectory ?? null,
    system_prompt: s.systemPrompt ?? null,
  });
}

export function dbListClaudeSessions(): Promise<BridgeClaudeSessionRow[]> {
  return invoke<BridgeClaudeSessionRow[]>('db_list_claude_sessions');
}

export function dbGetClaudeSession(id: string): Promise<BridgeClaudeSessionRow | null> {
  return invoke<BridgeClaudeSessionRow | null>('db_get_claude_session', { id });
}

export function dbUpdateClaudeSession(updatesJson: string): Promise<void> {
  return invoke<void>('db_update_claude_session', { updates_json: updatesJson });
}

export function dbDeleteClaudeSession(id: string): Promise<void> {
  return invoke<void>('db_delete_claude_session', { id });
}

// ── Claude Messages ─────────────────────────────────────────────────────────

export function dbAddClaudeMessage(m: {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  tokenUsage?: string | null;
}): Promise<void> {
  return invoke<void>('db_add_claude_message', {
    id: m.id,
    session_id: m.sessionId,
    role: m.role,
    content: m.content,
    token_usage: m.tokenUsage ?? null,
  });
}

export function dbGetClaudeMessages(sessionId: string): Promise<BridgeClaudeMessageRow[]> {
  return invoke<BridgeClaudeMessageRow[]>('db_get_claude_messages', {
    session_id: sessionId,
  });
}

export function dbDeleteClaudeMessage(id: string): Promise<void> {
  return invoke<void>('db_delete_claude_message', { id });
}

// ── Scheduling ──────────────────────────────────────────────────────────────

export function computeNextRun(
  mode: string,
  weekdays: string,
  time: string,
  intervalHours: number,
): Promise<number> {
  return invoke<number>('compute_next_run', {
    mode,
    weekdays,
    time,
    interval_hours: intervalHours,
  });
}

export function computeRetryDelay(
  baseMinutes: number,
  retryNumber: number,
): Promise<number> {
  return invoke<number>('compute_retry_delay', {
    base_minutes: baseMinutes,
    retry_number: retryNumber,
  });
}

// ── Usage ───────────────────────────────────────────────────────────────────

export function dbGetUsageSummary(
  startDate?: number,
  endDate?: number,
): Promise<UsageSummaryRow> {
  return invoke<UsageSummaryRow>('db_get_usage_summary', {
    start_date: startDate ?? null,
    end_date: endDate ?? null,
  });
}

export function dbGetUsageTrends(
  startDate?: number,
  endDate?: number,
): Promise<DailyStatsRow[]> {
  return invoke<DailyStatsRow[]>('db_get_usage_trends', {
    start_date: startDate ?? null,
    end_date: endDate ?? null,
  });
}

export function dbGetProviderStats(): Promise<ProviderStatsRow[]> {
  return invoke<ProviderStatsRow[]>('db_get_provider_stats');
}

export function dbGetModelStats(): Promise<ModelStatsRow[]> {
  return invoke<ModelStatsRow[]>('db_get_model_stats');
}

export function dbGetRequestLogs(
  filtersJson?: string,
  page?: number,
  pageSize?: number,
): Promise<PaginatedLogsResult> {
  return invoke<PaginatedLogsResult>('db_get_request_logs', {
    filters_json: filtersJson ?? null,
    page: page ?? null,
    page_size: pageSize ?? null,
  });
}

export function dbGetRequestDetail(requestId: string): Promise<RequestLogRow | null> {
  return invoke<RequestLogRow | null>('db_get_request_detail', {
    request_id: requestId,
  });
}

// ── Model Pricing ───────────────────────────────────────────────────────────

export function dbListModelPricing(): Promise<ModelPricingRow[]> {
  return invoke<ModelPricingRow[]>('db_list_model_pricing');
}

export function dbUpsertModelPricing(p: {
  modelId: string;
  displayName: string;
  inputCost: string;
  outputCost: string;
  cacheReadCost: string;
  cacheCreationCost: string;
}): Promise<void> {
  return invoke<void>('db_upsert_model_pricing', {
    model_id: p.modelId,
    display_name: p.displayName,
    input_cost: p.inputCost,
    output_cost: p.outputCost,
    cache_read_cost: p.cacheReadCost,
    cache_creation_cost: p.cacheCreationCost,
  });
}

export function dbDeleteModelPricing(modelId: string): Promise<void> {
  return invoke<void>('db_delete_model_pricing', { model_id: modelId });
}
