//! Centralized SQLite module – sole owner of `codex.db`.
//!
//! Every table previously managed by the frontend `@tauri-apps/plugin-sql`
//! is now created, migrated, and queried here. The frontend calls thin
//! `invoke()` wrappers instead of running raw SQL.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

// ── Singleton ───────────────────────────────────────────────────────────────

static DB: Mutex<Option<Connection>> = Mutex::new(None);

fn get_conn() -> Result<std::sync::MutexGuard<'static, Option<Connection>>, String> {
    DB.lock().map_err(|e| format!("DB lock: {e}"))
}

pub fn init(db_path: &PathBuf) -> Result<(), String> {
    let conn = Connection::open(db_path).map_err(|e| format!("Open: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("PRAGMA: {e}"))?;
    run_migrations(&conn)?;
    *DB.lock().map_err(|e| format!("Lock: {e}"))? = Some(conn);
    Ok(())
}

// ── Schema & Migrations ─────────────────────────────────────────────────────

fn run_migrations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS app_settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS chat_config (
            thread_id                       TEXT PRIMARY KEY,
            model                           TEXT,
            claude_session_id               TEXT,
            continuation_source_thread_id   TEXT,
            continuation_source_provider    TEXT,
            continuation_source_name        TEXT,
            continuation_compacted_messages INTEGER,
            reasoning                       TEXT DEFAULT 'high',
            temperature                     REAL,
            max_tokens                      INTEGER,
            created_at                      INTEGER DEFAULT (strftime('%s','now')),
            updated_at                      INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS chat_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id  TEXT NOT NULL,
            message    TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_chat_history_thread ON chat_history(thread_id);

        CREATE TABLE IF NOT EXISTS providers (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            app_type        TEXT NOT NULL,
            settings_config TEXT NOT NULL,
            website_url     TEXT,
            category        TEXT,
            icon            TEXT,
            icon_color      TEXT,
            notes           TEXT,
            is_current      INTEGER NOT NULL DEFAULT 0,
            sort_index      INTEGER DEFAULT 0,
            created_at      INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS saved_connections (
            id         TEXT PRIMARY KEY,
            label      TEXT NOT NULL,
            host       TEXT NOT NULL DEFAULT '127.0.0.1',
            port       INTEGER NOT NULL DEFAULT 4500,
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS claude_sessions (
            id                TEXT PRIMARY KEY,
            title             TEXT NOT NULL DEFAULT 'New Chat',
            model             TEXT,
            provider_id       TEXT,
            working_directory TEXT,
            system_prompt     TEXT,
            is_archived       INTEGER NOT NULL DEFAULT 0,
            created_at        INTEGER DEFAULT (strftime('%s','now')),
            updated_at        INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS claude_messages (
            id          TEXT PRIMARY KEY,
            session_id  TEXT NOT NULL,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            token_usage TEXT,
            created_at  INTEGER DEFAULT (strftime('%s','now')),
            FOREIGN KEY (session_id) REFERENCES claude_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_claude_messages_session ON claude_messages(session_id);

        CREATE TABLE IF NOT EXISTS automations (
            id                      TEXT PRIMARY KEY,
            name                    TEXT NOT NULL,
            prompt                  TEXT NOT NULL DEFAULT '',
            project_cwd             TEXT,
            retry_enabled           INTEGER NOT NULL DEFAULT 1,
            retry_max_attempts      INTEGER NOT NULL DEFAULT 2,
            retry_backoff_minutes   INTEGER NOT NULL DEFAULT 15,
            retry_count             INTEGER NOT NULL DEFAULT 0,
            pending_run_kind        TEXT NOT NULL DEFAULT 'schedule',
            status                  TEXT NOT NULL DEFAULT 'ACTIVE',
            schedule_mode           TEXT NOT NULL DEFAULT 'daily',
            schedule_weekdays       TEXT NOT NULL DEFAULT 'MO,TU,WE,TH,FR,SA,SU',
            schedule_time           TEXT NOT NULL DEFAULT '09:00',
            schedule_interval_hours INTEGER NOT NULL DEFAULT 24,
            schedule_custom_rrule   TEXT NOT NULL DEFAULT '',
            last_run_at             INTEGER,
            next_run_at             INTEGER,
            next_scheduled_run_at   INTEGER,
            last_thread_id          TEXT,
            last_run_status         TEXT,
            last_error              TEXT,
            background_notify       INTEGER NOT NULL DEFAULT 1,
            template_id             TEXT,
            created_at              INTEGER DEFAULT (strftime('%s','now')),
            updated_at              INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS automation_runs (
            id                  TEXT PRIMARY KEY,
            automation_id       TEXT NOT NULL,
            automation_name     TEXT NOT NULL,
            trigger_source      TEXT NOT NULL,
            status              TEXT NOT NULL,
            attempt_number      INTEGER NOT NULL DEFAULT 1,
            started_at          INTEGER NOT NULL,
            finished_at         INTEGER,
            scheduled_for       INTEGER,
            retry_scheduled_for INTEGER,
            thread_id           TEXT,
            error_message       TEXT,
            created_at          INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_automation_runs_aid ON automation_runs(automation_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS proxy_request_logs (
            request_id           TEXT PRIMARY KEY,
            provider_id          TEXT NOT NULL,
            app_type             TEXT NOT NULL,
            model                TEXT NOT NULL,
            request_model        TEXT,
            input_tokens         INTEGER NOT NULL DEFAULT 0,
            output_tokens        INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            input_cost_usd       TEXT NOT NULL DEFAULT '0',
            output_cost_usd      TEXT NOT NULL DEFAULT '0',
            cache_read_cost_usd  TEXT NOT NULL DEFAULT '0',
            cache_creation_cost_usd TEXT NOT NULL DEFAULT '0',
            total_cost_usd       TEXT NOT NULL DEFAULT '0',
            latency_ms           INTEGER NOT NULL,
            first_token_ms       INTEGER,
            duration_ms          INTEGER,
            status_code          INTEGER NOT NULL,
            error_message        TEXT,
            session_id           TEXT,
            provider_type        TEXT,
            is_streaming         INTEGER NOT NULL DEFAULT 0,
            cost_multiplier      TEXT NOT NULL DEFAULT '1.0',
            created_at           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_prl_provider ON proxy_request_logs(provider_id, app_type);
        CREATE INDEX IF NOT EXISTS idx_prl_created  ON proxy_request_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_prl_model    ON proxy_request_logs(model);
        CREATE INDEX IF NOT EXISTS idx_prl_status   ON proxy_request_logs(status_code);

        CREATE TABLE IF NOT EXISTS usage_daily_rollups (
            date            TEXT NOT NULL,
            app_type        TEXT NOT NULL,
            provider_id     TEXT NOT NULL,
            model           TEXT NOT NULL,
            request_count   INTEGER NOT NULL DEFAULT 0,
            success_count   INTEGER NOT NULL DEFAULT 0,
            input_tokens    INTEGER NOT NULL DEFAULT 0,
            output_tokens   INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_usd  TEXT NOT NULL DEFAULT '0',
            avg_latency_ms  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, app_type, provider_id, model)
        );

        CREATE TABLE IF NOT EXISTS model_pricing (
            model_id                    TEXT PRIMARY KEY,
            display_name                TEXT NOT NULL,
            input_cost_per_million      TEXT NOT NULL,
            output_cost_per_million     TEXT NOT NULL,
            cache_read_cost_per_million TEXT NOT NULL DEFAULT '0',
            cache_creation_cost_per_million TEXT NOT NULL DEFAULT '0'
        );
        ",
    )
    .map_err(|e| format!("Migration: {e}"))?;

    // Additive ALTER TABLE for chat_config (older DBs may lack these)
    for col in [
        "claude_session_id TEXT",
        "continuation_source_thread_id TEXT",
        "continuation_source_provider TEXT",
        "continuation_source_name TEXT",
        "continuation_compacted_messages INTEGER",
    ] {
        let _ = conn.execute(&format!("ALTER TABLE chat_config ADD COLUMN {col}"), []);
    }

    // Additive ALTER TABLE for automations
    for (col, def) in [
        ("project_cwd", "TEXT"),
        ("retry_enabled", "INTEGER NOT NULL DEFAULT 1"),
        ("retry_max_attempts", "INTEGER NOT NULL DEFAULT 2"),
        ("retry_backoff_minutes", "INTEGER NOT NULL DEFAULT 15"),
        ("retry_count", "INTEGER NOT NULL DEFAULT 0"),
        ("pending_run_kind", "TEXT NOT NULL DEFAULT 'schedule'"),
        ("next_scheduled_run_at", "INTEGER"),
        ("last_run_status", "TEXT"),
        ("last_error", "TEXT"),
        ("background_notify", "INTEGER NOT NULL DEFAULT 1"),
    ] {
        let _ = conn.execute(&format!("ALTER TABLE automations ADD COLUMN {col} {def}"), []);
    }

    seed_model_pricing(conn)?;
    Ok(())
}

fn seed_model_pricing(conn: &Connection) -> Result<(), String> {
    let seeds: &[(&str, &str, &str, &str, &str, &str)] = &[
        ("claude-opus-4-6-20260206", "Claude Opus 4.6", "5", "25", "0.50", "6.25"),
        ("claude-opus-4-5-20251101", "Claude Opus 4.5", "5", "25", "0.50", "6.25"),
        ("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5", "3", "15", "0.30", "3.75"),
        ("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "1", "5", "0.10", "1.25"),
        ("claude-opus-4-20250514", "Claude Opus 4", "15", "75", "1.50", "18.75"),
        ("claude-opus-4-1-20250805", "Claude Opus 4.1", "15", "75", "1.50", "18.75"),
        ("claude-sonnet-4-20250514", "Claude Sonnet 4", "3", "15", "0.30", "3.75"),
        ("claude-3-5-haiku-20241022", "Claude 3.5 Haiku", "0.80", "4", "0.08", "1"),
        ("claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet", "3", "15", "0.30", "3.75"),
        ("gpt-5.2", "GPT-5.2", "1.75", "14", "0.175", "0"),
        ("gpt-5.2-codex", "GPT-5.2 Codex", "1.75", "14", "0.175", "0"),
        ("gpt-5.1", "GPT-5.1", "1.25", "10", "0.125", "0"),
        ("gpt-5.1-codex", "GPT-5.1 Codex", "1.25", "10", "0.125", "0"),
        ("gpt-5", "GPT-5", "1.25", "10", "0.125", "0"),
        ("gpt-5-codex", "GPT-5 Codex", "1.25", "10", "0.125", "0"),
        ("gemini-3-pro-preview", "Gemini 3 Pro Preview", "2", "12", "0.2", "0"),
        ("gemini-3-flash-preview", "Gemini 3 Flash Preview", "0.5", "3", "0.05", "0"),
        ("gemini-2.5-pro", "Gemini 2.5 Pro", "1.25", "10", "0.125", "0"),
        ("gemini-2.5-flash", "Gemini 2.5 Flash", "0.3", "2.5", "0.03", "0"),
        ("deepseek-v3.2", "DeepSeek V3.2", "2.00", "3.00", "0.40", "0"),
        ("deepseek-v3.1", "DeepSeek V3.1", "4.00", "12.00", "0.80", "0"),
        ("deepseek-v3", "DeepSeek V3", "2.00", "8.00", "0.40", "0"),
        ("kimi-k2-0905", "Kimi K2", "4.00", "16.00", "1.00", "0"),
    ];
    for (id, name, inp, out, cr, cc) in seeds {
        conn.execute(
            "INSERT OR IGNORE INTO model_pricing (model_id, display_name, input_cost_per_million, output_cost_per_million, cache_read_cost_per_million, cache_creation_cost_per_million) VALUES (?1,?2,?3,?4,?5,?6)",
            params![id, name, inp, out, cr, cc],
        ).map_err(|e| format!("Seed: {e}"))?;
    }
    Ok(())
}

// ── Shared helpers for dynamic UPDATE builders ──────────────────────────────

use rusqlite::types::Value;

fn push_text(sets: &mut Vec<String>, vals: &mut Vec<Value>, idx: &mut usize, col: &str, v: &serde_json::Value) {
    match v {
        serde_json::Value::String(s) => { sets.push(format!("{col} = ?{idx}")); vals.push(Value::Text(s.clone())); *idx += 1; }
        serde_json::Value::Null => { sets.push(format!("{col} = ?{idx}")); vals.push(Value::Null); *idx += 1; }
        _ => {}
    }
}

fn push_int(sets: &mut Vec<String>, vals: &mut Vec<Value>, idx: &mut usize, col: &str, v: &serde_json::Value) {
    match v {
        serde_json::Value::Number(n) => { sets.push(format!("{col} = ?{idx}")); vals.push(Value::Integer(n.as_i64().unwrap_or(0))); *idx += 1; }
        serde_json::Value::Bool(b) => { sets.push(format!("{col} = ?{idx}")); vals.push(Value::Integer(if *b { 1 } else { 0 })); *idx += 1; }
        serde_json::Value::Null => { sets.push(format!("{col} = ?{idx}")); vals.push(Value::Null); *idx += 1; }
        _ => {}
    }
}

// ── Settings ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingRow {
    pub key: String,
    pub value: String,
}

#[tauri::command]
pub fn db_get_setting(key: String) -> Result<Option<String>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(|e| format!("Query: {e}"))
}

#[tauri::command]
pub fn db_set_setting(key: String, value: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, strftime('%s','now'))
         ON CONFLICT(key) DO UPDATE SET value=?2, updated_at=strftime('%s','now')",
        params![key, value],
    ).map_err(|e| format!("Upsert: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_get_all_settings() -> Result<Vec<SettingRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let mut stmt = conn.prepare("SELECT key, value FROM app_settings ORDER BY key")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt.query_map([], |r| Ok(SettingRow { key: r.get(0)?, value: r.get(1)? }))
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

// ── Chat Config ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfigRow {
    pub thread_id: String,
    pub model: Option<String>,
    pub claude_session_id: Option<String>,
    pub continuation_source_thread_id: Option<String>,
    pub continuation_source_provider: Option<String>,
    pub continuation_source_name: Option<String>,
    pub continuation_compacted_messages: Option<i64>,
    pub reasoning: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<i64>,
}

#[tauri::command]
pub fn db_get_chat_config(thread_id: String) -> Result<Option<ChatConfigRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.query_row(
        "SELECT thread_id, model, claude_session_id, continuation_source_thread_id, continuation_source_provider, continuation_source_name, continuation_compacted_messages, reasoning, temperature, max_tokens FROM chat_config WHERE thread_id = ?1",
        params![thread_id],
        |r| Ok(ChatConfigRow {
            thread_id: r.get(0)?,
            model: r.get(1)?,
            claude_session_id: r.get(2)?,
            continuation_source_thread_id: r.get(3)?,
            continuation_source_provider: r.get(4)?,
            continuation_source_name: r.get(5)?,
            continuation_compacted_messages: r.get(6)?,
            reasoning: r.get(7)?,
            temperature: r.get(8)?,
            max_tokens: r.get(9)?,
        }),
    )
    .optional()
    .map_err(|e| format!("Query: {e}"))
}

#[tauri::command]
pub fn db_save_chat_config(
    thread_id: String,
    model: Option<String>,
    claude_session_id: Option<String>,
    continuation_source_thread_id: Option<String>,
    continuation_source_provider: Option<String>,
    continuation_source_name: Option<String>,
    continuation_compacted_messages: Option<i64>,
    reasoning: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<i64>,
) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute(
        "INSERT INTO chat_config (thread_id, model, claude_session_id, continuation_source_thread_id, continuation_source_provider, continuation_source_name, continuation_compacted_messages, reasoning, temperature, max_tokens, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, strftime('%s','now'))
         ON CONFLICT(thread_id) DO UPDATE SET
           model = COALESCE(?2, model),
           claude_session_id = COALESCE(?3, claude_session_id),
           continuation_source_thread_id = COALESCE(?4, continuation_source_thread_id),
           continuation_source_provider = COALESCE(?5, continuation_source_provider),
           continuation_source_name = COALESCE(?6, continuation_source_name),
           continuation_compacted_messages = COALESCE(?7, continuation_compacted_messages),
           reasoning = COALESCE(?8, reasoning),
           temperature = COALESCE(?9, temperature),
           max_tokens = COALESCE(?10, max_tokens),
           updated_at = strftime('%s','now')",
        params![thread_id, model, claude_session_id, continuation_source_thread_id,
                continuation_source_provider, continuation_source_name,
                continuation_compacted_messages, reasoning, temperature, max_tokens],
    ).map_err(|e| format!("Upsert: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_delete_chat_config(thread_id: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute("DELETE FROM chat_config WHERE thread_id = ?1", params![thread_id])
        .map_err(|e| format!("Delete: {e}"))?;
    Ok(())
}

// ── Chat History ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryRow {
    pub id: i64,
    pub thread_id: String,
    pub message: String,
    pub created_at: i64,
}

/// Skips consecutive duplicates so repeated Enter presses do not flood navigation.
#[tauri::command]
pub fn db_add_chat_message(thread_id: String, message: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let last: Option<String> = conn
        .query_row(
            "SELECT message FROM chat_history WHERE thread_id = ?1 ORDER BY id DESC LIMIT 1",
            params![thread_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("Query: {e}"))?;
    if last.as_deref() == Some(&message) {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO chat_history (thread_id, message) VALUES (?1, ?2)",
        params![thread_id, message],
    ).map_err(|e| format!("Insert: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_get_chat_messages(thread_id: String, limit: Option<i64>) -> Result<Vec<String>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let lim = limit.unwrap_or(200);
    let mut stmt = conn
        .prepare("SELECT message FROM chat_history WHERE thread_id = ?1 ORDER BY id DESC LIMIT ?2")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows: Vec<String> = stmt
        .query_map(params![thread_id, lim], |r| r.get(0))
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    let mut reversed = rows;
    reversed.reverse();
    Ok(reversed)
}

#[tauri::command]
pub fn db_get_all_chat_history(limit: Option<i64>) -> Result<Vec<ChatHistoryRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let lim = limit.unwrap_or(500);
    let mut stmt = conn
        .prepare("SELECT id, thread_id, message, created_at FROM chat_history ORDER BY id DESC LIMIT ?1")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map(params![lim], |r| Ok(ChatHistoryRow {
            id: r.get(0)?, thread_id: r.get(1)?, message: r.get(2)?, created_at: r.get(3)?,
        }))
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub fn db_search_chat_history(query: String, limit: Option<i64>) -> Result<Vec<ChatHistoryRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let lim = limit.unwrap_or(200);
    let pattern = format!("%{query}%");
    let mut stmt = conn
        .prepare("SELECT id, thread_id, message, created_at FROM chat_history WHERE message LIKE ?1 ORDER BY id DESC LIMIT ?2")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map(params![pattern, lim], |r| Ok(ChatHistoryRow {
            id: r.get(0)?, thread_id: r.get(1)?, message: r.get(2)?, created_at: r.get(3)?,
        }))
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

// ── Saved Connections ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnectionRow {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: i64,
    pub is_default: i64,
    pub created_at: i64,
}

#[tauri::command]
pub fn db_list_connections() -> Result<Vec<SavedConnectionRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, label, host, port, is_default, created_at FROM saved_connections ORDER BY is_default DESC, created_at ASC")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| Ok(SavedConnectionRow {
            id: r.get(0)?, label: r.get(1)?, host: r.get(2)?, port: r.get(3)?,
            is_default: r.get(4)?, created_at: r.get(5)?,
        }))
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub fn db_save_connection(id: String, label: String, host: String, port: i64, is_default: bool) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    if is_default {
        conn.execute("UPDATE saved_connections SET is_default = 0", [])
            .map_err(|e| format!("Reset: {e}"))?;
    }
    let def_val: i64 = if is_default { 1 } else { 0 };
    conn.execute(
        "INSERT INTO saved_connections (id, label, host, port, is_default)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(id) DO UPDATE SET label=?2, host=?3, port=?4, is_default=?5",
        params![id, label, host, port, def_val],
    ).map_err(|e| format!("Upsert: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_delete_connection(id: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute("DELETE FROM saved_connections WHERE id = ?1", params![id])
        .map_err(|e| format!("Delete: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_set_default_connection(id: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute("UPDATE saved_connections SET is_default = 0", [])
        .map_err(|e| format!("Reset: {e}"))?;
    conn.execute("UPDATE saved_connections SET is_default = 1 WHERE id = ?1", params![id])
        .map_err(|e| format!("Set: {e}"))?;
    Ok(())
}

// ── Providers ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRow {
    pub id: String,
    pub name: String,
    pub app_type: String,
    pub settings_config: String,
    pub website_url: Option<String>,
    pub category: Option<String>,
    pub icon: Option<String>,
    pub icon_color: Option<String>,
    pub notes: Option<String>,
    pub is_current: i64,
    pub sort_index: i64,
    pub created_at: i64,
}

#[tauri::command]
pub fn db_list_providers(app_type: String) -> Result<Vec<ProviderRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, name, app_type, settings_config, website_url, category, icon, icon_color, notes, is_current, sort_index, created_at FROM providers WHERE app_type = ?1 ORDER BY sort_index ASC, created_at ASC")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map(params![app_type], |r| Ok(ProviderRow {
            id: r.get(0)?, name: r.get(1)?, app_type: r.get(2)?, settings_config: r.get(3)?,
            website_url: r.get(4)?, category: r.get(5)?, icon: r.get(6)?, icon_color: r.get(7)?,
            notes: r.get(8)?, is_current: r.get(9)?, sort_index: r.get(10)?, created_at: r.get(11)?,
        }))
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub fn db_get_current_provider_id(app_type: String) -> Result<Option<String>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.query_row(
        "SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1 LIMIT 1",
        params![app_type], |r| r.get(0),
    ).optional().map_err(|e| format!("Query: {e}"))
}

#[tauri::command]
pub fn db_add_provider(
    id: String, name: String, app_type: String, settings_config: String,
    website_url: Option<String>, category: Option<String>, icon: Option<String>,
    icon_color: Option<String>, notes: Option<String>,
) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute(
        "INSERT INTO providers (id, name, app_type, settings_config, website_url, category, icon, icon_color, notes) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![id, name, app_type, settings_config, website_url, category, icon, icon_color, notes],
    ).map_err(|e| format!("Insert: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_update_provider(
    id: String, name: String, settings_config: String,
    website_url: Option<String>, category: Option<String>, icon: Option<String>,
    icon_color: Option<String>, notes: Option<String>,
) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute(
        "UPDATE providers SET name=?2, settings_config=?3, website_url=?4, category=?5, icon=?6, icon_color=?7, notes=?8 WHERE id=?1",
        params![id, name, settings_config, website_url, category, icon, icon_color, notes],
    ).map_err(|e| format!("Update: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_delete_provider(id: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute("DELETE FROM providers WHERE id = ?1", params![id])
        .map_err(|e| format!("Delete: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_switch_provider(id: String, app_type: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute("UPDATE providers SET is_current = 0 WHERE app_type = ?1", params![app_type])
        .map_err(|e| format!("Reset: {e}"))?;
    conn.execute("UPDATE providers SET is_current = 1 WHERE id = ?1", params![id])
        .map_err(|e| format!("Switch: {e}"))?;
    Ok(())
}

// ── Automations ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRow {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub project_cwd: Option<String>,
    pub retry_enabled: i64,
    pub retry_max_attempts: i64,
    pub retry_backoff_minutes: i64,
    pub retry_count: i64,
    pub pending_run_kind: String,
    pub status: String,
    pub schedule_mode: String,
    pub schedule_weekdays: String,
    pub schedule_time: String,
    pub schedule_interval_hours: i64,
    pub schedule_custom_rrule: String,
    pub last_run_at: Option<i64>,
    pub next_run_at: Option<i64>,
    pub next_scheduled_run_at: Option<i64>,
    pub last_thread_id: Option<String>,
    pub last_run_status: Option<String>,
    pub last_error: Option<String>,
    pub background_notify: i64,
    pub template_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn read_automation_row(r: &rusqlite::Row) -> rusqlite::Result<AutomationRow> {
    Ok(AutomationRow {
        id: r.get(0)?, name: r.get(1)?, prompt: r.get(2)?, project_cwd: r.get(3)?,
        retry_enabled: r.get(4)?, retry_max_attempts: r.get(5)?, retry_backoff_minutes: r.get(6)?,
        retry_count: r.get(7)?, pending_run_kind: r.get(8)?, status: r.get(9)?,
        schedule_mode: r.get(10)?, schedule_weekdays: r.get(11)?, schedule_time: r.get(12)?,
        schedule_interval_hours: r.get(13)?, schedule_custom_rrule: r.get(14)?,
        last_run_at: r.get(15)?, next_run_at: r.get(16)?, next_scheduled_run_at: r.get(17)?,
        last_thread_id: r.get(18)?, last_run_status: r.get(19)?, last_error: r.get(20)?,
        background_notify: r.get(21)?, template_id: r.get(22)?, created_at: r.get(23)?, updated_at: r.get(24)?,
    })
}

const AUTOMATION_COLS: &str = "id, name, prompt, project_cwd, retry_enabled, retry_max_attempts, retry_backoff_minutes, retry_count, pending_run_kind, status, schedule_mode, schedule_weekdays, schedule_time, schedule_interval_hours, schedule_custom_rrule, last_run_at, next_run_at, next_scheduled_run_at, last_thread_id, last_run_status, last_error, background_notify, template_id, created_at, updated_at";

#[tauri::command]
pub fn db_list_automations() -> Result<Vec<AutomationRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let sql = format!("SELECT {AUTOMATION_COLS} FROM automations WHERE status != 'DELETED' ORDER BY next_run_at ASC, name ASC");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt.query_map([], read_automation_row)
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub fn db_get_automation(id: String) -> Result<Option<AutomationRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let sql = format!("SELECT {AUTOMATION_COLS} FROM automations WHERE id = ?1");
    conn.query_row(&sql, params![id], read_automation_row)
        .optional()
        .map_err(|e| format!("Query: {e}"))
}

#[tauri::command]
pub fn db_create_automation(
    id: String, name: String, prompt: String, project_cwd: Option<String>,
    retry_enabled: Option<bool>, retry_max_attempts: Option<i64>,
    retry_backoff_minutes: Option<i64>, background_notify: Option<bool>,
    status: Option<String>, schedule_mode: String, schedule_weekdays: String,
    schedule_time: String, schedule_interval_hours: Option<i64>,
    schedule_custom_rrule: Option<String>, template_id: Option<String>,
) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let re: i64 = if retry_enabled.unwrap_or(true) { 1 } else { 0 };
    let bn: i64 = if background_notify.unwrap_or(true) { 1 } else { 0 };
    conn.execute(
        "INSERT INTO automations (id, name, prompt, project_cwd, retry_enabled, retry_max_attempts, retry_backoff_minutes, background_notify, status, schedule_mode, schedule_weekdays, schedule_time, schedule_interval_hours, schedule_custom_rrule, template_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![id, name, prompt, project_cwd, re, retry_max_attempts.unwrap_or(2),
                retry_backoff_minutes.unwrap_or(15), bn, status.unwrap_or_else(|| "ACTIVE".into()),
                schedule_mode, schedule_weekdays, schedule_time,
                schedule_interval_hours.unwrap_or(24), schedule_custom_rrule.unwrap_or_default(),
                template_id],
    ).map_err(|e| format!("Insert: {e}"))?;
    Ok(())
}

/// Accepts a JSON object of fields to update; only provided keys are SET.
#[tauri::command]
pub fn db_update_automation(updates_json: String) -> Result<(), String> {
    let obj: serde_json::Value = serde_json::from_str(&updates_json)
        .map_err(|e| format!("Parse: {e}"))?;
    let map = obj.as_object().ok_or("Expected object")?;
    let id = map.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;

    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let mut sets = vec!["updated_at = strftime('%s','now')".to_string()];
    let mut vals: Vec<Value> = vec![];
    let mut idx: usize = 1;

    let text_cols = [
        ("name", "name"), ("prompt", "prompt"), ("projectCwd", "project_cwd"),
        ("pendingRunKind", "pending_run_kind"), ("status", "status"),
        ("scheduleMode", "schedule_mode"), ("scheduleWeekdays", "schedule_weekdays"),
        ("scheduleTime", "schedule_time"), ("scheduleCustomRrule", "schedule_custom_rrule"),
        ("lastThreadId", "last_thread_id"), ("lastRunStatus", "last_run_status"),
        ("lastError", "last_error"),
    ];
    for (jk, col) in text_cols {
        if let Some(v) = map.get(jk) { push_text(&mut sets, &mut vals, &mut idx, col, v); }
    }

    let int_cols = [
        ("retryEnabled", "retry_enabled"), ("retryMaxAttempts", "retry_max_attempts"),
        ("retryBackoffMinutes", "retry_backoff_minutes"), ("retryCount", "retry_count"),
        ("scheduleIntervalHours", "schedule_interval_hours"),
        ("lastRunAt", "last_run_at"), ("nextRunAt", "next_run_at"),
        ("nextScheduledRunAt", "next_scheduled_run_at"),
        ("backgroundNotify", "background_notify"),
    ];
    for (jk, col) in int_cols {
        if let Some(v) = map.get(jk) { push_int(&mut sets, &mut vals, &mut idx, col, v); }
    }

    if sets.len() <= 1 { return Ok(()); }

    vals.push(Value::Text(id.to_string()));
    let sql = format!("UPDATE automations SET {} WHERE id = ?{idx}", sets.join(", "));
    conn.execute(&sql, rusqlite::params_from_iter(vals.iter()))
        .map_err(|e| format!("Update: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_delete_automation(id: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute(
        "UPDATE automations SET status = 'DELETED', updated_at = strftime('%s','now') WHERE id = ?1",
        params![id],
    ).map_err(|e| format!("Delete: {e}"))?;
    Ok(())
}

// ── Automation Runs ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunRow {
    pub id: String,
    pub automation_id: String,
    pub automation_name: String,
    pub trigger_source: String,
    pub status: String,
    pub attempt_number: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub scheduled_for: Option<i64>,
    pub retry_scheduled_for: Option<i64>,
    pub thread_id: Option<String>,
    pub error_message: Option<String>,
    pub created_at: i64,
}

fn read_run_row(r: &rusqlite::Row) -> rusqlite::Result<AutomationRunRow> {
    Ok(AutomationRunRow {
        id: r.get(0)?, automation_id: r.get(1)?, automation_name: r.get(2)?,
        trigger_source: r.get(3)?, status: r.get(4)?, attempt_number: r.get(5)?,
        started_at: r.get(6)?, finished_at: r.get(7)?, scheduled_for: r.get(8)?,
        retry_scheduled_for: r.get(9)?, thread_id: r.get(10)?, error_message: r.get(11)?,
        created_at: r.get(12)?,
    })
}

#[tauri::command]
pub fn db_list_automation_runs(automation_id: Option<String>, limit: Option<i64>) -> Result<Vec<AutomationRunRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let lim = limit.unwrap_or(30);
    if let Some(aid) = automation_id {
        let mut stmt = conn
            .prepare("SELECT id, automation_id, automation_name, trigger_source, status, attempt_number, started_at, finished_at, scheduled_for, retry_scheduled_for, thread_id, error_message, created_at FROM automation_runs WHERE automation_id = ?1 ORDER BY started_at DESC LIMIT ?2")
            .map_err(|e| format!("Prepare: {e}"))?;
        let rows = stmt.query_map(params![aid, lim], read_run_row)
            .map_err(|e| format!("Query: {e}"))?
            .filter_map(|r| r.ok()).collect();
        Ok(rows)
    } else {
        let mut stmt = conn
            .prepare("SELECT id, automation_id, automation_name, trigger_source, status, attempt_number, started_at, finished_at, scheduled_for, retry_scheduled_for, thread_id, error_message, created_at FROM automation_runs ORDER BY started_at DESC LIMIT ?1")
            .map_err(|e| format!("Prepare: {e}"))?;
        let rows = stmt.query_map(params![lim], read_run_row)
            .map_err(|e| format!("Query: {e}"))?
            .filter_map(|r| r.ok()).collect();
        Ok(rows)
    }
}

#[tauri::command]
pub fn db_list_running_automation_runs() -> Result<Vec<AutomationRunRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, automation_id, automation_name, trigger_source, status, attempt_number, started_at, finished_at, scheduled_for, retry_scheduled_for, thread_id, error_message, created_at FROM automation_runs WHERE status = 'RUNNING' ORDER BY started_at DESC")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map([], read_run_row)
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub fn db_create_automation_run(
    id: String, automation_id: String, automation_name: String,
    trigger_source: String, status: String, attempt_number: i64, started_at: i64,
    scheduled_for: Option<i64>, retry_scheduled_for: Option<i64>,
    thread_id: Option<String>, error_message: Option<String>,
) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute(
        "INSERT INTO automation_runs (id, automation_id, automation_name, trigger_source, status, attempt_number, started_at, scheduled_for, retry_scheduled_for, thread_id, error_message) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![id, automation_id, automation_name, trigger_source, status, attempt_number, started_at, scheduled_for, retry_scheduled_for, thread_id, error_message],
    ).map_err(|e| format!("Insert: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_update_automation_run(updates_json: String) -> Result<(), String> {
    let obj: serde_json::Value = serde_json::from_str(&updates_json)
        .map_err(|e| format!("Parse: {e}"))?;
    let map = obj.as_object().ok_or("Expected object")?;
    let id = map.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;

    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let mut sets: Vec<String> = vec![];
    let mut vals: Vec<Value> = vec![];
    let mut idx: usize = 1;

    if let Some(v) = map.get("status") { push_text(&mut sets, &mut vals, &mut idx, "status", v); }
    if let Some(v) = map.get("finishedAt") { push_int(&mut sets, &mut vals, &mut idx, "finished_at", v); }
    if let Some(v) = map.get("retryScheduledFor") { push_int(&mut sets, &mut vals, &mut idx, "retry_scheduled_for", v); }
    if let Some(v) = map.get("threadId") { push_text(&mut sets, &mut vals, &mut idx, "thread_id", v); }
    if let Some(v) = map.get("errorMessage") { push_text(&mut sets, &mut vals, &mut idx, "error_message", v); }

    if sets.is_empty() { return Ok(()); }

    vals.push(Value::Text(id.to_string()));
    let sql = format!("UPDATE automation_runs SET {} WHERE id = ?{idx}", sets.join(", "));
    conn.execute(&sql, rusqlite::params_from_iter(vals.iter()))
        .map_err(|e| format!("Update: {e}"))?;
    Ok(())
}

// ── Claude Sessions ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionRow {
    pub id: String,
    pub title: String,
    pub model: Option<String>,
    pub provider_id: Option<String>,
    pub working_directory: Option<String>,
    pub system_prompt: Option<String>,
    pub is_archived: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[tauri::command]
pub fn db_create_claude_session(
    id: String, title: Option<String>, model: Option<String>,
    provider_id: Option<String>, working_directory: Option<String>,
    system_prompt: Option<String>,
) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute(
        "INSERT INTO claude_sessions (id, title, model, provider_id, working_directory, system_prompt) VALUES (?1,?2,?3,?4,?5,?6)",
        params![id, title.unwrap_or_else(|| "New Chat".into()), model, provider_id, working_directory, system_prompt],
    ).map_err(|e| format!("Insert: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_list_claude_sessions() -> Result<Vec<ClaudeSessionRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, title, model, provider_id, working_directory, system_prompt, is_archived, created_at, updated_at FROM claude_sessions WHERE is_archived = 0 ORDER BY updated_at DESC")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| Ok(ClaudeSessionRow {
            id: r.get(0)?, title: r.get(1)?, model: r.get(2)?, provider_id: r.get(3)?,
            working_directory: r.get(4)?, system_prompt: r.get(5)?, is_archived: r.get(6)?,
            created_at: r.get(7)?, updated_at: r.get(8)?,
        }))
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[tauri::command]
pub fn db_get_claude_session(id: String) -> Result<Option<ClaudeSessionRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.query_row(
        "SELECT id, title, model, provider_id, working_directory, system_prompt, is_archived, created_at, updated_at FROM claude_sessions WHERE id = ?1",
        params![id],
        |r| Ok(ClaudeSessionRow {
            id: r.get(0)?, title: r.get(1)?, model: r.get(2)?, provider_id: r.get(3)?,
            working_directory: r.get(4)?, system_prompt: r.get(5)?, is_archived: r.get(6)?,
            created_at: r.get(7)?, updated_at: r.get(8)?,
        }),
    ).optional().map_err(|e| format!("Query: {e}"))
}

#[tauri::command]
pub fn db_update_claude_session(updates_json: String) -> Result<(), String> {
    let obj: serde_json::Value = serde_json::from_str(&updates_json)
        .map_err(|e| format!("Parse: {e}"))?;
    let map = obj.as_object().ok_or("Expected object")?;
    let id = map.get("id").and_then(|v| v.as_str()).ok_or("Missing id")?;

    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let mut sets = vec!["updated_at = strftime('%s','now')".to_string()];
    let mut vals: Vec<Value> = vec![];
    let mut idx: usize = 1;

    if let Some(v) = map.get("title") { push_text(&mut sets, &mut vals, &mut idx, "title", v); }
    if let Some(v) = map.get("model") { push_text(&mut sets, &mut vals, &mut idx, "model", v); }
    if let Some(v) = map.get("isArchived") { push_int(&mut sets, &mut vals, &mut idx, "is_archived", v); }

    if sets.len() <= 1 { return Ok(()); }

    vals.push(Value::Text(id.to_string()));
    let sql = format!("UPDATE claude_sessions SET {} WHERE id = ?{idx}", sets.join(", "));
    conn.execute(&sql, rusqlite::params_from_iter(vals.iter()))
        .map_err(|e| format!("Update: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_delete_claude_session(id: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute("DELETE FROM claude_messages WHERE session_id = ?1", params![id])
        .map_err(|e| format!("Delete msgs: {e}"))?;
    conn.execute("DELETE FROM claude_sessions WHERE id = ?1", params![id])
        .map_err(|e| format!("Delete session: {e}"))?;
    Ok(())
}

// ── Claude Messages ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMessageRow {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub token_usage: Option<String>,
    pub created_at: i64,
}

#[tauri::command]
pub fn db_add_claude_message(
    id: String, session_id: String, role: String,
    content: String, token_usage: Option<String>,
) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute(
        "INSERT INTO claude_messages (id, session_id, role, content, token_usage) VALUES (?1,?2,?3,?4,?5)",
        params![id, session_id, role, content, token_usage],
    ).map_err(|e| format!("Insert: {e}"))?;
    conn.execute(
        "UPDATE claude_sessions SET updated_at = strftime('%s','now') WHERE id = ?1",
        params![session_id],
    ).map_err(|e| format!("Touch: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_get_claude_messages(session_id: String) -> Result<Vec<ClaudeMessageRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let mut stmt = conn
        .prepare("SELECT id, session_id, role, content, token_usage, created_at FROM claude_messages WHERE session_id = ?1 ORDER BY created_at ASC, rowid ASC")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |r| Ok(ClaudeMessageRow {
            id: r.get(0)?, session_id: r.get(1)?, role: r.get(2)?,
            content: r.get(3)?, token_usage: r.get(4)?, created_at: r.get(5)?,
        }))
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[tauri::command]
pub fn db_delete_claude_message(id: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute("DELETE FROM claude_messages WHERE id = ?1", params![id])
        .map_err(|e| format!("Delete: {e}"))?;
    Ok(())
}

// ── Scheduling Helpers ──────────────────────────────────────────────────────

#[tauri::command]
pub fn compute_next_run(
    mode: String, weekdays: String, time: String, interval_hours: i64,
) -> Result<i64, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| format!("Time: {e}"))?.as_secs() as i64;

    let parts: Vec<&str> = time.split(':').collect();
    let h: i64 = parts.first().and_then(|s| s.parse().ok()).unwrap_or(9);
    let m: i64 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);

    let day_idx = |d: &str| match d { "SU"=>Some(0), "MO"=>Some(1), "TU"=>Some(2), "WE"=>Some(3), "TH"=>Some(4), "FR"=>Some(5), "SA"=>Some(6), _=>None };
    let allowed: std::collections::HashSet<u32> = weekdays.split(',').filter_map(|d| day_idx(d.trim())).collect();

    if mode == "custom" && interval_hours > 0 && interval_hours < 24 {
        let next = now + interval_hours * 3600;
        return Ok(next - (next % 3600));
    }

    let day_start = now - (now % 86400);
    let target = day_start + h * 3600 + m * 60;
    let wd = ((now / 86400 + 4) % 7) as u32;

    if target > now && allowed.contains(&wd) { return Ok(target); }
    for off in 1..=8u32 {
        if allowed.contains(&((wd + off) % 7)) { return Ok(target + (off as i64) * 86400); }
    }
    Ok(now + 86400)
}

#[tauri::command]
pub fn compute_retry_delay(base_minutes: i64, retry_number: i64) -> Result<i64, String> {
    let b = base_minutes.max(1);
    let r = retry_number.max(1);
    Ok(b * 60 * (1i64 << (r - 1).min(10)))
}

// ── Usage Summary ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub total_requests: i64,
    pub total_cost: String,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_creation_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub success_rate: f64,
}

#[tauri::command]
pub fn db_get_usage_summary(start_date: Option<i64>, end_date: Option<i64>) -> Result<UsageSummary, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    // Detail logs
    let mut d_where = String::new();
    let mut d_params: Vec<Value> = vec![];
    let mut conds: Vec<String> = vec![];
    if let Some(s) = start_date { conds.push(format!("created_at >= ?{}", d_params.len() + 1)); d_params.push(Value::Integer(s)); }
    if let Some(e) = end_date { conds.push(format!("created_at <= ?{}", d_params.len() + 1)); d_params.push(Value::Integer(e)); }
    if !conds.is_empty() { d_where = format!("WHERE {}", conds.join(" AND ")); }

    let d_sql = format!(
        "SELECT COUNT(*), COALESCE(SUM(CAST(total_cost_usd AS REAL)),0), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cache_creation_tokens),0), COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(CASE WHEN status_code>=200 AND status_code<300 THEN 1 ELSE 0 END),0) FROM proxy_request_logs {d_where}"
    );
    let d_row = conn.query_row(&d_sql, rusqlite::params_from_iter(d_params.iter()), |r| {
        Ok((r.get::<_,i64>(0)?, r.get::<_,f64>(1)?, r.get::<_,i64>(2)?, r.get::<_,i64>(3)?, r.get::<_,i64>(4)?, r.get::<_,i64>(5)?, r.get::<_,i64>(6)?))
    }).unwrap_or((0, 0.0, 0, 0, 0, 0, 0));

    // Rollups
    let mut r_where = String::new();
    let mut r_params: Vec<Value> = vec![];
    let mut r_conds: Vec<String> = vec![];
    if let Some(s) = start_date { r_conds.push(format!("date >= date(?{}, 'unixepoch', 'localtime')", r_params.len() + 1)); r_params.push(Value::Integer(s)); }
    if let Some(e) = end_date { r_conds.push(format!("date <= date(?{}, 'unixepoch', 'localtime')", r_params.len() + 1)); r_params.push(Value::Integer(e)); }
    if !r_conds.is_empty() { r_where = format!("WHERE {}", r_conds.join(" AND ")); }

    let r_sql = format!(
        "SELECT COALESCE(SUM(request_count),0), COALESCE(SUM(CAST(total_cost_usd AS REAL)),0), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cache_creation_tokens),0), COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(success_count),0) FROM usage_daily_rollups {r_where}"
    );
    let r_row = conn.query_row(&r_sql, rusqlite::params_from_iter(r_params.iter()), |r| {
        Ok((r.get::<_,i64>(0)?, r.get::<_,f64>(1)?, r.get::<_,i64>(2)?, r.get::<_,i64>(3)?, r.get::<_,i64>(4)?, r.get::<_,i64>(5)?, r.get::<_,i64>(6)?))
    }).unwrap_or((0, 0.0, 0, 0, 0, 0, 0));

    let total_req = d_row.0 + r_row.0;
    let total_cost = d_row.1 + r_row.1;
    let success = d_row.6 + r_row.6;
    let rate = if total_req > 0 { (success as f64 / total_req as f64) * 100.0 } else { 0.0 };

    Ok(UsageSummary {
        total_requests: total_req,
        total_cost: format!("{total_cost:.6}"),
        total_input_tokens: d_row.2 + r_row.2,
        total_output_tokens: d_row.3 + r_row.3,
        total_cache_creation_tokens: d_row.4 + r_row.4,
        total_cache_read_tokens: d_row.5 + r_row.5,
        success_rate: rate,
    })
}

