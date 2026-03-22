import { memo, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listKanbanIssues,
  listKanbanProjectIds,
  createKanbanIssue,
  createKanbanIssueRun,
  updateKanbanIssue,
  updateKanbanIssueExecution,
  updateKanbanIssueRun,
  deleteKanbanIssue,
  moveKanbanIssue,
  listKanbanComments,
  listKanbanIssueRuns,
  createKanbanComment,
  deleteKanbanComment,
  countKanbanComments,
  linkThreadToIssue,
  KANBAN_COLUMNS,
  PRIORITY_CONFIG,
  type KanbanIssue,
  type KanbanExecutionState,
  type KanbanRunTriggerSource,
  type KanbanStatus,
  type KanbanPriority,
  type KanbanComment,
  type KanbanIssueRun,
} from '../lib/kanbanDb';
import type { ThreadSummary, ThreadDetail, ThreadItem, Turn } from '@codex-mobile/shared';
import { ThreadView } from './ThreadView';

export type KanbanProject = {
  id: string;
  name: string;
};

export type KanbanExecCallbacks = {
  startThread: (params?: { cwd?: string }) => Promise<ThreadSummary>;
  startTurn: (threadId: string, text: string) => Promise<Turn>;
  readThread: (threadId: string) => Promise<ThreadDetail>;
  onRunStarted?: (params: { runId: string; issueId: string; threadId: string }) => void;
  onThreadCreated: () => void;
};

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function projectNameFromId(projectId: string): string {
  const trimmed = projectId.replace(/[\\/]+$/, '');
  if (!trimmed) return projectId;
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || projectId;
}

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDateTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString();
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function getLastTurn(detail: ThreadDetail | null): Turn | null {
  const turns = detail?.turns;
  return turns && turns.length > 0 ? turns[turns.length - 1] : null;
}

function turnStatusToExecutionState(turn: Turn | null): KanbanExecutionState | null {
  if (!turn) return null;
  switch (turn.status) {
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

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function compactExecutionSummary(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function threadItemTextForExecutionSummary(item: ThreadItem): string {
  if (typeof item.text === 'string' && item.text.trim()) {
    return compactExecutionSummary(item.text);
  }
  if (typeof item.summary === 'string' && item.summary.trim()) {
    return compactExecutionSummary(item.summary);
  }
  if (Array.isArray(item.summary) && item.summary.length > 0) {
    return compactExecutionSummary(item.summary.join(' '));
  }
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((entry) => typeof entry === 'string' ? entry : entry?.text ?? '')
      .join(' ')
      .trim();
    if (text) return compactExecutionSummary(text);
  }
  return '';
}

function extractExecutionResultSummary(detail: ThreadDetail): string | null {
  const turns = detail.turns ?? [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const items = turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex];
      if (item.type === 'agentMessage' && item.phase === 'final_answer') {
        const summary = threadItemTextForExecutionSummary(item);
        if (summary) return summary;
      }
    }
  }

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const items = turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex];
      if (item.type === 'agentMessage') {
        const summary = threadItemTextForExecutionSummary(item);
        if (summary) return summary;
      }
    }
  }

  return null;
}

function compactPromptText(text: string): string {
  return text.trim().replace(/\s*\n+\s*/g, ' ').trim();
}

function buildIssueExecutionPrompt(params: {
  issue: KanbanIssue;
  projectName: string;
  comments: KanbanComment[];
}): string {
  const tags = params.issue.tags
    ? params.issue.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
    : [];
  const recentComments = params.comments.slice(-5);

  const lines: string[] = [
    'You are executing a Kanban issue inside the selected project workspace.',
    'Use the issue context below as the task definition and use the working directory as the project root.',
    '',
    '## Issue Context',
    `- Project: ${params.projectName}`,
    `- Working directory: ${params.issue.project_id}`,
    params.issue.issue_number > 0 ? `- Issue number: #${params.issue.issue_number}` : '- Issue number: Not assigned',
    `- Title: ${params.issue.title}`,
    `- Column status: ${params.issue.status}`,
    `- Priority: ${params.issue.priority}`,
    `- Tags: ${tags.length > 0 ? tags.join(', ') : 'None'}`,
    `- Start date: ${params.issue.start_date ?? 'Not set'}`,
    `- Due date: ${params.issue.due_date ?? 'Not set'}`,
    `- Previous execution status: ${params.issue.last_run_status ?? 'Never run'}`,
    `- Previous execution error: ${params.issue.last_error ?? 'None'}`,
    '',
    '## Description',
    params.issue.description?.trim() || 'No description provided.',
  ];

  if (recentComments.length > 0) {
    lines.push('', '## Recent Comments');
    for (const comment of recentComments) {
      lines.push(`- [${formatDateTime(comment.created_at)}] ${compactPromptText(comment.content)}`);
    }
  }

  lines.push(
    '',
    '## Execution Guidance',
    '- Treat this issue as the task to complete.',
    '- Prefer the smallest safe implementation that resolves the issue.',
    '- If the issue is ambiguous, inspect the codebase and make the most grounded interpretation possible.',
    '- When you finish, include: what changed, any blockers or follow-ups, and the recommended next Kanban status.'
  );

  return lines.join('\n');
}

const PRIORITY_I18N: Record<KanbanPriority, string> = {
  urgent: 'kanban.priorityUrgent',
  high: 'kanban.priorityHigh',
  medium: 'kanban.priorityMedium',
  low: 'kanban.priorityLow',
  none: 'kanban.priorityNone',
};

const EXECUTION_STATE_I18N: Record<KanbanExecutionState, string> = {
  RUNNING: 'kanban.executionRunning',
  SUCCESS: 'kanban.executionSuccess',
  FAILED: 'kanban.executionFailed',
  CANCELLED: 'kanban.executionCancelled',
};

// ── Issue Card ──

function isDueOverdue(dueDate: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dueDate) < today;
}

