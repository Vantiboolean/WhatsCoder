import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { previewWorkspaceText } from '../../lib/workspace/workspaceSummary';
import { useWorkspaceController } from '../../lib/workspace/workspaceController';
import type { WorkspaceExecBridge } from '../../lib/workspace/workspaceExecBridge';
import type { WorkspaceDraftPrefill, WorkspaceSectionId } from '../../lib/workspace/types';
import { DesktopEmptyState } from '../layout/DesktopPageShell';
import { ContextSection } from './sections/ContextSection';
import { OverviewSection } from './sections/OverviewSection';
import { RuntimeSection } from './sections/RuntimeSection';
import { TasksSection } from './sections/TasksSection';
import { WorktreeSection } from './sections/WorktreeSection';

export type { WorkspaceDraftPrefill, WorkspaceSectionId } from '../../lib/workspace/types';

const WORKSPACE_SECTION_STORAGE_KEY = 'codex-workspace-panel-section-v1';

type WorkspaceSectionMeta = {
  id: WorkspaceSectionId;
  label: string;
  description: string;
};

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

export const WorkspacePanel = memo(function WorkspacePanel({
  activeProjectId,
  activeIssueId,
  activeIssueLabel,
  activeWorkspaceRoots,
  folderAlias,
  execBridge,
  section,
  prefill,
  kanbanContent,
  onPrefillConsumed,
  onSectionChange,
  onProjectSelect,
  windowControls,
}: {
  activeProjectId?: string | null;
  activeIssueId?: string | null;
  activeIssueLabel?: string | null;
  activeWorkspaceRoots: string[];
  folderAlias: Record<string, string>;
  execBridge: WorkspaceExecBridge;
  section?: WorkspaceSectionId;
  prefill?: WorkspaceDraftPrefill | null;
  kanbanContent?: ReactNode;
  onPrefillConsumed?: (seedId: string) => void;
  onSectionChange?: (section: WorkspaceSectionId) => void;
  onProjectSelect?: (projectId: string) => void;
  windowControls?: ReactNode;
}) {
  const { t } = useTranslation();
  const [localSection, setLocalSection] = useState<WorkspaceSectionId>(() => loadSection());
  const selectedSection = section ?? localSection;

  const controller = useWorkspaceController({
    activeProjectId,
    activeIssueId,
    activeIssueLabel,
    activeWorkspaceRoots,
    folderAlias,
    prefill,
    onPrefillConsumed,
    onProjectSelect,
    execBridge,
  });

  useEffect(() => {
    if (section !== undefined) return;
    try {
      localStorage.setItem(WORKSPACE_SECTION_STORAGE_KEY, selectedSection);
    } catch {
      // Ignore local persistence failures in the UI shell.
    }
  }, [section, selectedSection]);

  const handleSectionChange = (nextSection: WorkspaceSectionId) => {
    if (section === undefined) {
      setLocalSection(nextSection);
    }
    onSectionChange?.(nextSection);
  };

  const sectionMetas = useMemo<WorkspaceSectionMeta[]>(() => ([
    { id: 'overview', label: t('workspacePage.tabOverview'), description: t('workspacePage.tabOverviewDesc') },
    { id: 'kanban', label: t('workspacePage.tabKanban'), description: t('workspacePage.tabKanbanDesc') },
    { id: 'tasks', label: t('workspacePage.tabTasks'), description: t('workspacePage.tabTasksDesc') },
    { id: 'runtime', label: t('workspacePage.tabRuntime'), description: t('workspacePage.tabRuntimeDesc') },
    { id: 'context', label: t('workspacePage.tabContext'), description: t('workspacePage.tabContextDesc') },
    { id: 'worktree', label: t('workspacePage.tabWorktree'), description: t('workspacePage.tabWorktreeDesc') },
  ]), [t]);

  const currentSectionMeta = sectionMetas.find((meta) => meta.id === selectedSection) ?? sectionMetas[0];
  const summary = controller.bundle?.summary;
  const summaryPills = useMemo(() => ([
    {
      key: 'tasks',
      label: t('workspacePage.summaryTasks'),
      value: `${summary?.completedSteps ?? 0}/${summary?.totalSteps ?? 0}`,
      tone: (summary?.totalSteps ?? 0) > 0 ? 'blue' : 'muted',
    },
    {
      key: 'runtime',
      label: t('workspacePage.summaryRuntime'),
      value: summary?.runtimeReady ? t('workspacePage.ready') : t('workspacePage.pending'),
      tone: summary?.runtimeReady ? 'green' : 'orange',
    },
    {
      key: 'artifacts',
      label: t('workspacePage.summaryArtifacts'),
      value: String(summary?.artifactCount ?? 0),
      tone: (summary?.artifactCount ?? 0) > 0 ? 'purple' : 'muted',
    },
    {
      key: 'worktree',
      label: t('workspacePage.summaryWorktree'),
      value: summary?.worktreeReady ? t('workspacePage.ready') : t('workspacePage.pending'),
      tone: summary?.worktreeReady ? 'green' : 'orange',
    },
  ]), [summary?.artifactCount, summary?.completedSteps, summary?.runtimeReady, summary?.totalSteps, summary?.worktreeReady, t]);

  const activeScopeLabel = controller.bundle?.scope.scopeType === 'issue'
    ? previewWorkspaceText(
      controller.bundle.scope.linkedIssue || controller.bundle.scope.issueLabel || controller.bundle.scope.issueId,
      controller.bundle.scope.scopeId,
      68,
    )
    : '';
  const savedAt = controller.bundle?.scope.updatedAt
    ? new Date(controller.bundle.scope.updatedAt * 1000).toLocaleString()
    : null;

  const renderSectionPage = () => {
    switch (selectedSection) {
      case 'kanban':
        return kanbanContent ?? <div className="workspace-empty-hint">{t('workspacePage.tabKanbanDesc')}</div>;
      case 'tasks':
        return <TasksSection controller={controller} />;
      case 'runtime':
        return <RuntimeSection controller={controller} />;
      case 'context':
        return <ContextSection controller={controller} />;
      case 'worktree':
        return <WorktreeSection controller={controller} />;
      default:
        return <OverviewSection controller={controller} onSectionChange={handleSectionChange} />;
    }
  };

  const sectionIcons: Record<WorkspaceSectionId, ReactNode> = {
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
  };

  if (controller.projectOptions.length === 0 && !controller.loading) {
    return (
      <section className="desktop-page-shell workspace-panel">
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
      </section>
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
          {savedAt ? <span className="workspace-topbar__saved">{t('workspacePage.savedAt', { time: savedAt })}</span> : null}
          {windowControls ?? null}
        </div>
      </header>

      <div className="workspace-layout">
        <aside className="workspace-sidebar">
          <div className="workspace-sidebar__project">
            <select
              className="workspace-sidebar__project-select"
              value={controller.selectedProjectId ?? ''}
              onChange={(event) => controller.selectProject(event.target.value)}
            >
              {controller.projectOptions.map((project) => (
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
                <span className="workspace-sidebar__item-icon">{sectionIcons[meta.id]}</span>
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
            <button type="button" className="workspace-sidebar__reset-btn" onClick={() => void controller.refreshBundle()}>
              {t('workspacePage.refresh')}
            </button>
          </div>
        </aside>

        <main className="workspace-main">
          <div className="workspace-main__header">
            <h2 className="workspace-main__title">{currentSectionMeta.label}</h2>
            <p className="workspace-main__desc">{currentSectionMeta.description}</p>
          </div>
          <div className="workspace-main__content">
            {controller.loading && !controller.bundle ? (
              <div className="workspace-empty-hint">{t('workspacePage.loading')}</div>
            ) : renderSectionPage()}
          </div>
        </main>
      </div>
    </section>
  );
});