// ── Usage Trends ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyStats {
    pub date: String,
    pub request_count: i64,
    pub total_cost: String,
    pub total_tokens: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_creation_tokens: i64,
    pub total_cache_read_tokens: i64,
}

#[tauri::command]
pub fn db_get_usage_trends(start_date: Option<i64>, end_date: Option<i64>) -> Result<Vec<DailyStats>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;

    let now_ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let end_ts = end_date.unwrap_or(now_ts);
    let mut start_ts = start_date.unwrap_or(end_ts - 86400);
    if start_ts >= end_ts { start_ts = end_ts - 86400; }

    let duration = end_ts - start_ts;
    let bucket_secs: i64 = if duration <= 86400 { 3600 } else { 86400 };
    let mut bucket_count = ((duration as f64) / (bucket_secs as f64)).ceil() as i64;
    if bucket_secs == 3600 { bucket_count = 24; }
    if bucket_count < 1 { bucket_count = 1; }

    let sql = format!(
        "SELECT CAST((created_at - ?1) / ?3 AS INTEGER) as bidx, COUNT(*), COALESCE(SUM(CAST(total_cost_usd AS REAL)),0), COALESCE(SUM(input_tokens+output_tokens),0), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cache_creation_tokens),0), COALESCE(SUM(cache_read_tokens),0) FROM proxy_request_logs WHERE created_at >= ?1 AND created_at <= ?2 GROUP BY bidx ORDER BY bidx ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("Prepare: {e}"))?;
    let mut bucket_map = std::collections::HashMap::new();
    let rows = stmt.query_map(params![start_ts, end_ts, bucket_secs], |r| {
        Ok((r.get::<_,i64>(0)?, r.get::<_,i64>(1)?, r.get::<_,f64>(2)?, r.get::<_,i64>(3)?, r.get::<_,i64>(4)?, r.get::<_,i64>(5)?, r.get::<_,i64>(6)?, r.get::<_,i64>(7)?))
    }).map_err(|e| format!("Query: {e}"))?;

    for row in rows.flatten() {
        let mut bidx = row.0;
        if bidx < 0 { continue; }
        if bidx >= bucket_count { bidx = bucket_count - 1; }
        bucket_map.insert(bidx, row);
    }

    let mut stats = Vec::with_capacity(bucket_count as usize);
    for i in 0..bucket_count {
        let ts = start_ts + i * bucket_secs;
        let date = chrono_like_iso(ts);
        if let Some(r) = bucket_map.get(&i) {
            stats.push(DailyStats { date, request_count: r.1, total_cost: format!("{:.6}", r.2), total_tokens: r.3, total_input_tokens: r.4, total_output_tokens: r.5, total_cache_creation_tokens: r.6, total_cache_read_tokens: r.7 });
        } else {
            stats.push(DailyStats { date, request_count: 0, total_cost: "0.000000".into(), total_tokens: 0, total_input_tokens: 0, total_output_tokens: 0, total_cache_creation_tokens: 0, total_cache_read_tokens: 0 });
        }
    }
    Ok(stats)
}

