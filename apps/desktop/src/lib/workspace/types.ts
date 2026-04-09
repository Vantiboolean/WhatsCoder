export type WorkspaceSectionId = 'overview' | 'kanban' | 'tasks' | 'runtime' | 'context' | 'worktree';
export type WorkspaceScopeType = 'project' | 'issue';
export type WorkspaceScopeId = `project::${string}` | `issue::${string}`;
export type WorkspaceStepStatus = 'pending' | 'active' | 'done';
export type WorkspaceExecutorProvider = 'codex' | 'claude';
export type WorkspaceRunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type WorkspaceExecutorRunStatus = WorkspaceRunStatus | 'idle';
export type WorkspaceContextKind = 'note' | 'image_ref' | 'prompt_ref' | 'file_ref' | 'thread_ref' | 'run_summary';
export type WorkspaceWorktreeStatus = 'planned' | 'ready' | 'archived';

export type WorkspaceDraftPrefill = {
  seedId: string;
  projectId: string;
  issueId?: string;
  issueLabel?: string;
  linkedIssue?: string;
  objective?: string;
  activeTask?: string;
};

export type WorkspaceProjectOption = {
  id: string;
  name: string;
};

export type WorkspaceScopeRecord = {
  scopeId: WorkspaceScopeId;
  scopeType: WorkspaceScopeType;
  projectId: string;
  issueId: string | null;
  issueLabel: string | null;
  linkedIssue: string;
  objective: string;
  activeTask: string;
  runtimeNotes: string;
  notes: string;
  imageRefs: string;
  lastRunThreadId: string | null;
  lastRunStatus: WorkspaceRunStatus | null;
  lastRunSummary: string | null;
  lastRunAt: number | null;
  activeExecutorId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceStepRecord = {
  id: string;
  scopeId: WorkspaceScopeId;
  title: string;
  status: WorkspaceStepStatus;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceExecutorRecord = {
  id: string;
  scopeId: WorkspaceScopeId;
  name: string;
  providerKind: WorkspaceExecutorProvider;
  model: string;
  reasoning: string;
  roleLabel: string;
  terminalLane: string;
  cwdOverride: string | null;
  isPrimary: boolean;
  runStatus: WorkspaceExecutorRunStatus;
  lastThreadId: string | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceContextItemRecord = {
  id: string;
  scopeId: WorkspaceScopeId;
  kind: WorkspaceContextKind;
  title: string;
  content: string;
  ref: string | null;
  source: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceWorktreeRecord = {
  id: string;
  scopeId: WorkspaceScopeId;
  branch: string;
  path: string;
  goal: string;
  status: WorkspaceWorktreeStatus;
  isPrimary: boolean;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceRunRecord = {
  id: string;
  scopeId: WorkspaceScopeId;
  executorId: string;
  issueId: string | null;
  threadId: string | null;
  providerKind: WorkspaceExecutorProvider;
  model: string;
  status: WorkspaceRunStatus;
  promptSnapshot: string;
  resultSummary: string | null;
  errorMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceSummary = {
  hasActivity: boolean;
  totalSteps: number;
  completedSteps: number;
  artifactCount: number;
  runtimeReady: boolean;
  worktreeReady: boolean;
  lastRunStatus: WorkspaceRunStatus | null;
  lastRunSummary: string | null;
  primaryExecutorName: string | null;
  primaryExecutorModel: string | null;
  primaryWorktreePath: string | null;
  primaryWorktreeBranch: string | null;
};

export type WorkspaceBundle = {
  scope: WorkspaceScopeRecord;
  steps: WorkspaceStepRecord[];
  executors: WorkspaceExecutorRecord[];
  contextItems: WorkspaceContextItemRecord[];
  worktrees: WorkspaceWorktreeRecord[];
  runs: WorkspaceRunRecord[];
  summary: WorkspaceSummary;
};

export function buildProjectScopeId(projectId: string): WorkspaceScopeId {
  return `project::${projectId}`;
}

export function buildIssueScopeId(issueId: string): WorkspaceScopeId {
  return `issue::${issueId}`;
}

export function parseWorkspaceScopeId(scopeId: WorkspaceScopeId): {
  scopeType: WorkspaceScopeType;
  projectId: string | null;
  issueId: string | null;
} {
  if (scopeId.startsWith('project::')) {
    return {
      scopeType: 'project',
      projectId: scopeId.slice('project::'.length),
      issueId: null,
    };
  }

  return {
    scopeType: 'issue',
    projectId: null,
    issueId: scopeId.slice('issue::'.length),
  };
}

export function fallbackProjectName(projectId: string): string {
  const normalized = projectId.replace(/[\\/]+$/, '');
  if (!normalized) return projectId;
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || projectId;
}

export function createWorkspaceEntityId(prefix: string): string {
  return `workspace-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
