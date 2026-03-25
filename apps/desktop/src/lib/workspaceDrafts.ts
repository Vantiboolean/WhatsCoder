export type WorkspaceStepStatus = 'pending' | 'active' | 'done';
export type WorkspaceSectionId = 'overview' | 'kanban' | 'tasks' | 'runtime' | 'context' | 'worktree';

export type WorkspaceStep = {
  id: string;
  title: string;
  status: WorkspaceStepStatus;
};

export type WorkspaceDraft = {
  issueId: string;
  issueLabel: string;
  objective: string;
  activeTask: string;
  linkedIssue: string;
  primaryAgent: string;
  executionModel: string;
  terminalFocus: string;
  runtimeNotes: string;
  worktreeBranch: string;
  worktreePath: string;
  worktreeGoal: string;
  notes: string;
  imageRefs: string;
  steps: WorkspaceStep[];
  lastUpdatedAt: number;
};

export type WorkspaceDraftPrefill = {
  seedId: string;
  projectId: string;
  issueId?: string;
  issueLabel?: string;
  linkedIssue?: string;
  objective?: string;
  activeTask?: string;
};

export type WorkspaceDraftSummary = {
  hasActivity: boolean;
  totalSteps: number;
  completedSteps: number;
  artifactCount: number;
  runtimeReady: boolean;
  worktreeReady: boolean;
};

const WORKSPACE_STORAGE_KEY_V3 = 'codex-workspace-panel-drafts-v3';
const WORKSPACE_STORAGE_KEY_V2 = 'codex-workspace-panel-drafts-v2';
const PROJECT_SCOPE_PREFIX = 'project::';
const ISSUE_SCOPE_PREFIX = 'issue::';

export function buildProjectDraftKey(projectId: string): string {
  return `${PROJECT_SCOPE_PREFIX}${projectId}`;
}

export function buildIssueDraftKey(issueId: string): string {
  return `${ISSUE_SCOPE_PREFIX}${issueId}`;
}

export function createWorkspaceStepId(): string {
  return `workspace-step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createEmptyWorkspaceDraft(): WorkspaceDraft {
  return {
    issueId: '',
    issueLabel: '',
    objective: '',
    activeTask: '',
    linkedIssue: '',
    primaryAgent: '',
    executionModel: '',
    terminalFocus: '',
    runtimeNotes: '',
    worktreeBranch: '',
    worktreePath: '',
    worktreeGoal: '',
    notes: '',
    imageRefs: '',
    steps: [],
    lastUpdatedAt: Date.now(),
  };
}

export function normalizeWorkspaceDraft(raw: unknown): WorkspaceDraft {
  if (!raw || typeof raw !== 'object') {
    return createEmptyWorkspaceDraft();
  }

  const value = raw as Partial<WorkspaceDraft>;
  const steps = Array.isArray(value.steps)
    ? value.steps
        .filter((step): step is WorkspaceStep => Boolean(step && typeof step === 'object'))
        .map((step) => {
          const status: WorkspaceStepStatus = step.status === 'active' || step.status === 'done' ? step.status : 'pending';
          return {
            id: typeof step.id === 'string' && step.id ? step.id : createWorkspaceStepId(),
            title: typeof step.title === 'string' ? step.title : '',
            status,
          };
        })
    : [];

  return {
    issueId: typeof value.issueId === 'string' ? value.issueId : '',
    issueLabel: typeof value.issueLabel === 'string' ? value.issueLabel : '',
    objective: typeof value.objective === 'string' ? value.objective : '',
    activeTask: typeof value.activeTask === 'string' ? value.activeTask : '',
    linkedIssue: typeof value.linkedIssue === 'string' ? value.linkedIssue : '',
    primaryAgent: typeof value.primaryAgent === 'string' ? value.primaryAgent : '',
    executionModel: typeof value.executionModel === 'string' ? value.executionModel : '',
    terminalFocus: typeof value.terminalFocus === 'string' ? value.terminalFocus : '',
    runtimeNotes: typeof value.runtimeNotes === 'string' ? value.runtimeNotes : '',
    worktreeBranch: typeof value.worktreeBranch === 'string' ? value.worktreeBranch : '',
    worktreePath: typeof value.worktreePath === 'string' ? value.worktreePath : '',
    worktreeGoal: typeof value.worktreeGoal === 'string' ? value.worktreeGoal : '',
    notes: typeof value.notes === 'string' ? value.notes : '',
    imageRefs: typeof value.imageRefs === 'string' ? value.imageRefs : '',
    steps,
    lastUpdatedAt: typeof value.lastUpdatedAt === 'number' ? value.lastUpdatedAt : Date.now(),
  };
}

function normalizeStoredDraftMap(parsed: Record<string, unknown>): Record<string, WorkspaceDraft> {
  return Object.fromEntries(
    Object.entries(parsed).map(([key, draft]) => {
      const normalizedKey = key.startsWith(PROJECT_SCOPE_PREFIX) || key.startsWith(ISSUE_SCOPE_PREFIX)
        ? key
        : buildProjectDraftKey(key);
      return [normalizedKey, normalizeWorkspaceDraft(draft)];
    }),
  );
}

export function loadWorkspaceDraftMap(): Record<string, WorkspaceDraft> {
  try {
    const currentRaw = localStorage.getItem(WORKSPACE_STORAGE_KEY_V3);
    if (currentRaw) {
      return normalizeStoredDraftMap(JSON.parse(currentRaw) as Record<string, unknown>);
    }

    const legacyRaw = localStorage.getItem(WORKSPACE_STORAGE_KEY_V2);
    if (legacyRaw) {
      return normalizeStoredDraftMap(JSON.parse(legacyRaw) as Record<string, unknown>);
    }

    return {};
  } catch {
    return {};
  }
}

export function saveWorkspaceDraftMap(draftsByKey: Record<string, WorkspaceDraft>): void {
  localStorage.setItem(WORKSPACE_STORAGE_KEY_V3, JSON.stringify(draftsByKey));
}

export function countWorkspaceArtifacts(value: string): number {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

export function getWorkspaceDraftSummary(draft: WorkspaceDraft): WorkspaceDraftSummary {
  const totalSteps = draft.steps.length;
  const completedSteps = draft.steps.filter((step) => step.status === 'done').length;
  const artifactCount = countWorkspaceArtifacts(draft.notes) + countWorkspaceArtifacts(draft.imageRefs);
  const runtimeReady = Boolean(draft.primaryAgent.trim() || draft.executionModel.trim() || draft.terminalFocus.trim());
  const worktreeReady = Boolean(draft.worktreeBranch.trim() || draft.worktreePath.trim());
  const hasActivity = Boolean(
    draft.issueId ||
    draft.linkedIssue.trim() ||
    draft.objective.trim() ||
    draft.activeTask.trim() ||
    draft.notes.trim() ||
    draft.imageRefs.trim() ||
    draft.primaryAgent.trim() ||
    draft.executionModel.trim() ||
    draft.terminalFocus.trim() ||
    draft.worktreeBranch.trim() ||
    draft.worktreePath.trim() ||
    draft.steps.length > 0
  );

  return {
    hasActivity,
    totalSteps,
    completedSteps,
    artifactCount,
    runtimeReady,
    worktreeReady,
  };
}