/// Minimal ISO-8601 without pulling in the `chrono` crate.
fn chrono_like_iso(epoch: i64) -> String {
    let secs_per_day: i64 = 86400;
    let days = epoch / secs_per_day;
    let rem = epoch % secs_per_day;
    let h = rem / 3600;
    let m = (rem % 3600) / 60;
    let s = rem % 60;

    // Civil date from days since epoch (algorithm from Howard Hinnant)
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let yr = if mo <= 2 { y + 1 } else { y };

    format!("{yr:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

// ── Provider & Model Stats ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatsRow {
    pub provider_id: String,
    pub provider_name: String,
    pub request_count: i64,
    pub total_tokens: i64,
    pub total_cost: String,
    pub success_rate: f64,
    pub avg_latency_ms: i64,
}

#[tauri::command]
pub fn db_get_provider_stats() -> Result<Vec<ProviderStatsRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let sql = "
        SELECT provider_id, provider_name, SUM(rc), SUM(tt), SUM(tc), SUM(sc), CASE WHEN SUM(rc)>0 THEN SUM(ls)/SUM(rc) ELSE 0 END FROM (
          SELECT l.provider_id, COALESCE(p.name,'Unknown') as provider_name, COUNT(*) as rc, COALESCE(SUM(l.input_tokens+l.output_tokens),0) as tt, COALESCE(SUM(CAST(l.total_cost_usd AS REAL)),0) as tc, COALESCE(SUM(CASE WHEN l.status_code>=200 AND l.status_code<300 THEN 1 ELSE 0 END),0) as sc, COALESCE(SUM(l.latency_ms),0) as ls FROM proxy_request_logs l LEFT JOIN providers p ON l.provider_id=p.id GROUP BY l.provider_id
          UNION ALL
          SELECT r.provider_id, COALESCE(p2.name,'Unknown'), COALESCE(SUM(r.request_count),0), COALESCE(SUM(r.input_tokens+r.output_tokens),0), COALESCE(SUM(CAST(r.total_cost_usd AS REAL)),0), COALESCE(SUM(r.success_count),0), COALESCE(SUM(r.avg_latency_ms*r.request_count),0) FROM usage_daily_rollups r LEFT JOIN providers p2 ON r.provider_id=p2.id GROUP BY r.provider_id
        ) GROUP BY provider_id ORDER BY tc DESC";
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let rc: i64 = r.get(2)?;
            let sc: i64 = r.get(5)?;
            let rate = if rc > 0 { (sc as f64 / rc as f64) * 100.0 } else { 0.0 };
            let cost: f64 = r.get(4)?;
            Ok(ProviderStatsRow {
                provider_id: r.get(0)?, provider_name: r.get(1)?, request_count: rc,
                total_tokens: r.get(3)?, total_cost: format!("{cost:.6}"),
                success_rate: rate, avg_latency_ms: r.get(6)?,
            })
        })
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatsRow {
    pub model: String,
    pub request_count: i64,
    pub total_tokens: i64,
    pub total_cost: String,
    pub avg_cost_per_request: String,
}

