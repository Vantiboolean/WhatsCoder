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
  countKanbanComments,
  linkThreadToIssue,
  maybeNormalizeSortOrders,
  KANBAN_COLUMNS,
  type KanbanIssue,
  type KanbanExecutionState,
  type KanbanRunTriggerSource,
  type KanbanStatus,
  type KanbanPriority,
} from '../../lib/kanbanDb';
import type { ThreadDetail } from '@whats-coder/shared';
import {
  buildIssueDraftKey,
  createEmptyWorkspaceDraft,
  getWorkspaceDraftSummary,
  loadWorkspaceDraftMap,
  type WorkspaceDraftSummary,
} from '../../lib/workspaceDrafts';
import { DesktopEmptyState, DesktopPageShell } from '../DesktopPageShell';
import type { WorkspaceDraftPrefill, WorkspaceSectionId } from '../WorkspacePanel';
import { ThreadView } from '../ThreadView';
import { KanbanColumn } from './KanbanColumn';
import { FilterBar } from './FilterBar';
import { IssueDialog } from './IssueDialog';
import {
  genId,
  projectNameFromId,
  nowUnixSeconds,
  formatErrorMessage,
  buildIssueExecutionPrompt,
  useLocalStorage,
} from './kanban-helpers';
export type { KanbanProject, KanbanExecCallbacks } from './kanban-helpers';

const KANBAN_STATUS_COLORS: Record<KanbanStatus, string> = {
  todo: 'var(--accent-blue)',
  in_progress: 'var(--accent-yellow, #eab308)',
  in_review: 'var(--accent-purple, #a855f7)',
  done: 'var(--accent-green)',
};
const EMPTY_WORKSPACE_SUMMARY = getWorkspaceDraftSummary(createEmptyWorkspaceDraft());

