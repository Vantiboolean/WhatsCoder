import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThreadDetail, ThreadItem } from '@whats-coder/shared';
import { listKanbanComments, listKanbanIssues, type KanbanComment, type KanbanIssue } from '../db/kanbanDb';
import {
  createWorkspaceRun,
  deleteWorkspaceContextItem,
  deleteWorkspaceExecutor,
  deleteWorkspaceWorktree,
  listWorkspaceProjects,
  loadWorkspaceBundle,
  migrateWorkspaceDraftsIfNeeded,
  replaceWorkspaceSteps,
  updateWorkspaceRun,
  upsertWorkspaceContextItem,
  upsertWorkspaceExecutor,
  upsertWorkspaceScope,
  upsertWorkspaceWorktree,
} from './workspaceDb';
import {
  buildWorkspaceExecutionPrompt,
  workspaceRunStatusFromThread,
  type GitWorktreeEntry,
  type WorkspaceExecBridge,
  type WorkspacePromptsResult,
} from './workspaceExecBridge';
import {
  buildIssueScopeId,
  buildProjectScopeId,
  createWorkspaceEntityId,
  fallbackProjectName,
  type WorkspaceBundle,
  type WorkspaceContextItemRecord,
  type WorkspaceContextKind,
  type WorkspaceDraftPrefill,
  type WorkspaceExecutorProvider,
  type WorkspaceExecutorRecord,
  type WorkspaceExecutorRunStatus,
  type WorkspaceProjectOption,
  type WorkspaceRunRecord,
  type WorkspaceRunStatus,
  type WorkspaceScopeId,
  type WorkspaceStepRecord,
  type WorkspaceStepStatus,
  type WorkspaceWorktreeRecord,
  type WorkspaceWorktreeStatus,
} from './types';

type ScopeSelection = {
  scopeId: WorkspaceScopeId;
  projectId: string;
  issueId: string | null;
  issueLabel: string | null;
};

export type WorkspaceControllerProjectOption = WorkspaceProjectOption & {
  scopeId: WorkspaceScopeId;
};

export type UseWorkspaceControllerArgs = {
  activeProjectId?: string | null;
  activeIssueId?: string | null;
  activeIssueLabel?: string | null;
  activeWorkspaceRoots: string[];
  folderAlias: Record<string, string>;
  prefill?: WorkspaceDraftPrefill | null;
  onPrefillConsumed?: (seedId: string) => void;
  onProjectSelect?: (projectId: string) => void;
  execBridge: WorkspaceExecBridge;
};

export type UseWorkspaceControllerResult = {
  loading: boolean;
  bundle: WorkspaceBundle | null;
  projectOptions: WorkspaceControllerProjectOption[];
  selectedProjectId: string | null;
  currentScopeId: WorkspaceScopeId | null;
  currentProjectLabel: string;
  promptLibrary: WorkspacePromptsResult | null;
  projectFolders: string[];
  gitWorktreeSnapshot: GitWorktreeEntry[];
  selectProject: (projectId: string) => void;
  refreshBundle: () => Promise<WorkspaceBundle | null>;
  refreshPromptLibrary: () => Promise<WorkspacePromptsResult | null>;
  refreshProjectFolders: () => Promise<string[]>;
  refreshGitWorktreeSnapshot: () => Promise<GitWorktreeEntry[]>;
  updateScopeFields: (updates: {
    linkedIssue?: string;
    objective?: string;
    activeTask?: string;
    runtimeNotes?: string;
    notes?: string;
    imageRefs?: string;
    issueLabel?: string | null;
  }) => Promise<void>;
  replaceSteps: (steps: Array<{ id?: string; title: string; status: WorkspaceStepStatus; sortOrder: number }>) => Promise<void>;
  saveExecutor: (input: Partial<WorkspaceExecutorRecord> & Pick<WorkspaceExecutorRecord, 'name' | 'providerKind'>) => Promise<void>;
  deleteExecutor: (executorId: string) => Promise<void>;
  runExecutor: (executorId: string) => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  saveContextItem: (input: Partial<WorkspaceContextItemRecord> & Pick<WorkspaceContextItemRecord, 'kind'>) => Promise<void>;
  saveContextOrdering: (items: WorkspaceContextItemRecord[]) => Promise<void>;
  deleteContextItem: (itemId: string) => Promise<void>;
  saveWorktree: (input: Partial<WorkspaceWorktreeRecord>) => Promise<void>;
  deleteWorktree: (worktreeId: string) => Promise<void>;
  createGitWorktree: (params: { branch: string; path: string; goal?: string }) => Promise<void>;
  removeGitWorktree: (params: { record: WorkspaceWorktreeRecord; force?: boolean }) => Promise<void>;
};