#[tauri::command]
pub fn db_get_model_stats() -> Result<Vec<ModelStatsRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let sql = "
        SELECT model, SUM(rc), SUM(tt), SUM(tc) FROM (
          SELECT model, COUNT(*) as rc, COALESCE(SUM(input_tokens+output_tokens),0) as tt, COALESCE(SUM(CAST(total_cost_usd AS REAL)),0) as tc FROM proxy_request_logs GROUP BY model
          UNION ALL
          SELECT model, COALESCE(SUM(request_count),0), COALESCE(SUM(input_tokens+output_tokens),0), COALESCE(SUM(CAST(total_cost_usd AS REAL)),0) FROM usage_daily_rollups GROUP BY model
        ) GROUP BY model ORDER BY tc DESC";
    let mut stmt = conn.prepare(sql).map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let rc: i64 = r.get(1)?;
            let tc: f64 = r.get(3)?;
            let avg = if rc > 0 { tc / rc as f64 } else { 0.0 };
            Ok(ModelStatsRow {
                model: r.get(0)?, request_count: rc, total_tokens: r.get(2)?,
                total_cost: format!("{tc:.6}"), avg_cost_per_request: format!("{avg:.6}"),
            })
        })
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok()).collect();
    Ok(rows)
}

// ── Request Logs ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogRow {
    pub request_id: String,
    pub provider_id: String,
    pub provider_name: Option<String>,
    pub app_type: String,
    pub model: String,
    pub request_model: Option<String>,
    pub cost_multiplier: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub input_cost_usd: String,
    pub output_cost_usd: String,
    pub cache_read_cost_usd: String,
    pub cache_creation_cost_usd: String,
    pub total_cost_usd: String,
    pub is_streaming: bool,
    pub latency_ms: i64,
    pub first_token_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub status_code: i64,
    pub error_message: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaginatedLogs {
    pub data: Vec<RequestLogRow>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

fn read_log_row(r: &rusqlite::Row) -> rusqlite::Result<RequestLogRow> {
    Ok(RequestLogRow {
        request_id: r.get(0)?, provider_id: r.get(1)?, provider_name: r.get(2)?,
        app_type: r.get(3)?, model: r.get(4)?, request_model: r.get(5)?,
        cost_multiplier: r.get::<_, String>(6).unwrap_or_else(|_| "1".into()),
        input_tokens: r.get(7)?, output_tokens: r.get(8)?,
        cache_read_tokens: r.get(9)?, cache_creation_tokens: r.get(10)?,
        input_cost_usd: r.get(11)?, output_cost_usd: r.get(12)?,
        cache_read_cost_usd: r.get(13)?, cache_creation_cost_usd: r.get(14)?,
        total_cost_usd: r.get(15)?,
        is_streaming: r.get::<_, i64>(16).unwrap_or(0) != 0,
        latency_ms: r.get(17)?, first_token_ms: r.get(18)?, duration_ms: r.get(19)?,
        status_code: r.get(20)?, error_message: r.get(21)?, created_at: r.get(22)?,
    })
}

const LOG_SELECT: &str = "l.request_id, l.provider_id, p.name, l.app_type, l.model, l.request_model, l.cost_multiplier, l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_creation_tokens, l.input_cost_usd, l.output_cost_usd, l.cache_read_cost_usd, l.cache_creation_cost_usd, l.total_cost_usd, l.is_streaming, l.latency_ms, l.first_token_ms, l.duration_ms, l.status_code, l.error_message, l.created_at";

#[tauri::command]
pub fn db_get_request_logs(filters_json: Option<String>, page: Option<i64>, page_size: Option<i64>) -> Result<PaginatedLogs, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let pg = page.unwrap_or(0);
    let ps = page_size.unwrap_or(20);

    let filters: serde_json::Value = filters_json
        .as_deref()
        .map(|s| serde_json::from_str(s).unwrap_or(serde_json::Value::Null))
        .unwrap_or(serde_json::Value::Null);
    let obj = filters.as_object();

    let mut conds: Vec<String> = vec![];
    let mut vals: Vec<Value> = vec![];
    let mut idx: usize = 1;

    if let Some(m) = obj.and_then(|o| o.get("appType")).and_then(|v| v.as_str()) {
        conds.push(format!("l.app_type = ?{idx}")); vals.push(Value::Text(m.into())); idx += 1;
    }
    if let Some(m) = obj.and_then(|o| o.get("providerName")).and_then(|v| v.as_str()) {
        conds.push(format!("p.name LIKE ?{idx}")); vals.push(Value::Text(format!("%{m}%"))); idx += 1;
    }
    if let Some(m) = obj.and_then(|o| o.get("model")).and_then(|v| v.as_str()) {
        conds.push(format!("l.model LIKE ?{idx}")); vals.push(Value::Text(format!("%{m}%"))); idx += 1;
    }
    if let Some(sc) = obj.and_then(|o| o.get("statusCode")).and_then(|v| v.as_i64()) {
        conds.push(format!("l.status_code = ?{idx}")); vals.push(Value::Integer(sc)); idx += 1;
    }
    if let Some(sd) = obj.and_then(|o| o.get("startDate")).and_then(|v| v.as_i64()) {
        conds.push(format!("l.created_at >= ?{idx}")); vals.push(Value::Integer(sd)); idx += 1;
    }
    if let Some(ed) = obj.and_then(|o| o.get("endDate")).and_then(|v| v.as_i64()) {
        conds.push(format!("l.created_at <= ?{idx}")); vals.push(Value::Integer(ed)); idx += 1;
    }

    let wh = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };

    // Count
    let cnt_sql = format!("SELECT COUNT(*) FROM proxy_request_logs l LEFT JOIN providers p ON l.provider_id=p.id {wh}");
    let total: i64 = conn.query_row(&cnt_sql, rusqlite::params_from_iter(vals.iter()), |r| r.get(0)).unwrap_or(0);

    // Data
    vals.push(Value::Integer(ps));
    vals.push(Value::Integer(pg * ps));
    let data_sql = format!("SELECT {LOG_SELECT} FROM proxy_request_logs l LEFT JOIN providers p ON l.provider_id=p.id {wh} ORDER BY l.created_at DESC LIMIT ?{idx} OFFSET ?{}", idx + 1);
    let mut stmt = conn.prepare(&data_sql).map_err(|e| format!("Prepare: {e}"))?;
    let data = stmt.query_map(rusqlite::params_from_iter(vals.iter()), read_log_row)
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok()).collect();

    Ok(PaginatedLogs { data, total, page: pg, page_size: ps })
}

