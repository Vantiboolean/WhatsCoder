import type { ThreadDetail } from '@whats-coder/shared';
import type {
  WorkspaceContextItemRecord,
  WorkspaceExecutorProvider,
  WorkspaceExecutorRecord,
  WorkspaceRunStatus,
  WorkspaceScopeRecord,
  WorkspaceSummary,
  WorkspaceWorktreeRecord,
} from './types';

export type WorkspacePromptItem = {
  name: string;
  path: string;
  content: string;
};

export type WorkspacePromptsResult = {
  workspace: WorkspacePromptItem[];
  general: WorkspacePromptItem[];
};

export type GitWorktreeEntry = {
  path: string;
  branch: string | null;
  head: string | null;
  isBare: boolean;
  isDetached: boolean;
  isLocked: boolean;
};

export type WorkspaceRunExecutorRequest = {
  scope: WorkspaceScopeRecord;
  executor: WorkspaceExecutorRecord;
  prompt: string;
  projectId: string;
  preferredThreadName: string;
};

export type WorkspaceRunExecutorResult = {
  threadId: string;
  providerKind: WorkspaceExecutorProvider;
  model: string;
  startedAt: number;
};

export type WorkspaceExecBridge = {
  runExecutor: (params: WorkspaceRunExecutorRequest) => Promise<WorkspaceRunExecutorResult>;
  readThread: (threadId: string) => Promise<ThreadDetail>;
  openThread: (threadId: string) => Promise<void>;
  listPrompts: (cwd: string | null) => Promise<WorkspacePromptsResult>;
  listProjectFolders: (cwd: string) => Promise<string[]>;
  listGitWorktrees: (cwd: string) => Promise<GitWorktreeEntry[]>;
  createGitWorktree: (params: { cwd: string; branch: string; path: string }) => Promise<string>;
  removeGitWorktree: (params: { path: string; force?: boolean }) => Promise<void>;
};

export function workspaceRunStatusFromThread(detail: ThreadDetail): WorkspaceRunStatus | null {
  const turns = detail.turns ?? [];
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn) return null;

  switch (lastTurn.status) {
    case 'inProgress':
      return 'running';
    case 'completed':
      return 'success';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'cancelled';
    default:
      return null;
  }
}

function compactPromptText(value: string, fallback = 'None provided.'): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function buildWorkspaceExecutionPrompt(params: {
  scope: WorkspaceScopeRecord;
  summary: WorkspaceSummary;
  executor: WorkspaceExecutorRecord;
  contextItems: WorkspaceContextItemRecord[];
  worktrees: WorkspaceWorktreeRecord[];
  issueDetails?: {
    title: string;
    description: string | null;
    status: string;
    priority: string;
    tags: string | null;
    issueNumber: number;
  } | null;
  issueComments?: Array<{ content: string; createdAt: number }>;
}): string {
  const primaryWorktree = params.worktrees.find((item) => item.isPrimary) ?? params.worktrees[0] ?? null;
  const recentComments = (params.issueComments ?? []).slice(-5);
  const contextSections = params.contextItems
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => {
      const body = compactPromptText(item.content || item.ref || '', 'No content.');
      return `- [${item.kind}] ${item.title || 'Untitled'}: ${body}`;
    });

  const lines: string[] = [
    'You are executing a workspace-scoped task inside the selected desktop project.',
    'Treat the workspace state below as the canonical task, execution, and context definition.',
    '',
    '## Task Definition',
    `- Scope: ${params.scope.scopeId}`,
    `- Scope type: ${params.scope.scopeType}`,
    `- Project root: ${params.scope.projectId}`,
    `- Linked issue: ${params.scope.linkedIssue || params.scope.issueLabel || params.scope.issueId || 'None'}`,
    `- Objective: ${compactPromptText(params.scope.objective)}`,
    `- Active task: ${compactPromptText(params.scope.activeTask)}`,
    '## Workspace Summary',
    `- Steps completed: ${params.summary.completedSteps}/${params.summary.totalSteps}`,
    `- Artifact count: ${params.summary.artifactCount}`,
    `- Runtime ready: ${params.summary.runtimeReady ? 'yes' : 'no'}`,
    `- Worktree ready: ${params.summary.worktreeReady ? 'yes' : 'no'}`,
    `- Last run status: ${params.summary.lastRunStatus ?? 'Never run'}`,
    `- Last run summary: ${params.summary.lastRunSummary ?? 'None'}`,
    '',
    '## Runtime Notes',
    compactPromptText(params.scope.runtimeNotes),
    '',
    '## Executor Configuration',
    `- Name: ${params.executor.name || 'Unnamed executor'}`,
    `- Provider: ${params.executor.providerKind}`,
    `- Model: ${params.executor.model || 'Default model'}`,
    `- Reasoning: ${params.executor.reasoning || 'Default'}`,
    `- Role: ${params.executor.roleLabel || 'General implementation'}`,
    `- Terminal lane: ${params.executor.terminalLane || 'Default lane'}`,
    `- Working directory override: ${params.executor.cwdOverride || params.scope.projectId}`,
    '',
    '## Context Items',
    ...(contextSections.length > 0 ? contextSections : ['- None yet.']),
    '',
    '## Worktree Status',
    primaryWorktree
      ? `- Primary worktree: ${primaryWorktree.path || 'No path'} | branch ${primaryWorktree.branch || 'No branch'} | status ${primaryWorktree.status}`
      : '- No worktree configured yet.',
  ];

  if (params.issueDetails) {
    lines.push(
      '',
      '## Kanban Issue',
      `- Issue number: ${params.issueDetails.issueNumber > 0 ? `#${params.issueDetails.issueNumber}` : 'Unassigned'}`,
      `- Title: ${params.issueDetails.title}`,
      `- Status: ${params.issueDetails.status}`,
      `- Priority: ${params.issueDetails.priority}`,
      `- Tags: ${params.issueDetails.tags || 'None'}`,
      '',
      compactPromptText(params.issueDetails.description ?? '', 'No issue description provided.'),
    );
  }

  if (recentComments.length > 0) {
    lines.push('', '## Recent Issue Comments');
    for (const comment of recentComments) {
      lines.push(`- [${new Date(comment.createdAt * 1000).toLocaleString()}] ${compactPromptText(comment.content)}`);
    }
  }

  lines.push(
    '',
    '## Execution Instructions',
    '- Use the workspace scope above as the source of truth.',
    '- Prefer the smallest safe implementation that completes the active task.',
    '- If the task is ambiguous, inspect the codebase and make the most grounded interpretation possible.',
    '- When finished, summarize what changed, blockers or follow-ups, and the recommended next status.',
  );

  return lines.join('\n');
}
