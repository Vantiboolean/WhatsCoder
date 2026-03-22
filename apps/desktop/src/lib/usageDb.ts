/**
 * Usage dashboard data – delegates all queries to Rust backend commands via invoke().
 */
import { invoke } from '@tauri-apps/api/core';

// ── Types ──

export interface UsageSummary {
  totalRequests: number;
  totalCost: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  successRate: number;
}

export interface DailyStats {
  date: string;
  requestCount: number;
  totalCost: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
}

export interface ProviderStats {
  providerId: string;
  providerName: string;
  requestCount: number;
  totalTokens: number;
  totalCost: string;
  successRate: number;
  avgLatencyMs: number;
}

export interface ModelStats {
  model: string;
  requestCount: number;
  totalTokens: number;
  totalCost: string;
  avgCostPerRequest: string;
}

export interface RequestLog {
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

export interface PaginatedLogs {
  data: RequestLog[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LogFilters {
  appType?: string;
  providerName?: string;
  model?: string;
  statusCode?: number;
  startDate?: number;
  endDate?: number;
}

export interface ModelPricing {
  modelId: string;
  displayName: string;
  inputCostPerMillion: string;
  outputCostPerMillion: string;
  cacheReadCostPerMillion: string;
  cacheCreationCostPerMillion: string;
}

export type TimeRange = '1d' | '7d' | '30d';

// ── Backward-compat no-op (Rust handles schema) ──

export async function ensureUsageSchema(): Promise<void> {}

// ── Formatting Utilities ──

export function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function fmtInt(value: unknown, fallback = '--'): string {
  const num = parseFiniteNumber(value);
  if (num == null) return fallback;
  return new Intl.NumberFormat().format(Math.trunc(num));
}

export function fmtUsd(value: unknown, digits: number, fallback = '--'): string {
  const num = parseFiniteNumber(value);
  if (num == null) return fallback;
  return `$${num.toFixed(digits)}`;
}

// ── Query Functions ──

export async function getUsageSummary(startDate?: number, endDate?: number): Promise<UsageSummary> {
  return invoke<UsageSummary>('db_get_usage_summary', {
    start_date: startDate ?? null,
    end_date: endDate ?? null,
  });
}

export async function getUsageTrends(startDate?: number, endDate?: number): Promise<DailyStats[]> {
  return invoke<DailyStats[]>('db_get_usage_trends', {
    start_date: startDate ?? null,
    end_date: endDate ?? null,
  });
}

export async function getProviderStats(): Promise<ProviderStats[]> {
  return invoke<ProviderStats[]>('db_get_provider_stats', {});
}

export async function getModelStats(): Promise<ModelStats[]> {
  return invoke<ModelStats[]>('db_get_model_stats', {});
}

export async function getRequestLogs(filters: LogFilters, page = 0, pageSize = 20): Promise<PaginatedLogs> {
  return invoke<PaginatedLogs>('db_get_request_logs', {
    filters_json: JSON.stringify(filters),
    page,
    page_size: pageSize,
  });
}

export async function getRequestDetail(requestId: string): Promise<RequestLog | null> {
  return invoke<RequestLog | null>('db_get_request_detail', {
    request_id: requestId,
  });
}

// ── Model Pricing CRUD ──

export async function getModelPricingList(): Promise<ModelPricing[]> {
  return invoke<ModelPricing[]>('db_list_model_pricing', {});
}

export async function updateModelPricing(
  modelId: string,
  displayName: string,
  inputCost: string,
  outputCost: string,
  cacheReadCost: string,
  cacheCreationCost: string,
): Promise<void> {
  await invoke('db_upsert_model_pricing', {
    model_id: modelId,
    display_name: displayName,
    input_cost: inputCost,
    output_cost: outputCost,
    cache_read_cost: cacheReadCost,
    cache_creation_cost: cacheCreationCost,
  });
}

export async function deleteModelPricing(modelId: string): Promise<void> {
  await invoke('db_delete_model_pricing', { model_id: modelId });
}
