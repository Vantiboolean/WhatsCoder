import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { previewWorkspaceText } from '../../../lib/workspace/workspaceSummary';
import type { WorkspaceExecutorProvider, WorkspaceExecutorRecord } from '../../../lib/workspace/types';
import type { UseWorkspaceControllerResult } from '../../../lib/workspace/workspaceController';
import { WorkspaceSurface } from './WorkspaceSurface';

export function RuntimeSection({
  controller,
}: {
  controller: UseWorkspaceControllerResult;
}) {
  const { t } = useTranslation();
  const bundle = controller.bundle;
  const [selectedExecutorId, setSelectedExecutorId] = useState<string | null>(null);

  useEffect(() => {
    const nextId = bundle?.executors.find((executor) => executor.isPrimary)?.id ?? bundle?.executors[0]?.id ?? null;
    if (nextId && nextId !== selectedExecutorId) {
      setSelectedExecutorId(nextId);
      return;
    }
    if (!nextId) {
      setSelectedExecutorId(null);
    }
  }, [bundle?.executors, selectedExecutorId]);

  const selectedExecutor = useMemo(
    () => bundle?.executors.find((executor) => executor.id === selectedExecutorId) ?? bundle?.executors[0] ?? null,
    [bundle?.executors, selectedExecutorId],
  );

  if (!bundle) {
    return <div className="workspace-empty-hint">{t('workspacePage.noProjectsHint')}</div>;
  }

  const saveExecutorPatch = async (patch: Partial<WorkspaceExecutorRecord>) => {
    if (!selectedExecutor) return;
    await controller.saveExecutor({
      ...selectedExecutor,
      ...patch,
      name: patch.name ?? selectedExecutor.name,
      providerKind: patch.providerKind ?? selectedExecutor.providerKind,
    });
  };

  const recentRuns = bundle.runs.slice(0, 5);

  return (
    <div className="workspace-page-grid workspace-page-grid--runtime">
      <WorkspaceSurface
        title={t('workspacePage.runtimeExecutorsTitle')}
        description={t('workspacePage.runtimeExecutorsDesc')}
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M5 7l2 2-2 2" />
            <path d="M9 11h3" />
          </svg>
        )}
        action={(
          <div className="workspace-inline-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void controller.saveExecutor({ name: '', providerKind: 'codex' })}
            >
              {t('workspacePage.addCodexExecutor')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void controller.saveExecutor({ name: '', providerKind: 'claude' })}
            >
              {t('workspacePage.addClaudeExecutor')}
            </button>
          </div>
        )}
      >
        <div className="workspace-runtime-shell">
          <div className="workspace-runtime-list">
            {bundle.executors.length === 0 ? (
              <div className="workspace-empty-hint">{t('workspacePage.runtimeEmptyExecutors')}</div>
            ) : (
              bundle.executors.map((executor) => (
                <button
                  key={executor.id}
                  type="button"
                  className={`workspace-runtime-list__item${executor.id === selectedExecutor?.id ? ' workspace-runtime-list__item--active' : ''}`}
                  onClick={() => setSelectedExecutorId(executor.id)}
                >
                  <div className="workspace-runtime-list__title">
                    <strong>{previewWorkspaceText(executor.name, t('workspacePage.runtimeUnnamedExecutor'))}</strong>
                    {executor.isPrimary ? <span className="workspace-runtime-list__badge">{t('workspacePage.runtimePrimary')}</span> : null}
                  </div>
                  <div className="workspace-runtime-list__meta">
                    <span>{executor.providerKind}</span>
                    <span>{executor.runStatus}</span>
                  </div>
                  <div className="workspace-runtime-list__meta">
                    <span>{previewWorkspaceText(executor.model, t('workspacePage.modelPlaceholder'))}</span>
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="workspace-runtime-detail">
            {selectedExecutor ? (
              <div className="workspace-field-stack">
                <label className="workspace-field workspace-field--full">
                  <span>{t('workspacePage.agentLabel')}</span>
                  <input
                    value={selectedExecutor.name}
                    onChange={(event) => void saveExecutorPatch({ name: event.target.value })}
                    placeholder={t('workspacePage.agentPlaceholder')}
                  />
                </label>
                <div className="workspace-field-grid">
                  <label className="workspace-field">
                    <span>{t('workspacePage.runtimeProviderLabel')}</span>
                    <select
                      value={selectedExecutor.providerKind}
                      onChange={(event) => void saveExecutorPatch({ providerKind: event.target.value as WorkspaceExecutorProvider })}
                    >
                      <option value="codex">Codex</option>
                      <option value="claude">Claude</option>
                    </select>
                  </label>
                  <label className="workspace-field">
                    <span>{t('workspacePage.modelLabel')}</span>
                    <input
                      value={selectedExecutor.model}
                      onChange={(event) => void saveExecutorPatch({ model: event.target.value })}
                      placeholder={t('workspacePage.modelPlaceholder')}
                    />
                  </label>
                  <label className="workspace-field">
                    <span>{t('workspacePage.runtimeReasoningLabel')}</span>
                    <input
                      value={selectedExecutor.reasoning}
                      onChange={(event) => void saveExecutorPatch({ reasoning: event.target.value })}
                      placeholder="low / medium / high / xhigh"
                    />
                  </label>
                  <label className="workspace-field">
                    <span>{t('workspacePage.runtimeRoleLabel')}</span>
                    <input
                      value={selectedExecutor.roleLabel}
                      onChange={(event) => void saveExecutorPatch({ roleLabel: event.target.value })}
                      placeholder={t('workspacePage.runtimeRolePlaceholder')}
                    />
                  </label>
                  <label className="workspace-field workspace-field--full">
                    <span>{t('workspacePage.terminalFocusLabel')}</span>
                    <input
                      value={selectedExecutor.terminalLane}
                      onChange={(event) => void saveExecutorPatch({ terminalLane: event.target.value })}
                      placeholder={t('workspacePage.terminalFocusPlaceholder')}
                    />
                  </label>
                  <label className="workspace-field workspace-field--full">
                    <span>{t('workspacePage.runtimeCwdLabel')}</span>
                    <input
                      value={selectedExecutor.cwdOverride ?? ''}
                      onChange={(event) => void saveExecutorPatch({ cwdOverride: event.target.value || null })}
                      placeholder={bundle.scope.projectId}
                    />
                  </label>
                </div>

                <div className="workspace-inline-actions">
                  <button type="button" className="btn-secondary" onClick={() => void saveExecutorPatch({ isPrimary: true })}>
                    {t('workspacePage.runtimeSetPrimary')}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={selectedExecutor.runStatus === 'running' || selectedExecutor.runStatus === 'queued'}
                    onClick={() => void controller.runExecutor(selectedExecutor.id)}
                  >
                    {selectedExecutor.runStatus === 'running' || selectedExecutor.runStatus === 'queued'
                      ? t('workspacePage.runtimeRunning')
                      : t('workspacePage.runtimeRunNow')}
                  </button>
                  {selectedExecutor.lastThreadId ? (
                    <button type="button" className="btn-secondary" onClick={() => void controller.openThread(selectedExecutor.lastThreadId as string)}>
                      {t('workspacePage.openLatestThread')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="workspace-sidebar__reset-btn"
                    onClick={() => void controller.deleteExecutor(selectedExecutor.id)}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="workspace-empty-hint">{t('workspacePage.runtimeEmptyExecutors')}</div>
            )}
          </div>
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.runtimeRunsTitle')}
        description={t('workspacePage.runtimeRunsDesc')}
        className="workspace-surface--wide"
        icon={(
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h10" />
            <path d="M9 4l4 4-4 4" />
          </svg>
        )}
      >
        {recentRuns.length === 0 ? (
          <div className="workspace-empty-hint">{t('workspacePage.runtimeEmptyRuns')}</div>
        ) : (
          <div className="workspace-compact-list">
            {recentRuns.map((run) => (
              <div key={run.id} className="workspace-compact-list__row workspace-compact-list__row--stacked">
                <span>{previewWorkspaceText(run.model || run.providerKind, run.providerKind)}</span>
                <strong>{run.status}</strong>
                <span>{previewWorkspaceText(run.resultSummary || run.errorMessage, t('workspacePage.runtimeRunSummaryFallback'))}</span>
              </div>
            ))}
          </div>
        )}
      </WorkspaceSurface>
    </div>
  );
}
