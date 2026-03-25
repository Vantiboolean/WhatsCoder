import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildIssueDraftKey,
  buildProjectDraftKey,
  countWorkspaceArtifacts,
  createEmptyWorkspaceDraft,
  createWorkspaceStepId,
  getWorkspaceDraftSummary,
  loadWorkspaceDraftMap,
  saveWorkspaceDraftMap,
  type WorkspaceDraft,
  type WorkspaceDraftPrefill,
  type WorkspaceSectionId,
  type WorkspaceStep,
  type WorkspaceStepStatus,
} from '../lib/workspaceDrafts';
import { DesktopEmptyState, DesktopPageShell } from './DesktopPageShell';
export type { WorkspaceDraftPrefill, WorkspaceSectionId } from '../lib/workspaceDrafts';

type WorkspaceProject = {
  id: string;
  name: string;
};

type WorkspaceSectionMeta = {
  id: WorkspaceSectionId;
  label: string;
  description: string;
};

type WorkspaceRouteItem = {
  id: WorkspaceSectionId;
  title: string;
  purpose: string;
  upstream: string;
  downstream: string;
};

type WorkspaceChainItem = {
  page: Exclude<WorkspaceSectionId, 'overview'>;
  label: string;
  value: string;
  hint: string;
};

const WORKSPACE_SECTION_STORAGE_KEY = 'codex-workspace-panel-section-v1';
const FALLBACK_WORKSPACE_DRAFT = createEmptyWorkspaceDraft();

function isWorkspaceSectionId(value: unknown): value is WorkspaceSectionId {
  return value === 'overview' || value === 'kanban' || value === 'tasks' || value === 'runtime' || value === 'context' || value === 'worktree';
}

function loadSection(): WorkspaceSectionId {
  try {
    const raw = localStorage.getItem(WORKSPACE_SECTION_STORAGE_KEY);
    return isWorkspaceSectionId(raw) ? raw : 'overview';
  } catch {
    return 'overview';
  }
}