function isDueSoon(dueDate: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  const diff = (due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= 3;
}

const IssueCard = memo(function IssueCard({
  issue,
  commentCount,
  onEdit,
  onDelete,
  onDragStart,
  onDragOverCard,
  isDragTarget,
  onExecute,
  onViewThread,
  isExecuting,
}: {
  issue: KanbanIssue;
  commentCount: number;
  onEdit: (issue: KanbanIssue) => void;
  onDelete: (id: string) => void;
  onDragStart: (e: React.DragEvent, issue: KanbanIssue) => void;
  onDragOverCard: (e: React.DragEvent, issueId: string) => void;
  isDragTarget: boolean;
  onExecute?: (issue: KanbanIssue) => void;
  onViewThread?: (issue: KanbanIssue) => void;
  isExecuting?: boolean;
}) {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const priority = PRIORITY_CONFIG[issue.priority];
  const tags = issue.tags ? issue.tags.split(',').filter(Boolean) : [];
  const overdue = issue.due_date && issue.status !== 'done' && isDueOverdue(issue.due_date);
  const dueSoon = issue.due_date && issue.status !== 'done' && !overdue && isDueSoon(issue.due_date);
  const executionStateLabel = issue.last_run_status ? t(EXECUTION_STATE_I18N[issue.last_run_status]) : null;

  return (
    <div
      className={`kanban-card${isDragTarget ? ' kanban-card--drag-target' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, issue)}
      onDragOver={(e) => onDragOverCard(e, issue.id)}
      onClick={() => onEdit(issue)}
    >
      <div className="kanban-card-header">
        <div className="kanban-card-title-row">
          {issue.issue_number > 0 && (
            <span className="kanban-card-number">#{issue.issue_number}</span>
          )}
          <span className="kanban-card-title">{issue.title}</span>
        </div>
        <button
          className="kanban-card-menu-btn"
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
            <circle cx="7" cy="3" r="1.2" />
            <circle cx="7" cy="7" r="1.2" />
            <circle cx="7" cy="11" r="1.2" />
          </svg>
        </button>
        {showMenu && (
          <>
            <div className="kanban-card-menu-backdrop" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
            <div className="kanban-card-menu">
              <button onClick={(e) => { e.stopPropagation(); onEdit(issue); setShowMenu(false); }}>{t('common.edit')}</button>
              <button className="kanban-card-menu-danger" onClick={(e) => { e.stopPropagation(); onDelete(issue.id); setShowMenu(false); }}>{t('common.delete')}</button>
            </div>
          </>
        )}
      </div>
      {issue.description && (
        <div className="kanban-card-desc">{issue.description.length > 120 ? `${issue.description.slice(0, 120)}...` : issue.description}</div>
      )}
      <div className="kanban-card-footer">
        <span className="kanban-card-priority" style={{ color: priority.color }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <rect x="1" y="6" width="2" height="3" rx="0.5" opacity={issue.priority === 'none' ? 0.3 : 1} />
            <rect x="4" y="4" width="2" height="5" rx="0.5" opacity={issue.priority === 'none' || issue.priority === 'low' ? 0.3 : 1} />
            <rect x="7" y="1" width="2" height="8" rx="0.5" opacity={issue.priority === 'urgent' || issue.priority === 'high' ? 1 : 0.3} />
          </svg>
          {t(PRIORITY_I18N[issue.priority])}
        </span>
        {executionStateLabel && (
          <span
            className={`kanban-card-run-state kanban-card-run-state--${issue.last_run_status?.toLowerCase()}`}
            title={issue.last_error ?? undefined}
          >
            {executionStateLabel}
          </span>
        )}
        {issue.due_date && (
          <span className={`kanban-card-due${overdue ? ' kanban-card-due--overdue' : ''}${dueSoon ? ' kanban-card-due--soon' : ''}`}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 5v3l2 2" />
            </svg>
            {new Date(issue.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
        {tags.length > 0 && (
          <div className="kanban-card-tags">
            {tags.slice(0, 3).map((tag) => (
              <span key={tag} className="kanban-card-tag">{tag}</span>
            ))}
            {tags.length > 3 && <span className="kanban-card-tag">+{tags.length - 3}</span>}
          </div>
        )}
        {commentCount > 0 && (
          <span className="kanban-card-comments">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4a2 2 0 012-2h8a2 2 0 012 2v5a2 2 0 01-2 2H6l-3 3V4z" />
            </svg>
            {commentCount}
          </span>
        )}
        {issue.linked_thread_id ? (
          <>
            <button
              className="kanban-card-exec-btn kanban-card-exec-btn--linked"
              title={t('kanban.viewExecution')}
              onClick={(e) => { e.stopPropagation(); onViewThread?.(issue); }}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h12v10H2z" /><path d="M5 8h6M5 6h4" />
              </svg>
            </button>
            {onExecute && (
              <button
                className="kanban-card-exec-btn"
                title={t('kanban.rerun')}
                disabled={isExecuting}
                onClick={(e) => { e.stopPropagation(); onExecute(issue); }}
              >
                {isExecuting ? (
                  <span className="kanban-card-exec-spinner" />
                ) : (
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 2l10 6-10 6V2z" />
                  </svg>
                )}
              </button>
            )}
          </>
        ) : onExecute && (
          <button
            className="kanban-card-exec-btn"
            title={t('kanban.execute')}
            disabled={isExecuting}
            onClick={(e) => { e.stopPropagation(); onExecute(issue); }}
          >
            {isExecuting ? (
              <span className="kanban-card-exec-spinner" />
            ) : (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 2l10 6-10 6V2z" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
});

// ── Quick Add Input ──

const QuickAddInput = memo(function QuickAddInput({
  status,
  onAdd,
}: {
  status: KanbanStatus;
  onAdd: (title: string, status: KanbanStatus) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    if (!value.trim()) return;
    onAdd(value.trim(), status);
    setValue('');
    inputRef.current?.focus();
  };

  if (!active) {
    return (
      <button className="kanban-quick-add-trigger" onClick={() => { setActive(true); setTimeout(() => inputRef.current?.focus(), 0); }}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <line x1="6" y1="2" x2="6" y2="10" />
          <line x1="2" y1="6" x2="10" y2="6" />
        </svg>
        {t('kanban.addIssue')}
      </button>
    );
  }

  return (
    <div className="kanban-quick-add">
      <input
        ref={inputRef}
        className="kanban-quick-add-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') { setValue(''); setActive(false); }
        }}
        onBlur={() => { if (!value.trim()) setActive(false); }}
        placeholder={t('kanban.quickAddPlaceholder')}
      />
    </div>
  );
});

// ── Column ──

const KanbanColumn = memo(function KanbanColumn({
  status,
  label,
  issues,
  commentCounts,
  collapsed,
  onToggleCollapse,
  onAddIssue,
  onQuickAdd,
  onEditIssue,
  onDeleteIssue,
  onDragStart,
  onDragOver,
  onDragOverCard,
  onDrop,
  dragOverColumn,
  dragOverCardId,
  onExecuteIssue,
  onViewThread,
  executingIssueIds,
}: {
  status: KanbanStatus;
  label: string;
  issues: KanbanIssue[];
  commentCounts: Record<string, number>;
  collapsed: boolean;
  onToggleCollapse: (status: KanbanStatus) => void;
  onAddIssue: (status: KanbanStatus) => void;
  onQuickAdd: (title: string, status: KanbanStatus) => void;
  onEditIssue: (issue: KanbanIssue) => void;
  onDeleteIssue: (id: string) => void;
  onDragStart: (e: React.DragEvent, issue: KanbanIssue) => void;
  onDragOver: (e: React.DragEvent, status: KanbanStatus) => void;
  onDragOverCard: (e: React.DragEvent, issueId: string) => void;
  onDrop: (e: React.DragEvent, status: KanbanStatus) => void;
  dragOverColumn: KanbanStatus | null;
  dragOverCardId: string | null;
  onExecuteIssue?: (issue: KanbanIssue) => void;
  onViewThread?: (issue: KanbanIssue) => void;
  executingIssueIds?: Set<string>;
}) {
  const { t } = useTranslation();
  const statusColors: Record<KanbanStatus, string> = {
    todo: 'var(--accent-blue)',
    in_progress: 'var(--accent-yellow, #eab308)',
    in_review: 'var(--accent-purple, #a855f7)',
    done: 'var(--accent-green)',
  };

  if (collapsed) {
    return (
      <div
        className={`kanban-column kanban-column--collapsed${dragOverColumn === status ? ' kanban-column--drag-over' : ''}`}
        onClick={() => onToggleCollapse(status)}
        onDragOver={(e) => onDragOver(e, status)}
        onDrop={(e) => onDrop(e, status)}
      >
        <div className="kanban-column-collapsed-label">
          <span className="kanban-column-dot" style={{ background: statusColors[status] }} />
          <span>{label}</span>
          <span className="kanban-column-count">{issues.length}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`kanban-column${dragOverColumn === status ? ' kanban-column--drag-over' : ''}`}
      onDragOver={(e) => onDragOver(e, status)}
      onDrop={(e) => onDrop(e, status)}
    >
      <div className="kanban-column-header">
        <div className="kanban-column-title">
          <button className="kanban-column-collapse-btn" onClick={() => onToggleCollapse(status)} title={t('kanban.collapseColumn')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 3.5l3 3 3-3" />
            </svg>
          </button>
          <span className="kanban-column-dot" style={{ background: statusColors[status] }} />
          <span>{label}</span>
          <span className="kanban-column-count">{issues.length}</span>
        </div>
        <button className="kanban-column-add-btn" onClick={() => onAddIssue(status)} title={t('kanban.addIssueTo', { column: label })}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="7" y1="3" x2="7" y2="11" />
            <line x1="3" y1="7" x2="11" y2="7" />
          </svg>
        </button>
      </div>
      <div className="kanban-column-cards">
        {issues.map((issue) => (
          <IssueCard
            key={issue.id}
            issue={issue}
            commentCount={commentCounts[issue.id] ?? 0}
            onEdit={onEditIssue}
            onDelete={onDeleteIssue}
            onDragStart={onDragStart}
            onDragOverCard={onDragOverCard}
            isDragTarget={dragOverCardId === issue.id}
            onExecute={onExecuteIssue}
            onViewThread={onViewThread}
            isExecuting={executingIssueIds?.has(issue.id) || issue.last_run_status === 'RUNNING'}
          />
        ))}
        {issues.length === 0 && (
          <div className="kanban-column-empty">
            {t('kanban.noIssues')}
          </div>
        )}
      </div>
      <div className="kanban-column-footer">
        <QuickAddInput status={status} onAdd={onQuickAdd} />
      </div>
    </div>
  );
});

// ── Filter Bar ──

const FilterBar = memo(function FilterBar({
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

// ── Issue Dialog ──

function IssueDialog({
  issue,
  initialStatus,
  onSave,
  onCommentsChanged,
  onOpenExecution,
  onRerun,
  canExecute,
  onClose,
}: {
  issue: KanbanIssue | null;
  initialStatus?: KanbanStatus;
  onSave: (data: { title: string; description: string; priority: KanbanPriority; tags: string; status: KanbanStatus; startDate: string; dueDate: string }) => void;
  onCommentsChanged?: (issueId: string, count: number) => void;
  onOpenExecution?: (issue: KanbanIssue) => void;
  onRerun?: (issue: KanbanIssue) => void;
  canExecute?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(issue?.title ?? '');
  const [description, setDescription] = useState(issue?.description ?? '');
  const [priority, setPriority] = useState<KanbanPriority>(issue?.priority ?? 'medium');
  const [tags, setTags] = useState(issue?.tags ?? '');
  const [status, setStatus] = useState<KanbanStatus>(issue?.status ?? initialStatus ?? 'todo');
  const [startDate, setStartDate] = useState(issue?.start_date ?? '');
  const [dueDate, setDueDate] = useState(issue?.due_date ?? '');
  const [comments, setComments] = useState<KanbanComment[]>([]);
  const [runs, setRuns] = useState<KanbanIssueRun[]>([]);
  const [newComment, setNewComment] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (issue) {
      void listKanbanComments(issue.id).then(setComments);
      void listKanbanIssueRuns(issue.id, 8).then(setRuns);
    } else {
      setComments([]);
      setRuns([]);
    }
  }, [issue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({ title: title.trim(), description: description.trim(), priority, tags: tags.trim(), status, startDate, dueDate });
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || !issue) return;
    await createKanbanComment({ id: genId(), issueId: issue.id, content: newComment.trim() });
    setNewComment('');
    const updated = await listKanbanComments(issue.id);
    setComments(updated);
    onCommentsChanged?.(issue.id, updated.length);
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!issue) return;
    await deleteKanbanComment(commentId);
    const updated = await listKanbanComments(issue.id);
    setComments(updated);
    onCommentsChanged?.(issue.id, updated.length);
  };

  return (
    <div className="kanban-dialog-backdrop" onClick={onClose}>
      <form className="kanban-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="kanban-dialog-header">
          <h3>
            {issue ? (
              <>
                {issue.issue_number > 0 && <span className="kanban-dialog-issue-num">#{issue.issue_number}</span>}
                {t('kanban.editIssue')}
              </>
            ) : t('kanban.newIssue')}
          </h3>
          <button type="button" className="kanban-dialog-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>

        <div className="kanban-dialog-body">
          <label className="kanban-dialog-label">
            {t('kanban.issueTitle')}
            <input
              ref={titleRef}
              className="kanban-dialog-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('kanban.issueTitlePlaceholder')}
              required
            />
          </label>

          <label className="kanban-dialog-label">
            {t('kanban.description')}
            <textarea
              className="kanban-dialog-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('kanban.descriptionPlaceholder')}
              rows={4}
            />
          </label>

          <div className="kanban-dialog-row">
            <label className="kanban-dialog-label kanban-dialog-label--half">
              {t('kanban.status')}
              <select className="kanban-dialog-select" value={status} onChange={(e) => setStatus(e.target.value as KanbanStatus)}>
                {KANBAN_COLUMNS.map((col) => (
                  <option key={col.key} value={col.key}>{t(col.i18nKey)}</option>
                ))}
              </select>
            </label>

            <label className="kanban-dialog-label kanban-dialog-label--half">
              {t('kanban.priority')}
              <select className="kanban-dialog-select" value={priority} onChange={(e) => setPriority(e.target.value as KanbanPriority)}>
                {Object.entries(PRIORITY_I18N).map(([key, i18nKey]) => (
                  <option key={key} value={key}>{t(i18nKey)}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="kanban-dialog-row">
            <label className="kanban-dialog-label kanban-dialog-label--half">
              {t('kanban.startDate')}
              <input
                type="date"
                className="kanban-dialog-input"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>
            <label className="kanban-dialog-label kanban-dialog-label--half">
              {t('kanban.dueDate')}
              <input
                type="date"
                className="kanban-dialog-input"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </label>
          </div>

          <label className="kanban-dialog-label">
            {t('kanban.tags')}
            <input
              className="kanban-dialog-input"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('kanban.tagsPlaceholder')}
            />
          </label>

          {issue?.last_run_status && (
            <div className="kanban-dialog-execution">
              <div className="kanban-dialog-comments-header">{t('kanban.execution')}</div>
              <div className="kanban-dialog-execution-meta">
                <span className={`kanban-card-run-state kanban-card-run-state--${issue.last_run_status.toLowerCase()}`}>
                  {t(EXECUTION_STATE_I18N[issue.last_run_status])}
                </span>
                {issue.last_run_at && (
                  <span className="kanban-dialog-execution-time">
                    {t('kanban.lastRunAt', { date: formatDateTime(issue.last_run_at) })}
                  </span>
                )}
                {issue.last_finished_at && (
                  <span className="kanban-dialog-execution-time">
                    {t('kanban.lastFinishedAt', { date: formatDateTime(issue.last_finished_at) })}
                  </span>
                )}
              </div>
              {issue.last_error && (
                <div className="kanban-dialog-execution-error">{issue.last_error}</div>
              )}
              {issue.last_result_summary && (
                <div className="kanban-dialog-execution-summary">
                  <div className="kanban-dialog-execution-summary-label">{t('kanban.lastResultSummary')}</div>
                  <div className="kanban-dialog-execution-summary-text">{issue.last_result_summary}</div>
                </div>
              )}
              <div className="kanban-dialog-run-history">
                <div className="kanban-dialog-execution-summary-label">{t('kanban.runHistory')}</div>
                {runs.length > 0 ? (
                  <div className="kanban-dialog-run-list">
                    {runs.map((run) => (
                      <div key={run.id} className="kanban-dialog-run-item">
                        <div className="kanban-dialog-run-item-top">
                          <span className={`kanban-card-run-state kanban-card-run-state--${run.status.toLowerCase()}`}>
                            {t(EXECUTION_STATE_I18N[run.status])}
                          </span>
                          <span className="kanban-dialog-execution-time">{formatDateTime(run.started_at)}</span>
                        </div>
                        {(run.result_summary || run.error_message) && (
                          <div className="kanban-dialog-run-item-text">
                            {run.result_summary ?? run.error_message}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="kanban-dialog-run-empty">{t('kanban.noRunHistory')}</div>
                )}
              </div>
            </div>
          )}

          {issue && (
            <div className="kanban-dialog-comments">
              <div className="kanban-dialog-comments-header">
                {t('kanban.comments')} ({comments.length})
              </div>
              {comments.length > 0 && (
                <div className="kanban-dialog-comments-list">
                  {comments.map((c) => (
                    <div key={c.id} className="kanban-dialog-comment">
                      <div className="kanban-dialog-comment-content">{c.content}</div>
                      <div className="kanban-dialog-comment-meta">
                        <span>{formatDate(c.created_at)}</span>
                        <button type="button" className="kanban-dialog-comment-delete" onClick={() => { void handleDeleteComment(c.id); }}>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <line x1="3" y1="3" x2="9" y2="9" /><line x1="9" y1="3" x2="3" y2="9" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="kanban-dialog-comment-add">
                <input
                  ref={commentInputRef}
                  className="kanban-dialog-input"
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder={t('kanban.addComment')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void handleAddComment(); }
                  }}
                />
                <button
                  type="button"
                  className="kanban-dialog-btn kanban-dialog-btn--secondary kanban-dialog-comment-send"
                  onClick={() => { void handleAddComment(); }}
                  disabled={!newComment.trim()}
                >
                  {t('kanban.send')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="kanban-dialog-footer">
          {issue && (
            <span className="kanban-dialog-meta">
              {t('kanban.created', { date: formatDate(issue.created_at) })}
              {issue.updated_at !== issue.created_at && ` · ${t('kanban.updated', { date: formatDate(issue.updated_at) })}`}
            </span>
          )}
          <div className="kanban-dialog-actions">
            {issue?.linked_thread_id && onOpenExecution && (
              <button
                type="button"
                className="kanban-dialog-btn kanban-dialog-btn--secondary"
                onClick={() => { onOpenExecution(issue); onClose(); }}
              >
                {t('kanban.viewExecution')}
              </button>
            )}
            {issue && canExecute && onRerun && (
              <button
                type="button"
                className="kanban-dialog-btn kanban-dialog-btn--secondary"
                onClick={() => { onRerun(issue); onClose(); }}
                disabled={issue.last_run_status === 'RUNNING'}
              >
                {t('kanban.rerun')}
              </button>
            )}
            <button type="button" className="kanban-dialog-btn kanban-dialog-btn--secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button type="submit" className="kanban-dialog-btn kanban-dialog-btn--primary" disabled={!title.trim()}>
              {issue ? t('kanban.saveChanges') : t('kanban.createIssue')}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ── Main Panel ──

export const KanbanPanel = memo(function KanbanPanel({
  projects,
  executionSyncVersion,
  execCallbacks,
}: {
  projects: KanbanProject[];
  executionSyncVersion?: number;
  execCallbacks?: KanbanExecCallbacks;
}) {
  const { t } = useTranslation();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectOptions, setProjectOptions] = useState<KanbanProject[]>(projects);
  const [issues, setIssues] = useState<KanbanIssue[]>([]);
  const [loading, setLoading] = useState(true);

  const [editingIssue, setEditingIssue] = useState<KanbanIssue | null>(null);
  const [creatingForStatus, setCreatingForStatus] = useState<KanbanStatus | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<KanbanPriority | 'all'>('all');
  const [tagFilter, setTagFilter] = useState('');

  const [collapsedColumns, setCollapsedColumns] = useState<Set<KanbanStatus>>(new Set());
  const [draggedIssue, setDraggedIssue] = useState<KanbanIssue | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<KanbanStatus | null>(null);
  const [dragOverCardId, setDragOverCardId] = useState<string | null>(null);
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  const [dbError, setDbError] = useState<string | null>(null);

  const [autoRun, setAutoRun] = useState(false);
  const [viewingThreadIssue, setViewingThreadIssue] = useState<KanbanIssue | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [executingIssueIds, setExecutingIssueIds] = useState<Set<string>>(new Set());
  const threadPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedProject = projectOptions.find((p) => p.id === selectedProjectId) ?? null;

  const refreshProjectOptions = useCallback(async () => {
    try {
      const dbProjectIds = await listKanbanProjectIds();
      const merged = new Map<string, KanbanProject>();
      for (const project of projects) {
        merged.set(project.id, project);
      }
      for (const projectId of dbProjectIds) {
        if (!merged.has(projectId)) {
          merged.set(projectId, { id: projectId, name: projectNameFromId(projectId) });
        }
      }
      setProjectOptions(Array.from(merged.values()));
    } catch {
      setProjectOptions(projects);
    }
  }, [projects]);

  useEffect(() => {
    void refreshProjectOptions();
  }, [refreshProjectOptions]);

  useEffect(() => {
    if (projectOptions.length > 0 && (!selectedProjectId || !projectOptions.find((p) => p.id === selectedProjectId))) {
      setSelectedProjectId(projectOptions[0].id);
    }
  }, [projectOptions, selectedProjectId]);

  const refreshIssues = useCallback(async (projectId: string) => {
    try {
      const list = await listKanbanIssues(projectId);
      setIssues(list);
      setDbError(null);
      if (list.length > 0) {
        const counts = await countKanbanComments(list.map((i) => i.id));
        setCommentCounts(counts);
      } else {
        setCommentCounts({});
      }
    } catch (err) {
      console.error('refreshIssues failed:', err);
      setDbError(String(err));
    } finally {
      void refreshProjectOptions();
    }
  }, [refreshProjectOptions]);

  useEffect(() => {
    if (!selectedProjectId) {
      setIssues([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void refreshIssues(selectedProjectId).finally(() => setLoading(false));
  }, [selectedProjectId, refreshIssues]);

  useEffect(() => {
    if (!selectedProjectId || executionSyncVersion === undefined) return;
    void refreshIssues(selectedProjectId);
  }, [executionSyncVersion, refreshIssues, selectedProjectId]);

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const issue of issues) {
      if (issue.tags) {
        for (const tag of issue.tags.split(',')) {
          const tVal = tag.trim();
          if (tVal) tagSet.add(tVal);
        }
      }
    }
    return Array.from(tagSet).sort();
  }, [issues]);

  const filteredIssues = useMemo(() => {
    let result = issues;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((i) =>
        i.title.toLowerCase().includes(q) ||
        (i.description && i.description.toLowerCase().includes(q)) ||
        (i.tags && i.tags.toLowerCase().includes(q))
      );
    }
    if (priorityFilter !== 'all') {
      result = result.filter((i) => i.priority === priorityFilter);
    }
    if (tagFilter) {
      result = result.filter((i) => i.tags && i.tags.split(',').map((tg) => tg.trim()).includes(tagFilter));
    }
    return result;
  }, [issues, searchQuery, priorityFilter, tagFilter]);

  const handleSelectProject = useCallback((id: string) => {
    setSelectedProjectId(id);
    setSearchQuery('');
    setPriorityFilter('all');
    setTagFilter('');
  }, []);

  const handleAddIssue = useCallback((status: KanbanStatus) => {
    setCreatingForStatus(status);
    setEditingIssue(null);
  }, []);

  const syncExecutionStateFromThread = useCallback(async (params: {
    runId: string;
    issueId: string;
    projectId: string;
    detail: ThreadDetail;
  }): Promise<boolean> => {
    const lastTurn = getLastTurn(params.detail);
    const nextState = turnStatusToExecutionState(lastTurn);
    if (!nextState || nextState === 'RUNNING') return false;

    const finishedAt = nowUnixSeconds();
    const lastError = nextState === 'FAILED' || nextState === 'CANCELLED'
      ? lastTurn?.error?.message ?? null
      : null;
    const resultSummary = nextState === 'SUCCESS'
      ? extractExecutionResultSummary(params.detail)
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

    if (selectedProjectId === params.projectId) {
      await refreshIssues(params.projectId);
    }

    return true;
  }, [refreshIssues, selectedProjectId]);

  const startThreadPolling = useCallback((threadId: string) => {
    if (threadPollRef.current) clearInterval(threadPollRef.current);
    threadPollRef.current = setInterval(async () => {
      if (!execCallbacks) return;
      try {
        const detail = await execCallbacks.readThread(threadId);
        setThreadDetail(detail);
        const lastTurn = getLastTurn(detail);
        if (lastTurn && lastTurn.status !== 'inProgress') {
          if (threadPollRef.current) clearInterval(threadPollRef.current);
          threadPollRef.current = null;
        }
      } catch { /* ignore */ }
    }, 3000);
  }, [execCallbacks]);

  const handleExecuteIssue = useCallback(async (
    issue: KanbanIssue,
    triggerSource: KanbanRunTriggerSource = 'manual',
  ) => {
    if (!execCallbacks) return;
    const projectId = issue.project_id || selectedProjectId;
    if (!projectId) return;
    const runId = genId();
    const startedAt = nowUnixSeconds();
    let thread: ThreadSummary | null = null;
    setExecutingIssueIds((prev) => {
      const next = new Set(prev);
      next.add(issue.id);
      return next;
    });
    try {
      await createKanbanIssueRun({
        id: runId,
        issueId: issue.id,
        triggerSource,
        status: 'RUNNING',
        startedAt,
      });
      await updateKanbanIssueExecution(issue.id, {
        lastRunStatus: 'RUNNING',
        lastRunAt: startedAt,
        lastFinishedAt: null,
        lastError: null,
      });
      await refreshIssues(projectId);

      const projectName = projectOptions.find((project) => project.id === issue.project_id)?.name
        ?? selectedProject?.name
        ?? projectNameFromId(issue.project_id);
      const comments = await listKanbanComments(issue.id);
      const prompt = buildIssueExecutionPrompt({
        issue,
        projectName,
        comments,
      });
      thread = await execCallbacks.startThread({ cwd: projectId });
      await execCallbacks.startTurn(thread.id, prompt);
      await updateKanbanIssueRun(runId, { threadId: thread.id });
      await linkThreadToIssue(issue.id, thread.id);
      execCallbacks.onRunStarted?.({ runId, issueId: issue.id, threadId: thread.id });
      execCallbacks.onThreadCreated();
      const newStatus: KanbanStatus = issue.status === 'todo' ? 'in_progress' : issue.status;
      if (newStatus !== issue.status) {
        await updateKanbanIssue(issue.id, { status: newStatus });
      }
      await refreshIssues(projectId);

      const linkedIssue: KanbanIssue = {
        ...issue,
        linked_thread_id: thread.id,
        status: newStatus,
        last_run_status: 'RUNNING',
        last_run_at: startedAt,
        last_finished_at: null,
        last_error: null,
      };
      setViewingThreadIssue(linkedIssue);
      setThreadLoading(true);

      let initialDetail: ThreadDetail | null = null;
      try {
        initialDetail = await execCallbacks.readThread(thread.id);
        setThreadDetail(initialDetail);
      } catch {
        setThreadDetail(null);
      } finally {
        setThreadLoading(false);
      }

      if (initialDetail) {
        const settled = await syncExecutionStateFromThread({
          runId,
          issueId: issue.id,
          projectId,
          detail: initialDetail,
        });
        if (!settled) {
          startThreadPolling(thread.id);
        }
      } else {
        startThreadPolling(thread.id);
      }
    } catch (err) {
      const errorMessage = formatErrorMessage(err);
      const finishedAt = nowUnixSeconds();
      try {
        await updateKanbanIssueRun(runId, {
          status: 'FAILED',
          threadId: thread?.id ?? null,
          finishedAt,
          errorMessage,
        });
      } catch {
        // Ignore secondary persistence failures and surface the original execution error.
      }
      try {
        await updateKanbanIssueExecution(issue.id, {
          lastRunStatus: 'FAILED',
          lastFinishedAt: finishedAt,
          lastError: errorMessage,
        });
      } catch {
        // Ignore secondary persistence failures and surface the original execution error.
      }
      await refreshIssues(projectId).catch(() => {});
      console.error('Failed to execute issue:', err);
    } finally {
      setExecutingIssueIds((prev) => {
        if (!prev.has(issue.id)) return prev;
        const next = new Set(prev);
        next.delete(issue.id);
        return next;
      });
    }
  }, [
    execCallbacks,
    projectOptions,
    refreshIssues,
    selectedProject,
    selectedProjectId,
    startThreadPolling,
    syncExecutionStateFromThread,
  ]);

  const handleQuickAdd = useCallback(async (title: string, status: KanbanStatus) => {
    if (!selectedProjectId) return;
    try {
      const issueId = genId();
      await createKanbanIssue({ id: issueId, projectId: selectedProjectId, title, status });
      await refreshIssues(selectedProjectId);
      if (autoRun && status === 'in_progress' && execCallbacks) {
        const newIssues = await listKanbanIssues(selectedProjectId);
        const created = newIssues.find((i) => i.id === issueId);
        if (created) void handleExecuteIssue(created, 'quick_add_auto');
      }
    } catch (err) {
      console.error('handleQuickAdd failed:', err);
      setDbError(String(err));
    }
  }, [selectedProjectId, refreshIssues, autoRun, execCallbacks, handleExecuteIssue]);

  const handleSaveIssue = useCallback(async (data: { title: string; description: string; priority: KanbanPriority; tags: string; status: KanbanStatus; startDate: string; dueDate: string }) => {
    if (!selectedProjectId) return;
    try {
      if (editingIssue) {
        await updateKanbanIssue(editingIssue.id, {
          title: data.title,
          description: data.description || null,
          priority: data.priority,
          tags: data.tags ? data.tags.split(',').map((tg) => tg.trim()).filter(Boolean) : null,
          status: data.status,
          startDate: data.startDate || null,
          dueDate: data.dueDate || null,
        });
      } else {
        await createKanbanIssue({
          id: genId(),
          projectId: selectedProjectId,
          title: data.title,
          description: data.description || undefined,
          status: data.status,
          priority: data.priority,
          tags: data.tags ? data.tags.split(',').map((tg) => tg.trim()).filter(Boolean) : undefined,
          startDate: data.startDate || undefined,
          dueDate: data.dueDate || undefined,
        });
      }
      await refreshIssues(selectedProjectId);
      setEditingIssue(null);
      setCreatingForStatus(null);
    } catch (err) {
      console.error('handleSaveIssue failed:', err);
      setDbError(String(err));
    }
  }, [selectedProjectId, editingIssue, refreshIssues]);

  const handleDeleteIssue = useCallback(async (id: string) => {
    if (!selectedProjectId) return;
    await deleteKanbanIssue(id);
    await refreshIssues(selectedProjectId);
  }, [selectedProjectId, refreshIssues]);

  const handleToggleCollapse = useCallback((status: KanbanStatus) => {
    setCollapsedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const handleDragStart = useCallback((_e: React.DragEvent, issue: KanbanIssue) => {
    setDraggedIssue(issue);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, status: KanbanStatus) => {
    e.preventDefault();
    setDragOverColumn(status);
  }, []);

  const handleDragOverCard = useCallback((e: React.DragEvent, cardId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverCardId(cardId);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, targetStatus: KanbanStatus) => {
    e.preventDefault();
    const targetCardId = dragOverCardId;
    setDragOverColumn(null);
    setDragOverCardId(null);
    if (!draggedIssue || !selectedProjectId) return;
    if (draggedIssue.id === targetCardId) { setDraggedIssue(null); return; }

    const targetIssues = issues.filter((i) => i.status === targetStatus);

    let newOrder: number;
    if (targetCardId) {
      const targetIdx = targetIssues.findIndex((i) => i.id === targetCardId);
      if (targetIdx >= 0) {
        const targetCard = targetIssues[targetIdx];
        const prevCard = targetIdx > 0 ? targetIssues[targetIdx - 1] : null;
        if (prevCard && prevCard.id !== draggedIssue.id) {
          newOrder = (prevCard.sort_order + targetCard.sort_order) / 2;
        } else if (targetIdx === 0) {
          newOrder = targetCard.sort_order - 1;
        } else {
          newOrder = targetCard.sort_order - 0.5;
        }
      } else {
        newOrder = targetIssues.length > 0 ? Math.max(...targetIssues.map((i) => i.sort_order)) + 1 : 0;
      }
    } else {
      newOrder = targetIssues.length > 0 ? Math.max(...targetIssues.map((i) => i.sort_order)) + 1 : 0;
    }

    await moveKanbanIssue(draggedIssue.id, targetStatus, newOrder);
    await refreshIssues(selectedProjectId);
    if (autoRun && targetStatus === 'in_progress' && !draggedIssue.linked_thread_id && execCallbacks) {
      const updatedIssue = { ...draggedIssue, status: targetStatus as KanbanStatus, sort_order: newOrder };
      void handleExecuteIssue(updatedIssue, 'move_auto');
    }
    setDraggedIssue(null);
  }, [draggedIssue, dragOverCardId, selectedProjectId, issues, refreshIssues, autoRun, execCallbacks, handleExecuteIssue]);

  const issuesByStatus = useMemo(() =>
    KANBAN_COLUMNS.reduce<Record<KanbanStatus, KanbanIssue[]>>((acc, col) => {
      acc[col.key] = filteredIssues.filter((i) => i.status === col.key);
      return acc;
    }, {} as Record<KanbanStatus, KanbanIssue[]>),
  [filteredIssues]);

  useEffect(() => {
    if (!editingIssue) return;
    const freshIssue = issues.find((issue) => issue.id === editingIssue.id);
    if (freshIssue && freshIssue !== editingIssue) {
      setEditingIssue(freshIssue);
    }
  }, [editingIssue, issues]);

  const handleCloseThreadPanel = useCallback(() => {
    setViewingThreadIssue(null);
    setThreadDetail(null);
    if (threadPollRef.current) {
      clearInterval(threadPollRef.current);
      threadPollRef.current = null;
    }
  }, []);

  const handleViewThread = useCallback(async (issue: KanbanIssue) => {
    if (!execCallbacks || !issue.linked_thread_id) return;
    setViewingThreadIssue(issue);
    setThreadLoading(true);
    try {
      const detail = await execCallbacks.readThread(issue.linked_thread_id);
      setThreadDetail(detail);
      startThreadPolling(issue.linked_thread_id);
    } catch {
      setThreadDetail(null);
    } finally {
      setThreadLoading(false);
    }
  }, [execCallbacks, startThreadPolling]);

  useEffect(() => {
    return () => {
      if (threadPollRef.current) clearInterval(threadPollRef.current);
    };
  }, []);

  if (projectOptions.length === 0) {
    return (
      <div className="kanban-panel">
        <div className="kanban-empty-state">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
            <rect x="4" y="8" width="12" height="32" rx="2" />
            <rect x="18" y="8" width="12" height="22" rx="2" />
            <rect x="32" y="8" width="12" height="28" rx="2" />
          </svg>
          <p>{t('kanban.noProjects')}</p>
          <span className="kanban-empty-hint">{t('kanban.noProjectsHint')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`kanban-panel${viewingThreadIssue ? ' kanban-panel--with-thread' : ''}`}>
      <div className="kanban-panel-main">
        <div className="kanban-header" data-tauri-drag-region>
          <div className="kanban-header-left">
            <h2 className="kanban-header-title">{t('kanban.title')}</h2>
            <span className="kanban-header-sep">/</span>
            <select
              className="kanban-project-select"
              value={selectedProjectId ?? ''}
              onChange={(e) => handleSelectProject(e.target.value)}
            >
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>

        {selectedProject && (
          <>
            <FilterBar
              issues={issues}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              priorityFilter={priorityFilter}
              onPriorityFilterChange={setPriorityFilter}
              tagFilter={tagFilter}
              onTagFilterChange={setTagFilter}
              allTags={allTags}
              totalCount={issues.length}
              filteredCount={filteredIssues.length}
              autoRun={autoRun}
              onAutoRunChange={setAutoRun}
              hasExecCallbacks={!!execCallbacks}
            />
          </>
        )}

        {dbError && (
          <div className="kanban-error-banner" onClick={() => setDbError(null)}>
            <span>DB Error: {dbError}</span>
            <button onClick={() => setDbError(null)}>✕</button>
          </div>
        )}

        {loading ? (
          <div className="kanban-loading">{t('common.loading')}</div>
        ) : selectedProject ? (
          <div className="kanban-board" onDragLeave={() => { setDragOverColumn(null); setDragOverCardId(null); }}>
            {KANBAN_COLUMNS.map((col) => (
              <KanbanColumn
                key={col.key}
                status={col.key}
                label={t(col.i18nKey)}
                issues={issuesByStatus[col.key]}
                commentCounts={commentCounts}
                collapsed={collapsedColumns.has(col.key)}
                onToggleCollapse={handleToggleCollapse}
                onAddIssue={handleAddIssue}
                onQuickAdd={(title, status) => { void handleQuickAdd(title, status); }}
                onEditIssue={(issue) => { setEditingIssue(issue); setCreatingForStatus(null); }}
                onDeleteIssue={(id) => { void handleDeleteIssue(id); }}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragOverCard={handleDragOverCard}
                onDrop={(e, s) => { void handleDrop(e, s); }}
                dragOverColumn={dragOverColumn}
                dragOverCardId={dragOverCardId}
                onExecuteIssue={execCallbacks ? (issue) => { void handleExecuteIssue(issue); } : undefined}
                onViewThread={execCallbacks ? (issue) => { void handleViewThread(issue); } : undefined}
                executingIssueIds={executingIssueIds}
              />
            ))}
          </div>
        ) : null}
      </div>

      {viewingThreadIssue && (
        <div className="kanban-thread-panel">
          <div className="kanban-thread-panel-header">
            <div className="kanban-thread-panel-title">
              {viewingThreadIssue.issue_number > 0 && <span className="kanban-thread-panel-num">#{viewingThreadIssue.issue_number}</span>}
              <span>{viewingThreadIssue.title}</span>
            </div>
            <button className="kanban-thread-panel-close" onClick={handleCloseThreadPanel}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" />
              </svg>
            </button>
          </div>
          <div className="kanban-thread-panel-body">
            {threadLoading ? (
              <div className="kanban-thread-panel-loading">{t('common.loading')}</div>
            ) : threadDetail ? (
              <ThreadView thread={threadDetail} hideHeader />
            ) : (
              <div className="kanban-thread-panel-empty">{t('kanban.noExecutionData')}</div>
            )}
          </div>
        </div>
      )}

      {(editingIssue || creatingForStatus !== null) && (
        <IssueDialog
          issue={editingIssue}
          initialStatus={creatingForStatus ?? undefined}
          onSave={(data) => { void handleSaveIssue(data); }}
          onCommentsChanged={(issueId, count) => {
            setCommentCounts((prev) => {
              if (count <= 0) {
                if (!(issueId in prev)) return prev;
                const next = { ...prev };
                delete next[issueId];
                return next;
              }
              if (prev[issueId] === count) return prev;
              return { ...prev, [issueId]: count };
            });
          }}
          onOpenExecution={execCallbacks ? (issue) => { void handleViewThread(issue); } : undefined}
          onRerun={execCallbacks ? (issue) => { void handleExecuteIssue(issue, 'manual'); } : undefined}
          canExecute={!!execCallbacks}
          onClose={() => { setEditingIssue(null); setCreatingForStatus(null); }}
        />
      )}
    </div>
  );
});
