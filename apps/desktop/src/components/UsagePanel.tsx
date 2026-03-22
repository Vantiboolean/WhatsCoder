import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type UsageSummary,
  type DailyStats,
  type ProviderStats,
  type ModelStats,
  type RequestLog,
  type PaginatedLogs,
  type LogFilters,
  type ModelPricing,
  type TimeRange,
  getUsageSummary,
  getUsageTrends,
  getProviderStats,
  getModelStats,
  getRequestLogs,
  getModelPricingList,
  updateModelPricing,
  deleteModelPricing,
  fmtUsd,
  fmtInt,
  parseFiniteNumber,
} from '../lib/usageDb';

// ── Summary Cards ──

const SummaryCards = memo(function SummaryCards({ summary, loading }: { summary: UsageSummary | null; loading: boolean }) {
  const { t } = useTranslation();
  if (loading || !summary) {
    return (
      <div className="usage-cards">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="usage-card usage-card--loading">
            <div className="usage-card__skeleton" />
          </div>
        ))}
      </div>
    );
  }

  const totalTokens = summary.totalInputTokens + summary.totalOutputTokens;
  const totalCacheTokens = summary.totalCacheCreationTokens + summary.totalCacheReadTokens;

  const cards = [
    { title: t('usage.totalRequests'), value: summary.totalRequests.toLocaleString(), color: 'blue' },
    { title: t('usage.totalCost'), value: fmtUsd(summary.totalCost, 4), color: 'green' },
    {
      title: t('usage.totalTokens'), value: totalTokens.toLocaleString(), color: 'purple',
      sub: [
        { label: t('usage.inputLabel'), value: `${(summary.totalInputTokens / 1000).toFixed(1)}k` },
        { label: t('usage.outputLabel'), value: `${(summary.totalOutputTokens / 1000).toFixed(1)}k` },
      ],
    },
    {
      title: t('usage.cacheTokens'), value: totalCacheTokens.toLocaleString(), color: 'orange',
      sub: [
        { label: t('usage.cacheWrite'), value: `${(summary.totalCacheCreationTokens / 1000).toFixed(1)}k` },
        { label: t('usage.cacheRead'), value: `${(summary.totalCacheReadTokens / 1000).toFixed(1)}k` },
      ],
    },
  ];

  return (
    <div className="usage-cards">
      {cards.map((card, i) => (
        <div key={i} className={`usage-card usage-card--${card.color}`}>
          <div className="usage-card__header">
            <span className="usage-card__title">{card.title}</span>
            <span className={`usage-card__icon usage-card__icon--${card.color}`} />
          </div>
          <div className="usage-card__value">{card.value}</div>
          {card.sub ? (
            <div className="usage-card__sub">
              {card.sub.map((s, j) => (
                <div key={j} className="usage-card__sub-row">
                  <span>{s.label}</span><span>{s.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="usage-card__sub usage-card__sub--empty" />
          )}
        </div>
      ))}
    </div>
  );
});

// ── SVG Trend Chart ──

const TrendChart = memo(function TrendChart({ trends, days }: { trends: DailyStats[]; days: number }) {
  const { t } = useTranslation();
  if (!trends.length) {
    return (
      <div className="usage-chart usage-chart--empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}>
          <path d="M3 3v18h18" /><path d="M7 16l4-8 4 4 6-6" />
        </svg>
        <span>{t('usage.noTrendData')}</span>
      </div>
    );
  }

  const isToday = days === 1;
  const width = 800;
  const height = 280;
  const pad = { top: 24, right: 60, bottom: 40, left: 60 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const maxTokens = Math.max(1, ...trends.map(row => Math.max(row.totalInputTokens, row.totalOutputTokens)));
  const maxCost = Math.max(0.000001, ...trends.map(row => parseFiniteNumber(row.totalCost) ?? 0));

  const xScale = (i: number) => pad.left + (i / Math.max(1, trends.length - 1)) * innerW;
  const yTokens = (v: number) => pad.top + innerH - (v / maxTokens) * innerH;
  const yCost = (v: number) => pad.top + innerH - (v / maxCost) * innerH;

  const inputLine = trends.map((row, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yTokens(row.totalInputTokens).toFixed(1)}`).join(' ');
  const outputLine = trends.map((row, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yTokens(row.totalOutputTokens).toFixed(1)}`).join(' ');
  const costLine = trends.map((row, i) => {
    const c = parseFiniteNumber(row.totalCost) ?? 0;
    return `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yCost(c).toFixed(1)}`;
  }).join(' ');

  const bottomY = pad.top + innerH;
  const inputArea = `${inputLine} L${xScale(trends.length - 1).toFixed(1)},${bottomY} L${xScale(0).toFixed(1)},${bottomY} Z`;
  const outputArea = `${outputLine} L${xScale(trends.length - 1).toFixed(1)},${bottomY} L${xScale(0).toFixed(1)},${bottomY} Z`;

  const labels: string[] = trends.map(row => {
    const d = new Date(row.date);
    return isToday
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : `${d.getMonth() + 1}/${d.getDate()}`;
  });

  const tickInterval = Math.max(1, Math.ceil(trends.length / 8));
  const showPoints = trends.length <= 14;

  return (
    <div className="usage-chart">
      <div className="usage-chart__header">
        <span className="usage-chart__title">{t('usage.usageTrends')}</span>
        <span className="usage-chart__range">
          {isToday ? t('usage.todayHourly') : days === 7 ? t('usage.last7Days') : t('usage.last30Days')}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="usage-chart__svg">
        {[0, 0.25, 0.5, 0.75, 1].map(frac => (
          <line key={frac} x1={pad.left} x2={width - pad.right} y1={pad.top + innerH * (1 - frac)} y2={pad.top + innerH * (1 - frac)} className="usage-chart__grid" />
        ))}
        {[0, 0.5, 1].map(frac => (
          <text key={`yt-${frac}`} x={pad.left - 8} y={pad.top + innerH * (1 - frac) + 4} className="usage-chart__label" textAnchor="end">
            {`${((maxTokens * frac) / 1000).toFixed(0)}k`}
          </text>
        ))}
        {[0, 0.5, 1].map(frac => (
          <text key={`yc-${frac}`} x={width - pad.right + 8} y={pad.top + innerH * (1 - frac) + 4} className="usage-chart__label usage-chart__label--cost" textAnchor="start">
            {`$${(maxCost * frac).toFixed(2)}`}
          </text>
        ))}
        {labels.map((label, i) => (
          i % tickInterval === 0 ? (
            <text key={i} x={xScale(i)} y={height - 8} className="usage-chart__label" textAnchor="middle">
              {label}
            </text>
          ) : null
        ))}
        <path d={inputArea} className="usage-chart__area usage-chart__area--input" />
        <path d={outputArea} className="usage-chart__area usage-chart__area--output" />
        <path d={inputLine} className="usage-chart__line usage-chart__line--input" />
        <path d={outputLine} className="usage-chart__line usage-chart__line--output" />
        <path d={costLine} className="usage-chart__line usage-chart__line--cost" />
        {showPoints && trends.map((row, i) => (
          <circle key={`pi-${i}`} cx={xScale(i)} cy={yTokens(row.totalInputTokens)} className="usage-chart__point usage-chart__point--input" />
        ))}
        {showPoints && trends.map((row, i) => (
          <circle key={`po-${i}`} cx={xScale(i)} cy={yTokens(row.totalOutputTokens)} className="usage-chart__point usage-chart__point--output" />
        ))}
        {showPoints && trends.map((row, i) => {
          const c = parseFiniteNumber(row.totalCost) ?? 0;
          return <circle key={`pc-${i}`} cx={xScale(i)} cy={yCost(c)} className="usage-chart__point usage-chart__point--cost" />;
        })}
      </svg>
      <div className="usage-chart__legend">
        <span className="usage-chart__legend-item"><span className="usage-chart__dot usage-chart__dot--input" /> {t('usage.inputTokens')}</span>
        <span className="usage-chart__legend-item"><span className="usage-chart__dot usage-chart__dot--output" /> {t('usage.outputTokens')}</span>
        <span className="usage-chart__legend-item"><span className="usage-chart__dot usage-chart__dot--cost" /> {t('usage.costUsd')}</span>
      </div>
    </div>
  );
});

// ── Request Logs Table ──

const LogsTable = memo(function LogsTable({ logs, total, page, pageSize, onPageChange }: {
  logs: RequestLog[]; total: number; page: number; pageSize: number; onPageChange: (p: number) => void;
}) {
  const { t } = useTranslation();
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="usage-table-wrap">
      <div className="usage-table-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th>{t('usage.time')}</th>
              <th>{t('usage.provider')}</th>
              <th>{t('usage.modelCol')}</th>
              <th className="usage-table__right">{t('usage.inputLabel')}</th>
              <th className="usage-table__right">{t('usage.outputLabel')}</th>
              <th className="usage-table__right">{t('usage.cacheR')}</th>
              <th className="usage-table__right">{t('usage.cacheW')}</th>
              <th className="usage-table__right">{t('usage.cost')}</th>
              <th className="usage-table__center">{t('usage.latency')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr><td colSpan={10} className="usage-table__empty">{t('usage.noRequestLogs')}</td></tr>
            ) : logs.map(log => {
              const durationMs = log.durationMs ?? log.latencyMs;
              const durationSec = durationMs / 1000;
              const durClass = durationSec <= 5 ? 'success' : durationSec <= 120 ? 'warning' : 'error';
              const statusClass = log.statusCode >= 200 && log.statusCode < 300 ? 'success' : 'error';

              return (
                <tr key={log.requestId}>
                  <td className="usage-table__nowrap">{new Date(log.createdAt * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{log.providerName ?? t('common.unknown')}</td>
                  <td className="usage-table__mono usage-table__truncate" title={log.model}>{log.model}</td>
                  <td className="usage-table__right">{fmtInt(log.inputTokens)}</td>
                  <td className="usage-table__right">{fmtInt(log.outputTokens)}</td>
                  <td className="usage-table__right">{fmtInt(log.cacheReadTokens)}</td>
                  <td className="usage-table__right">{fmtInt(log.cacheCreationTokens)}</td>
                  <td className="usage-table__right">{fmtUsd(log.totalCostUsd, 6)}</td>
                  <td className="usage-table__center">
                    <span className={`usage-badge usage-badge--${durClass}`}>
                      {Number.isFinite(durationSec) ? `${Math.round(durationSec)}s` : '--'}
                    </span>
                  </td>
                  <td>
                    <span className={`usage-badge usage-badge--${statusClass}`}>{log.statusCode}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total > 0 && (
        <div className="usage-pagination">
          <span className="usage-pagination__info">{total} {t('common.records')}</span>
          <div className="usage-pagination__controls">
            <button className="usage-pagination__btn" onClick={() => onPageChange(Math.max(0, page - 1))} disabled={page === 0}>{t('common.prev')}</button>
            <span className="usage-pagination__page">{page + 1} / {totalPages}</span>
            <button className="usage-pagination__btn" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages - 1}>{t('common.next')}</button>
          </div>
        </div>
      )}
    </div>
  );
});

// ── Provider Stats Table ──

const ProviderStatsTable = memo(function ProviderStatsTable({ stats }: { stats: ProviderStats[] }) {
  const { t } = useTranslation();
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th>{t('usage.provider')}</th>
            <th className="usage-table__right">{t('usage.requests')}</th>
            <th className="usage-table__right">{t('usage.tokens')}</th>
            <th className="usage-table__right">{t('usage.cost')}</th>
            <th className="usage-table__right">{t('usage.successRate')}</th>
            <th className="usage-table__right">{t('usage.avgLatency')}</th>
          </tr>
        </thead>
        <tbody>
          {stats.length === 0 ? (
            <tr><td colSpan={6} className="usage-table__empty">{t('usage.noProviderStats')}</td></tr>
          ) : stats.map(s => (
            <tr key={s.providerId}>
              <td className="usage-table__bold">{s.providerName}</td>
              <td className="usage-table__right">{s.requestCount.toLocaleString()}</td>
              <td className="usage-table__right">{s.totalTokens.toLocaleString()}</td>
              <td className="usage-table__right">{fmtUsd(s.totalCost, 4)}</td>
              <td className="usage-table__right">{s.successRate.toFixed(1)}%</td>
              <td className="usage-table__right">{s.avgLatencyMs}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

// ── Model Stats Table ──

const ModelStatsTable = memo(function ModelStatsTable({ stats }: { stats: ModelStats[] }) {
  const { t } = useTranslation();
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th>{t('usage.modelCol')}</th>
            <th className="usage-table__right">{t('usage.requests')}</th>
            <th className="usage-table__right">{t('usage.tokens')}</th>
            <th className="usage-table__right">{t('usage.totalCost')}</th>
            <th className="usage-table__right">{t('usage.avgCost')}</th>
          </tr>
        </thead>
        <tbody>
          {stats.length === 0 ? (
            <tr><td colSpan={5} className="usage-table__empty">{t('usage.noModelStats')}</td></tr>
          ) : stats.map(s => (
            <tr key={s.model}>
              <td className="usage-table__mono">{s.model}</td>
              <td className="usage-table__right">{s.requestCount.toLocaleString()}</td>
              <td className="usage-table__right">{s.totalTokens.toLocaleString()}</td>
              <td className="usage-table__right">{fmtUsd(s.totalCost, 4)}</td>
              <td className="usage-table__right">{fmtUsd(s.avgCostPerRequest, 6)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

// ── Pricing Panel ──

const PricingPanel = memo(function PricingPanel({ pricing, onRefresh }: { pricing: ModelPricing[]; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [editModal, setEditModal] = useState<{ model: ModelPricing; isNew: boolean } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleSave = useCallback(async (modelId: string, displayName: string, inputCost: string, outputCost: string, cacheReadCost: string, cacheCreationCost: string) => {
    await updateModelPricing(modelId, displayName, inputCost, outputCost, cacheReadCost, cacheCreationCost);
    setEditModal(null);
    onRefresh();
  }, [onRefresh]);

  const handleDelete = useCallback(async (modelId: string) => {
    await deleteModelPricing(modelId);
    setDeleteConfirm(null);
    onRefresh();
  }, [onRefresh]);

  const handleAddNew = useCallback(() => {
    setEditModal({
      isNew: true,
      model: { modelId: '', displayName: '', inputCostPerMillion: '0', outputCostPerMillion: '0', cacheReadCostPerMillion: '0', cacheCreationCostPerMillion: '0' },
    });
  }, []);

  return (
    <div className="usage-pricing">
      <div className="usage-pricing__header">
        <div>
          <h3 className="usage-pricing__title">{t('usage.modelPricing')}</h3>
          <p className="usage-pricing__desc">{t('usage.costPerMillion')}</p>
        </div>
        <button className="usage-btn usage-btn--sm" onClick={handleAddNew}>{`+ ${t('common.add')}`}</button>
      </div>
      {pricing.length === 0 ? (
        <div className="usage-pricing__empty">{t('usage.noPricingData')}</div>
      ) : (
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>{t('usage.modelId')}</th>
                <th>{t('common.name')}</th>
                <th className="usage-table__right">{t('usage.inputLabel')}</th>
                <th className="usage-table__right">{t('usage.outputLabel')}</th>
                <th className="usage-table__right">{t('usage.cacheRead')}</th>
                <th className="usage-table__right">{t('usage.cacheWrite')}</th>
                <th className="usage-table__right">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {pricing.map(p => (
                <tr key={p.modelId}>
                  <td className="usage-table__mono">{p.modelId}</td>
                  <td>{p.displayName}</td>
                  <td className="usage-table__right usage-table__mono">${p.inputCostPerMillion}</td>
                  <td className="usage-table__right usage-table__mono">${p.outputCostPerMillion}</td>
                  <td className="usage-table__right usage-table__mono">${p.cacheReadCostPerMillion}</td>
                  <td className="usage-table__right usage-table__mono">${p.cacheCreationCostPerMillion}</td>
                  <td className="usage-table__right">
                    <div className="usage-pricing__actions">
                      <button className="usage-btn usage-btn--ghost" onClick={() => setEditModal({ model: p, isNew: false })} title={t('common.edit')}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11.5 1.5l3 3L5 14H2v-3z" /></svg>
                      </button>
                      <button className="usage-btn usage-btn--ghost usage-btn--danger" onClick={() => setDeleteConfirm(p.modelId)} title={t('common.delete')}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 5h10M5.5 5V3.5a1 1 0 011-1h3a1 1 0 011 1V5M6.5 7.5v4M9.5 7.5v4" /><path d="M4 5l.7 8.4a1 1 0 001 .9h4.6a1 1 0 001-.9L12 5" /></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit / Add Modal */}
      {editModal && (
        <PricingEditModal
          model={editModal.model}
          isNew={editModal.isNew}
          onSave={handleSave}
          onClose={() => setEditModal(null)}
        />
      )}

      {/* Delete Confirm */}
      {deleteConfirm && (
        <div className="usage-modal-backdrop" onClick={() => setDeleteConfirm(null)}>
          <div className="usage-modal" onClick={e => e.stopPropagation()}>
            <h3 className="usage-modal__title">{t('usage.deletePricing')}</h3>
            <p className="usage-modal__text">{t('usage.deletePricingConfirm', { modelId: deleteConfirm })}</p>
            <div className="usage-modal__footer">
              <button className="usage-btn" onClick={() => setDeleteConfirm(null)}>{t('common.cancel')}</button>
              <button className="usage-btn usage-btn--danger" onClick={() => handleDelete(deleteConfirm)}>{t('common.delete')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

// ── Pricing Edit Modal ──

function PricingEditModal({ model, isNew, onSave, onClose }: {
  model: ModelPricing; isNew: boolean; onSave: (modelId: string, displayName: string, inputCost: string, outputCost: string, cacheReadCost: string, cacheCreationCost: string) => Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    modelId: model.modelId,
    displayName: model.displayName,
    inputCost: model.inputCostPerMillion,
    outputCost: model.outputCostPerMillion,
    cacheReadCost: model.cacheReadCostPerMillion,
    cacheCreationCost: model.cacheCreationCostPerMillion,
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(
        isNew ? form.modelId : model.modelId,
        form.displayName,
        form.inputCost,
        form.outputCost,
        form.cacheReadCost,
        form.cacheCreationCost,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="usage-modal-backdrop" onClick={onClose}>
      <div className="usage-modal usage-modal--wide" onClick={e => e.stopPropagation()}>
        <h3 className="usage-modal__title">{isNew ? t('usage.addPricing') : `${t('usage.editPricing')} - ${model.modelId}`}</h3>
        <form onSubmit={handleSubmit} className="usage-modal__form">
          {isNew && (
            <label className="usage-field">
              <span>{t('usage.modelId')}</span>
              <input value={form.modelId} onChange={e => setForm({ ...form, modelId: e.target.value })} required placeholder={t('usage.modelIdPlaceholder')} />
            </label>
          )}
          <label className="usage-field">
            <span>{t('usage.displayName')}</span>
            <input value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} required />
          </label>
          <div className="usage-field-row">
            <label className="usage-field">
              <span>{t('usage.inputPrice')}</span>
              <input type="number" step="0.01" min="0" value={form.inputCost} onChange={e => setForm({ ...form, inputCost: e.target.value })} required />
            </label>
            <label className="usage-field">
              <span>{t('usage.outputPrice')}</span>
              <input type="number" step="0.01" min="0" value={form.outputCost} onChange={e => setForm({ ...form, outputCost: e.target.value })} required />
            </label>
          </div>
          <div className="usage-field-row">
            <label className="usage-field">
              <span>{t('usage.cacheReadPrice')}</span>
              <input type="number" step="0.01" min="0" value={form.cacheReadCost} onChange={e => setForm({ ...form, cacheReadCost: e.target.value })} required />
            </label>
            <label className="usage-field">
              <span>{t('usage.cacheWritePrice')}</span>
              <input type="number" step="0.01" min="0" value={form.cacheCreationCost} onChange={e => setForm({ ...form, cacheCreationCost: e.target.value })} required />
            </label>
          </div>
          <div className="usage-modal__footer">
            <button type="button" className="usage-btn" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="usage-btn usage-btn--primary" disabled={saving}>
              {saving ? t('composer.saving') : isNew ? t('common.add') : t('common.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main Dashboard ──

type DataTab = 'logs' | 'providers' | 'models';

export function UsagePanel() {
  const { t } = useTranslation();
  const [timeRange, setTimeRange] = useState<TimeRange>('1d');
  const [refreshMs, setRefreshMs] = useState(30000);
  const [dataTab, setDataTab] = useState<DataTab>('logs');
  const [pricingOpen, setPricingOpen] = useState(false);

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [trends, setTrends] = useState<DailyStats[]>([]);
  const [providerStats, setProviderStats] = useState<ProviderStats[]>([]);
  const [modelStatsList, setModelStatsList] = useState<ModelStats[]>([]);
  const [logs, setLogs] = useState<PaginatedLogs>({ data: [], total: 0, page: 0, pageSize: 20 });
  const [pricing, setPricing] = useState<ModelPricing[]>([]);
  const [loading, setLoading] = useState(true);

  // Log filters
  const [logFilters, setLogFilters] = useState<LogFilters>({});
  const [logPage, setLogPage] = useState(0);

  const days = timeRange === '1d' ? 1 : timeRange === '7d' ? 7 : 30;

  const getTimeWindow = useCallback(() => {
    const endDate = Math.floor(Date.now() / 1000);
    const startDate = endDate - days * 24 * 60 * 60;
    return { startDate, endDate };
  }, [days]);

  const refresh = useCallback(async () => {
    try {
      const { startDate, endDate } = getTimeWindow();
      const [s, t] = await Promise.all([
        getUsageSummary(startDate, endDate),
        getUsageTrends(startDate, endDate),
      ]);
      setSummary(s);
      setTrends(t);
    } catch (e) {
      console.error('Usage refresh error:', e);
    } finally {
      setLoading(false);
    }
  }, [getTimeWindow]);

  const refreshTab = useCallback(async () => {
    try {
      if (dataTab === 'logs') {
        const rollingEnd = Math.floor(Date.now() / 1000);
        const rollingStart = rollingEnd - 24 * 60 * 60;
        const effectiveFilters = {
          ...logFilters,
          startDate: logFilters.startDate ?? rollingStart,
          endDate: logFilters.endDate ?? rollingEnd,
        };
        const result = await getRequestLogs(effectiveFilters, logPage, 20);
        setLogs(result);
      } else if (dataTab === 'providers') {
        const stats = await getProviderStats();
        setProviderStats(stats);
      } else if (dataTab === 'models') {
        const stats = await getModelStats();
        setModelStatsList(stats);
      }
    } catch (e) {
      console.error('Tab refresh error:', e);
    }
  }, [dataTab, logFilters, logPage]);

  const refreshPricing = useCallback(async () => {
    try {
      const list = await getModelPricingList();
      setPricing(list);
    } catch (e) {
      console.error('Pricing refresh error:', e);
    }
  }, []);

  // Initial load and auto-refresh
  useEffect(() => {
    setLoading(true);
    void refresh();
    void refreshTab();
  }, [refresh, refreshTab]);

  useEffect(() => {
    if (pricingOpen) void refreshPricing();
  }, [pricingOpen, refreshPricing]);

  useEffect(() => {
    if (refreshMs <= 0) return;
    const timer = setInterval(() => {
      void refresh();
      void refreshTab();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [refresh, refreshTab, refreshMs]);

  const refreshIntervalOptions = useMemo(() => [0, 5000, 10000, 30000, 60000] as const, []);

  const cycleRefresh = useCallback(() => {
    const idx = refreshIntervalOptions.indexOf(refreshMs as typeof refreshIntervalOptions[number]);
    const safeIdx = idx >= 0 ? idx : 3;
    const next = refreshIntervalOptions[(safeIdx + 1) % refreshIntervalOptions.length];
    setRefreshMs(next);
  }, [refreshMs, refreshIntervalOptions]);

  const handleLogPageChange = useCallback((p: number) => {
    setLogPage(p);
  }, []);

  return (
    <div className="usage-panel">
      <div className="usage-header" data-tauri-drag-region>
        <h2>{t('usage.title')}</h2>
      </div>

      <div className="usage-toolbar">
        <div className="usage-toolbar__left">
          <div className="usage-range-group">
            {(['1d', '7d', '30d'] as TimeRange[]).map(tr => (
              <button
                key={tr}
                className={`usage-range-btn${timeRange === tr ? ' usage-range-btn--active' : ''}`}
                onClick={() => { setTimeRange(tr); setLoading(true); }}
              >
                {tr === '1d' ? t('usage.period24h') : tr === '7d' ? t('usage.period7d') : t('usage.period30d')}
              </button>
            ))}
          </div>
        </div>
        <button className="usage-refresh-btn" onClick={cycleRefresh} title={t('usage.autoRefresh')}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 2v5h5" /><path d="M4 10a5.5 5.5 0 109-2" />
          </svg>
          <span>{refreshMs > 0 ? `${refreshMs / 1000}s` : t('usage.off')}</span>
        </button>
      </div>

      {/* Summary Cards */}
      <SummaryCards summary={summary} loading={loading} />

      {/* Trend Chart */}
      <TrendChart trends={trends} days={days} />

      {/* Data Tabs */}
      <div className="usage-data-section">
        <div className="usage-tabs-bar">
          <div className="usage-tabs">
            {([
              ['logs', t('usage.requestLogs')],
              ['providers', t('usage.providerStats')],
              ['models', t('usage.modelStats')],
            ] as [DataTab, string][]).map(([tab, label]) => (
              <button
                key={tab}
                className={`usage-tab${dataTab === tab ? ' usage-tab--active' : ''}`}
                onClick={() => setDataTab(tab)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Inline filter pills for logs tab */}
          {dataTab === 'logs' && (
            <div className="usage-filters">
              <select
                className="usage-filter-control"
                value={logFilters.appType ?? 'all'}
                onChange={e => { setLogFilters({ ...logFilters, appType: e.target.value === 'all' ? undefined : e.target.value }); setLogPage(0); }}
              >
                <option value="all">{t('usage.allApps')}</option>
                <option value="claude">{t('providers.claude')}</option>
                <option value="codex">{t('providers.codex')}</option>
              </select>
              <select
                className="usage-filter-control"
                value={logFilters.statusCode?.toString() ?? 'all'}
                onChange={e => { setLogFilters({ ...logFilters, statusCode: e.target.value === 'all' ? undefined : parseInt(e.target.value) }); setLogPage(0); }}
              >
                <option value="all">{t('usage.allStatus')}</option>
                <option value="200">200</option>
                <option value="400">400</option>
                <option value="429">429</option>
                <option value="500">500</option>
              </select>
              <input
                className="usage-filter-control"
                placeholder={t('usage.modelFilter')}
                value={logFilters.model ?? ''}
                onChange={e => { setLogFilters({ ...logFilters, model: e.target.value || undefined }); setLogPage(0); }}
              />
            </div>
          )}
        </div>

        {/* Tab Content */}
        {dataTab === 'logs' && (
          <LogsTable logs={logs.data} total={logs.total} page={logPage} pageSize={20} onPageChange={handleLogPageChange} />
        )}
        {dataTab === 'providers' && <ProviderStatsTable stats={providerStats} />}
        {dataTab === 'models' && <ModelStatsTable stats={modelStatsList} />}
      </div>

      {/* Pricing Config (Collapsible) */}
      <div className="usage-section">
        <button className="usage-collapsible" onClick={() => setPricingOpen(!pricingOpen)}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`usage-collapsible__chevron${pricingOpen ? ' usage-collapsible__chevron--open' : ''}`}>
            <path d="M3 1l4 4-4 4" />
          </svg>
          <span>{t('usage.pricingConfig')}</span>
        </button>
        {pricingOpen && <PricingPanel pricing={pricing} onRefresh={refreshPricing} />}
      </div>
    </div>
  );
}
