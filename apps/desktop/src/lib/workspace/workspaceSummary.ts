import type {
  WorkspaceContextItemRecord,
  WorkspaceExecutorRecord,
  WorkspaceScopeRecord,
  WorkspaceStepRecord,
  WorkspaceSummary,
  WorkspaceWorktreeRecord,
} from './types';

export function countArtifactLines(value: string): number {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .length;
}

export function buildWorkspaceSummary(params: {
  scope: WorkspaceScopeRecord;
  steps: WorkspaceStepRecord[];
  executors: WorkspaceExecutorRecord[];
  contextItems: WorkspaceContextItemRecord[];
  worktrees: WorkspaceWorktreeRecord[];
}): WorkspaceSummary {
  const { scope, steps, executors, contextItems, worktrees } = params;
  const totalSteps = steps.length;
  const completedSteps = steps.filter((step) => step.status === 'done').length;
  const artifactCount =
    countArtifactLines(scope.notes) +
    countArtifactLines(scope.imageRefs) +
    contextItems.filter((item) => item.kind !== 'run_summary').length;
  const primaryExecutor = executors.find((executor) => executor.isPrimary) ?? executors[0] ?? null;
  const primaryWorktree = worktrees.find((worktree) => worktree.isPrimary) ?? worktrees[0] ?? null;
  const runtimeReady = executors.some((executor) =>
    Boolean(
      executor.name.trim() ||
      executor.model.trim() ||
      executor.terminalLane.trim() ||
      executor.cwdOverride?.trim(),
    ),
  ) || Boolean(scope.runtimeNotes.trim());
  const worktreeReady = worktrees.some((worktree) => Boolean(worktree.branch.trim() || worktree.path.trim()));
  const hasActivity = Boolean(
    scope.issueId ||
    scope.issueLabel ||
    scope.linkedIssue.trim() ||
    scope.objective.trim() ||
    scope.activeTask.trim() ||
    scope.runtimeNotes.trim() ||
    scope.notes.trim() ||
    scope.imageRefs.trim() ||
    steps.length > 0 ||
    executors.length > 0 ||
    contextItems.length > 0 ||
    worktrees.length > 0 ||
    scope.lastRunThreadId ||
    scope.lastRunSummary,
  );

  return {
    hasActivity,
    totalSteps,
    completedSteps,
    artifactCount,
    runtimeReady,
    worktreeReady,
    lastRunStatus: scope.lastRunStatus,
    lastRunSummary: scope.lastRunSummary,
    primaryExecutorName: primaryExecutor?.name ?? null,
    primaryExecutorModel: primaryExecutor?.model ?? null,
    primaryWorktreePath: primaryWorktree?.path ?? null,
    primaryWorktreeBranch: primaryWorktree?.branch ?? null,
  };
}

export function previewWorkspaceText(value: string | null | undefined, fallback: string, maxChars = 88): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 3))}...` : normalized;
}
