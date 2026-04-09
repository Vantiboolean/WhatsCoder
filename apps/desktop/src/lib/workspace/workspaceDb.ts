import { invoke } from '@tauri-apps/api/core';
import { getSetting, setSetting } from '../db/db';
import { loadWorkspaceDraftMap } from '../utils/workspaceDrafts';
import { buildWorkspaceSummary } from './workspaceSummary';
import {
  createWorkspaceEntityId,
  parseWorkspaceScopeId,
  type WorkspaceBundle,
  type WorkspaceContextItemRecord,
  type WorkspaceContextKind,
  type WorkspaceExecutorProvider,
  type WorkspaceExecutorRecord,
  type WorkspaceExecutorRunStatus,
  type WorkspaceProjectOption,
  type WorkspaceRunRecord,
  type WorkspaceRunStatus,
  type WorkspaceScopeId,
  type WorkspaceScopeRecord,
  type WorkspaceScopeType,
  type WorkspaceStepRecord,
  type WorkspaceStepStatus,
  type WorkspaceSummary,
  type WorkspaceWorktreeRecord,
  type WorkspaceWorktreeStatus,
} from './types';

type RawRow = Record<string, unknown>;

let tablesEnsured = false;

const WORKSPACE_DB_MIGRATION_KEY = 'workspace-db-migrated-v1';

async function rawExecute(sql: string, params: unknown[] = []): Promise<number> {
  try {
    return await invoke<number>('db_raw_execute', { sql, params });
  } catch (err) {
    throw new Error(`SQL error [${sql.trim().slice(0, 80)}...]: ${err}`);
  }
}

async function rawSelect<T = RawRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return invoke<T[]>('db_raw_select', { sql, params });
}

function buildInClause(count: number, startAt = 1): string {
  return Array.from({ length: count }, (_, index) => `?${startAt + index}`).join(', ');
}

function readString(row: RawRow, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string' ? value : fallback;
}