export const KanbanPanel = memo(function KanbanPanel({
  projects,
  activeProjectId,
  onProjectSelect,
  embedded = false,
  executionSyncVersion,
  executionModelLabel,
  observedThreadId,
  observedThreadDetail,
  onOpenWorkspace,
  execCallbacks,
  windowControls,
}: {
  projects: import('./kanban-helpers').KanbanProject[];
  activeProjectId?: string | null;
  onProjectSelect?: (projectId: string) => void;
  embedded?: boolean;
  executionSyncVersion?: number;
  executionModelLabel?: string | null;
  observedThreadId?: string | null;
  observedThreadDetail?: ThreadDetail | null;
  onOpenWorkspace?: (params: { projectId: string; section: WorkspaceSectionId; prefill?: WorkspaceDraftPrefill }) => void;
  execCallbacks?: import('./kanban-helpers').KanbanExecCallbacks;
  windowControls?: import('react').ReactNode;
}) {
  const { t } = useTranslation();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectOptions, setProjectOptions] = useState<import('./kanban-helpers').KanbanProject[]>(projects);
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

  const [autoRun, setAutoRun] = useLocalStorage('kanban-auto-run', false);
  const [viewingThreadIssue, setViewingThreadIssue] = useState<KanbanIssue | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [executingIssueIds, setExecutingIssueIds] = useState<Set<string>>(new Set());
  const [deletingIssueId, setDeletingIssueId] = useState<string | null>(null);
  const threadViewSeqRef = useRef(0);

  const selectedProject = projectOptions.find((p) => p.id === selectedProjectId) ?? null;

  const refreshProjectOptions = useCallback(async () => {
    try {
      const dbProjectIds = await listKanbanProjectIds();
      const merged = new Map<string, import('./kanban-helpers').KanbanProject>();
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
    if (activeProjectId && activeProjectId !== selectedProjectId) {
      setSelectedProjectId(activeProjectId);
      return;
    }

    if (projectOptions.length > 0 && (!selectedProjectId || !projectOptions.find((p) => p.id === selectedProjectId))) {
      setSelectedProjectId(projectOptions[0].id);
    }
  }, [activeProjectId, projectOptions, selectedProjectId]);

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
    onProjectSelect?.(id);
    setSearchQuery('');
    setPriorityFilter('all');
    setTagFilter('');
  }, [onProjectSelect]);

  const buildWorkspacePrefill = useCallback((issue: KanbanIssue): WorkspaceDraftPrefill => {
    const linkedIssue = issue.issue_number > 0 ? `#${issue.issue_number} ${issue.title}` : issue.title;
    const objective = issue.description?.trim() || issue.title;
    return {
      seedId: `kanban-issue-${issue.id}-${Date.now()}`,
      projectId: issue.project_id,
      issueId: issue.id,
      issueLabel: linkedIssue,
      linkedIssue,
      objective,
      activeTask: issue.title,
    };
  }, []);

  const handleOpenWorkspaceForIssue = useCallback((issue: KanbanIssue, section: WorkspaceSectionId) => {
    onOpenWorkspace?.({
      projectId: issue.project_id,
      section,
      prefill: buildWorkspacePrefill(issue),
    });
  }, [buildWorkspacePrefill, onOpenWorkspace]);

  const handleAddIssue = useCallback((status: KanbanStatus) => {
    setCreatingForStatus(status);
    setEditingIssue(null);
  }, []);

  const handleExecuteIssue = useCallback(async (
    issue: KanbanIssue,
    triggerSource: KanbanRunTriggerSource = 'manual',
  ) => {
    if (!execCallbacks) return;
    const projectId = issue.project_id || selectedProjectId;
    if (!projectId) return;
    const shouldRevealExecution = triggerSource === 'manual';
    const runId = genId();
    const startedAt = nowUnixSeconds();
    let thread: { id: string } | null = null;
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

      if (shouldRevealExecution) {
        const linkedIssue: KanbanIssue = {
          ...issue,
          linked_thread_id: thread.id,
          status: newStatus,
          last_run_status: 'RUNNING' as KanbanExecutionState,
          last_run_at: startedAt,
          last_finished_at: null,
          last_error: null,
        };
        const execSeq = ++threadViewSeqRef.current;
        setViewingThreadIssue(linkedIssue);
        setThreadLoading(true);
        setThreadDetail(null);
        execCallbacks.setObservedThread?.({ threadId: thread.id, detail: null });

        try {
          const initialDetail = await execCallbacks.readThread(thread.id);
          if (execSeq === threadViewSeqRef.current) {
            setThreadDetail(initialDetail);
          }
          await execCallbacks.onThreadObserved?.({
            threadId: thread.id,
            detail: initialDetail,
            runId,
            issueId: issue.id,
          });
        } catch {
          if (execSeq === threadViewSeqRef.current) {
            setThreadDetail(null);
          }
        } finally {
          if (execSeq === threadViewSeqRef.current) {
            setThreadLoading(false);
          }
        }
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
      } catch { /* ignore secondary persistence failures */ }
      try {
        await updateKanbanIssueExecution(issue.id, {
          lastRunStatus: 'FAILED',
          lastFinishedAt: finishedAt,
          lastError: errorMessage,
        });
      } catch { /* ignore secondary persistence failures */ }
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

  const confirmDeleteIssue = useCallback(async (id: string) => {
    if (!selectedProjectId) return;
    setDeletingIssueId(null);
    try {
      await deleteKanbanIssue(id);
      await refreshIssues(selectedProjectId);
    } catch (err) {
      console.error('handleDeleteIssue failed:', err);
      setDbError(String(err));
    }
  }, [selectedProjectId, refreshIssues]);

  const handleRequestDeleteIssue = useCallback((id: string) => {
    setDeletingIssueId(id);
  }, []);

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
    await maybeNormalizeSortOrders(selectedProjectId, targetStatus);
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

  const donePercent = useMemo(() => {
    if (issues.length === 0) return 0;
    const doneCount = issues.reduce((count, issue) => count + (issue.status === 'done' ? 1 : 0), 0);
    return Math.round((doneCount / issues.length) * 100);
  }, [issues]);

  const activeFilterCount = useMemo(
    () => Number(Boolean(searchQuery)) + Number(priorityFilter !== 'all') + Number(Boolean(tagFilter)),
    [priorityFilter, searchQuery, tagFilter],
  );
  const workspaceSummaryByIssue = useMemo<Record<string, WorkspaceDraftSummary>>(() => {
    const draftMap = loadWorkspaceDraftMap();
    return Object.fromEntries(
      issues.map((issue) => {
        const issueDraft = draftMap[buildIssueDraftKey(issue.id)];
        return [issue.id, issueDraft ? getWorkspaceDraftSummary(issueDraft) : EMPTY_WORKSPACE_SUMMARY];
      }),
    );
  }, [issues]);

  useEffect(() => {
    if (!editingIssue) return;
    const freshIssue = issues.find((issue) => issue.id === editingIssue.id);
    if (freshIssue && freshIssue !== editingIssue) {
      setEditingIssue(freshIssue);
    }
  }, [editingIssue, issues]);

  const handleCloseThreadPanel = useCallback(() => {
    threadViewSeqRef.current += 1;
    setViewingThreadIssue(null);
    setThreadDetail(null);
    execCallbacks?.setObservedThread?.({ threadId: null, detail: null });
  }, [execCallbacks]);

  const handleViewThread = useCallback(async (issue: KanbanIssue) => {
    if (!execCallbacks || !issue.linked_thread_id) return;
    const seq = ++threadViewSeqRef.current;
    setViewingThreadIssue(issue);
    setThreadLoading(true);
    setThreadDetail(null);
    execCallbacks.setObservedThread?.({ threadId: issue.linked_thread_id, detail: null });
    try {
      const detail = await execCallbacks.readThread(issue.linked_thread_id);
      if (seq !== threadViewSeqRef.current) return;
      setThreadDetail(detail);
      await execCallbacks.onThreadObserved?.({
        threadId: issue.linked_thread_id,
        detail,
      });
    } catch {
      if (seq === threadViewSeqRef.current) {
        setThreadDetail(null);
      }
    } finally {
      if (seq === threadViewSeqRef.current) {
        setThreadLoading(false);
      }
    }
  }, [execCallbacks]);

  useEffect(() => {
    return () => {
      execCallbacks?.setObservedThread?.({ threadId: null, detail: null });
    };
  }, [execCallbacks]);

  useEffect(() => {
    if (!viewingThreadIssue?.linked_thread_id) return;
    if (!observedThreadId || observedThreadId !== viewingThreadIssue.linked_thread_id) return;
    if (!observedThreadDetail) return;
    setThreadDetail(observedThreadDetail);
    setThreadLoading(false);
  }, [observedThreadDetail, observedThreadId, viewingThreadIssue]);

  const deletingIssue = deletingIssueId ? issues.find((i) => i.id === deletingIssueId) : null;
  const filterBar = (
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
      executionModelLabel={executionModelLabel ?? null}
    />
  );
  const newIssueAction = (
    <button type="button" className="kanban-primary-action" onClick={() => handleAddIssue('todo')}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="6" y1="2" x2="6" y2="10" /><line x1="2" y1="6" x2="10" y2="6" /></svg>
      {t('kanban.newIssue')}
    </button>
  );

  const content = (
    <>
      {dbError && (
        <div className="kanban-error-banner" onClick={() => setDbError(null)}>
          <span>DB Error: {dbError}</span>
          <button onClick={() => setDbError(null)}>&#x2715;</button>
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
              onDeleteIssue={handleRequestDeleteIssue}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragOverCard={handleDragOverCard}
              onDrop={(e, s) => { void handleDrop(e, s); }}
              dragOverColumn={dragOverColumn}
              dragOverCardId={dragOverCardId}
              onExecuteIssue={execCallbacks ? (issue) => { void handleExecuteIssue(issue); } : undefined}
              onViewThread={execCallbacks ? (issue) => { void handleViewThread(issue); } : undefined}
              onOpenWorkspaceIssue={onOpenWorkspace ? (issue) => { handleOpenWorkspaceForIssue(issue, 'tasks'); } : undefined}
              executingIssueIds={executingIssueIds}
              workspaceSummaryByIssue={workspaceSummaryByIssue}
            />
          ))}
        </div>
      ) : null}

      {viewingThreadIssue && (
        <div className="kanban-dialog-backdrop kanban-dialog-backdrop--sheet" onClick={handleCloseThreadPanel}>
          <div
            className="kanban-dialog kanban-dialog--sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kanban-thread-sheet-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="kanban-dialog-header">
              <div className="kanban-thread-sheet-head-text">
                <h3 id="kanban-thread-sheet-title">
                  {viewingThreadIssue.issue_number > 0 && (
                    <span className="kanban-dialog-issue-num">#{viewingThreadIssue.issue_number}</span>
                  )}
                  {t('kanban.viewExecution')}
                </h3>
                {executionModelLabel ? (
                  <div className="kanban-thread-sheet-model">{t('kanban.executionModel', { model: executionModelLabel })}</div>
                ) : null}
              </div>
              <button type="button" className="kanban-dialog-close" onClick={handleCloseThreadPanel}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </div>
            <div className="kanban-dialog-body kanban-thread-sheet-body">
              {threadLoading ? (
                <div className="kanban-thread-panel-loading">{t('common.loading')}</div>
              ) : threadDetail ? (
                <ThreadView thread={threadDetail} hideHeader />
              ) : (
                <div className="kanban-thread-panel-empty">{t('kanban.noExecutionData')}</div>
              )}
            </div>
            <div className="kanban-dialog-footer">
              <div className="kanban-dialog-actions">
                {onOpenWorkspace ? (
                  <>
                    <button
                      type="button"
                      className="kanban-dialog-btn kanban-dialog-btn--secondary"
                      onClick={() => handleOpenWorkspaceForIssue(viewingThreadIssue, 'runtime')}
                    >
                      {t('kanban.openWorkspaceRuntime')}
                    </button>
                    <button
                      type="button"
                      className="kanban-dialog-btn kanban-dialog-btn--secondary"
                      onClick={() => handleOpenWorkspaceForIssue(viewingThreadIssue, 'context')}
                    >
                      {t('kanban.openWorkspaceContext')}
                    </button>
                  </>
                ) : null}
                <button type="button" className="kanban-dialog-btn kanban-dialog-btn--secondary" onClick={handleCloseThreadPanel}>
                  {t('common.close')}
                </button>
              </div>
            </div>
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
          onOpenWorkspace={onOpenWorkspace ? (issue, section) => { handleOpenWorkspaceForIssue(issue, section); } : undefined}
          onRerun={execCallbacks ? (issue) => { void handleExecuteIssue(issue, 'manual'); } : undefined}
          canExecute={!!execCallbacks}
          onClose={() => { setEditingIssue(null); setCreatingForStatus(null); }}
        />
      )}

      {deletingIssueId && (
        <div className="kanban-dialog-backdrop" onClick={() => setDeletingIssueId(null)}>
          <div className="kanban-dialog kanban-dialog--small" onClick={(e) => e.stopPropagation()}>
            <div className="kanban-dialog-header">
              <h3>{t('kanban.deleteConfirm')}</h3>
            </div>
            <div className="kanban-dialog-body">
              {deletingIssue && (
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
                  <strong>{deletingIssue.issue_number > 0 ? `#${deletingIssue.issue_number} ` : ''}{deletingIssue.title}</strong>
                  <br />
                  {t('kanban.deleteConfirmMessage')}
                </p>
              )}
            </div>
            <div className="kanban-dialog-footer">
              <div className="kanban-dialog-actions">
                <button className="kanban-dialog-btn kanban-dialog-btn--secondary" onClick={() => setDeletingIssueId(null)}>
                  {t('common.cancel')}
                </button>
                <button className="kanban-dialog-btn kanban-dialog-btn--danger" onClick={() => { void confirmDeleteIssue(deletingIssueId); }}>
                  {t('common.delete')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (projectOptions.length === 0) {
    if (embedded) {
      return (
        <div className="kanban-embedded kanban-embedded--empty">
          <DesktopEmptyState
            icon={(
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="8" width="12" height="32" rx="2" />
                <rect x="18" y="8" width="12" height="22" rx="2" />
                <rect x="32" y="8" width="12" height="28" rx="2" />
              </svg>
            )}
            title={t('kanban.noProjects')}
            description={t('kanban.noProjectsHint')}
          />
        </div>
      );
    }
    return (
      <DesktopPageShell
        className="kanban-panel"
        title={t('kanban.title')}
        windowControls={windowControls}
      >
        <div className="desktop-page-surface">
          <DesktopEmptyState
            icon={(
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="8" width="12" height="32" rx="2" />
                <rect x="18" y="8" width="12" height="22" rx="2" />
                <rect x="32" y="8" width="12" height="28" rx="2" />
              </svg>
            )}
            title={t('kanban.noProjects')}
            description={t('kanban.noProjectsHint')}
          />
        </div>
      </DesktopPageShell>
    );
  }

  if (embedded) {
    return (
      <div className="kanban-embedded">
        {selectedProject ? (
          <div className="kanban-toolbar kanban-toolbar--embedded">
            {filterBar}
            {newIssueAction}
          </div>
        ) : null}
        {content}
      </div>
    );
  }

  return (
    <DesktopPageShell
      className="kanban-panel"
      bodyClassName="kanban-panel__body"
      title={t('kanban.title')}
      windowControls={windowControls}
      toolbar={selectedProject ? (
        <div className="kanban-toolbar">
          <select
            className="kanban-project-select"
            value={selectedProjectId ?? ''}
            onChange={(e) => handleSelectProject(e.target.value)}
          >
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
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
            executionModelLabel={executionModelLabel ?? null}
          />
          {newIssueAction}
        </div>
      ) : (
        <select
          className="kanban-project-select"
          value={selectedProjectId ?? ''}
          onChange={(e) => handleSelectProject(e.target.value)}
        >
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}
    >
      {content}
    </DesktopPageShell>
  );
});
