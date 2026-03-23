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
import { ThreadView } from '../ThreadView';
import { KanbanColumn } from './KanbanColumn';
import { FilterBar } from './FilterBar';
import { IssueDialog } from './IssueDialog';
import {
  genId,
  projectNameFromId,
  formatDateTime,
  nowUnixSeconds,
  getLastTurn,
  turnStatusToExecutionState,
  formatErrorMessage,
  extractExecutionResultSummary,
  buildIssueExecutionPrompt,
  useLocalStorage,
} from './kanban-helpers';
export type { KanbanProject, KanbanExecCallbacks } from './kanban-helpers';

const THREAD_POLL_INTERVAL_MS = 3000;

export const KanbanPanel = memo(function KanbanPanel({
  projects,
  executionSyncVersion,
  executionModelLabel,
  execCallbacks,
}: {
  projects: import('./kanban-helpers').KanbanProject[];
  executionSyncVersion?: number;
  executionModelLabel?: string | null;
  execCallbacks?: import('./kanban-helpers').KanbanExecCallbacks;
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
  const threadPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  const startThreadPolling = useCallback((threadId: string, ownerSeq: number) => {
    if (threadPollRef.current) clearInterval(threadPollRef.current);
    threadPollRef.current = setInterval(async () => {
      if (!execCallbacks || ownerSeq !== threadViewSeqRef.current) {
        if (threadPollRef.current) clearInterval(threadPollRef.current);
        threadPollRef.current = null;
        return;
      }
      try {
        const detail = await execCallbacks.readThread(threadId);
        if (ownerSeq !== threadViewSeqRef.current) return;
        setThreadDetail(detail);
        const lastTurn = getLastTurn(detail);
        if (lastTurn && lastTurn.status !== 'inProgress') {
          if (threadPollRef.current) clearInterval(threadPollRef.current);
          threadPollRef.current = null;
        }
      } catch { /* ignore */ }
    }, THREAD_POLL_INTERVAL_MS);
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

      let initialDetail: ThreadDetail | null = null;
      try {
        initialDetail = await execCallbacks.readThread(thread.id);
        if (execSeq === threadViewSeqRef.current) {
          setThreadDetail(initialDetail);
        }
      } catch {
        if (execSeq === threadViewSeqRef.current) {
          setThreadDetail(null);
        }
      } finally {
        if (execSeq === threadViewSeqRef.current) {
          setThreadLoading(false);
        }
      }

      if (initialDetail) {
        const settled = await syncExecutionStateFromThread({
          runId,
          issueId: issue.id,
          projectId,
          detail: initialDetail,
        });
        if (execSeq === threadViewSeqRef.current && !settled) {
          startThreadPolling(thread.id, execSeq);
        }
      } else if (execSeq === threadViewSeqRef.current) {
        startThreadPolling(thread.id, execSeq);
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
    if (threadPollRef.current) {
      clearInterval(threadPollRef.current);
      threadPollRef.current = null;
    }
  }, []);

  const handleViewThread = useCallback(async (issue: KanbanIssue) => {
    if (!execCallbacks || !issue.linked_thread_id) return;
    const seq = ++threadViewSeqRef.current;
    setViewingThreadIssue(issue);
    setThreadLoading(true);
    setThreadDetail(null);
    try {
      const detail = await execCallbacks.readThread(issue.linked_thread_id);
      if (seq !== threadViewSeqRef.current) return;
      setThreadDetail(detail);
      startThreadPolling(issue.linked_thread_id, seq);
    } catch {
      if (seq === threadViewSeqRef.current) {
        setThreadDetail(null);
      }
    } finally {
      if (seq === threadViewSeqRef.current) {
        setThreadLoading(false);
      }
    }
  }, [execCallbacks, startThreadPolling]);

  useEffect(() => {
    return () => {
      if (threadPollRef.current) clearInterval(threadPollRef.current);
    };
  }, []);

  const deletingIssue = deletingIssueId ? issues.find((i) => i.id === deletingIssueId) : null;

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
    <div className="kanban-panel">
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
        )}

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
                executingIssueIds={executingIssueIds}
              />
            ))}
          </div>
        ) : null}
      </div>

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
    </div>
  );
});
