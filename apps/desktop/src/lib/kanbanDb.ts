import { invoke } from '@tauri-apps/api/core';

// ── Low-level helpers wrapping Rust db_raw_execute / db_raw_select ──

type RawRow = Record<string, unknown>;

async function rawExecute(sql: string, params: unknown[] = []): Promise<number> {
  try {
    return await invoke<number>('db_raw_execute', { sql, params });
  } catch (err) {
    throw new Error(`SQL error [${sql.trim().slice(0, 60)}...]: ${err}`);
  }
}

async function rawSelect<T = RawRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  return invoke<T[]>('db_raw_select', { sql, params });
}

// ── Types ──

export type KanbanStatus = 'todo' | 'in_progress' | 'in_review' | 'done';
export type KanbanPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';
export type KanbanExecutionState = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type KanbanRunTriggerSource = 'manual' | 'quick_add_auto' | 'move_auto';

export interface KanbanIssue {
  id: string;
  project_id: string;
  issue_number: number;
  title: string;
  description: string | null;
  status: KanbanStatus;
  priority: KanbanPriority;
  tags: string | null;
  start_date: string | null;
  due_date: string | null;
  linked_thread_id: string | null;
  last_run_status: KanbanExecutionState | null;
  last_run_at: number | null;
  last_finished_at: number | null;
  last_error: string | null;
  last_result_summary: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface KanbanIssueRun {
  id: string;
  issue_id: string;
  trigger_source: KanbanRunTriggerSource;
  status: KanbanExecutionState;
  thread_id: string | null;
  error_message: string | null;
  result_summary: string | null;
  started_at: number;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

export const KANBAN_COLUMNS: { key: KanbanStatus; i18nKey: string }[] = [
  { key: 'todo', i18nKey: 'kanban.todo' },
  { key: 'in_progress', i18nKey: 'kanban.inProgress' },
  { key: 'in_review', i18nKey: 'kanban.inReview' },
  { key: 'done', i18nKey: 'kanban.doneStat' },
];

export const PRIORITY_CONFIG: Record<KanbanPriority, { label: string; color: string }> = {
  urgent: { label: 'Urgent', color: '#ef4444' },
  high: { label: 'High', color: '#f97316' },
  medium: { label: 'Medium', color: '#eab308' },
  low: { label: 'Low', color: '#3b82f6' },
  none: { label: 'None', color: '#6b7280' },
};

// ── Schema ──

let _tablesEnsured = false;

const KANBAN_ISSUES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS kanban_issues (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    issue_number INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    tags TEXT,
    start_date TEXT,
    due_date TEXT,
    sort_order REAL NOT NULL DEFAULT 0,
    linked_thread_id TEXT,
    last_run_status TEXT,
    last_run_at INTEGER,
    last_finished_at INTEGER,
    last_error TEXT,
    last_result_summary TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )
`;

const KANBAN_COMMENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS kanban_comments (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )
`;

const KANBAN_ISSUE_RUNS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS kanban_issue_runs (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    trigger_source TEXT NOT NULL,
    status TEXT NOT NULL,
    thread_id TEXT,
    error_message TEXT,
    result_summary TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  )
`;

function selectExistingColumnOrFallback(columns: Set<string>, column: string, fallbackSql: string): string {
  return columns.has(column) ? column : `${fallbackSql} AS ${column}`;
}

async function tableHasForeignKeys(tableName: 'kanban_issues' | 'kanban_comments'): Promise<boolean> {
  const rows = await rawSelect(`PRAGMA foreign_key_list(${tableName})`);
  return rows.length > 0;
}

async function getTableColumns(tableName: string): Promise<Set<string>> {
  const rows = await rawSelect<{ name: string }>(`PRAGMA table_info(${tableName})`);
  return new Set(rows.map((row) => row.name));
}

async function rebuildKanbanTablesWithoutForeignKeys(): Promise<void> {
  const issuesHasForeignKeys = await tableHasForeignKeys('kanban_issues');
  const commentsHasForeignKeys = await tableHasForeignKeys('kanban_comments');

  if (!issuesHasForeignKeys && !commentsHasForeignKeys) return;

  let transactionStarted = false;
  try {
    await rawExecute('PRAGMA foreign_keys = OFF');
    await rawExecute('BEGIN IMMEDIATE');
    transactionStarted = true;

    if (issuesHasForeignKeys) {
      await rawExecute('ALTER TABLE kanban_issues RENAME TO kanban_issues_old');
    }
    if (commentsHasForeignKeys) {
      await rawExecute('ALTER TABLE kanban_comments RENAME TO kanban_comments_old');
    }

    await rawExecute(KANBAN_ISSUES_TABLE_SQL);
    await rawExecute(KANBAN_COMMENTS_TABLE_SQL);

    if (issuesHasForeignKeys) {
      const issueColumns = await getTableColumns('kanban_issues_old');
      await rawExecute(
        `INSERT INTO kanban_issues (
          id, project_id, issue_number, title, description, status, priority, tags,
          start_date, due_date, sort_order, linked_thread_id, last_run_status,
          last_run_at, last_finished_at, last_error, last_result_summary, created_at, updated_at
        )
        SELECT
          id,
          project_id,
          ${selectExistingColumnOrFallback(issueColumns, 'issue_number', '0')},
          title,
          ${selectExistingColumnOrFallback(issueColumns, 'description', 'NULL')},
          ${issueColumns.has('status') ? "CASE WHEN status = 'backlog' THEN 'todo' ELSE status END" : "'todo' AS status"},
          ${selectExistingColumnOrFallback(issueColumns, 'priority', "'medium'")},
          ${selectExistingColumnOrFallback(issueColumns, 'tags', 'NULL')},
          ${selectExistingColumnOrFallback(issueColumns, 'start_date', 'NULL')},
          ${selectExistingColumnOrFallback(issueColumns, 'due_date', 'NULL')},
          ${selectExistingColumnOrFallback(issueColumns, 'sort_order', '0')},
          ${selectExistingColumnOrFallback(issueColumns, 'linked_thread_id', 'NULL')},
          ${selectExistingColumnOrFallback(issueColumns, 'last_run_status', 'NULL')},
          ${selectExistingColumnOrFallback(issueColumns, 'last_run_at', 'NULL')},
          ${selectExistingColumnOrFallback(issueColumns, 'last_finished_at', 'NULL')},
          ${selectExistingColumnOrFallback(issueColumns, 'last_error', 'NULL')},
          ${selectExistingColumnOrFallback(issueColumns, 'last_result_summary', 'NULL')},
          ${selectExistingColumnOrFallback(issueColumns, 'created_at', "strftime('%s','now')")},
          ${selectExistingColumnOrFallback(issueColumns, 'updated_at', "strftime('%s','now')")}
        FROM kanban_issues_old`
      );
    }

    if (commentsHasForeignKeys) {
      const commentColumns = await getTableColumns('kanban_comments_old');
      await rawExecute(
        `INSERT INTO kanban_comments (id, issue_id, content, created_at, updated_at)
        SELECT
          id,
          issue_id,
          content,
          ${selectExistingColumnOrFallback(commentColumns, 'created_at', "strftime('%s','now')")},
          ${selectExistingColumnOrFallback(commentColumns, 'updated_at', "strftime('%s','now')")}
        FROM kanban_comments_old`
      );
    }

    if (commentsHasForeignKeys) {
      await rawExecute('DROP TABLE IF EXISTS kanban_comments_old');
    }
    if (issuesHasForeignKeys) {
      await rawExecute('DROP TABLE IF EXISTS kanban_issues_old');
    }

    await rawExecute('COMMIT');
    transactionStarted = false;
  } catch (err) {
    if (transactionStarted) {
      try {
        await rawExecute('ROLLBACK');
      } catch {
        // Ignore rollback failures so we can surface the original error.
      }
    }
    throw err;
  } finally {
    try {
      await rawExecute('PRAGMA foreign_keys = ON');
    } catch {
      // Best effort: the backend enables foreign keys again on next app start.
    }
  }
}

export async function ensureKanbanTables(): Promise<void> {
  if (_tablesEnsured) return;
  await rawExecute(KANBAN_ISSUES_TABLE_SQL);
  await rawExecute(`
    CREATE INDEX IF NOT EXISTS idx_kanban_issues_project ON kanban_issues(project_id, status, sort_order)
  `);

  try { await rawExecute('ALTER TABLE kanban_issues ADD COLUMN issue_number INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
  try { await rawExecute('ALTER TABLE kanban_issues ADD COLUMN start_date TEXT'); } catch { /* exists */ }
  try { await rawExecute('ALTER TABLE kanban_issues ADD COLUMN due_date TEXT'); } catch { /* exists */ }
  try { await rawExecute('ALTER TABLE kanban_issues ADD COLUMN linked_thread_id TEXT'); } catch { /* exists */ }
  try { await rawExecute('ALTER TABLE kanban_issues ADD COLUMN last_run_status TEXT'); } catch { /* exists */ }
  try { await rawExecute('ALTER TABLE kanban_issues ADD COLUMN last_run_at INTEGER'); } catch { /* exists */ }
  try { await rawExecute('ALTER TABLE kanban_issues ADD COLUMN last_finished_at INTEGER'); } catch { /* exists */ }
  try { await rawExecute('ALTER TABLE kanban_issues ADD COLUMN last_error TEXT'); } catch { /* exists */ }
  try { await rawExecute('ALTER TABLE kanban_issues ADD COLUMN last_result_summary TEXT'); } catch { /* exists */ }
  try { await rawExecute("UPDATE kanban_issues SET status = 'todo' WHERE status = 'backlog'"); } catch { /* ignore */ }

  const hasOldTable = await rawSelect<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='kanban_comments'"
  );
  if (hasOldTable.length > 0) {
    try {
      await rawExecute(`
        CREATE TABLE IF NOT EXISTS kanban_comments_v2 (
          id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, content TEXT NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s','now')),
          updated_at INTEGER DEFAULT (strftime('%s','now'))
        )
      `);
      try { await rawExecute(`INSERT OR IGNORE INTO kanban_comments_v2 SELECT id, issue_id, content, created_at, updated_at FROM kanban_comments`); } catch { /* empty */ }
      await rawExecute(`DROP TABLE IF EXISTS kanban_comments`);
      await rawExecute(`ALTER TABLE kanban_comments_v2 RENAME TO kanban_comments`);
    } catch { /* migration failed, drop temp */ await rawExecute(`DROP TABLE IF EXISTS kanban_comments_v2`).catch(() => {}); }
  } else {
    await rawExecute(KANBAN_COMMENTS_TABLE_SQL);
  }
  await rawExecute(`
    CREATE INDEX IF NOT EXISTS idx_kanban_comments_issue ON kanban_comments(issue_id, created_at)
  `);
  await rawExecute(KANBAN_ISSUE_RUNS_TABLE_SQL);
  try { await rawExecute('ALTER TABLE kanban_issue_runs ADD COLUMN result_summary TEXT'); } catch { /* exists */ }
  await rawExecute(`
    CREATE INDEX IF NOT EXISTS idx_kanban_issue_runs_issue ON kanban_issue_runs(issue_id, created_at DESC)
  `);
  await rebuildKanbanTablesWithoutForeignKeys();
  await rawExecute(`
    CREATE INDEX IF NOT EXISTS idx_kanban_issues_project ON kanban_issues(project_id, status, sort_order)
  `);
  await rawExecute(`
    CREATE INDEX IF NOT EXISTS idx_kanban_comments_issue ON kanban_comments(issue_id, created_at)
  `);
  await rawExecute(`
    CREATE INDEX IF NOT EXISTS idx_kanban_issue_runs_issue ON kanban_issue_runs(issue_id, created_at DESC)
  `);
  _tablesEnsured = true;
}

// ── Issues ──

export async function listKanbanIssues(projectId: string): Promise<KanbanIssue[]> {
  await ensureKanbanTables();
  return rawSelect<KanbanIssue>(
    'SELECT * FROM kanban_issues WHERE project_id = ?1 ORDER BY sort_order ASC, created_at ASC',
    [projectId]
  );
}

export async function listKanbanProjectIds(): Promise<string[]> {
  await ensureKanbanTables();
  const rows = await rawSelect<{ project_id: string }>(
    'SELECT DISTINCT project_id FROM kanban_issues WHERE project_id IS NOT NULL AND project_id != "" ORDER BY project_id ASC'
  );
  return rows.map((row) => row.project_id);
}

export async function updateKanbanIssueExecution(id: string, updates: {
  linkedThreadId?: string | null;
  lastRunStatus?: KanbanExecutionState | null;
  lastRunAt?: number | null;
  lastFinishedAt?: number | null;
  lastError?: string | null;
  lastResultSummary?: string | null;
}): Promise<void> {
  await ensureKanbanTables();
  const sets: string[] = ["updated_at = strftime('%s','now')"];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.linkedThreadId !== undefined) { sets.push(`linked_thread_id = ?${idx}`); params.push(updates.linkedThreadId); idx++; }
  if (updates.lastRunStatus !== undefined) { sets.push(`last_run_status = ?${idx}`); params.push(updates.lastRunStatus); idx++; }
  if (updates.lastRunAt !== undefined) { sets.push(`last_run_at = ?${idx}`); params.push(updates.lastRunAt); idx++; }
  if (updates.lastFinishedAt !== undefined) { sets.push(`last_finished_at = ?${idx}`); params.push(updates.lastFinishedAt); idx++; }
  if (updates.lastError !== undefined) { sets.push(`last_error = ?${idx}`); params.push(updates.lastError); idx++; }
  if (updates.lastResultSummary !== undefined) { sets.push(`last_result_summary = ?${idx}`); params.push(updates.lastResultSummary); idx++; }

  params.push(id);
  await rawExecute(
    `UPDATE kanban_issues SET ${sets.join(', ')} WHERE id = ?${idx}`,
    params
  );
}

export async function createKanbanIssue(issue: {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status?: KanbanStatus;
  priority?: KanbanPriority;
  tags?: string[];
  startDate?: string;
  dueDate?: string;
}): Promise<void> {
  await ensureKanbanTables();

  const maxRows = await rawSelect<{ max_order: number | null }>(
    'SELECT MAX(sort_order) as max_order FROM kanban_issues WHERE project_id = ?1 AND status = ?2',
    [issue.projectId, issue.status ?? 'todo']
  );
  const nextOrder = (maxRows[0]?.max_order ?? 0) + 1;

  const numRows = await rawSelect<{ max_num: number | null }>(
    'SELECT MAX(issue_number) as max_num FROM kanban_issues WHERE project_id = ?1',
    [issue.projectId]
  );
  const nextNum = (numRows[0]?.max_num ?? 0) + 1;

  await rawExecute(
    `INSERT INTO kanban_issues (id, project_id, issue_number, title, description, status, priority, tags, start_date, due_date, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    [
      issue.id,
      issue.projectId,
      nextNum,
      issue.title,
      issue.description ?? null,
      issue.status ?? 'todo',
      issue.priority ?? 'medium',
      issue.tags ? issue.tags.join(',') : null,
      issue.startDate ?? null,
      issue.dueDate ?? null,
      nextOrder,
    ]
  );
}

export async function updateKanbanIssue(id: string, updates: {
  title?: string;
  description?: string | null;
  status?: KanbanStatus;
  priority?: KanbanPriority;
  tags?: string[] | null;
  startDate?: string | null;
  dueDate?: string | null;
  sortOrder?: number;
}): Promise<void> {
  await ensureKanbanTables();
  const sets: string[] = ["updated_at = strftime('%s','now')"];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.title !== undefined) { sets.push(`title = ?${idx}`); params.push(updates.title); idx++; }
  if (updates.description !== undefined) { sets.push(`description = ?${idx}`); params.push(updates.description); idx++; }
  if (updates.status !== undefined) { sets.push(`status = ?${idx}`); params.push(updates.status); idx++; }
  if (updates.priority !== undefined) { sets.push(`priority = ?${idx}`); params.push(updates.priority); idx++; }
  if (updates.tags !== undefined) { sets.push(`tags = ?${idx}`); params.push(updates.tags ? updates.tags.join(',') : null); idx++; }
  if (updates.startDate !== undefined) { sets.push(`start_date = ?${idx}`); params.push(updates.startDate); idx++; }
  if (updates.dueDate !== undefined) { sets.push(`due_date = ?${idx}`); params.push(updates.dueDate); idx++; }
  if (updates.sortOrder !== undefined) { sets.push(`sort_order = ?${idx}`); params.push(updates.sortOrder); idx++; }

