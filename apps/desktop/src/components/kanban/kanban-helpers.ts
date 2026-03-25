import { useCallback, useState } from 'react';
import type { ThreadDetail, ThreadItem, Turn, ThreadSummary } from '@whats-coder/shared';
import type {
  KanbanIssue,
  KanbanExecutionState,
  KanbanPriority,
  KanbanComment,
} from '../../lib/kanbanDb';

export type KanbanProject = {
  id: string;
  name: string;
};

export type KanbanExecCallbacks = {
  startThread: (params?: { cwd?: string }) => Promise<ThreadSummary>;
  startTurn: (threadId: string, text: string) => Promise<Turn>;
  readThread: (threadId: string) => Promise<ThreadDetail>;
  onRunStarted?: (params: { runId: string; issueId: string; threadId: string }) => void;
  onThreadObserved?: (params: {
    threadId: string;
    detail: ThreadDetail;
    runId?: string;
    issueId?: string;
  }) => Promise<void> | void;
  setObservedThread?: (params: {
    threadId: string | null;
    detail?: ThreadDetail | null;
  }) => void;
  onThreadCreated: () => void;
};

export const PRIORITY_I18N: Record<KanbanPriority, string> = {
  urgent: 'kanban.priorityUrgent',
  high: 'kanban.priorityHigh',
  medium: 'kanban.priorityMedium',
  low: 'kanban.priorityLow',
  none: 'kanban.priorityNone',
};

export const EXECUTION_STATE_I18N: Record<KanbanExecutionState, string> = {
  RUNNING: 'kanban.executionRunning',
  SUCCESS: 'kanban.executionSuccess',
  FAILED: 'kanban.executionFailed',
  CANCELLED: 'kanban.executionCancelled',
};

export function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function projectNameFromId(projectId: string): string {
  const trimmed = projectId.replace(/[\\/]+$/, '');
  if (!trimmed) return projectId;
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || projectId;
}

export function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDateTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString();
}

export function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function getLastTurn(detail: ThreadDetail | null): Turn | null {
  const turns = detail?.turns;
  return turns && turns.length > 0 ? turns[turns.length - 1] : null;
}

export function turnStatusToExecutionState(turn: Turn | null): KanbanExecutionState | null {
  if (!turn) return null;
  switch (turn.status) {
    case 'inProgress':
      return 'RUNNING';
    case 'completed':
      return 'SUCCESS';
    case 'failed':
      return 'FAILED';
    case 'interrupted':
      return 'CANCELLED';
    default:
      return null;
  }
}

export function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function compactExecutionSummary(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function threadItemTextForExecutionSummary(item: ThreadItem): string {
  if (typeof item.text === 'string' && item.text.trim()) {
    return compactExecutionSummary(item.text);
  }
  if (typeof item.summary === 'string' && item.summary.trim()) {
    return compactExecutionSummary(item.summary);
  }
  if (Array.isArray(item.summary) && item.summary.length > 0) {
    return compactExecutionSummary(item.summary.join(' '));
  }
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((entry) => typeof entry === 'string' ? entry : entry?.text ?? '')
      .join(' ')
      .trim();
    if (text) return compactExecutionSummary(text);
  }
  return '';
}

export function extractExecutionResultSummary(detail: ThreadDetail): string | null {
  const turns = detail.turns ?? [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const items = turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex];
      if (item.type === 'agentMessage' && item.phase === 'final_answer') {
        const summary = threadItemTextForExecutionSummary(item);
        if (summary) return summary;
      }
    }
  }

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex--) {
    const items = turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
      const item = items[itemIndex];
      if (item.type === 'agentMessage') {
        const summary = threadItemTextForExecutionSummary(item);
        if (summary) return summary;
      }
    }
  }

  return null;
}

function compactPromptText(text: string): string {
  return text.trim().replace(/\s*\n+\s*/g, ' ').trim();
}

export function buildIssueExecutionPrompt(params: {
  issue: KanbanIssue;
  projectName: string;
  comments: KanbanComment[];
}): string {
  const tags = params.issue.tags
    ? params.issue.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
    : [];
  const recentComments = params.comments.slice(-5);

  const lines: string[] = [
    'You are executing a Kanban issue inside the selected project workspace.',
    'Use the issue context below as the task definition and use the working directory as the project root.',
    '',
    '## Issue Context',
    `- Project: ${params.projectName}`,
    `- Working directory: ${params.issue.project_id}`,
    params.issue.issue_number > 0 ? `- Issue number: #${params.issue.issue_number}` : '- Issue number: Not assigned',
    `- Title: ${params.issue.title}`,
    `- Column status: ${params.issue.status}`,
    `- Priority: ${params.issue.priority}`,
    `- Tags: ${tags.length > 0 ? tags.join(', ') : 'None'}`,
    `- Start date: ${params.issue.start_date ?? 'Not set'}`,
    `- Due date: ${params.issue.due_date ?? 'Not set'}`,
    `- Previous execution status: ${params.issue.last_run_status ?? 'Never run'}`,
    `- Previous execution error: ${params.issue.last_error ?? 'None'}`,
    '',
    '## Description',
    params.issue.description?.trim() || 'No description provided.',
  ];

  if (recentComments.length > 0) {
    lines.push('', '## Recent Comments');
    for (const comment of recentComments) {
      lines.push(`- [${formatDateTime(comment.created_at)}] ${compactPromptText(comment.content)}`);
    }
  }

  lines.push(
    '',
    '## Execution Guidance',
    '- Treat this issue as the task to complete.',
    '- Prefer the smallest safe implementation that resolves the issue.',
    '- If the issue is ambiguous, inspect the codebase and make the most grounded interpretation possible.',
    '- When you finish, include: what changed, any blockers or follow-ups, and the recommended next Kanban status.'
  );

  return lines.join('\n');
}

export function isDueOverdue(dueDate: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dueDate) < today;
}

export function isDueSoon(dueDate: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  const diff = (due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= 3;
}

export function useLocalStorage<T>(key: string, defaultValue: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
  }, [key]);

  return [value, set];
}