const EMPTY_PROMPT_LIBRARY: WorkspacePromptsResult = {
  workspace: [],
  general: [],
};

function normalizeProjectId(projectId: string): string {
  return projectId.trim();
}

function buildProjectLabel(projectId: string, folderAlias: Record<string, string>): string {
  return folderAlias[projectId] || fallbackProjectName(projectId);
}

function readThreadItemText(item: ThreadItem): string {
  if (typeof item.text === 'string' && item.text.trim()) {
    return item.text.replace(/\s+/g, ' ').trim();
  }
  if (typeof item.summary === 'string' && item.summary.trim()) {
    return item.summary.replace(/\s+/g, ' ').trim();
  }
  if (Array.isArray(item.summary) && item.summary.length > 0) {
    return item.summary.join(' ').replace(/\s+/g, ' ').trim();
  }
  if (Array.isArray(item.content)) {
    return item.content
      .map((entry) => (typeof entry === 'string' ? entry : entry?.text ?? ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

function extractThreadResultSummary(detail: ThreadDetail): string | null {
  const turns = detail.turns ?? [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item.type === 'agentMessage' && item.phase === 'final_answer') {
        const text = readThreadItemText(item);
        if (text) return text;
      }
    }
  }
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item.type === 'agentMessage') {
        const text = readThreadItemText(item);
        if (text) return text;
      }
    }
  }
  return null;
}

function formatRunSummaryTitle(executorName: string, finishedAt: number): string {
  const prefix = executorName.trim() || 'Executor';
  return `${prefix} · ${new Date(finishedAt * 1000).toLocaleString()}`;
}

function defaultExecutorName(providerKind: WorkspaceExecutorProvider, currentCount: number): string {
  const providerLabel = providerKind === 'claude' ? 'Claude' : 'Codex';
  return `${providerLabel} ${currentCount + 1}`;
}

function defaultContextTitle(kind: WorkspaceContextKind, currentCount: number): string {
  const labelMap: Record<WorkspaceContextKind, string> = {
    note: 'Note',
    image_ref: 'Image Ref',
    prompt_ref: 'Prompt Ref',
    file_ref: 'File Ref',
    thread_ref: 'Thread Ref',
    run_summary: 'Run Summary',
  };
  return `${labelMap[kind]} ${currentCount + 1}`;
}

function resolveScopeSelection(params: {
  selectedProjectId: string | null;
  activeIssueId?: string | null;
  activeIssueLabel?: string | null;
}): ScopeSelection | null {
  const projectId = params.selectedProjectId ? normalizeProjectId(params.selectedProjectId) : '';
  if (!projectId) return null;
  if (params.activeIssueId) {
    return {
      scopeId: buildIssueScopeId(params.activeIssueId),
      projectId,
      issueId: params.activeIssueId,
      issueLabel: params.activeIssueLabel ?? null,
    };
  }
  return {
    scopeId: buildProjectScopeId(projectId),
    projectId,
    issueId: null,
    issueLabel: null,
  };
}

