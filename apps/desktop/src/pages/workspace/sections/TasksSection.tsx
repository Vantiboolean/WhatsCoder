import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { UseWorkspaceControllerResult } from '../../../lib/workspace/workspaceController';
import type { WorkspaceStepRecord } from '../../../lib/workspace/types';
import type { WorkspaceStepStatus } from '../../../lib/workspace/types';
import { WorkspaceSurface } from './WorkspaceSurface';

function nextStepStatus(status: WorkspaceStepStatus): WorkspaceStepStatus {
  switch (status) {
    case 'pending':
      return 'active';
    case 'active':
      return 'done';
    default:
      return 'pending';
  }
}

export function TasksSection({
  controller,
}: {
  controller: UseWorkspaceControllerResult;
}) {
  const { t } = useTranslation();
  const bundle = controller.bundle;

  const commitSteps = useCallback(async (updater: (steps: WorkspaceStepRecord[]) => WorkspaceStepRecord[]) => {
    if (!bundle) return;
    const nextSteps = updater(bundle.steps).map((step, index) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      sortOrder: index,
    }));
    await controller.replaceSteps(nextSteps);
  }, [bundle, controller]);

  if (!bundle) {
    return <div className="workspace-empty-hint">{t('workspacePage.noProjectsHint')}</div>;
  }

  return (
    <div className="workspace-page-grid">
      <WorkspaceSurface
        title={t('workspacePage.missionTitle')}
        description={t('workspacePage.missionDesc')}
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4h12" />
            <path d="M2 8h9" />
            <path d="M2 12h6" />
          </svg>
        )}
      >
        <div className="workspace-field-stack">
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.linkedIssueLabel')}</span>
            <input
              value={bundle.scope.linkedIssue}
              onChange={(event) => void controller.updateScopeFields({ linkedIssue: event.target.value })}
              placeholder={t('workspacePage.linkedIssuePlaceholder')}
            />
          </label>
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.objectiveLabel')}</span>
            <textarea
              value={bundle.scope.objective}
              onChange={(event) => void controller.updateScopeFields({ objective: event.target.value })}
              placeholder={t('workspacePage.objectivePlaceholder')}
              rows={5}
            />
          </label>
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.activeTaskLabel')}</span>
            <textarea
              value={bundle.scope.activeTask}
              onChange={(event) => void controller.updateScopeFields({ activeTask: event.target.value })}
              placeholder={t('workspacePage.activeTaskPlaceholder')}
              rows={4}
            />
          </label>
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.flowTitle')}
        description={t('workspacePage.flowDesc')}
        className="workspace-surface--wide"
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v10" />
            <circle cx="3" cy="3" r="1.5" />
            <circle cx="3" cy="13" r="1.5" />
            <path d="M7 6h6" />
            <path d="M7 10h4" />
          </svg>
        )}
        action={(
          <button
            type="button"
            className="btn-primary workspace-add-step-btn"
            onClick={() => void commitSteps((steps) => [
              ...steps,
              {
                id: '',
                title: t('workspacePage.newStep'),
                status: steps.length === 0 ? 'active' : 'pending',
                scopeId: bundle.scope.scopeId,
                sortOrder: steps.length,
                createdAt: 0,
                updatedAt: 0,
              },
            ])}
          >
            {t('workspacePage.addStep')}
          </button>
        )}
      >
        {bundle.steps.length === 0 ? (
          <div className="workspace-empty-hint">{t('workspacePage.emptyFlow')}</div>
        ) : (
          <div className="workspace-step-list">
            {bundle.steps.map((step, index) => (
              <div key={step.id} className={`workspace-step workspace-step--${step.status}`}>
                <button
                  type="button"
                  className={`workspace-step__status workspace-step__status--${step.status}`}
                  onClick={() => void commitSteps((steps) => steps.map((item) => (
                    item.id === step.id ? { ...item, status: nextStepStatus(item.status) } : item
                  )))}
                >
                  {t(`workspacePage.step${step.status.charAt(0).toUpperCase()}${step.status.slice(1)}` as const, { defaultValue: step.status })}
                </button>
                <div className="workspace-step__index">{String(index + 1).padStart(2, '0')}</div>
                <input
                  className="workspace-step__input"
                  value={step.title}
                  onChange={(event) => void commitSteps((steps) => steps.map((item) => (
                    item.id === step.id ? { ...item, title: event.target.value } : item
                  )))}
                  placeholder={t('workspacePage.stepTitlePlaceholder')}
                />
                <button
                  type="button"
                  className="workspace-step__delete"
                  onClick={() => void commitSteps((steps) => steps.filter((item) => item.id !== step.id))}
                  aria-label={t('common.delete')}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M4.5 4.5l7 7" />
                    <path d="M11.5 4.5l-7 7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </WorkspaceSurface>
    </div>
  );
}