#[tauri::command]
pub fn db_get_request_detail(request_id: String) -> Result<Option<RequestLogRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let sql = format!("SELECT {LOG_SELECT} FROM proxy_request_logs l LEFT JOIN providers p ON l.provider_id=p.id WHERE l.request_id = ?1");
    conn.query_row(&sql, params![request_id], read_log_row)
        .optional()
        .map_err(|e| format!("Query: {e}"))
}

// ── Model Pricing ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricingRow {
    pub model_id: String,
    pub display_name: String,
    pub input_cost_per_million: String,
    pub output_cost_per_million: String,
    pub cache_read_cost_per_million: String,
    pub cache_creation_cost_per_million: String,
}

#[tauri::command]
pub fn db_list_model_pricing() -> Result<Vec<ModelPricingRow>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let mut stmt = conn
        .prepare("SELECT model_id, display_name, input_cost_per_million, output_cost_per_million, cache_read_cost_per_million, cache_creation_cost_per_million FROM model_pricing ORDER BY display_name")
        .map_err(|e| format!("Prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| Ok(ModelPricingRow {
            model_id: r.get(0)?, display_name: r.get(1)?, input_cost_per_million: r.get(2)?,
            output_cost_per_million: r.get(3)?, cache_read_cost_per_million: r.get(4)?,
            cache_creation_cost_per_million: r.get(5)?,
        }))
        .map_err(|e| format!("Query: {e}"))?
        .filter_map(|r| r.ok()).collect();
    Ok(rows)
}