export function useWorkspaceController(args: UseWorkspaceControllerArgs): UseWorkspaceControllerResult {
  const {
    activeProjectId,
    activeIssueId,
    activeIssueLabel,
    activeWorkspaceRoots,
    folderAlias,
    prefill,
    onPrefillConsumed,
    onProjectSelect,
    execBridge,
  } = args;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => activeProjectId ?? activeWorkspaceRoots[0] ?? null);
  const [projectOptions, setProjectOptions] = useState<WorkspaceControllerProjectOption[]>([]);
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [migrationReady, setMigrationReady] = useState(false);
  const [promptLibrary, setPromptLibrary] = useState<WorkspacePromptsResult | null>(null);
  const [projectFolders, setProjectFolders] = useState<string[]>([]);
  const [gitWorktreeSnapshot, setGitWorktreeSnapshot] = useState<GitWorktreeEntry[]>([]);
  const currentScopeRef = useRef<ScopeSelection | null>(null);
  const currentBundleRef = useRef<WorkspaceBundle | null>(null);
  const loadSeqRef = useRef(0);
  const prefillSeedRef = useRef<string | null>(null);

  useEffect(() => {
    currentBundleRef.current = bundle;
  }, [bundle]);

  useEffect(() => {
    if (activeProjectId && activeProjectId !== selectedProjectId) {
      setSelectedProjectId(activeProjectId);
      return;
    }
    if (selectedProjectId) {
      return;
    }
    if (activeWorkspaceRoots.length > 0) {
      setSelectedProjectId(activeWorkspaceRoots[0]);
    }
  }, [activeProjectId, activeWorkspaceRoots, selectedProjectId]);

  const currentScope = useMemo(
    () => resolveScopeSelection({
      selectedProjectId,
      activeIssueId,
      activeIssueLabel,
    }),
    [activeIssueId, activeIssueLabel, selectedProjectId],
  );

  const refreshProjectOptions = useCallback(async (preferredProjectId?: string | null) => {
    const dbProjects = await listWorkspaceProjects().catch(() => []);
    const merged = new Map<string, WorkspaceControllerProjectOption>();
    const pushProject = (projectId: string | null | undefined) => {
      const normalized = typeof projectId === 'string' ? normalizeProjectId(projectId) : '';
      if (!normalized || merged.has(normalized)) return;
      merged.set(normalized, {
        id: normalized,
        name: buildProjectLabel(normalized, folderAlias),
        scopeId: buildProjectScopeId(normalized),
      });
    };

    for (const root of activeWorkspaceRoots) {
      pushProject(root);
    }
    pushProject(activeProjectId);
    pushProject(selectedProjectId);
    pushProject(preferredProjectId);
    for (const project of dbProjects) {
      pushProject(project.id);
    }

    const currentId = preferredProjectId ?? activeProjectId ?? selectedProjectId ?? null;
    const nextOptions = Array.from(merged.values()).sort((left, right) => {
      if (currentId && left.id === currentId) return -1;
      if (currentId && right.id === currentId) return 1;
      return left.name.localeCompare(right.name);
    });

    setProjectOptions(nextOptions);
    if (nextOptions.length === 0) {
      setSelectedProjectId(null);
      return nextOptions;
    }
    const currentStillExists = selectedProjectId && nextOptions.some((project) => project.id === selectedProjectId);
    if (!currentStillExists) {
      setSelectedProjectId(currentId && nextOptions.some((project) => project.id === currentId) ? currentId : nextOptions[0].id);
    }
    return nextOptions;
  }, [activeProjectId, activeWorkspaceRoots, folderAlias, selectedProjectId]);

  const loadBundleForScope = useCallback(async (scope: ScopeSelection | null, silent = false) => {
    currentScopeRef.current = scope;
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    if (!scope) {
      if (!silent) setLoading(false);
      setBundle(null);
      return null;
    }

    if (!silent) setLoading(true);
    const loaded = await loadWorkspaceBundle({
      scopeId: scope.scopeId,
      projectId: scope.projectId,
      issueId: scope.issueId,
      issueLabel: scope.issueLabel,
    });
    if (loadSeqRef.current !== seq) {
      return null;
    }
    setBundle(loaded);
    if (!silent) setLoading(false);
    return loaded;
  }, []);

  const refreshBundle = useCallback(async () => {
    const scope = currentScopeRef.current ?? currentScope;
    return loadBundleForScope(scope, true);
  }, [currentScope, loadBundleForScope]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    migrateWorkspaceDraftsIfNeeded()
      .catch(() => false)
      .then(() => refreshProjectOptions(activeProjectId))
      .finally(() => {
        if (!cancelled) {
          setMigrationReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, refreshProjectOptions]);

  useEffect(() => {
    if (!migrationReady) return;
    void loadBundleForScope(currentScope, false);
  }, [currentScope, loadBundleForScope, migrationReady]);

  useEffect(() => {
    if (!migrationReady) return;
    void refreshProjectOptions(activeProjectId);
  }, [activeProjectId, activeWorkspaceRoots, folderAlias, migrationReady, refreshProjectOptions]);

  const updateScopeFields = useCallback(async (updates: {
    linkedIssue?: string;
    objective?: string;
    activeTask?: string;
    runtimeNotes?: string;
    notes?: string;
    imageRefs?: string;
    issueLabel?: string | null;
  }) => {
    const current = currentBundleRef.current;
    if (!current) return;
    await upsertWorkspaceScope({
      ...current.scope,
      ...updates,
    });
    await refreshBundle();
  }, [refreshBundle]);

  useEffect(() => {
    if (!prefill || !bundle) return;
    if (prefillSeedRef.current === prefill.seedId) return;
    if (prefill.projectId !== bundle.scope.projectId) return;
    if (prefill.issueId && bundle.scope.scopeId !== buildIssueScopeId(prefill.issueId)) return;
    if (!prefill.issueId && bundle.scope.scopeId !== buildProjectScopeId(prefill.projectId)) return;

    const patch: Parameters<typeof updateScopeFields>[0] = {};
    if (!bundle.scope.linkedIssue.trim() && prefill.linkedIssue) patch.linkedIssue = prefill.linkedIssue;
    if (!bundle.scope.objective.trim() && prefill.objective) patch.objective = prefill.objective;
    if (!bundle.scope.activeTask.trim() && prefill.activeTask) patch.activeTask = prefill.activeTask;
    if (!bundle.scope.issueLabel && prefill.issueLabel) patch.issueLabel = prefill.issueLabel;

    prefillSeedRef.current = prefill.seedId;
    onPrefillConsumed?.(prefill.seedId);
    if (Object.keys(patch).length > 0) {
      void updateScopeFields(patch);
    }
  }, [bundle, onPrefillConsumed, prefill, updateScopeFields]);

  const replaceStepsAction = useCallback(async (
    steps: Array<{ id?: string; title: string; status: WorkspaceStepStatus; sortOrder: number }>,
  ) => {
    const current = currentBundleRef.current;
    if (!current) return;
    await replaceWorkspaceSteps(current.scope.scopeId, steps);
    await refreshBundle();
  }, [refreshBundle]);

  const saveExecutor = useCallback(async (
    input: Partial<WorkspaceExecutorRecord> & Pick<WorkspaceExecutorRecord, 'name' | 'providerKind'>,
  ) => {
    const current = currentBundleRef.current;
    if (!current) return;
    const existing = input.id ? current.executors.find((executor) => executor.id === input.id) : null;
    const nextCount = current.executors.length;
    const nextExecutor: WorkspaceExecutorRecord = {
      id: input.id ?? createWorkspaceEntityId('executor'),
      scopeId: current.scope.scopeId,
      name: input.name?.trim() || existing?.name || defaultExecutorName(input.providerKind, nextCount),
      providerKind: input.providerKind,
      model: input.model ?? existing?.model ?? '',
      reasoning: input.reasoning ?? existing?.reasoning ?? '',
      roleLabel: input.roleLabel ?? existing?.roleLabel ?? '',
      terminalLane: input.terminalLane ?? existing?.terminalLane ?? '',
      cwdOverride: input.cwdOverride ?? existing?.cwdOverride ?? null,
      isPrimary: input.isPrimary ?? existing?.isPrimary ?? current.executors.length === 0,
      runStatus: input.runStatus ?? existing?.runStatus ?? 'idle',
      lastThreadId: input.lastThreadId ?? existing?.lastThreadId ?? null,
      lastRunAt: input.lastRunAt ?? existing?.lastRunAt ?? null,
      createdAt: existing?.createdAt ?? Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };

    const nextExecutors = await upsertWorkspaceExecutor(nextExecutor);
    const primaryExecutor = nextExecutors.find((executor) => executor.isPrimary) ?? nextExecutors[0] ?? null;
    await upsertWorkspaceScope({
      ...current.scope,
      activeExecutorId: primaryExecutor?.id ?? null,
    });
    await refreshBundle();
  }, [refreshBundle]);

  const deleteExecutorAction = useCallback(async (executorId: string) => {
    const current = currentBundleRef.current;
    if (!current) return;
    const nextExecutors = await deleteWorkspaceExecutor(current.scope.scopeId, executorId);
    const primaryExecutor = nextExecutors.find((executor) => executor.isPrimary) ?? nextExecutors[0] ?? null;
    await upsertWorkspaceScope({
      ...current.scope,
      activeExecutorId: primaryExecutor?.id ?? null,
    });
    await refreshBundle();
  }, [refreshBundle]);

  const saveContextItem = useCallback(async (
    input: Partial<WorkspaceContextItemRecord> & Pick<WorkspaceContextItemRecord, 'kind'>,
  ) => {
    const current = currentBundleRef.current;
    if (!current) return;
    const existing = input.id ? current.contextItems.find((item) => item.id === input.id) : null;
    const nextItem: WorkspaceContextItemRecord = {
      id: input.id ?? createWorkspaceEntityId('context'),
      scopeId: current.scope.scopeId,
      kind: input.kind,
      title: input.title ?? existing?.title ?? defaultContextTitle(input.kind, current.contextItems.length),
      content: input.content ?? existing?.content ?? '',
      ref: input.ref ?? existing?.ref ?? null,
      source: input.source ?? existing?.source ?? null,
      sortOrder: input.sortOrder ?? existing?.sortOrder ?? current.contextItems.length,
      createdAt: existing?.createdAt ?? Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    await upsertWorkspaceContextItem(nextItem);
    await refreshBundle();
  }, [refreshBundle]);

  const saveContextOrdering = useCallback(async (items: WorkspaceContextItemRecord[]) => {
    for (const [index, item] of items.entries()) {
      await upsertWorkspaceContextItem({
        ...item,
        sortOrder: index,
      });
    }
    await refreshBundle();
  }, [refreshBundle]);

  const deleteContextItemAction = useCallback(async (itemId: string) => {
    const current = currentBundleRef.current;
    if (!current) return;
    await deleteWorkspaceContextItem(current.scope.scopeId, itemId);
    await refreshBundle();
  }, [refreshBundle]);

  const saveWorktree = useCallback(async (input: Partial<WorkspaceWorktreeRecord>) => {
    const current = currentBundleRef.current;
    if (!current) return;
    const existing = input.id ? current.worktrees.find((worktree) => worktree.id === input.id) : null;
    const nextWorktree: WorkspaceWorktreeRecord = {
      id: input.id ?? createWorkspaceEntityId('worktree'),
      scopeId: current.scope.scopeId,
      branch: input.branch ?? existing?.branch ?? '',
      path: input.path ?? existing?.path ?? '',
      goal: input.goal ?? existing?.goal ?? '',
      status: input.status ?? existing?.status ?? 'planned',
      isPrimary: input.isPrimary ?? existing?.isPrimary ?? current.worktrees.length === 0,
      createdAt: existing?.createdAt ?? Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    await upsertWorkspaceWorktree(nextWorktree);
    await refreshBundle();
  }, [refreshBundle]);

  const deleteWorktreeAction = useCallback(async (worktreeId: string) => {
    const current = currentBundleRef.current;
    if (!current) return;
    await deleteWorkspaceWorktree(current.scope.scopeId, worktreeId);
    await refreshBundle();
  }, [refreshBundle]);

  const refreshPromptLibrary = useCallback(async () => {
    const projectId = currentBundleRef.current?.scope.projectId ?? currentScopeRef.current?.projectId ?? null;
    const result = await execBridge.listPrompts(projectId);
    setPromptLibrary(result);
    return result;
  }, [execBridge]);

  const refreshProjectFolders = useCallback(async () => {
    const projectId = currentBundleRef.current?.scope.projectId ?? currentScopeRef.current?.projectId;
    if (!projectId) {
      setProjectFolders([]);
      return [];
    }
    const result = await execBridge.listProjectFolders(projectId).catch(() => []);
    setProjectFolders(result);
    return result;
  }, [execBridge]);

  const refreshGitWorktreeSnapshot = useCallback(async () => {
    const projectId = currentBundleRef.current?.scope.projectId ?? currentScopeRef.current?.projectId;
    if (!projectId) {
      setGitWorktreeSnapshot([]);
      return [];
    }
    const result = await execBridge.listGitWorktrees(projectId).catch(() => []);
    setGitWorktreeSnapshot(result);
    return result;
  }, [execBridge]);

  const createGitWorktreeAction = useCallback(async (params: { branch: string; path: string; goal?: string }) => {
    const current = currentBundleRef.current;
    if (!current) return;
    await execBridge.createGitWorktree({
      cwd: current.scope.projectId,
      branch: params.branch,
      path: params.path,
    });
    await saveWorktree({
      branch: params.branch,
      path: params.path,
      goal: params.goal ?? '',
      status: 'ready',
      isPrimary: current.worktrees.length === 0,
    });
    await refreshGitWorktreeSnapshot();
  }, [execBridge, refreshGitWorktreeSnapshot, saveWorktree]);

  const removeGitWorktreeAction = useCallback(async (params: { record: WorkspaceWorktreeRecord; force?: boolean }) => {
    await execBridge.removeGitWorktree({
      path: params.record.path,
      force: params.force,
    });
    await deleteWorktreeAction(params.record.id);
    await refreshGitWorktreeSnapshot();
  }, [deleteWorktreeAction, execBridge, refreshGitWorktreeSnapshot]);

  const readIssueContext = useCallback(async (projectId: string, issueId: string | null): Promise<{
    issue: KanbanIssue | null;
    comments: KanbanComment[];
  }> => {
    if (!issueId) {
      return { issue: null, comments: [] };
    }
    const [issues, comments] = await Promise.all([
      listKanbanIssues(projectId).catch(() => []),
      listKanbanComments(issueId).catch(() => []),
    ]);
    return {
      issue: issues.find((entry) => entry.id === issueId) ?? null,
      comments,
    };
  }, []);

  const runExecutor = useCallback(async (executorId: string) => {
    const current = currentBundleRef.current;
    if (!current) return;
    const executor = current.executors.find((entry) => entry.id === executorId);
    if (!executor) return;
    if (executor.runStatus === 'running' || executor.runStatus === 'queued') return;

    const startedAt = Math.floor(Date.now() / 1000);
    const { issue, comments } = await readIssueContext(current.scope.projectId, current.scope.issueId);
    const prompt = buildWorkspaceExecutionPrompt({
      scope: current.scope,
      summary: current.summary,
      executor,
      contextItems: current.contextItems,
      worktrees: current.worktrees,
      issueDetails: issue ? {
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        tags: issue.tags,
        issueNumber: issue.issue_number,
      } : null,
      issueComments: comments.map((comment) => ({
        content: comment.content,
        createdAt: comment.created_at,
      })),
    });
    const runId = createWorkspaceEntityId('run');
    const nextRun: WorkspaceRunRecord = {
      id: runId,
      scopeId: current.scope.scopeId,
      executorId: executor.id,
      issueId: current.scope.issueId,
      threadId: null,
      providerKind: executor.providerKind,
      model: executor.model,
      status: 'queued',
      promptSnapshot: prompt,
      resultSummary: null,
      errorMessage: null,
      startedAt,
      finishedAt: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    await createWorkspaceRun(nextRun);
    await upsertWorkspaceExecutor({
      ...executor,
      runStatus: 'running',
      lastRunAt: startedAt,
    });
    await upsertWorkspaceScope({
      ...current.scope,
      activeExecutorId: executor.id,
      lastRunStatus: 'running',
      lastRunSummary: null,
      lastRunAt: startedAt,
    });
    await refreshBundle();

    try {
      const result = await execBridge.runExecutor({
        scope: current.scope,
        executor,
        prompt,
        projectId: executor.cwdOverride?.trim() || current.scope.projectId,
        preferredThreadName: executor.name.trim() || current.scope.activeTask.trim() || current.scope.objective.trim() || current.scope.issueLabel || 'Workspace Run',
      });
      await updateWorkspaceRun({
        id: runId,
        threadId: result.threadId,
        providerKind: result.providerKind,
        model: result.model,
        status: 'running',
        startedAt: result.startedAt,
      });
      await upsertWorkspaceExecutor({
        ...executor,
        model: result.model || executor.model,
        runStatus: 'running',
        lastThreadId: result.threadId,
        lastRunAt: result.startedAt,
      });
      await upsertWorkspaceScope({
        ...current.scope,
        activeExecutorId: executor.id,
        lastRunThreadId: result.threadId,
        lastRunStatus: 'running',
        lastRunAt: result.startedAt,
        lastRunSummary: null,
      });
      await refreshBundle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = Math.floor(Date.now() / 1000);
      await updateWorkspaceRun({
        id: runId,
        status: 'failed',
        errorMessage: message,
        finishedAt: failedAt,
      });
      await upsertWorkspaceExecutor({
        ...executor,
        runStatus: 'failed',
        lastRunAt: failedAt,
      });
      await upsertWorkspaceScope({
        ...current.scope,
        activeExecutorId: executor.id,
        lastRunStatus: 'failed',
        lastRunAt: failedAt,
        lastRunSummary: message,
      });
      await refreshBundle();
    }
  }, [execBridge, readIssueContext, refreshBundle]);

  const reconcileRuns = useCallback(async () => {
    const current = currentBundleRef.current;
    if (!current) return;
    const activeRuns = current.runs.filter((run) => (run.status === 'queued' || run.status === 'running') && run.threadId);
    if (activeRuns.length === 0) return;

    let changed = false;
    for (const run of activeRuns) {
      const detail = await execBridge.readThread(run.threadId as string).catch(() => null);
      if (!detail) {
        continue;
      }
      const nextStatus = workspaceRunStatusFromThread(detail);
      if (!nextStatus || nextStatus === 'running') {
        continue;
      }
      const finishedAt = Math.floor(Date.now() / 1000);
      const summary = extractThreadResultSummary(detail);
      const lastTurn = detail.turns?.[detail.turns.length - 1];
      const errorMessage =
        nextStatus === 'failed'
          ? lastTurn?.error?.message ?? run.errorMessage ?? 'Run failed'
          : nextStatus === 'cancelled'
            ? lastTurn?.error?.message ?? 'Run cancelled'
            : null;

      await updateWorkspaceRun({
        id: run.id,
        status: nextStatus,
        resultSummary: summary,
        errorMessage,
        finishedAt,
      });

      const latestBundle = currentBundleRef.current;
      const latestExecutor = latestBundle?.executors.find((executor) => executor.id === run.executorId);
      const latestScope = latestBundle?.scope ?? current.scope;

      if (latestExecutor) {
        const nextRunStatus: WorkspaceExecutorRunStatus = nextStatus;
        await upsertWorkspaceExecutor({
          ...latestExecutor,
          runStatus: nextRunStatus,
          lastThreadId: run.threadId,
          lastRunAt: finishedAt,
        });
      }

      await upsertWorkspaceScope({
        ...latestScope,
        activeExecutorId: run.executorId,
        lastRunThreadId: run.threadId,
        lastRunStatus: nextStatus,
        lastRunSummary: summary ?? errorMessage ?? latestScope.lastRunSummary,
        lastRunAt: finishedAt,
      });

      if (summary) {
        const latestContextItems = latestBundle?.contextItems ?? current.contextItems;
        await upsertWorkspaceContextItem({
          id: createWorkspaceEntityId('context'),
          scopeId: latestScope.scopeId,
          kind: 'run_summary',
          title: formatRunSummaryTitle(latestExecutor?.name ?? run.executorId, finishedAt),
          content: summary,
          ref: run.threadId,
          source: latestExecutor?.name ?? run.executorId,
          sortOrder: latestContextItems.length,
          createdAt: finishedAt,
          updatedAt: finishedAt,
        });
      }

      changed = true;
    }

    if (changed) {
      await refreshBundle();
    }
  }, [execBridge, refreshBundle]);

  useEffect(() => {
    const activeRunKey = bundle?.runs
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .map((run) => `${run.id}:${run.status}:${run.threadId ?? 'pending'}`)
      .join('|');
    if (!activeRunKey) return;
    void reconcileRuns();
    const timer = window.setInterval(() => {
      void reconcileRuns();
    }, 2500);
    return () => {
      window.clearInterval(timer);
    };
  }, [bundle?.scope.scopeId, bundle?.runs, reconcileRuns]);

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    setPromptLibrary(null);
    setProjectFolders([]);
    setGitWorktreeSnapshot([]);
    onProjectSelect?.(projectId);
  }, [onProjectSelect]);

  const openThread = useCallback(async (threadId: string) => {
    await execBridge.openThread(threadId);
  }, [execBridge]);

  const currentProjectLabel = useMemo(() => {
    const projectId = bundle?.scope.projectId ?? selectedProjectId ?? '';
    return projectId ? buildProjectLabel(projectId, folderAlias) : '';
  }, [bundle?.scope.projectId, folderAlias, selectedProjectId]);

  return {
    loading,
    bundle,
    projectOptions,
    selectedProjectId,
    currentScopeId: bundle?.scope.scopeId ?? currentScope?.scopeId ?? null,
    currentProjectLabel,
    promptLibrary: promptLibrary ?? EMPTY_PROMPT_LIBRARY,
    projectFolders,
    gitWorktreeSnapshot,
    selectProject,
    refreshBundle,
    refreshPromptLibrary,
    refreshProjectFolders,
    refreshGitWorktreeSnapshot,
    updateScopeFields,
    replaceSteps: replaceStepsAction,
    saveExecutor,
    deleteExecutor: deleteExecutorAction,
    runExecutor,
    openThread,
    saveContextItem,
    saveContextOrdering,
    deleteContextItem: deleteContextItemAction,
    saveWorktree,
    deleteWorktree: deleteWorktreeAction,
    createGitWorktree: createGitWorktreeAction,
    removeGitWorktree: removeGitWorktreeAction,
  };
}
