import Database from '@tauri-apps/plugin-sql';

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;
  db = await Database.load('sqlite:codex.db');
  await initSchema(db);
  return db;
}

async function initSchema(database: Database) {
  await database.execute(`
    CREATE TABLE IF NOT EXISTS chat_config (
      thread_id TEXT PRIMARY KEY,
      model TEXT,
      reasoning TEXT DEFAULT 'high',
      temperature REAL,
      max_tokens INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  await database.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  await database.execute(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  await database.execute(`
    CREATE INDEX IF NOT EXISTS idx_chat_history_thread ON chat_history(thread_id)
  `);
}

// ── Chat Config ──

export interface ChatConfig {
  thread_id: string;
  model?: string;
  reasoning?: string;
  temperature?: number;
  max_tokens?: number;
}

export async function getChatConfig(threadId: string): Promise<ChatConfig | null> {
  const database = await getDb();
  const rows = await database.select<ChatConfig[]>(
    'SELECT * FROM chat_config WHERE thread_id = $1',
    [threadId]
  );
  return rows.length > 0 ? rows[0] : null;
}

export async function saveChatConfig(config: ChatConfig): Promise<void> {
  const database = await getDb();
  await database.execute(
    `INSERT INTO chat_config (thread_id, model, reasoning, temperature, max_tokens, updated_at)
     VALUES ($1, $2, $3, $4, $5, strftime('%s','now'))
     ON CONFLICT(thread_id) DO UPDATE SET
       model = COALESCE($2, model),
       reasoning = COALESCE($3, reasoning),
       temperature = COALESCE($4, temperature),
       max_tokens = COALESCE($5, max_tokens),
       updated_at = strftime('%s','now')`,
    [config.thread_id, config.model ?? null, config.reasoning ?? null, config.temperature ?? null, config.max_tokens ?? null]
  );
}

export async function deleteChatConfig(threadId: string): Promise<void> {
  const database = await getDb();
  await database.execute('DELETE FROM chat_config WHERE thread_id = $1', [threadId]);
}

// ── App Settings ──

export async function getSetting(key: string): Promise<string | null> {
  const database = await getDb();
  const rows = await database.select<{ value: string }[]>(
    'SELECT value FROM app_settings WHERE key = $1',
    [key]
  );
  return rows.length > 0 ? rows[0].value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const database = await getDb();
  await database.execute(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = strftime('%s','now')`,
    [key, value]
  );
}

export async function getSettingJson<T>(key: string, fallback: T): Promise<T> {
  const raw = await getSetting(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function setSettingJson<T>(key: string, value: T): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const database = await getDb();
  const rows = await database.select<{ key: string; value: string }[]>('SELECT key, value FROM app_settings');
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

// ── Chat History (input history for up/down arrow) ──

export async function addChatMessage(threadId: string, message: string): Promise<void> {
  const database = await getDb();
  const last = await database.select<{ message: string }[]>(
    'SELECT message FROM chat_history WHERE thread_id = $1 ORDER BY id DESC LIMIT 1',
    [threadId]
  );
  if (last.length > 0 && last[0].message === message) return;
  await database.execute(
    'INSERT INTO chat_history (thread_id, message) VALUES ($1, $2)',
    [threadId, message]
  );
}

export async function getChatMessages(threadId: string, limit = 200): Promise<string[]> {
  const database = await getDb();
  const rows = await database.select<{ message: string }[]>(
    'SELECT message FROM chat_history WHERE thread_id = $1 ORDER BY id DESC LIMIT $2',
    [threadId, limit]
  );
  return rows.map(r => r.message).reverse();
}

export interface ChatHistoryEntry {
  id: number;
  thread_id: string;
  message: string;
  created_at: number;
}

export async function getAllChatHistory(limit = 500): Promise<ChatHistoryEntry[]> {
  const database = await getDb();
  return database.select<ChatHistoryEntry[]>(
    'SELECT id, thread_id, message, created_at FROM chat_history ORDER BY id DESC LIMIT $1',
    [limit]
  );
}

export async function searchChatHistory(query: string, limit = 200): Promise<ChatHistoryEntry[]> {
  const database = await getDb();
  return database.select<ChatHistoryEntry[]>(
    'SELECT id, thread_id, message, created_at FROM chat_history WHERE message LIKE $1 ORDER BY id DESC LIMIT $2',
    [`%${query}%`, limit]
  );
}