function readNullableString(row: RawRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(row: RawRow, key: string, fallback = 0): number {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(row: RawRow, key: string): boolean {
  return readNumber(row, key, 0) === 1;
}

function normalizeScopeRow(row: RawRow): WorkspaceScopeRecord {
  return {
    scopeId: readString(row, 'scope_id') as WorkspaceScopeId,
    scopeType: readString(row, 'scope_type', 'project') as WorkspaceScopeType,
    projectId: readString(row, 'project_id'),
    issueId: readNullableString(row, 'issue_id'),
    issueLabel: readNullableString(row, 'issue_label'),
    linkedIssue: readString(row, 'linked_issue'),
    objective: readString(row, 'objective'),
    activeTask: readString(row, 'active_task'),
    runtimeNotes: readString(row, 'runtime_notes'),
    notes: readString(row, 'notes'),
    imageRefs: readString(row, 'image_refs'),
    lastRunThreadId: readNullableString(row, 'last_run_thread_id'),
    lastRunStatus: readNullableString(row, 'last_run_status') as WorkspaceRunStatus | null,
    lastRunSummary: readNullableString(row, 'last_run_summary'),
    lastRunAt: row.last_run_at == null ? null : readNumber(row, 'last_run_at'),
    activeExecutorId: readNullableString(row, 'active_executor_id'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  };
}

function normalizeStepRow(row: RawRow): WorkspaceStepRecord {
  return {
    id: readString(row, 'id'),
    scopeId: readString(row, 'scope_id') as WorkspaceScopeId,
    title: readString(row, 'title'),
    status: readString(row, 'status', 'pending') as WorkspaceStepStatus,
    sortOrder: readNumber(row, 'sort_order'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  };
}

function normalizeExecutorRow(row: RawRow): WorkspaceExecutorRecord {
  return {
    id: readString(row, 'id'),
    scopeId: readString(row, 'scope_id') as WorkspaceScopeId,
    name: readString(row, 'name'),
    providerKind: readString(row, 'provider_kind', 'codex') as WorkspaceExecutorProvider,
    model: readString(row, 'model'),
    reasoning: readString(row, 'reasoning'),
    roleLabel: readString(row, 'role_label'),
    terminalLane: readString(row, 'terminal_lane'),
    cwdOverride: readNullableString(row, 'cwd_override'),
    isPrimary: readBoolean(row, 'is_primary'),
    runStatus: readString(row, 'run_status', 'idle') as WorkspaceExecutorRunStatus,
    lastThreadId: readNullableString(row, 'last_thread_id'),
    lastRunAt: row.last_run_at == null ? null : readNumber(row, 'last_run_at'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  };
}

function normalizeContextRow(row: RawRow): WorkspaceContextItemRecord {
  return {
    id: readString(row, 'id'),
    scopeId: readString(row, 'scope_id') as WorkspaceScopeId,
    kind: readString(row, 'kind', 'note') as WorkspaceContextKind,
    title: readString(row, 'title'),
    content: readString(row, 'content'),
    ref: readNullableString(row, 'ref'),
    source: readNullableString(row, 'source'),
    sortOrder: readNumber(row, 'sort_order'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  };
}

function normalizeWorktreeRow(row: RawRow): WorkspaceWorktreeRecord {
  return {
    id: readString(row, 'id'),
    scopeId: readString(row, 'scope_id') as WorkspaceScopeId,
    branch: readString(row, 'branch'),
    path: readString(row, 'path'),
    goal: readString(row, 'goal'),
    status: readString(row, 'status', 'planned') as WorkspaceWorktreeStatus,
    isPrimary: readBoolean(row, 'is_primary'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  };
}

function normalizeRunRow(row: RawRow): WorkspaceRunRecord {
  return {
    id: readString(row, 'id'),
    scopeId: readString(row, 'scope_id') as WorkspaceScopeId,
    executorId: readString(row, 'executor_id'),
    issueId: readNullableString(row, 'issue_id'),
    threadId: readNullableString(row, 'thread_id'),
    providerKind: readString(row, 'provider_kind', 'codex') as WorkspaceExecutorProvider,
    model: readString(row, 'model'),
    status: readString(row, 'status', 'queued') as WorkspaceRunStatus,
    promptSnapshot: readString(row, 'prompt_snapshot'),
    resultSummary: readNullableString(row, 'result_summary'),
    errorMessage: readNullableString(row, 'error_message'),
    startedAt: readNumber(row, 'started_at'),
    finishedAt: row.finished_at == null ? null : readNumber(row, 'finished_at'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  };
}

function emptyScope(params: {
  scopeId: WorkspaceScopeId;
  projectId: string;
  scopeType: WorkspaceScopeType;
  issueId?: string | null;
  issueLabel?: string | null;
}): WorkspaceScopeRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    scopeId: params.scopeId,
    scopeType: params.scopeType,
    projectId: params.projectId,
    issueId: params.issueId ?? null,
    issueLabel: params.issueLabel ?? null,
    linkedIssue: params.issueLabel ?? '',
    objective: '',
    activeTask: '',
    runtimeNotes: '',
    notes: '',
    imageRefs: '',
    lastRunThreadId: null,
    lastRunStatus: null,
    lastRunSummary: null,
    lastRunAt: null,
    activeExecutorId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function ensureWorkspaceTables(): Promise<void> {
  if (tablesEnsured) return;

  const statements = [
    `CREATE TABLE IF NOT EXISTS workspace_scopes (
      scope_id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      project_id TEXT NOT NULL,
      issue_id TEXT,
      issue_label TEXT,
      linked_issue TEXT NOT NULL DEFAULT '',
      objective TEXT NOT NULL DEFAULT '',
      active_task TEXT NOT NULL DEFAULT '',
      runtime_notes TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      image_refs TEXT NOT NULL DEFAULT '',
      last_run_thread_id TEXT,
      last_run_status TEXT,
      last_run_summary TEXT,
      last_run_at INTEGER,
      active_executor_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_steps (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_executors (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      provider_kind TEXT NOT NULL DEFAULT 'codex',
      model TEXT NOT NULL DEFAULT '',
      reasoning TEXT NOT NULL DEFAULT '',
      role_label TEXT NOT NULL DEFAULT '',
      terminal_lane TEXT NOT NULL DEFAULT '',
      cwd_override TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      run_status TEXT NOT NULL DEFAULT 'idle',
      last_thread_id TEXT,
      last_run_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_context_items (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      ref TEXT,
      source TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_worktrees (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_runs (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      issue_id TEXT,
      thread_id TEXT,
      provider_kind TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      prompt_snapshot TEXT NOT NULL DEFAULT '',
      result_summary TEXT,
      error_message TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    'CREATE INDEX IF NOT EXISTS idx_workspace_scopes_project_id ON workspace_scopes(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_workspace_scopes_issue_id ON workspace_scopes(issue_id)',
    'CREATE INDEX IF NOT EXISTS idx_workspace_steps_scope_id ON workspace_steps(scope_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_workspace_executors_scope_id ON workspace_executors(scope_id, is_primary DESC, created_at ASC)',
    'CREATE INDEX IF NOT EXISTS idx_workspace_context_scope_id ON workspace_context_items(scope_id, sort_order)',
    'CREATE INDEX IF NOT EXISTS idx_workspace_worktrees_scope_id ON workspace_worktrees(scope_id, is_primary DESC, created_at ASC)',
    'CREATE INDEX IF NOT EXISTS idx_workspace_runs_scope_id ON workspace_runs(scope_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_workspace_runs_status ON workspace_runs(status)',
  ];

  for (const statement of statements) {
    await rawExecute(statement);
  }

  tablesEnsured = true;
}

export async function getWorkspaceScope(scopeId: WorkspaceScopeId): Promise<WorkspaceScopeRecord | null> {
  await ensureWorkspaceTables();
  const rows = await rawSelect<RawRow>(
    'SELECT * FROM workspace_scopes WHERE scope_id = ?1 LIMIT 1',
    [scopeId],
  );
  return rows[0] ? normalizeScopeRow(rows[0]) : null;
}

export async function ensureWorkspaceScope(params: {
  scopeId: WorkspaceScopeId;
  projectId: string;
  scopeType: WorkspaceScopeType;
  issueId?: string | null;
  issueLabel?: string | null;
}): Promise<WorkspaceScopeRecord> {
  await ensureWorkspaceTables();
  const existing = await getWorkspaceScope(params.scopeId);
  if (existing) {
    if (
      existing.projectId !== params.projectId ||
      existing.issueId !== (params.issueId ?? null) ||
      existing.issueLabel !== (params.issueLabel ?? null)
    ) {
      const nextScope = {
        ...existing,
        projectId: params.projectId,
        issueId: params.issueId ?? existing.issueId,
        issueLabel: params.issueLabel ?? existing.issueLabel,
        scopeType: params.scopeType,
      };
      await upsertWorkspaceScope(nextScope);
      return nextScope;
    }
    return existing;
  }

  const next = emptyScope(params);
  await upsertWorkspaceScope(next);
  return next;
}

export async function upsertWorkspaceScope(scope: WorkspaceScopeRecord): Promise<void> {
  await ensureWorkspaceTables();
  await rawExecute(
    `INSERT INTO workspace_scopes (
      scope_id, scope_type, project_id, issue_id, issue_label, linked_issue, objective, active_task,
      runtime_notes, notes, image_refs, last_run_thread_id, last_run_status, last_run_summary,
      last_run_at, active_executor_id, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
      ?9, ?10, ?11, ?12, ?13, ?14,
      ?15, ?16, COALESCE(?17, strftime('%s','now')), strftime('%s','now')
    )
    ON CONFLICT(scope_id) DO UPDATE SET
      scope_type = excluded.scope_type,
      project_id = excluded.project_id,
      issue_id = excluded.issue_id,
      issue_label = excluded.issue_label,
      linked_issue = excluded.linked_issue,
      objective = excluded.objective,
      active_task = excluded.active_task,
      runtime_notes = excluded.runtime_notes,
      notes = excluded.notes,
      image_refs = excluded.image_refs,
      last_run_thread_id = excluded.last_run_thread_id,
      last_run_status = excluded.last_run_status,
      last_run_summary = excluded.last_run_summary,
      last_run_at = excluded.last_run_at,
      active_executor_id = excluded.active_executor_id,
      updated_at = strftime('%s','now')`,
    [
      scope.scopeId,
      scope.scopeType,
      scope.projectId,
      scope.issueId,
      scope.issueLabel,
      scope.linkedIssue,
      scope.objective,
      scope.activeTask,
      scope.runtimeNotes,
      scope.notes,
      scope.imageRefs,
      scope.lastRunThreadId,
      scope.lastRunStatus,
      scope.lastRunSummary,
      scope.lastRunAt,
      scope.activeExecutorId,
      scope.createdAt || null,
    ],
  );
}

export async function listWorkspaceSteps(scopeId: WorkspaceScopeId): Promise<WorkspaceStepRecord[]> {
  await ensureWorkspaceTables();
  const rows = await rawSelect<RawRow>(
    'SELECT * FROM workspace_steps WHERE scope_id = ?1 ORDER BY sort_order ASC, created_at ASC',
    [scopeId],
  );
  return rows.map(normalizeStepRow);
}

export async function replaceWorkspaceSteps(
  scopeId: WorkspaceScopeId,
  steps: Array<{ id?: string; title: string; status: WorkspaceStepStatus; sortOrder: number }>,
): Promise<WorkspaceStepRecord[]> {
  await ensureWorkspaceTables();
  await rawExecute('BEGIN IMMEDIATE');
  try {
    await rawExecute('DELETE FROM workspace_steps WHERE scope_id = ?1', [scopeId]);
    for (const [index, step] of steps.entries()) {
      const id = step.id ?? createWorkspaceEntityId('step');
      await rawExecute(
        `INSERT INTO workspace_steps (
          id, scope_id, title, status, sort_order, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'), strftime('%s','now'))`,
        [id, scopeId, step.title, step.status, step.sortOrder ?? index],
      );
    }
    await rawExecute('COMMIT');
    return listWorkspaceSteps(scopeId);
  } catch (err) {
    await rawExecute('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function clearPrimaryExecutor(scopeId: WorkspaceScopeId, keepId?: string): Promise<void> {
  if (keepId) {
    await rawExecute(
      'UPDATE workspace_executors SET is_primary = 0, updated_at = strftime(\'%s\',\'now\') WHERE scope_id = ?1 AND id != ?2',
      [scopeId, keepId],
    );
    return;
  }

  await rawExecute(
    'UPDATE workspace_executors SET is_primary = 0, updated_at = strftime(\'%s\',\'now\') WHERE scope_id = ?1',
    [scopeId],
  );
}

export async function listWorkspaceExecutors(scopeId: WorkspaceScopeId): Promise<WorkspaceExecutorRecord[]> {
  await ensureWorkspaceTables();
  const rows = await rawSelect<RawRow>(
    'SELECT * FROM workspace_executors WHERE scope_id = ?1 ORDER BY is_primary DESC, created_at ASC',
    [scopeId],
  );
  return rows.map(normalizeExecutorRow);
}

export async function upsertWorkspaceExecutor(executor: WorkspaceExecutorRecord): Promise<WorkspaceExecutorRecord[]> {
  await ensureWorkspaceTables();
  await rawExecute('BEGIN IMMEDIATE');
  try {
    if (executor.isPrimary) {
      await clearPrimaryExecutor(executor.scopeId, executor.id);
    }
    await rawExecute(
      `INSERT INTO workspace_executors (
        id, scope_id, name, provider_kind, model, reasoning, role_label, terminal_lane,
        cwd_override, is_primary, run_status, last_thread_id, last_run_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
        ?9, ?10, ?11, ?12, ?13, COALESCE(?14, strftime('%s','now')), strftime('%s','now')
      )
      ON CONFLICT(id) DO UPDATE SET
        scope_id = excluded.scope_id,
        name = excluded.name,
        provider_kind = excluded.provider_kind,
        model = excluded.model,
        reasoning = excluded.reasoning,
        role_label = excluded.role_label,
        terminal_lane = excluded.terminal_lane,
        cwd_override = excluded.cwd_override,
        is_primary = excluded.is_primary,
        run_status = excluded.run_status,
        last_thread_id = excluded.last_thread_id,
        last_run_at = excluded.last_run_at,
        updated_at = strftime('%s','now')`,
      [
        executor.id,
        executor.scopeId,
        executor.name,
        executor.providerKind,
        executor.model,
        executor.reasoning,
        executor.roleLabel,
        executor.terminalLane,
        executor.cwdOverride,
        executor.isPrimary ? 1 : 0,
        executor.runStatus,
        executor.lastThreadId,
        executor.lastRunAt,
        executor.createdAt || null,
      ],
    );

    const nextExecutors = await listWorkspaceExecutors(executor.scopeId);
    if (nextExecutors.length > 0 && !nextExecutors.some((item) => item.isPrimary)) {
      await rawExecute(
        'UPDATE workspace_executors SET is_primary = 1, updated_at = strftime(\'%s\',\'now\') WHERE id = ?1',
        [nextExecutors[0].id],
      );
    }
    await rawExecute('COMMIT');
    return listWorkspaceExecutors(executor.scopeId);
  } catch (err) {
    await rawExecute('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function deleteWorkspaceExecutor(scopeId: WorkspaceScopeId, executorId: string): Promise<WorkspaceExecutorRecord[]> {
  await ensureWorkspaceTables();
  await rawExecute('BEGIN IMMEDIATE');
  try {
    await rawExecute('DELETE FROM workspace_executors WHERE id = ?1', [executorId]);
    const nextExecutors = await listWorkspaceExecutors(scopeId);
    if (nextExecutors.length > 0 && !nextExecutors.some((item) => item.isPrimary)) {
      await rawExecute(
        'UPDATE workspace_executors SET is_primary = 1, updated_at = strftime(\'%s\',\'now\') WHERE id = ?1',
        [nextExecutors[0].id],
      );
    }
    await rawExecute('COMMIT');
    return listWorkspaceExecutors(scopeId);
  } catch (err) {
    await rawExecute('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function listWorkspaceContextItems(scopeId: WorkspaceScopeId): Promise<WorkspaceContextItemRecord[]> {
  await ensureWorkspaceTables();
  const rows = await rawSelect<RawRow>(
    'SELECT * FROM workspace_context_items WHERE scope_id = ?1 ORDER BY sort_order ASC, created_at ASC',
    [scopeId],
  );
  return rows.map(normalizeContextRow);
}

export async function upsertWorkspaceContextItem(item: WorkspaceContextItemRecord): Promise<WorkspaceContextItemRecord[]> {
  await ensureWorkspaceTables();
  await rawExecute(
    `INSERT INTO workspace_context_items (
      id, scope_id, kind, title, content, ref, source, sort_order, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, strftime('%s','now')), strftime('%s','now')
    )
    ON CONFLICT(id) DO UPDATE SET
      scope_id = excluded.scope_id,
      kind = excluded.kind,
      title = excluded.title,
      content = excluded.content,
      ref = excluded.ref,
      source = excluded.source,
      sort_order = excluded.sort_order,
      updated_at = strftime('%s','now')`,
    [
      item.id,
      item.scopeId,
      item.kind,
      item.title,
      item.content,
      item.ref,
      item.source,
      item.sortOrder,
      item.createdAt || null,
    ],
  );
  return listWorkspaceContextItems(item.scopeId);
}

export async function deleteWorkspaceContextItem(scopeId: WorkspaceScopeId, itemId: string): Promise<WorkspaceContextItemRecord[]> {
  await ensureWorkspaceTables();
  await rawExecute('DELETE FROM workspace_context_items WHERE id = ?1', [itemId]);
  return listWorkspaceContextItems(scopeId);
}

export async function listWorkspaceWorktrees(scopeId: WorkspaceScopeId): Promise<WorkspaceWorktreeRecord[]> {
  await ensureWorkspaceTables();
  const rows = await rawSelect<RawRow>(
    'SELECT * FROM workspace_worktrees WHERE scope_id = ?1 ORDER BY is_primary DESC, created_at ASC',
    [scopeId],
  );
  return rows.map(normalizeWorktreeRow);
}

async function clearPrimaryWorktree(scopeId: WorkspaceScopeId, keepId?: string): Promise<void> {
  if (keepId) {
    await rawExecute(
      'UPDATE workspace_worktrees SET is_primary = 0, updated_at = strftime(\'%s\',\'now\') WHERE scope_id = ?1 AND id != ?2',
      [scopeId, keepId],
    );
    return;
  }

  await rawExecute(
    'UPDATE workspace_worktrees SET is_primary = 0, updated_at = strftime(\'%s\',\'now\') WHERE scope_id = ?1',
    [scopeId],
  );
}

export async function upsertWorkspaceWorktree(worktree: WorkspaceWorktreeRecord): Promise<WorkspaceWorktreeRecord[]> {
  await ensureWorkspaceTables();
  await rawExecute('BEGIN IMMEDIATE');
  try {
    if (worktree.isPrimary) {
      await clearPrimaryWorktree(worktree.scopeId, worktree.id);
    }
    await rawExecute(
      `INSERT INTO workspace_worktrees (
        id, scope_id, branch, path, goal, status, is_primary, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, strftime('%s','now')), strftime('%s','now')
      )
      ON CONFLICT(id) DO UPDATE SET
        scope_id = excluded.scope_id,
        branch = excluded.branch,
        path = excluded.path,
        goal = excluded.goal,
        status = excluded.status,
        is_primary = excluded.is_primary,
        updated_at = strftime('%s','now')`,
      [
        worktree.id,
        worktree.scopeId,
        worktree.branch,
        worktree.path,
        worktree.goal,
        worktree.status,
        worktree.isPrimary ? 1 : 0,
        worktree.createdAt || null,
      ],
    );

    const nextWorktrees = await listWorkspaceWorktrees(worktree.scopeId);
    if (nextWorktrees.length > 0 && !nextWorktrees.some((item) => item.isPrimary)) {
      await rawExecute(
        'UPDATE workspace_worktrees SET is_primary = 1, updated_at = strftime(\'%s\',\'now\') WHERE id = ?1',
        [nextWorktrees[0].id],
      );
    }
    await rawExecute('COMMIT');
    return listWorkspaceWorktrees(worktree.scopeId);
  } catch (err) {
    await rawExecute('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function deleteWorkspaceWorktree(scopeId: WorkspaceScopeId, worktreeId: string): Promise<WorkspaceWorktreeRecord[]> {
  await ensureWorkspaceTables();
  await rawExecute('BEGIN IMMEDIATE');
  try {
    await rawExecute('DELETE FROM workspace_worktrees WHERE id = ?1', [worktreeId]);
    const next = await listWorkspaceWorktrees(scopeId);
    if (next.length > 0 && !next.some((item) => item.isPrimary)) {
      await rawExecute(
        'UPDATE workspace_worktrees SET is_primary = 1, updated_at = strftime(\'%s\',\'now\') WHERE id = ?1',
        [next[0].id],
      );
    }
    await rawExecute('COMMIT');
    return listWorkspaceWorktrees(scopeId);
  } catch (err) {
    await rawExecute('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function createWorkspaceRun(run: WorkspaceRunRecord): Promise<void> {
  await ensureWorkspaceTables();
  await rawExecute(
    `INSERT INTO workspace_runs (
      id, scope_id, executor_id, issue_id, thread_id, provider_kind, model, status,
      prompt_snapshot, result_summary, error_message, started_at, finished_at, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
      ?9, ?10, ?11, ?12, ?13, COALESCE(?14, strftime('%s','now')), strftime('%s','now')
    )`,
    [
      run.id,
      run.scopeId,
      run.executorId,
      run.issueId,
      run.threadId,
      run.providerKind,
      run.model,
      run.status,
      run.promptSnapshot,
      run.resultSummary,
      run.errorMessage,
      run.startedAt,
      run.finishedAt,
      run.createdAt || null,
    ],
  );
}

export async function updateWorkspaceRun(updates: Partial<WorkspaceRunRecord> & { id: string }): Promise<void> {
  await ensureWorkspaceTables();
  const sets: string[] = ['updated_at = strftime(\'%s\',\'now\')'];
  const params: unknown[] = [];
  let idx = 1;

  const textColumns: Array<[keyof WorkspaceRunRecord, string]> = [
    ['scopeId', 'scope_id'],
    ['executorId', 'executor_id'],
    ['issueId', 'issue_id'],
    ['threadId', 'thread_id'],
    ['providerKind', 'provider_kind'],
    ['model', 'model'],
    ['status', 'status'],
    ['promptSnapshot', 'prompt_snapshot'],
    ['resultSummary', 'result_summary'],
    ['errorMessage', 'error_message'],
  ];

  for (const [key, column] of textColumns) {
    if (key in updates && updates[key] !== undefined) {
      sets.push(`${column} = ?${idx}`);
      params.push(updates[key] ?? null);
      idx += 1;
    }
  }

  if (updates.startedAt !== undefined) {
    sets.push(`started_at = ?${idx}`);
    params.push(updates.startedAt);
    idx += 1;
  }
  if (updates.finishedAt !== undefined) {
    sets.push(`finished_at = ?${idx}`);
    params.push(updates.finishedAt);
    idx += 1;
  }

  params.push(updates.id);
  await rawExecute(
    `UPDATE workspace_runs SET ${sets.join(', ')} WHERE id = ?${idx}`,
    params,
  );
}

export async function listWorkspaceRuns(
  scopeId: WorkspaceScopeId,
  options?: { limit?: number; statuses?: WorkspaceRunStatus[] },
): Promise<WorkspaceRunRecord[]> {
  await ensureWorkspaceTables();
  const params: unknown[] = [scopeId];
  let statusSql = '';
  if (options?.statuses && options.statuses.length > 0) {
    statusSql = ` AND status IN (${buildInClause(options.statuses.length, 2)})`;
    params.push(...options.statuses);
  }
  const limitIndex = params.length + 1;
  params.push(options?.limit ?? 20);
  const rows = await rawSelect<RawRow>(
    `SELECT * FROM workspace_runs WHERE scope_id = ?1${statusSql} ORDER BY created_at DESC LIMIT ?${limitIndex}`,
    params,
  );
  return rows.map(normalizeRunRow);
}

export async function listWorkspaceProjects(): Promise<WorkspaceProjectOption[]> {
  await ensureWorkspaceTables();
  const rows = await rawSelect<RawRow>(
    'SELECT DISTINCT project_id FROM workspace_scopes WHERE project_id IS NOT NULL AND project_id != "" ORDER BY project_id ASC',
  );
  return rows.map((row) => ({
    id: readString(row, 'project_id'),
    name: readString(row, 'project_id'),
  }));
}

export async function loadWorkspaceBundle(params: {
  scopeId: WorkspaceScopeId;
  projectId: string;
  issueId?: string | null;
  issueLabel?: string | null;
}): Promise<WorkspaceBundle> {
  const parsed = parseWorkspaceScopeId(params.scopeId);
  const scope = await ensureWorkspaceScope({
    scopeId: params.scopeId,
    projectId: params.projectId,
    scopeType: parsed.scopeType,
    issueId: params.issueId ?? parsed.issueId,
    issueLabel: params.issueLabel ?? null,
  });

  const [steps, executors, contextItems, worktrees, runs] = await Promise.all([
    listWorkspaceSteps(scope.scopeId),
    listWorkspaceExecutors(scope.scopeId),
    listWorkspaceContextItems(scope.scopeId),
    listWorkspaceWorktrees(scope.scopeId),
    listWorkspaceRuns(scope.scopeId),
  ]);

  const summary = buildWorkspaceSummary({
    scope,
    steps,
    executors,
    contextItems,
    worktrees,
  });

  return {
    scope,
    steps,
    executors,
    contextItems,
    worktrees,
    runs,
    summary,
  };
}

export async function listWorkspaceSummaries(scopeIds: WorkspaceScopeId[]): Promise<Record<string, WorkspaceSummary>> {
  await ensureWorkspaceTables();
  if (scopeIds.length === 0) return {};

  const placeholders = buildInClause(scopeIds.length);
  const [scopeRows, stepRows, contextRows, executorRows, worktreeRows] = await Promise.all([
    rawSelect<RawRow>(
      `SELECT * FROM workspace_scopes WHERE scope_id IN (${placeholders})`,
      scopeIds,
    ),
    rawSelect<RawRow>(
      `SELECT scope_id, COUNT(*) AS total_steps,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed_steps
        FROM workspace_steps
        WHERE scope_id IN (${placeholders})
        GROUP BY scope_id`,
      scopeIds,
    ),
    rawSelect<RawRow>(
      `SELECT scope_id, COUNT(*) AS context_count
        FROM workspace_context_items
        WHERE scope_id IN (${placeholders}) AND kind != 'run_summary'
        GROUP BY scope_id`,
      scopeIds,
    ),
    rawSelect<RawRow>(
      `SELECT * FROM workspace_executors
        WHERE scope_id IN (${placeholders})
        ORDER BY is_primary DESC, created_at ASC`,
      scopeIds,
    ),
    rawSelect<RawRow>(
      `SELECT * FROM workspace_worktrees
        WHERE scope_id IN (${placeholders})
        ORDER BY is_primary DESC, created_at ASC`,
      scopeIds,
    ),
  ]);

  const stepsByScope = new Map<string, WorkspaceStepRecord[]>();
  for (const row of stepRows) {
    const scopeId = readString(row, 'scope_id') as WorkspaceScopeId;
    const total = readNumber(row, 'total_steps');
    const completed = readNumber(row, 'completed_steps');
    const items: WorkspaceStepRecord[] = [];
    for (let index = 0; index < total; index += 1) {
      items.push({
        id: `${scopeId}-summary-step-${index}`,
        scopeId,
        title: '',
        status: index < completed ? 'done' : 'pending',
        sortOrder: index,
        createdAt: 0,
        updatedAt: 0,
      });
    }
    stepsByScope.set(scopeId, items);
  }

  const contextCountByScope = new Map<string, number>();
  for (const row of contextRows) {
    contextCountByScope.set(readString(row, 'scope_id'), readNumber(row, 'context_count'));
  }

  const executorsByScope = new Map<string, WorkspaceExecutorRecord[]>();
  for (const row of executorRows) {
    const executor = normalizeExecutorRow(row);
    const current = executorsByScope.get(executor.scopeId) ?? [];
    current.push(executor);
    executorsByScope.set(executor.scopeId, current);
  }

  const worktreesByScope = new Map<string, WorkspaceWorktreeRecord[]>();
  for (const row of worktreeRows) {
    const worktree = normalizeWorktreeRow(row);
    const current = worktreesByScope.get(worktree.scopeId) ?? [];
    current.push(worktree);
    worktreesByScope.set(worktree.scopeId, current);
  }

  const result: Record<string, WorkspaceSummary> = {};
  for (const row of scopeRows) {
    const scope = normalizeScopeRow(row);
    const contextCount = contextCountByScope.get(scope.scopeId) ?? 0;
    const syntheticContextItems: WorkspaceContextItemRecord[] = Array.from({ length: contextCount }, (_, index) => ({
      id: `${scope.scopeId}-summary-context-${index}`,
      scopeId: scope.scopeId,
      kind: 'note',
      title: '',
      content: '',
      ref: null,
      source: null,
      sortOrder: index,
      createdAt: 0,
      updatedAt: 0,
    }));

    result[scope.scopeId] = buildWorkspaceSummary({
      scope,
      steps: stepsByScope.get(scope.scopeId) ?? [],
      executors: executorsByScope.get(scope.scopeId) ?? [],
      contextItems: syntheticContextItems,
      worktrees: worktreesByScope.get(scope.scopeId) ?? [],
    });
  }

  return result;
}

export async function migrateWorkspaceDraftsIfNeeded(): Promise<boolean> {
  await ensureWorkspaceTables();
  const migrated = await getSetting(WORKSPACE_DB_MIGRATION_KEY).catch(() => null);
  if (migrated === '1') {
    return false;
  }

  const legacyDrafts = loadWorkspaceDraftMap();
  const entries = Object.entries(legacyDrafts);
  if (entries.length === 0) {
    await setSetting(WORKSPACE_DB_MIGRATION_KEY, '1').catch(() => {});
    return false;
  }

  const existingScopes = await rawSelect<RawRow>('SELECT scope_id FROM workspace_scopes');
  const existingScopeIds = new Set(existingScopes.map((row) => readString(row, 'scope_id')));
  const now = Math.floor(Date.now() / 1000);

  for (const [scopeIdRaw, draft] of entries) {
    const scopeId = scopeIdRaw as WorkspaceScopeId;
    if (existingScopeIds.has(scopeId)) {
      continue;
    }

    const parsed = parseWorkspaceScopeId(scopeId);
    const issueId = parsed.scopeType === 'issue' ? parsed.issueId : draft.issueId || null;
    const issueLabel = draft.issueLabel || null;
    const issueProjectRows =
      parsed.scopeType === 'issue' && issueId
        ? await rawSelect<RawRow>(
          'SELECT project_id FROM kanban_issues WHERE id = ?1 LIMIT 1',
          [issueId],
        ).catch(() => [])
        : [];
    const projectId =
      parsed.scopeType === 'project'
        ? parsed.projectId ?? ''
        : (issueProjectRows[0] ? readString(issueProjectRows[0], 'project_id') : '');

    const resolvedProjectId =
      projectId || (scopeId.startsWith('project::') ? scopeId.slice('project::'.length) : '');

    const baseScope = emptyScope({
      scopeId,
      scopeType: parsed.scopeType,
      projectId: resolvedProjectId,
      issueId,
      issueLabel,
    });

    const nextScope: WorkspaceScopeRecord = {
      ...baseScope,
      linkedIssue: draft.linkedIssue,
      objective: draft.objective,
      activeTask: draft.activeTask,
      runtimeNotes: draft.runtimeNotes,
      notes: draft.notes,
      imageRefs: draft.imageRefs,
      issueId: draft.issueId || issueId,
      issueLabel: draft.issueLabel || issueLabel,
      createdAt: Math.floor((draft.lastUpdatedAt || Date.now()) / 1000),
      updatedAt: Math.floor((draft.lastUpdatedAt || Date.now()) / 1000),
    };

    await upsertWorkspaceScope(nextScope);
    if (draft.steps.length > 0) {
      await replaceWorkspaceSteps(
        scopeId,
        draft.steps.map((step, index) => ({
          id: step.id,
          title: step.title,
          status: step.status,
          sortOrder: index,
        })),
      );
    }

    if (draft.primaryAgent.trim() || draft.executionModel.trim() || draft.terminalFocus.trim()) {
      const executorId = createWorkspaceEntityId('executor');
      await upsertWorkspaceExecutor({
        id: executorId,
        scopeId,
        name: draft.primaryAgent,
        providerKind: draft.executionModel.toLowerCase().includes('claude') ? 'claude' : 'codex',
        model: draft.executionModel,
        reasoning: '',
        roleLabel: 'Migrated primary executor',
        terminalLane: draft.terminalFocus,
        cwdOverride: null,
        isPrimary: true,
        runStatus: 'idle',
        lastThreadId: null,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await upsertWorkspaceScope({
        ...nextScope,
        activeExecutorId: executorId,
      });
    }

    if (draft.worktreeBranch.trim() || draft.worktreePath.trim() || draft.worktreeGoal.trim()) {
      await upsertWorkspaceWorktree({
        id: createWorkspaceEntityId('worktree'),
        scopeId,
        branch: draft.worktreeBranch,
        path: draft.worktreePath,
        goal: draft.worktreeGoal,
        status: draft.worktreeBranch.trim() || draft.worktreePath.trim() ? 'ready' : 'planned',
        isPrimary: true,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  await setSetting(WORKSPACE_DB_MIGRATION_KEY, '1').catch(() => {});
  return true;
}