#[tauri::command]
pub fn db_upsert_model_pricing(
    model_id: String, display_name: String, input_cost: String,
    output_cost: String, cache_read_cost: String, cache_creation_cost: String,
) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute(
        "INSERT OR REPLACE INTO model_pricing (model_id, display_name, input_cost_per_million, output_cost_per_million, cache_read_cost_per_million, cache_creation_cost_per_million) VALUES (?1,?2,?3,?4,?5,?6)",
        params![model_id, display_name, input_cost, output_cost, cache_read_cost, cache_creation_cost],
    ).map_err(|e| format!("Upsert: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_delete_model_pricing(model_id: String) -> Result<(), String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    conn.execute("DELETE FROM model_pricing WHERE model_id = ?1", params![model_id])
        .map_err(|e| format!("Delete: {e}"))?;
    Ok(())
}

// ── Generic raw SQL (used by frontend Kanban module) ────────────────────────

#[tauri::command]
pub fn db_raw_execute(sql: String, params: Vec<serde_json::Value>) -> Result<u64, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let p: Vec<Box<dyn rusqlite::types::ToSql>> = params.iter().map(json_to_sql).collect();
    let refs: Vec<&dyn rusqlite::types::ToSql> = p.iter().map(|b| b.as_ref()).collect();
    let changed = conn
        .execute(&sql, refs.as_slice())
        .map_err(|e| format!("raw_execute: {e}"))?;
    Ok(changed as u64)
}