function previewText(value: string, fallback: string, maxChars = 86): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 3))}...` : normalized;
}

function fallbackProjectName(projectId: string): string {
  const normalized = projectId.replace(/[\\/]+$/, '');
  if (!normalized) return projectId;
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || projectId;
}

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

function WorkspaceSurface({
  title,
  description,
  action,
  className,
  icon,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`workspace-surface${className ? ` ${className}` : ''}`}>
      <div className="workspace-surface__header">
        <div className="workspace-surface__header-copy">
          {icon ? <span className="workspace-surface__icon">{icon}</span> : null}
          <div>
            <h3 className="workspace-surface__title">{title}</h3>
            <p className="workspace-surface__desc">{description}</p>
          </div>
        </div>
        {action ? <div className="workspace-surface__action">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export const WorkspacePanel = memo(function WorkspacePanel({
  projects,
  activeProjectId,
  activeIssueId,
  activeIssueLabel,
  section,
  prefill,
  kanbanContent,
  onPrefillConsumed,
  onSectionChange,
  onProjectSelect,
  windowControls,
}: {
  projects: WorkspaceProject[];
  activeProjectId?: string | null;
  activeIssueId?: string | null;
  activeIssueLabel?: string | null;
  section?: WorkspaceSectionId;
  prefill?: WorkspaceDraftPrefill | null;
  kanbanContent?: ReactNode;
  onPrefillConsumed?: (seedId: string) => void;
  onSectionChange?: (section: WorkspaceSectionId) => void;
  onProjectSelect?: (projectId: string) => void;
  windowControls?: ReactNode;
}) {
  const { t } = useTranslation();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(activeProjectId ?? projects[0]?.id ?? null);
  const [localSection, setLocalSection] = useState<WorkspaceSectionId>(() => loadSection());
  const [draftsByScope, setDraftsByScope] = useState<Record<string, WorkspaceDraft>>(() => loadWorkspaceDraftMap());
  const selectedSection = section ?? localSection;
  const currentDraftKey = useMemo(() => {
    if (activeIssueId) return buildIssueDraftKey(activeIssueId);
    if (selectedProjectId) return buildProjectDraftKey(selectedProjectId);
    return null;
  }, [activeIssueId, selectedProjectId]);
  const projectOptions = useMemo<WorkspaceProject[]>(() => {
    const merged = new Map<string, WorkspaceProject>();
    for (const project of projects) {
      merged.set(project.id, project);
    }
    if (activeProjectId && !merged.has(activeProjectId)) {
      merged.set(activeProjectId, { id: activeProjectId, name: fallbackProjectName(activeProjectId) });
    }
    if (selectedProjectId && !merged.has(selectedProjectId)) {
      merged.set(selectedProjectId, { id: selectedProjectId, name: fallbackProjectName(selectedProjectId) });
    }
    return Array.from(merged.values());
  }, [activeProjectId, projects, selectedProjectId]);

  const handleSectionChange = useCallback((nextSection: WorkspaceSectionId) => {
    if (section === undefined) {
      setLocalSection(nextSection);
    }
    onSectionChange?.(nextSection);
  }, [onSectionChange, section]);

  useEffect(() => {
    if (activeProjectId && activeProjectId !== selectedProjectId) {
      setSelectedProjectId(activeProjectId);
      return;
    }

    if (selectedProjectId && projectOptions.some((project) => project.id === selectedProjectId)) {
      return;
    }

    setSelectedProjectId(projectOptions[0]?.id ?? null);
  }, [activeProjectId, projectOptions, selectedProjectId]);

  useEffect(() => {
    if (!prefill) return;
    const matchesProject = prefill.projectId === selectedProjectId || prefill.projectId === activeProjectId;
    if (!matchesProject) return;

    const prefillDraftKey = prefill.issueId ? buildIssueDraftKey(prefill.issueId) : buildProjectDraftKey(prefill.projectId);
    setDraftsByScope((prev) => {
      const current = prev[prefillDraftKey] ?? createEmptyWorkspaceDraft();
      const nextLinkedIssue = current.linkedIssue.trim() || prefill.linkedIssue || '';
      const nextObjective = current.objective.trim() || prefill.objective || '';
      const nextActiveTask = current.activeTask.trim() || prefill.activeTask || '';

      if (
        (prefill.issueId || '') === current.issueId &&
        (prefill.issueLabel || '') === current.issueLabel &&
        nextLinkedIssue === current.linkedIssue &&
        nextObjective === current.objective &&
        nextActiveTask === current.activeTask
      ) {
        return prev;
      }

      return {
        ...prev,
        [prefillDraftKey]: {
          ...current,
          issueId: current.issueId || prefill.issueId || '',
          issueLabel: current.issueLabel || prefill.issueLabel || '',
          linkedIssue: nextLinkedIssue,
          objective: nextObjective,
          activeTask: nextActiveTask,
          lastUpdatedAt: Date.now(),
        },
      };
    });

    onPrefillConsumed?.(prefill.seedId);
  }, [activeProjectId, onPrefillConsumed, prefill, selectedProjectId]);

  useEffect(() => {
    if (!currentDraftKey) return;
    if (draftsByScope[currentDraftKey]) return;
    setDraftsByScope((prev) => ({
      ...prev,
      [currentDraftKey]: {
        ...createEmptyWorkspaceDraft(),
        issueId: activeIssueId ?? '',
        issueLabel: activeIssueLabel ?? '',
      },
    }));
  }, [activeIssueId, activeIssueLabel, currentDraftKey, draftsByScope]);

  useEffect(() => {
    try {
      saveWorkspaceDraftMap(draftsByScope);
    } catch {
      // Ignore local persistence failures in the UI layer.
    }
  }, [draftsByScope]);

  useEffect(() => {
    if (section !== undefined) return;
    try {
      localStorage.setItem(WORKSPACE_SECTION_STORAGE_KEY, selectedSection);
    } catch {
      // Ignore local persistence failures in the UI layer.
    }
  }, [section, selectedSection]);

  const selectedDraft = useMemo(
    () => (currentDraftKey ? draftsByScope[currentDraftKey] ?? FALLBACK_WORKSPACE_DRAFT : FALLBACK_WORKSPACE_DRAFT),
    [currentDraftKey, draftsByScope],
  );

  const updateDraft = useCallback((updater: (draft: WorkspaceDraft) => WorkspaceDraft) => {
    if (!currentDraftKey) return;
    setDraftsByScope((prev) => {
      const current = prev[currentDraftKey] ?? createEmptyWorkspaceDraft();
      return {
        ...prev,
        [currentDraftKey]: {
          ...updater(current),
          lastUpdatedAt: Date.now(),
        },
      };
    });
  }, [currentDraftKey]);

  const handleSelectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    onProjectSelect?.(projectId);
  }, [onProjectSelect]);

  const handleResetWorkspace = useCallback(() => {
    if (!selectedProjectId) return;
    if (!window.confirm(t('workspacePage.resetConfirmMessage'))) return;
    if (!currentDraftKey) return;
    setDraftsByScope((prev) => {
      const next = { ...prev };
      delete next[currentDraftKey];
      return next;
    });
    handleSectionChange('overview');
  }, [currentDraftKey, handleSectionChange, selectedProjectId, t]);

  const handleAddStep = useCallback(() => {
    updateDraft((draft) => ({
      ...draft,
      steps: [
        ...draft.steps,
        {
          id: createWorkspaceStepId(),
          title: t('workspacePage.newStep'),
          status: draft.steps.length === 0 ? 'active' : 'pending',
        },
      ],
    }));
  }, [t, updateDraft]);

  const draftSummary = useMemo(() => getWorkspaceDraftSummary(selectedDraft), [selectedDraft]);
  const totalSteps = draftSummary.totalSteps;
  const completedSteps = draftSummary.completedSteps;
  const artifactCount = draftSummary.artifactCount;
  const worktreeReady = draftSummary.worktreeReady;
  const runtimeReady = draftSummary.runtimeReady;
  const activeScopeLabel = activeIssueId
    ? previewText(
        selectedDraft.linkedIssue || selectedDraft.issueLabel || activeIssueLabel || activeIssueId,
        activeIssueId,
        68,
      )
    : '';
  const currentScopeRoute = activeIssueId
    ? `workspace/issue/${activeIssueId}${selectedSection === 'overview' ? '' : `/${selectedSection}`}`
    : selectedSection === 'overview'
      ? 'workspace'
      : `workspace/${selectedSection}`;

  const sectionMetas = useMemo<WorkspaceSectionMeta[]>(() => ([
    { id: 'overview', label: t('workspacePage.tabOverview'), description: t('workspacePage.tabOverviewDesc') },
    { id: 'kanban', label: t('workspacePage.tabKanban'), description: t('workspacePage.tabKanbanDesc') },
    { id: 'tasks', label: t('workspacePage.tabTasks'), description: t('workspacePage.tabTasksDesc') },
    { id: 'runtime', label: t('workspacePage.tabRuntime'), description: t('workspacePage.tabRuntimeDesc') },
    { id: 'context', label: t('workspacePage.tabContext'), description: t('workspacePage.tabContextDesc') },
    { id: 'worktree', label: t('workspacePage.tabWorktree'), description: t('workspacePage.tabWorktreeDesc') },
  ]), [t]);

  const currentSectionMeta = sectionMetas.find((section) => section.id === selectedSection) ?? sectionMetas[0];

  const summaryPills = useMemo(() => ([
    {
      key: 'tasks',
      label: t('workspacePage.summaryTasks'),
      value: `${completedSteps}/${totalSteps}`,
      tone: 'blue',
    },
    {
      key: 'runtime',
      label: t('workspacePage.summaryRuntime'),
      value: runtimeReady ? t('workspacePage.ready') : t('workspacePage.pending'),
      tone: runtimeReady ? 'green' : 'muted',
    },
    {
      key: 'artifacts',
      label: t('workspacePage.summaryArtifacts'),
      value: artifactCount.toString(),
      tone: artifactCount > 0 ? 'purple' : 'muted',
    },
    {
      key: 'worktree',
      label: t('workspacePage.summaryWorktree'),
      value: worktreeReady ? t('workspacePage.ready') : t('workspacePage.pending'),
      tone: worktreeReady ? 'green' : 'orange',
    },
  ]), [artifactCount, completedSteps, runtimeReady, t, totalSteps, worktreeReady]);

  const routeItems = useMemo<WorkspaceRouteItem[]>(() => ([
    {
      id: 'overview',
      title: t('workspacePage.tabOverview'),
      purpose: t('workspacePage.routeOverviewPurpose'),
      upstream: t('workspacePage.routeOverviewUpstream'),
      downstream: t('workspacePage.routeOverviewDownstream'),
    },
    {
      id: 'kanban',
      title: t('workspacePage.tabKanban'),
      purpose: t('workspacePage.routeKanbanPurpose'),
      upstream: t('workspacePage.routeKanbanUpstream'),
      downstream: t('workspacePage.routeKanbanDownstream'),
    },
    {
      id: 'tasks',
      title: t('workspacePage.tabTasks'),
      purpose: t('workspacePage.routeTasksPurpose'),
      upstream: t('workspacePage.routeTasksUpstream'),
      downstream: t('workspacePage.routeTasksDownstream'),
    },
    {
      id: 'runtime',
      title: t('workspacePage.tabRuntime'),
      purpose: t('workspacePage.routeRuntimePurpose'),
      upstream: t('workspacePage.routeRuntimeUpstream'),
      downstream: t('workspacePage.routeRuntimeDownstream'),
    },
    {
      id: 'context',
      title: t('workspacePage.tabContext'),
      purpose: t('workspacePage.routeContextPurpose'),
      upstream: t('workspacePage.routeContextUpstream'),
      downstream: t('workspacePage.routeContextDownstream'),
    },
    {
      id: 'worktree',
      title: t('workspacePage.tabWorktree'),
      purpose: t('workspacePage.routeWorktreePurpose'),
      upstream: t('workspacePage.routeWorktreeUpstream'),
      downstream: t('workspacePage.routeWorktreeDownstream'),
    },
  ]), [t]);

  const chainItems = useMemo<WorkspaceChainItem[]>(() => ([
    {
      page: 'tasks',
      label: t('workspacePage.chainTask'),
      value: previewText(selectedDraft.activeTask || selectedDraft.objective, t('workspacePage.chainTaskFallback')),
      hint: t('workspacePage.chainTaskHint'),
    },
    {
      page: 'runtime',
      label: t('workspacePage.chainAgent'),
      value: previewText(`${selectedDraft.primaryAgent} ${selectedDraft.executionModel} ${selectedDraft.terminalFocus}`.trim(), t('workspacePage.chainAgentFallback')),
      hint: t('workspacePage.chainAgentHint'),
    },
    {
      page: 'context',
      label: t('workspacePage.chainNote'),
      value: previewText(selectedDraft.notes, t('workspacePage.chainNoteFallback')),
      hint: t('workspacePage.chainNoteHint'),
    },
    {
      page: 'context',
      label: t('workspacePage.chainImage'),
      value: previewText(selectedDraft.imageRefs, t('workspacePage.chainImageFallback')),
      hint: t('workspacePage.chainImageHint'),
    },
    {
      page: 'worktree',
      label: t('workspacePage.chainWorktree'),
      value: previewText(`${selectedDraft.worktreeBranch} ${selectedDraft.worktreePath}`.trim(), t('workspacePage.chainWorktreeFallback')),
      hint: t('workspacePage.chainWorktreeHint'),
    },
  ]), [selectedDraft, t]);

  const renderOverviewPage = () => (
    <div className="workspace-page-grid">
      <WorkspaceSurface
        title={t('workspacePage.mapTitle')}
        description={t('workspacePage.mapDesc')}
        className="workspace-surface--wide"
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2.5" width="5" height="5" rx="1" />
            <rect x="9.5" y="2.5" width="5" height="5" rx="1" />
            <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
            <path d="M12 9.5v5" />
            <path d="M9.5 12h5" />
          </svg>
        }
      >
        <div className="workspace-route-grid">
          {routeItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`workspace-route-card${selectedSection === item.id ? ' workspace-route-card--active' : ''}`}
              onClick={() => handleSectionChange(item.id)}
            >
              <div className="workspace-route-card__header">
                <span className="workspace-route-card__title">{item.title}</span>
                <span className="workspace-route-card__route">{item.id === 'overview' ? '/*' : `/${item.id}`}</span>
              </div>
              <div className="workspace-route-card__purpose">{item.purpose}</div>
              <div className="workspace-route-card__links">
                <span>{item.upstream}</span>
                <span>{item.downstream}</span>
              </div>
            </button>
          ))}
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.chainTitle')}
        description={t('workspacePage.chainDesc')}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.5 5.5h6" />
            <path d="M6.5 8h6" />
            <path d="M6.5 10.5h4" />
            <circle cx="3.5" cy="5.5" r="1" />
            <circle cx="3.5" cy="8" r="1" />
            <circle cx="3.5" cy="10.5" r="1" />
          </svg>
        }
      >
        <div className="workspace-chain-list">
          {chainItems.map((item) => (
            <button
              key={`${item.page}-${item.label}`}
              type="button"
              className="workspace-chain-row"
              onClick={() => handleSectionChange(item.page)}
            >
              <div className="workspace-chain-row__left">
                <span className="workspace-chain-row__label">{item.label}</span>
                <span className="workspace-chain-row__hint">{item.hint}</span>
              </div>
              <div className="workspace-chain-row__value">{item.value}</div>
            </button>
          ))}
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.connectionsTitle')}
        description={t('workspacePage.connectionsDesc')}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5.5 4L10 8l-4.5 4" />
            <path d="M2 8h8" />
            <path d="M12 4v8" />
          </svg>
        }
      >
        <div className="workspace-compact-list">
          <div className="workspace-compact-list__row">
            <span>{t('workspacePage.connectionsIssue')}</span>
            <strong>{previewText(selectedDraft.linkedIssue, t('workspacePage.connectionsIssueFallback'))}</strong>
          </div>
          <div className="workspace-compact-list__row">
            <span>{t('workspacePage.connectionsTask')}</span>
            <strong>{previewText(selectedDraft.activeTask || selectedDraft.objective, t('workspacePage.connectionsTaskFallback'))}</strong>
          </div>
          <div className="workspace-compact-list__row">
            <span>{t('workspacePage.connectionsResult')}</span>
            <strong className={worktreeReady ? 'workspace-status--ready' : ''}>{worktreeReady ? t('workspacePage.connectionsResultReady') : t('workspacePage.connectionsResultPending')}</strong>
          </div>
        </div>
      </WorkspaceSurface>
    </div>
  );

  const renderTasksPage = () => (
    <div className="workspace-page-grid">
      <WorkspaceSurface
        title={t('workspacePage.missionTitle')}
        description={t('workspacePage.missionDesc')}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4h12" />
            <path d="M2 8h9" />
            <path d="M2 12h6" />
          </svg>
        }
      >
        <div className="workspace-field-stack">
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.linkedIssueLabel')}</span>
            <input
              value={selectedDraft.linkedIssue}
              onChange={(event) => updateDraft((draft) => ({ ...draft, linkedIssue: event.target.value }))}
              placeholder={t('workspacePage.linkedIssuePlaceholder')}
            />
          </label>
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.objectiveLabel')}</span>
            <textarea
              value={selectedDraft.objective}
              onChange={(event) => updateDraft((draft) => ({ ...draft, objective: event.target.value }))}
              placeholder={t('workspacePage.objectivePlaceholder')}
              rows={5}
            />
          </label>
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.activeTaskLabel')}</span>
            <textarea
              value={selectedDraft.activeTask}
              onChange={(event) => updateDraft((draft) => ({ ...draft, activeTask: event.target.value }))}
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
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3v10" />
            <circle cx="3" cy="3" r="1.5" />
            <circle cx="3" cy="13" r="1.5" />
            <path d="M7 6h6" />
            <path d="M7 10h4" />
          </svg>
        }
        action={(
          <button type="button" className="btn-primary workspace-add-step-btn" onClick={handleAddStep}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M6 2v8" />
              <path d="M2 6h8" />
            </svg>
            {t('workspacePage.addStep')}
          </button>
        )}
      >
        {selectedDraft.steps.length === 0 ? (
          <div className="workspace-empty-hint">{t('workspacePage.emptyFlow')}</div>
        ) : (
          <div className="workspace-step-list">
            {selectedDraft.steps.map((step, index) => (
              <div key={step.id} className={`workspace-step workspace-step--${step.status}`}>
                <button
                  type="button"
                  className={`workspace-step__status workspace-step__status--${step.status}`}
                  onClick={() => {
                    updateDraft((draft) => ({
                      ...draft,
                      steps: draft.steps.map((item) => (
                        item.id === step.id ? { ...item, status: nextStepStatus(item.status) } : item
                      )),
                    }));
                  }}
                >
                  {t(`workspacePage.step${step.status.charAt(0).toUpperCase()}${step.status.slice(1)}`)}
                </button>
                <div className="workspace-step__index">{String(index + 1).padStart(2, '0')}</div>
                <input
                  className="workspace-step__input"
                  value={step.title}
                  onChange={(event) => {
                    const nextTitle = event.target.value;
                    updateDraft((draft) => ({
                      ...draft,
                      steps: draft.steps.map((item) => (
                        item.id === step.id ? { ...item, title: nextTitle } : item
                      )),
                    }));
                  }}
                  placeholder={t('workspacePage.stepTitlePlaceholder')}
                />
                <button
                  type="button"
                  className="workspace-step__delete"
                  onClick={() => {
                    updateDraft((draft) => ({
                      ...draft,
                      steps: draft.steps.filter((item) => item.id !== step.id),
                    }));
                  }}
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

  const renderRuntimePage = () => (
    <div className="workspace-page-grid">
      <WorkspaceSurface
        title={t('workspacePage.runtimeTitle')}
        description={t('workspacePage.runtimeDesc')}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M5 7l2 2-2 2" />
            <path d="M9 11h3" />
          </svg>
        }
      >
        <div className="workspace-field-grid">
          <label className="workspace-field">
            <span>{t('workspacePage.agentLabel')}</span>
            <input
              value={selectedDraft.primaryAgent}
              onChange={(event) => updateDraft((draft) => ({ ...draft, primaryAgent: event.target.value }))}
              placeholder={t('workspacePage.agentPlaceholder')}
            />
          </label>
          <label className="workspace-field">
            <span>{t('workspacePage.modelLabel')}</span>
            <input
              value={selectedDraft.executionModel}
              onChange={(event) => updateDraft((draft) => ({ ...draft, executionModel: event.target.value }))}
              placeholder={t('workspacePage.modelPlaceholder')}
            />
          </label>
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.terminalFocusLabel')}</span>
            <input
              value={selectedDraft.terminalFocus}
              onChange={(event) => updateDraft((draft) => ({ ...draft, terminalFocus: event.target.value }))}
              placeholder={t('workspacePage.terminalFocusPlaceholder')}
            />
          </label>
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.runtimeNotesLabel')}</span>
            <textarea
              value={selectedDraft.runtimeNotes}
              onChange={(event) => updateDraft((draft) => ({ ...draft, runtimeNotes: event.target.value }))}
              placeholder={t('workspacePage.runtimeNotesPlaceholder')}
              rows={5}
            />
          </label>
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.runtimeFlowTitle')}
        description={t('workspacePage.runtimeFlowDesc')}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 8h3l2-4 2 8 2-4h3" />
          </svg>
        }
      >
        <div className="workspace-data-grid">
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.runtimeTaskSource')}</span>
            <strong className="workspace-data-card__value">{previewText(selectedDraft.activeTask || selectedDraft.objective, t('workspacePage.runtimeTaskSourceFallback'))}</strong>
            <span className="workspace-data-card__hint">{t('workspacePage.runtimeTaskSourceHint')}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.runtimeAgentOwner')}</span>
            <strong className="workspace-data-card__value">{previewText(`${selectedDraft.primaryAgent} ${selectedDraft.executionModel}`.trim(), t('workspacePage.runtimeAgentOwnerFallback'))}</strong>
            <span className="workspace-data-card__hint">{t('workspacePage.runtimeAgentOwnerHint')}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.runtimeTerminalLane')}</span>
            <strong className="workspace-data-card__value">{previewText(selectedDraft.terminalFocus, t('workspacePage.runtimeTerminalLaneFallback'))}</strong>
            <span className="workspace-data-card__hint">{t('workspacePage.runtimeTerminalLaneHint')}</span>
          </article>
        </div>
      </WorkspaceSurface>
    </div>
  );

  const renderContextPage = () => (
    <div className="workspace-page-grid">
      <WorkspaceSurface
        title={t('workspacePage.notesTitle')}
        description={t('workspacePage.notesDesc')}
        className="workspace-surface--wide"
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 2.5h10a1 1 0 011 1v9a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1z" />
            <path d="M5 6h6" />
            <path d="M5 9h4" />
          </svg>
        }
      >
        <div className="workspace-field-grid">
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.notesLabel')}</span>
            <textarea
              value={selectedDraft.notes}
              onChange={(event) => updateDraft((draft) => ({ ...draft, notes: event.target.value }))}
              placeholder={t('workspacePage.notesPlaceholder')}
              rows={6}
            />
          </label>
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.imagesLabel')}</span>
            <textarea
              value={selectedDraft.imageRefs}
              onChange={(event) => updateDraft((draft) => ({ ...draft, imageRefs: event.target.value }))}
              placeholder={t('workspacePage.imagesPlaceholder')}
              rows={5}
            />
          </label>
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.contextFlowTitle')}
        description={t('workspacePage.contextFlowDesc')}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5v3l2 2" />
          </svg>
        }
      >
        <div className="workspace-compact-list">
          <div className="workspace-compact-list__row">
            <span>{t('workspacePage.contextFlowNotes')}</span>
            <strong>{countWorkspaceArtifacts(selectedDraft.notes).toString()}</strong>
          </div>
          <div className="workspace-compact-list__row">
            <span>{t('workspacePage.contextFlowImages')}</span>
            <strong>{countWorkspaceArtifacts(selectedDraft.imageRefs).toString()}</strong>
          </div>
          <div className="workspace-compact-list__row">
            <span>{t('workspacePage.contextFlowNext')}</span>
            <strong>{previewText(selectedDraft.runtimeNotes || selectedDraft.notes, t('workspacePage.contextFlowNextFallback'))}</strong>
          </div>
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.contextLinksTitle')}
        description={t('workspacePage.contextLinksDesc')}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 9l-2.5 2.5a1.77 1.77 0 01-2.5-2.5L4.5 6.5" />
            <path d="M9 7l2.5-2.5a1.77 1.77 0 012.5 2.5L11.5 9.5" />
            <path d="M6 10l4-4" />
          </svg>
        }
      >
        <div className="workspace-data-grid workspace-data-grid--single">
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.contextLinksTask')}</span>
            <strong className="workspace-data-card__value">{previewText(selectedDraft.activeTask || selectedDraft.objective, t('workspacePage.contextLinksTaskFallback'))}</strong>
            <span className="workspace-data-card__hint">{t('workspacePage.contextLinksTaskHint')}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.contextLinksRuntime')}</span>
            <strong className="workspace-data-card__value">{previewText(selectedDraft.runtimeNotes || selectedDraft.terminalFocus, t('workspacePage.contextLinksRuntimeFallback'))}</strong>
            <span className="workspace-data-card__hint">{t('workspacePage.contextLinksRuntimeHint')}</span>
          </article>
        </div>
      </WorkspaceSurface>
    </div>
  );

  const renderWorktreePage = () => (
    <div className="workspace-page-grid">
      <WorkspaceSurface
        title={t('workspacePage.worktreeTitle')}
        description={t('workspacePage.worktreeDesc')}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 3v10" />
            <path d="M5 7c3 0 5-2 8-2" />
            <circle cx="5" cy="3" r="1.5" />
            <circle cx="5" cy="13" r="1.5" />
            <circle cx="13" cy="5" r="1.5" />
          </svg>
        }
      >
        <div className="workspace-field-stack">
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.worktreeBranchLabel')}</span>
            <input
              value={selectedDraft.worktreeBranch}
              onChange={(event) => updateDraft((draft) => ({ ...draft, worktreeBranch: event.target.value }))}
              placeholder={t('workspacePage.worktreeBranchPlaceholder')}
            />
          </label>
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.worktreePathLabel')}</span>
            <input
              value={selectedDraft.worktreePath}
              onChange={(event) => updateDraft((draft) => ({ ...draft, worktreePath: event.target.value }))}
              placeholder={t('workspacePage.worktreePathPlaceholder')}
            />
          </label>
          <label className="workspace-field workspace-field--full">
            <span>{t('workspacePage.worktreeGoalLabel')}</span>
            <textarea
              value={selectedDraft.worktreeGoal}
              onChange={(event) => updateDraft((draft) => ({ ...draft, worktreeGoal: event.target.value }))}
              placeholder={t('workspacePage.worktreeGoalPlaceholder')}
              rows={4}
            />
          </label>
        </div>
      </WorkspaceSurface>

      <WorkspaceSurface
        title={t('workspacePage.worktreeLinksTitle')}
        description={t('workspacePage.worktreeLinksDesc')}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 9l-2.5 2.5a1.77 1.77 0 01-2.5-2.5L4.5 6.5" />
            <path d="M9 7l2.5-2.5a1.77 1.77 0 012.5 2.5L11.5 9.5" />
            <path d="M6 10l4-4" />
          </svg>
        }
      >
        <div className="workspace-data-grid">
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.worktreeLinksIssue')}</span>
            <strong className="workspace-data-card__value">{previewText(selectedDraft.linkedIssue, t('workspacePage.worktreeLinksIssueFallback'))}</strong>
            <span className="workspace-data-card__hint">{t('workspacePage.worktreeLinksIssueHint')}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.worktreeLinksRuntime')}</span>
            <strong className="workspace-data-card__value">{previewText(selectedDraft.terminalFocus || selectedDraft.primaryAgent, t('workspacePage.worktreeLinksRuntimeFallback'))}</strong>
            <span className="workspace-data-card__hint">{t('workspacePage.worktreeLinksRuntimeHint')}</span>
          </article>
          <article className="workspace-data-card">
            <span className="workspace-data-card__label">{t('workspacePage.worktreeLinksOutcome')}</span>
            <strong className="workspace-data-card__value">{previewText(selectedDraft.worktreeGoal, t('workspacePage.worktreeLinksOutcomeFallback'))}</strong>
            <span className="workspace-data-card__hint">{t('workspacePage.worktreeLinksOutcomeHint')}</span>
          </article>
        </div>
      </WorkspaceSurface>
    </div>
  );

  const renderSectionPage = () => {
    switch (selectedSection) {
      case 'kanban':
        return kanbanContent ?? <div className="workspace-empty-hint">{t('workspacePage.tabKanbanDesc')}</div>;
      case 'tasks':
        return renderTasksPage();
      case 'runtime':
        return renderRuntimePage();
      case 'context':
        return renderContextPage();
      case 'worktree':
        return renderWorktreePage();
      default:
        return renderOverviewPage();
    }
  };

  const sectionIcons: Record<WorkspaceSectionId, ReactNode> = useMemo(() => ({
    overview: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="5" height="5" rx="1" />
        <rect x="9" y="2" width="5" height="5" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" />
        <rect x="9" y="9" width="5" height="5" rx="1" />
      </svg>
    ),
    kanban: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="3.5" height="12" rx="1" />
        <rect x="6.25" y="2" width="3.5" height="8" rx="1" />
        <rect x="10.5" y="2" width="3.5" height="10" rx="1" />
      </svg>
    ),
    tasks: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4h8" />
        <path d="M4 8h6" />
        <path d="M4 12h4" />
        <circle cx="2" cy="4" r="0.6" fill="currentColor" stroke="none" />
        <circle cx="2" cy="8" r="0.6" fill="currentColor" stroke="none" />
        <circle cx="2" cy="12" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    ),
    runtime: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <path d="M5 7l2 2-2 2" />
        <path d="M9 11h3" />
      </svg>
    ),
    context: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 2.5h10a1 1 0 011 1v9a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1z" />
        <path d="M5 6h6" />
        <path d="M5 9h4" />
      </svg>
    ),
    worktree: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 3v10" />
        <path d="M5 7c3 0 5-2 8-2" />
        <circle cx="5" cy="3" r="1.2" />
        <circle cx="5" cy="13" r="1.2" />
        <circle cx="13" cy="5" r="1.2" />
      </svg>
    ),
  }), []);

  if (projectOptions.length === 0) {
    return (
      <DesktopPageShell
        className="workspace-panel"
        title={t('workspacePage.title')}
        windowControls={windowControls}
      >
        <div className="desktop-page-surface">
          <DesktopEmptyState
            icon={(
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="10" width="14" height="28" rx="2.5" />
                <rect x="24" y="8" width="18" height="14" rx="2.5" />
                <path d="M24 28h18" />
                <path d="M24 34h12" />
                <path d="M13 18h0.01" />
                <path d="M13 24h0.01" />
                <path d="M13 30h0.01" />
              </svg>
            )}
            title={t('workspacePage.noProjects')}
            description={t('workspacePage.noProjectsHint')}
          />
        </div>
      </DesktopPageShell>
    );
  }

  return (
    <section className="desktop-page-shell workspace-panel workspace-panel--octarine">
      <header className="workspace-topbar" data-tauri-drag-region>
        <div className="workspace-topbar__left" data-tauri-drag-region>
          <span className="workspace-topbar__title">{t('workspacePage.title')}</span>
          <span className="workspace-topbar__sep">/</span>
          <span className="workspace-topbar__section-name">{currentSectionMeta.label}</span>
          {activeIssueId && activeScopeLabel ? (
            <>
              <span className="workspace-topbar__sep">/</span>
              <span className="workspace-topbar__scope-badge">{activeScopeLabel}</span>
            </>
          ) : null}
        </div>
        <div className="workspace-topbar__right">
          <span className="workspace-topbar__saved">
            {t('workspacePage.savedAt', { time: new Date(selectedDraft.lastUpdatedAt).toLocaleString() })}
          </span>
          {windowControls ? windowControls : null}
        </div>
      </header>

      <div className="workspace-layout">
        <aside className="workspace-sidebar">
          <div className="workspace-sidebar__project">
            <select
              className="workspace-sidebar__project-select"
              value={selectedProjectId ?? ''}
              onChange={(event) => handleSelectProject(event.target.value)}
            >
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <nav className="workspace-sidebar__nav">
            {sectionMetas.map((meta) => (
              <button
                key={meta.id}
                type="button"
                className={`workspace-sidebar__item${selectedSection === meta.id ? ' workspace-sidebar__item--active' : ''}`}
                onClick={() => handleSectionChange(meta.id)}
              >
                <span className="workspace-sidebar__item-icon">
                  {sectionIcons[meta.id]}
                </span>
                <span className="workspace-sidebar__item-label">{meta.label}</span>
              </button>
            ))}
          </nav>

          <div className="workspace-sidebar__status">
            {summaryPills.map((pill) => (
              <div key={pill.key} className={`workspace-sidebar__pill workspace-sidebar__pill--${pill.tone}`}>
                <span className="workspace-sidebar__pill-label">{pill.label}</span>
                <span className="workspace-sidebar__pill-value">{pill.value}</span>
              </div>
            ))}
          </div>

          <div className="workspace-sidebar__footer">
            <button type="button" className="workspace-sidebar__reset-btn" onClick={handleResetWorkspace}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 8a6 6 0 0111.47-2.47" />
                <path d="M14 8a6 6 0 01-11.47 2.47" />
                <path d="M14 2v4h-4" />
                <path d="M2 14v-4h4" />
              </svg>
              {t('workspacePage.reset')}
            </button>
          </div>
        </aside>

        <main className="workspace-main">
          <div className="workspace-main__header">
            <h2 className="workspace-main__title">{currentSectionMeta.label}</h2>
            <p className="workspace-main__desc">{currentSectionMeta.description}</p>
          </div>
          <div className="workspace-main__content">
            {renderSectionPage()}
          </div>
        </main>
      </div>
    </section>
  );
});
