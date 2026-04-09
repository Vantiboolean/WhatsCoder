import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { previewWorkspaceText } from '../../../lib/workspace/workspaceSummary';
import type { WorkspaceWorktreeRecord, WorkspaceWorktreeStatus } from '../../../lib/workspace/types';
import type { UseWorkspaceControllerResult } from '../../../lib/workspace/workspaceController';
import { WorkspaceSurface } from './WorkspaceSurface';

export function WorktreeSection({
  controller,
}: {
  controller: UseWorkspaceControllerResult;
}) {
  const { t } = useTranslation();
  const bundle = controller.bundle;

  if (!bundle) {
    return <div className="workspace-empty-hint">{t('workspacePage.noProjectsHint')}</div>;
  }

  const addPlannedWorktree = async () => {
    await controller.saveWorktree({
      branch: '',
      path: '',
      goal: '',
      status: 'planned',
      isPrimary: bundle.worktrees.length === 0,
    });
  };

  const openFolder = async (path: string) => {
    if (!path) return;
    await invoke('open_in_explorer', { path }).catch(() => {});
  };

  const removeWorktree = async (record: WorkspaceWorktreeRecord) => {
    const confirmed = window.confirm(t('workspacePage.worktreeRemoveConfirm', {
      target: record.path || record.branch || record.id,
    }));
    if (!confirmed) return;

    if (record.path.trim()) {
      const force = record.status === 'archived'
        ? window.confirm(t('workspacePage.worktreeForceRemoveConfirm'))
        : false;
      await controller.removeGitWorktree({ record, force });
      return;
    }

    await controller.deleteWorktree(record.id);
  };

  return (
    <div className="workspace-page-grid">
      <WorkspaceSurface
        title={t('workspacePage.worktreeRecordsTitle')}
        description={t('workspacePage.worktreeRecordsDesc')}
        className="workspace-surface--wide"
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 3v10" />
            <path d="M5 7c3 0 5-2 8-2" />
            <circle cx="5" cy="3" r="1.5" />
            <circle cx="5" cy="13" r="1.5" />
            <circle cx="13" cy="5" r="1.5" />
          </svg>
        )}
        action={(
          <button type="button" className="btn-primary" onClick={() => void addPlannedWorktree()}>
            {t('workspacePage.worktreeAddRecord')}
          </button>
        )}
      >
        {bundle.worktrees.length === 0 ? (
          <div className="workspace-empty-hint">{t('workspacePage.worktreeEmptyRecords')}</div>
        ) : (
          <div className="workspace-context-list">
            {bundle.worktrees.map((worktree) => (
              <article key={worktree.id} className="workspace-context-card">
                <div className="workspace-context-card__header">
                  <div>
                    <strong>{previewWorkspaceText(worktree.path || worktree.branch, t('workspacePage.worktreePathPlaceholder'))}</strong>
                    <span className="workspace-context-card__meta">{worktree.status}</span>
                  </div>
                  <div className="workspace-inline-actions">
                    <button type="button" className="btn-secondary" onClick={() => void controller.saveWorktree({ ...worktree, isPrimary: true })}>
                      {worktree.isPrimary ? t('workspacePage.runtimePrimary') : t('workspacePage.worktreeMakePrimary')}
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => void controller.saveWorktree({ ...worktree, status: nextWorktreeStatus(worktree.status) })}>
                      {t('workspacePage.worktreeToggleStatus')}
                    </button>
                    {worktree.path ? (
                      <button type="button" className="btn-secondary" onClick={() => void openFolder(worktree.path)}>
                        {t('workspacePage.worktreeOpenFolder')}
                      </button>
                    ) : null}
                    <button type="button" className="workspace-sidebar__reset-btn" onClick={() => void removeWorktree(worktree)}>
                      {t('common.delete')}
                    </button>
                  </div>
                </div>

                <div className="workspace-field-grid">
                  <label className="workspace-field">
                    <span>{t('workspacePage.worktreeBranchLabel')}</span>
                    <input
                      value={worktree.branch}
                      onChange={(event) => void controller.saveWorktree({ ...worktree, branch: event.target.value })}
                      placeholder={t('workspacePage.worktreeBranchPlaceholder')}
                    />
                  </label>
                  <label className="workspace-field">
                    <span>{t('workspacePage.worktreePathLabel')}</span>
                    <input
                      value={worktree.path}
                      onChange={(event) => void controller.saveWorktree({ ...worktree, path: event.target.value })}
                      placeholder={t('workspacePage.worktreePathPlaceholder')}
                    />
                  </label>
                  <label className="workspace-field">
                    <span>{t('workspacePage.worktreeStatusLabel')}</span>
                    <select
                      value={worktree.status}
                      onChange={(event) => void controller.saveWorktree({ ...worktree, status: event.target.value as WorkspaceWorktreeStatus })}
                    >
                      <option value="planned">{t('workspacePage.worktreeStatusPlanned')}</option>
                      <option value="ready">{t('workspacePage.worktreeStatusReady')}</option>
                      <option value="archived">{t('workspacePage.worktreeStatusArchived')}</option>
                    </select>
                  </label>
                  <label className="workspace-field workspace-field--full">
                    <span>{t('workspacePage.worktreeGoalLabel')}</span>
                    <textarea
                      value={worktree.goal}
                      onChange={(event) => void controller.saveWorktree({ ...worktree, goal: event.target.value })}
                      placeholder={t('workspacePage.worktreeGoalPlaceholder')}
                      rows={4}
                    />
                  </label>
                </div>

                {worktree.branch.trim() && worktree.path.trim() && worktree.status !== 'ready' ? (
                  <div className="workspace-inline-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void controller.createGitWorktree({
                        branch: worktree.branch,
                        path: worktree.path,
                        goal: worktree.goal,
                      })}
                    >
                      {t('workspacePage.worktreeCreateNow')}
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.worktreeDetectedTitle')}
        description={t('workspacePage.worktreeDetectedDesc')}
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 8h10" />
            <path d="M8 4l4 4-4 4" />
          </svg>
        )}
        action={(
          <button type="button" className="btn-secondary" onClick={() => void controller.refreshGitWorktreeSnapshot()}>
            {t('workspacePage.worktreeRefreshDetected')}
          </button>
        )}
      >
        {controller.gitWorktreeSnapshot.length === 0 ? (
          <div className="workspace-empty-hint">{t('workspacePage.worktreeEmptyDetected')}</div>
        ) : (
          <div className="workspace-compact-list">
            {controller.gitWorktreeSnapshot.map((entry) => (
              <div key={entry.path} className="workspace-compact-list__row workspace-compact-list__row--stacked">
                <span>{entry.branch || t('workspacePage.worktreeStatusDetached')}</span>
                <strong>{entry.path}</strong>
                <span>{entry.head || t('workspacePage.pending')}</span>
              </div>
            ))}
          </div>
        )}
      </WorkspaceSurface>
    </div>
  );
}

function nextWorktreeStatus(status: WorkspaceWorktreeStatus): WorkspaceWorktreeStatus {
  switch (status) {
    case 'planned':
      return 'ready';
    case 'ready':
      return 'archived';
    default:
      return 'planned';
  }
}
