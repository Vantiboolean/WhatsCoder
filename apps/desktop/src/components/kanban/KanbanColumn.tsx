import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { KanbanIssue, KanbanStatus } from '../../lib/kanbanDb';
import { IssueCard } from './IssueCard';
import { QuickAddInput } from './QuickAddInput';

export const KanbanColumn = memo(function KanbanColumn({
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
