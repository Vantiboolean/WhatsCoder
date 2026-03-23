import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { KanbanIssue, KanbanStatus, KanbanPriority } from '../../lib/kanbanDb';
import { PRIORITY_I18N } from './kanban-helpers';

export const FilterBar = memo(function FilterBar({
  issues,
  searchQuery,
  onSearchChange,
  priorityFilter,
  onPriorityFilterChange,
  tagFilter,
  onTagFilterChange,
  allTags,
  totalCount,
  filteredCount,
  autoRun,
  onAutoRunChange,
  hasExecCallbacks,
  executionModelLabel,
}: {
  issues: KanbanIssue[];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  priorityFilter: KanbanPriority | 'all';
  onPriorityFilterChange: (value: KanbanPriority | 'all') => void;
  tagFilter: string;
  onTagFilterChange: (value: string) => void;
  allTags: string[];
  totalCount: number;
  filteredCount: number;
  autoRun: boolean;
  onAutoRunChange: (v: boolean) => void;
  hasExecCallbacks: boolean;
  executionModelLabel: string | null;
}) {
  const { t } = useTranslation();
  const isFiltering = searchQuery || priorityFilter !== 'all' || tagFilter;
  const stats = useMemo(() => {
    const byStatus: Record<KanbanStatus, number> = { todo: 0, in_progress: 0, in_review: 0, done: 0 };
    for (const issue of issues) byStatus[issue.status]++;
    const total = issues.length;
    const donePercent = total > 0 ? Math.round((byStatus.done / total) * 100) : 0;
    return { total, donePercent };
  }, [issues]);

  return (
    <div className="kanban-filter-bar">
      <div className="kanban-filter-controls">
        <div className="kanban-filter-search">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l3.5 3.5" />
          </svg>
          <input
            className="kanban-filter-search-input"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t('kanban.searchIssues')}
          />
          {searchQuery && (
            <button className="kanban-filter-clear" onClick={() => onSearchChange('')}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          )}
        </div>
        <select
          className="kanban-filter-select"
          value={priorityFilter}
          onChange={(e) => onPriorityFilterChange(e.target.value as KanbanPriority | 'all')}
        >
          <option value="all">{t('kanban.allPriorities')}</option>
          {Object.entries(PRIORITY_I18N).map(([key, i18nKey]) => (
            <option key={key} value={key}>{t(i18nKey)}</option>
          ))}
        </select>
        {allTags.length > 0 && (
          <select
            className="kanban-filter-select"
            value={tagFilter}
            onChange={(e) => onTagFilterChange(e.target.value)}
          >
            <option value="">{t('kanban.allTags')}</option>
            {allTags.map((tag) => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </select>
        )}
        {isFiltering && (
          <span className="kanban-filter-count">{filteredCount} / {totalCount}</span>
        )}
      </div>
      <div className="kanban-filter-actions">
        {stats.total > 0 && (
          <div className="kanban-stats-bar">
            <span className="kanban-stats-total">{t('kanban.issues', { count: stats.total })}</span>
            <span className="kanban-stats-done">{t('kanban.done', { percent: stats.donePercent })}</span>
          </div>
        )}
        {hasExecCallbacks && executionModelLabel && (
          <span className="kanban-filter-execution-model" title={executionModelLabel}>
            {t('kanban.executionModel', { model: executionModelLabel })}
          </span>
        )}
        {hasExecCallbacks && (
          <button
            className={`kanban-filter-toggle${autoRun ? ' kanban-filter-toggle--active' : ''}`}
            onClick={() => onAutoRunChange(!autoRun)}
            title={t('kanban.autoRunHint')}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" opacity={autoRun ? 1 : 0.4}>
              <path d="M4 2l10 6-10 6V2z" />
            </svg>
            {t('kanban.autoRun')}
          </button>
        )}
      </div>
    </div>
  );
});
