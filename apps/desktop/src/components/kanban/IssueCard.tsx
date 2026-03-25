import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PRIORITY_CONFIG,
  type KanbanIssue,
} from '../../lib/kanbanDb';
import type { WorkspaceDraftSummary } from '../../lib/workspaceDrafts';
import { PRIORITY_I18N, EXECUTION_STATE_I18N, isDueOverdue, isDueSoon } from './kanban-helpers';

const EMPTY_WORKSPACE_SUMMARY: WorkspaceDraftSummary = {
  hasActivity: false,
  totalSteps: 0,
  completedSteps: 0,
  artifactCount: 0,
  runtimeReady: false,
  worktreeReady: false,
};

export const IssueCard = memo(function IssueCard({
  issue,
  commentCount,
  onEdit,
  onDelete,
  onDragStart,
  onDragOverCard,
  isDragTarget,
  onExecute,
  onViewThread,
  onOpenWorkspace,
  isExecuting,
  workspaceSummary,
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
  onOpenWorkspace?: (issue: KanbanIssue) => void;
  isExecuting?: boolean;
  workspaceSummary?: WorkspaceDraftSummary | null;
}) {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const priority = PRIORITY_CONFIG[issue.priority];
  const tags = issue.tags ? issue.tags.split(',').filter(Boolean) : [];
  const overdue = issue.due_date && issue.status !== 'done' && isDueOverdue(issue.due_date);
  const dueSoon = issue.due_date && issue.status !== 'done' && !overdue && isDueSoon(issue.due_date);
  const executionStateLabel = issue.last_run_status ? t(EXECUTION_STATE_I18N[issue.last_run_status]) : null;
  const summary = workspaceSummary ?? EMPTY_WORKSPACE_SUMMARY;
  const workspacePills = [
    {
      key: 'tasks',
      label: t('workspacePage.summaryTasks'),
      value: `${summary.completedSteps}/${summary.totalSteps}`,
      tone: summary.totalSteps > 0 ? 'blue' : 'muted',
    },
    {
      key: 'runtime',
      label: t('workspacePage.summaryRuntime'),
      value: summary.runtimeReady ? t('workspacePage.ready') : t('workspacePage.pending'),
      tone: summary.runtimeReady ? 'green' : summary.hasActivity ? 'orange' : 'muted',
    },
    {
      key: 'artifacts',
      label: t('workspacePage.summaryArtifacts'),
      value: summary.artifactCount.toString(),
      tone: summary.artifactCount > 0 ? 'purple' : 'muted',
    },
    {
      key: 'worktree',
      label: t('workspacePage.summaryWorktree'),
      value: summary.worktreeReady ? t('workspacePage.ready') : t('workspacePage.pending'),
      tone: summary.worktreeReady ? 'green' : summary.hasActivity ? 'orange' : 'muted',
    },
  ] as const;

  return (
    <div
      className={`kanban-card${isDragTarget ? ' kanban-card--drag-target' : ''}`}
      style={{ borderLeftColor: priority.color, borderLeftWidth: 3 }}
      draggable
      onDragStart={(e) => onDragStart(e, issue)}
      onDragOver={(e) => onDragOverCard(e, issue.id)}
      onClick={() => {
        if (issue.linked_thread_id && onViewThread) {
          onViewThread(issue);
        } else {
          onEdit(issue);
        }
      }}
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
      <div className="kanban-card-workspace">
        {workspacePills.map((pill) => (
          <span key={pill.key} className={`kanban-card-workspace-pill kanban-card-workspace-pill--${pill.tone}`}>
            <strong>{pill.value}</strong>
            <span>{pill.label}</span>
          </span>
        ))}
      </div>
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
        {(onOpenWorkspace || onExecute || (issue.linked_thread_id && onViewThread)) ? (
          <div className="kanban-card-actions">
            {onOpenWorkspace && (
              <button
                className="kanban-card-exec-btn kanban-card-exec-btn--workspace"
                title={t('kanban.openWorkspaceTasks')}
                onClick={(e) => { e.stopPropagation(); onOpenWorkspace(issue); }}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="5" height="5" rx="1" />
                  <rect x="9" y="2" width="5" height="5" rx="1" />
                  <rect x="2" y="9" width="5" height="5" rx="1" />
                  <path d="M11.5 9.5h2.5" />
                  <path d="M12.75 8.25v2.5" />
                </svg>
              </button>
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
            ) : onExecute ? (
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
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});