  params.push(id);
  await rawExecute(
    `UPDATE kanban_issues SET ${sets.join(', ')} WHERE id = ?${idx}`,
    params
  );
}

export async function deleteKanbanIssue(id: string): Promise<void> {
  await ensureKanbanTables();
  await rawExecute('DELETE FROM kanban_comments WHERE issue_id = ?1', [id]);
  await rawExecute('DELETE FROM kanban_issues WHERE id = ?1', [id]);
}

export async function moveKanbanIssue(id: string, newStatus: KanbanStatus, newSortOrder: number): Promise<void> {
  await ensureKanbanTables();
  await rawExecute(
    `UPDATE kanban_issues SET status = ?1, sort_order = ?2, updated_at = strftime('%s','now') WHERE id = ?3`,
    [newStatus, newSortOrder, id]
  );
}

export async function linkThreadToIssue(issueId: string, threadId: string): Promise<void> {
  await ensureKanbanTables();
  await rawExecute(
    `UPDATE kanban_issues SET linked_thread_id = ?1, updated_at = strftime('%s','now') WHERE id = ?2`,
    [threadId, issueId]
  );
}

export async function unlinkThreadFromIssue(issueId: string): Promise<void> {
  await ensureKanbanTables();
  await rawExecute(
    `UPDATE kanban_issues SET linked_thread_id = NULL, updated_at = strftime('%s','now') WHERE id = ?1`,
    [issueId]
  );
}