#[tauri::command]
pub fn db_raw_select(sql: String, params: Vec<serde_json::Value>) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let guard = get_conn()?;
    let conn = guard.as_ref().ok_or("DB not initialized")?;
    let p: Vec<Box<dyn rusqlite::types::ToSql>> = params.iter().map(json_to_sql).collect();
    let refs: Vec<&dyn rusqlite::types::ToSql> = p.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map(refs.as_slice(), |row| {
            let mut map = serde_json::Map::new();
            for (i, name) in col_names.iter().enumerate() {
                let val: Value = row.get(i)?;
                map.insert(name.clone(), sqlite_value_to_json(val));
            }
            Ok(map)
        })
        .map_err(|e| format!("query: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row: {e}"))?);
    }
    Ok(out)
}

fn json_to_sql(v: &serde_json::Value) -> Box<dyn rusqlite::types::ToSql> {
    match v {
        serde_json::Value::Null => Box::new(rusqlite::types::Null),
        serde_json::Value::Bool(b) => Box::new(*b as i64),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else if let Some(f) = n.as_f64() {
                Box::new(f)
            } else {
                Box::new(rusqlite::types::Null)
            }
        }
        serde_json::Value::String(s) => Box::new(s.clone()),
        _ => Box::new(v.to_string()),
    }
}

fn sqlite_value_to_json(v: Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Integer(i) => serde_json::json!(i),
        Value::Real(f) => serde_json::json!(f),
        Value::Text(s) => serde_json::json!(s),
        Value::Blob(b) => serde_json::json!(base64_encode(&b)),
    }
}

fn base64_encode(data: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(data.len() * 4 / 3 + 4);
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        let _ = write!(s, "{}", CHARS[((n >> 18) & 63) as usize] as char);
        let _ = write!(s, "{}", CHARS[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 { let _ = write!(s, "{}", CHARS[((n >> 6) & 63) as usize] as char); } else { s.push('='); }
        if chunk.len() > 2 { let _ = write!(s, "{}", CHARS[(n & 63) as usize] as char); } else { s.push('='); }
    }
    s
}
