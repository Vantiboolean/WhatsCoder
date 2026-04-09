import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { previewWorkspaceText } from '../../../lib/workspace/workspaceSummary';
import type { WorkspaceSectionId } from '../../../lib/workspace/types';
import type { UseWorkspaceControllerResult } from '../../../lib/workspace/workspaceController';
import { WorkspaceSurface } from './WorkspaceSurface';

export function OverviewSection({
  controller,
  onSectionChange,
}: {
  controller: UseWorkspaceControllerResult;
  onSectionChange: (section: WorkspaceSectionId) => void;
}) {
  const { t } = useTranslation();
  const bundle = controller.bundle;

  const actionItems = useMemo(() => {
    if (!bundle) return [];
    const next: Array<{ key: string; section: WorkspaceSectionId; title: string; detail: string }> = [];
    if (!bundle.scope.objective.trim() || !bundle.scope.activeTask.trim()) {
      next.push({
        key: 'task-definition',
        section: 'tasks',
        title: t('workspacePage.overviewActionTasks'),
        detail: t('workspacePage.overviewActionTasksDesc'),
      });
    }
    if (bundle.executors.length === 0) {
      next.push({
        key: 'executor',
        section: 'runtime',
        title: t('workspacePage.overviewActionExecutor'),
        detail: t('workspacePage.overviewActionExecutorDesc'),
      });
    }
    if (bundle.contextItems.filter((item) => item.kind !== 'run_summary').length === 0) {
      next.push({
        key: 'context',
        section: 'context',
        title: t('workspacePage.overviewActionContext'),
        detail: t('workspacePage.overviewActionContextDesc'),
      });
    }
    if (bundle.worktrees.length === 0) {
      next.push({
        key: 'worktree',
        section: 'worktree',
        title: t('workspacePage.overviewActionWorktree'),
        detail: t('workspacePage.overviewActionWorktreeDesc'),
      });
    }
    if (next.length === 0) {
      next.push({
        key: 'run',
        section: 'runtime',
        title: t('workspacePage.overviewActionRun'),
        detail: t('workspacePage.overviewActionRunDesc'),
      });
    }
    return next;
  }, [bundle, t]);

  if (!bundle) {
    return <div className="workspace-empty-hint">{t('workspacePage.noProjectsHint')}</div>;
  }

  const primaryExecutor = bundle.executors.find((executor) => executor.isPrimary) ?? bundle.executors[0] ?? null;
  const primaryWorktree = bundle.worktrees.find((worktree) => worktree.isPrimary) ?? bundle.worktrees[0] ?? null;
  const contextCompleteness = bundle.contextItems.filter((item) => item.kind !== 'run_summary').length;
  const lastRunTone =
    bundle.scope.lastRunStatus === 'success'
      ? 'green'
      : bundle.scope.lastRunStatus === 'failed'
        ? 'orange'
        : bundle.scope.lastRunStatus === 'running'
          ? 'blue'
          : 'muted';

  return (
    <div className="workspace-page-grid">
      <WorkspaceSurface
        title={t('workspacePage.overviewStatusTitle')}
        description={t('workspacePage.overviewStatusDesc')}
        className="workspace-surface--wide"
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="5" height="5" rx="1" />
            <rect x="9" y="2" width="5" height="5" rx="1" />
            <rect x="2" y="9" width="5" height="5" rx="1" />
            <rect x="9" y="9" width="5" height="5" rx="1" />
          </svg>
        )}
      >
        <div className="workspace-data-grid">
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.overviewScope')}</span>
            <strong className="workspace-data-card__value">
              {bundle.scope.scopeType === 'issue'
                ? previewWorkspaceText(bundle.scope.linkedIssue || bundle.scope.issueLabel || bundle.scope.issueId, bundle.scope.scopeId)
                : previewWorkspaceText(controller.currentProjectLabel, bundle.scope.projectId)}
            </strong>
            <span className="workspace-data-card__hint">{bundle.scope.scopeId}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.overviewSteps')}</span>
            <strong className="workspace-data-card__value">{bundle.summary.completedSteps}/{bundle.summary.totalSteps}</strong>
            <span className="workspace-data-card__hint">{previewWorkspaceText(bundle.scope.activeTask || bundle.scope.objective, t('workspacePage.connectionsTaskFallback'))}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.overviewExecutor')}</span>
            <strong className="workspace-data-card__value">
              {previewWorkspaceText(
                `${primaryExecutor?.name ?? ''} ${primaryExecutor?.model ?? ''}`.trim(),
                t('workspacePage.runtimeAgentOwnerFallback'),
              )}
            </strong>
            <span className="workspace-data-card__hint">{primaryExecutor?.providerKind ?? t('workspacePage.pending')}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.overviewLastRun')}</span>
            <strong className={`workspace-data-card__value workspace-status--${lastRunTone}`}>
              {bundle.scope.lastRunStatus ?? t('workspacePage.pending')}
            </strong>
            <span className="workspace-data-card__hint">{previewWorkspaceText(bundle.scope.lastRunSummary, t('workspacePage.overviewLastRunFallback'))}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.overviewContext')}</span>
            <strong className="workspace-data-card__value">{contextCompleteness}</strong>
            <span className="workspace-data-card__hint">{t('workspacePage.overviewContextHint')}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.overviewWorktree')}</span>
            <strong className="workspace-data-card__value">
              {previewWorkspaceText(primaryWorktree?.path, t('workspacePage.worktreeLinksOutcomeFallback'))}
            </strong>
            <span className="workspace-data-card__hint">
              {primaryWorktree
                ? `${primaryWorktree.branch || t('workspacePage.pending')} · ${primaryWorktree.status}`
                : t('workspacePage.connectionsResultPending')}
            </span>
          </article>
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.overviewNextTitle')}
        description={t('workspacePage.overviewNextDesc')}
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h10" />
            <path d="M9 4l4 4-4 4" />
          </svg>
        )}
      >
        <div className="workspace-chain-list">
          {actionItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className="workspace-chain-row"
              onClick={() => onSectionChange(item.section)}
            >
              <div className="workspace-chain-row__left">
                <span className="workspace-chain-row__label">{item.title}</span>
                <span className="workspace-chain-row__hint">{item.detail}</span>
              </div>
              <div className="workspace-chain-row__value">{t(`workspacePage.tab${item.section.charAt(0).toUpperCase()}${item.section.slice(1)}` as const, { defaultValue: item.section })}</div>
            </button>
          ))}
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.overviewNotesTitle')}
        description={t('workspacePage.overviewNotesDesc')}
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 2.5h10a1 1 0 011 1v9a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1z" />
            <path d="M5 6h6" />
            <path d="M5 9h4" />
          </svg>
        )}
        action={bundle.scope.lastRunThreadId ? (
          <button type="button" className="btn-secondary" onClick={() => void controller.openThread(bundle.scope.lastRunThreadId as string)}>
            {t('workspacePage.openLatestThread')}
          </button>
        ) : undefined}
      >
        <div className="workspace-compact-list">
          <div className="workspace-compact-list__row">
            <span>{t('workspacePage.notesLabel')}</span>
            <strong>{previewWorkspaceText(bundle.scope.notes, t('workspacePage.notesPlaceholder'))}</strong>
          </div>
          <div className="workspace-compact-list__row">
            <span>{t('workspacePage.runtimeNotesLabel')}</span>
            <strong>{previewWorkspaceText(bundle.scope.runtimeNotes, t('workspacePage.runtimeNotesPlaceholder'))}</strong>
          </div>
          <div className="workspace-compact-list__row">
            <span>{t('workspacePage.imagesLabel')}</span>
            <strong>{previewWorkspaceText(bundle.scope.imageRefs, t('workspacePage.imagesPlaceholder'))}</strong>
          </div>
        </div>
      </WorkspaceSurface>
    </div>
  );
}