export async function getKanbanLinkedThreadIds(): Promise<Set<string>> {
  await ensureKanbanTables();
  const rows = await rawSelect<{ linked_thread_id: string }>(
    'SELECT DISTINCT linked_thread_id FROM kanban_issues WHERE linked_thread_id IS NOT NULL'
  );
  return new Set(rows.map((r) => r.linked_thread_id));
}

export async function listKanbanIssueRuns(issueId: string, limit = 20): Promise<KanbanIssueRun[]> {
  await ensureKanbanTables();
  return rawSelect<KanbanIssueRun>(
    'SELECT * FROM kanban_issue_runs WHERE issue_id = ?1 ORDER BY created_at DESC LIMIT ?2',
    [issueId, limit]
  );
}

export async function listRunningKanbanIssueRuns(): Promise<KanbanIssueRun[]> {
  await ensureKanbanTables();
  return rawSelect<KanbanIssueRun>(
    'SELECT * FROM kanban_issue_runs WHERE status = ?1 AND thread_id IS NOT NULL ORDER BY created_at ASC',
    ['RUNNING']
  );
}

export async function createKanbanIssueRun(run: {
  id: string;
  issueId: string;
  triggerSource: KanbanRunTriggerSource;
  status: KanbanExecutionState;
  threadId?: string | null;
  errorMessage?: string | null;
  resultSummary?: string | null;
  startedAt: number;
  finishedAt?: number | null;
}): Promise<void> {
  await ensureKanbanTables();
  await rawExecute(
    `INSERT INTO kanban_issue_runs (
      id, issue_id, trigger_source, status, thread_id, error_message, result_summary, started_at, finished_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [
      run.id,
      run.issueId,
      run.triggerSource,
      run.status,
      run.threadId ?? null,
      run.errorMessage ?? null,
      run.resultSummary ?? null,
      run.startedAt,
      run.finishedAt ?? null,
    ]
  );
}

export async function updateKanbanIssueRun(id: string, updates: {
  status?: KanbanExecutionState;
  threadId?: string | null;
  errorMessage?: string | null;
  resultSummary?: string | null;
  finishedAt?: number | null;
}): Promise<void> {
  await ensureKanbanTables();
  const sets: string[] = ["updated_at = strftime('%s','now')"];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.status !== undefined) { sets.push(`status = ?${idx}`); params.push(updates.status); idx++; }
  if (updates.threadId !== undefined) { sets.push(`thread_id = ?${idx}`); params.push(updates.threadId); idx++; }
  if (updates.errorMessage !== undefined) { sets.push(`error_message = ?${idx}`); params.push(updates.errorMessage); idx++; }
  if (updates.resultSummary !== undefined) { sets.push(`result_summary = ?${idx}`); params.push(updates.resultSummary); idx++; }
  if (updates.finishedAt !== undefined) { sets.push(`finished_at = ?${idx}`); params.push(updates.finishedAt); idx++; }

  params.push(id);
  await rawExecute(
    `UPDATE kanban_issue_runs SET ${sets.join(', ')} WHERE id = ?${idx}`,
    params
  );
}

// ── Comments ──

export interface KanbanComment {
  id: string;
  issue_id: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export async function listKanbanComments(issueId: string): Promise<KanbanComment[]> {
  await ensureKanbanTables();
  return rawSelect<KanbanComment>(
    'SELECT * FROM kanban_comments WHERE issue_id = ?1 ORDER BY created_at ASC',
    [issueId]
  );
}

export async function createKanbanComment(comment: {
  id: string;
  issueId: string;
  content: string;
}): Promise<void> {
  await ensureKanbanTables();
  await rawExecute(
    'INSERT INTO kanban_comments (id, issue_id, content) VALUES (?1, ?2, ?3)',
    [comment.id, comment.issueId, comment.content]
  );
}

export async function deleteKanbanComment(id: string): Promise<void> {
  await ensureKanbanTables();
  await rawExecute('DELETE FROM kanban_comments WHERE id = ?1', [id]);
}

export async function countKanbanComments(issueIds: string[]): Promise<Record<string, number>> {
  if (issueIds.length === 0) return {};
  await ensureKanbanTables();
  const placeholders = issueIds.map((_, i) => `?${i + 1}`).join(',');
  const rows = await rawSelect<{ issue_id: string; cnt: number }>(
    `SELECT issue_id, COUNT(*) as cnt FROM kanban_comments WHERE issue_id IN (${placeholders}) GROUP BY issue_id`,
    issueIds
  );
  const result: Record<string, number> = {};
  for (const row of rows) result[row.issue_id] = row.cnt;
  return result;
}
