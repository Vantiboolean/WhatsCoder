//! Tauri backend for the Codex desktop shell: native commands for Git and the filesystem,
//! Codex/Claude config files, the optional Codex app-server child process, SQLite-backed
//! settings and usage, automation scheduling, AI filesystem tools (`dynamic_tools`), and
//! Claude Code CLI streaming (`claude_api`).

mod automation_scheduler;
mod claude_api;
mod database;
mod dynamic_tools;

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// ── Codex app-server (WebSocket `app-server` child) ───────────────────────────
static CODEX_SERVER_PROCESS: Mutex<Option<Child>> = Mutex::new(None);
static CODEX_BINARY_PATH: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexServerStatus {
    pub running: bool,
    pub pid: Option<u32>,
}

/// Spawns `codex app-server` if none is running; reuses an existing healthy child and remembers the binary path for later starts.
#[tauri::command]
fn start_codex_server(
    port: Option<u16>,
    codex_path: Option<String>,
) -> Result<CodexServerStatus, String> {
    eprintln!("[codex-server] start_codex_server called: port={port:?}, codex_path={codex_path:?}");

    let mut guard = CODEX_SERVER_PROCESS
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    if let Some(ref mut child) = *guard {
        match child.try_wait() {
            Ok(None) => {
                let pid = child.id();
                eprintln!("[codex-server] Existing process alive, pid={pid}");
                return Ok(CodexServerStatus {
                    running: true,
                    pid: Some(pid),
                });
            }
            Ok(Some(status)) => {
                eprintln!("[codex-server] Existing process exited with status: {status}");
                *guard = None;
            }
            Err(e) => {
                eprintln!("[codex-server] Error checking existing process: {e}");
                *guard = None;
            }
        }
    }

    let listen_port = port.unwrap_or(4500);
    let listen_url = format!("ws://127.0.0.1:{listen_port}");

    let binary = codex_path
        .or_else(|| CODEX_BINARY_PATH.lock().ok().and_then(|g| g.clone()))
        .unwrap_or_else(|| "codex".to_string());

    eprintln!("[codex-server] Spawning: binary={binary:?}, listen_url={listen_url}");
    if cfg!(target_os = "windows") {
        eprintln!("[codex-server] Using cmd /C wrapper for Windows");
    }

    let child = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args([
                "/C", &binary, "app-server",
                "--listen", &listen_url,
                "--session-source", "desktop",
            ])
            .env("CODEX_DESKTOP", "1")
            .spawn()
    } else {
        Command::new(&binary)
            .args([
                "app-server",
                "--listen", &listen_url,
                "--session-source", "desktop",
            ])
            .env("CODEX_DESKTOP", "1")
            .spawn()
    }
    .map_err(|e| {
        eprintln!("[codex-server] SPAWN FAILED: {e}");
        format!("Failed to start codex app-server: {e}")
    })?;

    if let Ok(mut path_guard) = CODEX_BINARY_PATH.lock() {
        *path_guard = Some(binary.clone());
    }

    let pid = child.id();
    eprintln!("[codex-server] Process spawned successfully: pid={pid}, binary={binary}");
    *guard = Some(child);

    Ok(CodexServerStatus {
        running: true,
        pid: Some(pid),
    })
}

/// Kills the managed app-server child if present; no-op when nothing was started from this process.
#[tauri::command]
fn stop_codex_server() -> Result<(), String> {
    let mut guard = CODEX_SERVER_PROCESS
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    if let Some(mut child) = guard.take() {
        child
            .kill()
            .map_err(|e| format!("Failed to kill process: {e}"))?;
        let _ = child.wait();
    }

    Ok(())
}

/// Uses `try_wait` to detect a dead child so the UI does not assume the server is up after an external crash.
#[tauri::command]
fn get_codex_server_status() -> Result<CodexServerStatus, String> {
    let mut guard = CODEX_SERVER_PROCESS
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    if let Some(ref mut child) = *guard {
        match child.try_wait() {
            Ok(None) => {
                return Ok(CodexServerStatus {
                    running: true,
                    pid: Some(child.id()),
                });
            }
            _ => {
                *guard = None;
            }
        }
    }

    Ok(CodexServerStatus {
        running: false,
        pid: None,
    })
}

fn codex_exe_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "codex.exe"
    } else {
        "codex"
    }
}

/// Heuristic install locations (Cargo, npm, NVM, Homebrew, etc.) when `codex` is not on `PATH`.
#[tauri::command]
fn find_codex_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    let exe = codex_exe_name();

    if let Some(home) = dirs_next::home_dir() {
        let mut paths: Vec<PathBuf> = vec![
            home.join(".cargo").join("bin").join(exe),
            home.join(".local").join("bin").join("codex"),
        ];

        if cfg!(target_os = "windows") {
            if let Ok(appdata) = std::env::var("APPDATA") {
                paths.push(PathBuf::from(&appdata).join("npm").join("codex.cmd"));
                paths.push(PathBuf::from(&appdata).join("npm").join(exe));
            }
            if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
                paths.push(PathBuf::from(&localappdata).join("npm").join("codex.cmd"));
                paths.push(PathBuf::from(&localappdata).join("npm").join(exe));
            }
        } else {
            paths.push(PathBuf::from("/usr/local/bin/codex"));
            paths.push(PathBuf::from("/opt/homebrew/bin/codex"));
        }

        if let Ok(nvm_dir) = std::env::var("NVM_DIR") {
            let versions_dir = PathBuf::from(&nvm_dir).join("versions").join("node");
            if let Ok(entries) = std::fs::read_dir(&versions_dir) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("bin").join("codex");
                    if bin.exists() {
                        candidates.push(bin.to_string_lossy().to_string());
                    }
                }
            }
        }

        for p in paths {
            if p.exists() {
                let s = p.to_string_lossy().to_string();
                if !candidates.contains(&s) {
                    candidates.push(s);
                }
            }
        }
    }

    candidates
}

/// Blocking native file picker; returns the path chosen by the user (optional cancel).
#[tauri::command]
fn pick_codex_binary(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file().set_title("Select Codex Binary");

    if cfg!(target_os = "windows") {
        builder = builder.add_filter("Executable", &["exe", "cmd", "bat"]);
    }

    let result = builder.blocking_pick_file();
    Ok(result.map(|p| p.to_string()))
}

// ── Git (subprocess `git` in `cwd`) ───────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: String,
    pub is_dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub added_lines: u32,
    pub removed_lines: u32,
    pub untracked_count: u32,
    pub modified_count: u32,
    pub remote_url: Option<String>,
    pub last_commit_sha: Option<String>,
    pub last_commit_msg: Option<String>,
}

// ── Codex `~/.codex/config.toml` (structured subset for the UI) ────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfig {
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub approval_mode: Option<String>,
    pub sandbox: Option<String>,
    pub instructions: Option<String>,
    pub notify: Option<bool>,
}

// ── Host and app version (no secrets) ─────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub app_version: String,
}

fn codex_dir() -> Result<PathBuf, String> {
    dirs_next::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or("Cannot find home directory".to_string())
}

fn codex_config_path() -> Result<PathBuf, String> {
    Ok(codex_dir()?.join("config.toml"))
}

fn codex_global_state_path() -> Result<PathBuf, String> {
    Ok(codex_dir()?.join(".codex-global-state.json"))
}

fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        })
}

/// Aggregates porcelain status, shortstat (working tree + staged), and `HEAD...@{u}` ahead/behind (zero if no upstream).
#[tauri::command]
fn get_git_info(cwd: String) -> Result<GitInfo, String> {
    let branch = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| "unknown".to_string());

    let status_output = run_git(&cwd, &["status", "--porcelain"]).unwrap_or_default();

    let mut untracked = 0u32;
    let mut modified = 0u32;
    for line in status_output.lines() {
        if line.starts_with("??") {
            untracked += 1;
        } else if !line.is_empty() {
            modified += 1;
        }
    }

    let is_dirty = untracked > 0 || modified > 0;

    let diff_stat = run_git(&cwd, &["diff", "--shortstat"]).unwrap_or_default();
    let (added, removed) = parse_diff_stat(&diff_stat);

    let staged_stat = run_git(&cwd, &["diff", "--cached", "--shortstat"]).unwrap_or_default();
    let (staged_added, staged_removed) = parse_diff_stat(&staged_stat);

    let (ahead, behind) = run_git(
        &cwd,
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    )
    .and_then(|s| {
        let parts: Vec<&str> = s.split('\t').collect();
        if parts.len() == 2 {
            Some((
                parts[0].parse::<u32>().unwrap_or(0),
                parts[1].parse::<u32>().unwrap_or(0),
            ))
        } else {
            None
        }
    })
    .unwrap_or((0, 0));

    let remote_url = run_git(&cwd, &["config", "--get", "remote.origin.url"]);

    let last_commit_sha = run_git(&cwd, &["rev-parse", "--short", "HEAD"]);
    let last_commit_msg = run_git(&cwd, &["log", "-1", "--pretty=%s"]);

    Ok(GitInfo {
        branch,
        is_dirty,
        ahead,
        behind,
        added_lines: added + staged_added,
        removed_lines: removed + staged_removed,
        untracked_count: untracked,
        modified_count: modified,
        remote_url,
        last_commit_sha,
        last_commit_msg,
    })
}

fn parse_diff_stat(stat: &str) -> (u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    for part in stat.split(',') {
        let trimmed = part.trim();
        if trimmed.contains("insertion") {
            if let Some(n) = trimmed.split_whitespace().next() {
                added = n.parse().unwrap_or(0);
            }
        } else if trimmed.contains("deletion") {
            if let Some(n) = trimmed.split_whitespace().next() {
                removed = n.parse().unwrap_or(0);
            }
        }
    }
    (added, removed)
}

#[tauri::command]
fn read_codex_config() -> Result<CodexConfig, String> {
    let config_path = codex_config_path()?;

    if !config_path.exists() {
        return Ok(CodexConfig {
            model: None,
            model_provider: None,
            approval_mode: None,
            sandbox: None,
            instructions: None,
            notify: None,
        });
    }

    let content =
        std::fs::read_to_string(&config_path).map_err(|e| format!("Failed to read config: {e}"))?;

    let table: toml::Table =
        toml::from_str(&content).map_err(|e| format!("Failed to parse config: {e}"))?;

    let str_val = |key: &str| -> Option<String> {
        table.get(key).and_then(|v| v.as_str()).map(str::to_string)
    };

    let approval_mode = str_val("approval_mode").or_else(|| str_val("ask_for_approval"));

    let notify = table.get("notify").and_then(|v| {
        if let Some(b) = v.as_bool() {
            Some(b)
        } else if let Some(s) = v.as_str() {
            Some(s == "true")
        } else {
            None
        }
    });

    Ok(CodexConfig {
        model: str_val("model"),
        model_provider: str_val("model_provider"),
        approval_mode,
        sandbox: str_val("sandbox"),
        instructions: str_val("instructions"),
        notify,
    })
}

#[tauri::command]
fn read_active_workspace_roots() -> Result<Vec<String>, String> {
    let state_path = codex_global_state_path()?;
    if !state_path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&state_path)
        .map_err(|e| format!("Failed to read global state: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse global state: {e}"))?;

    let Some(items) = json
        .get("active-workspace-roots")
        .and_then(|value| value.as_array())
    else {
        return Ok(Vec::new());
    };

    let mut roots = Vec::new();
    for item in items {
        let Some(path) = item.as_str() else {
            continue;
        };
        if path.is_empty() {
            continue;
        }

        let already_exists = roots.iter().any(|existing: &String| {
            #[cfg(target_os = "windows")]
            {
                existing.eq_ignore_ascii_case(path)
            }
            #[cfg(not(target_os = "windows"))]
            {
                existing == path
            }
        });

        if !already_exists {
            roots.push(path.to_string());
        }
    }

    Ok(roots)
}

/// Merges one key into `config.toml`; only `notify` is serialized as a TOML bool (`value` is `"true"` / `"false"`).
#[tauri::command]
fn write_codex_config(key: String, value: String) -> Result<(), String> {
    let config_dir = codex_dir()?;
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create dir: {e}"))?;
    let config_path = config_dir.join("config.toml");

    let content = if config_path.exists() {
        std::fs::read_to_string(&config_path).unwrap_or_default()
    } else {
        String::new()
    };

    let mut table: toml::Table = toml::from_str(&content).unwrap_or_default();

    // `notify` must round-trip as bool in TOML; other keys stay strings for simplicity.
    if key == "notify" {
        let bool_val = value == "true";
        table.insert(key, toml::Value::Boolean(bool_val));
    } else {
        table.insert(key, toml::Value::String(value));
    }

    let new_content =
        toml::to_string_pretty(&table).map_err(|e| format!("Failed to serialize config: {e}"))?;

    std::fs::write(&config_path, new_content)
        .map_err(|e| format!("Failed to write config: {e}"))?;

    Ok(())
}

#[tauri::command]
fn get_system_info(app: tauri::AppHandle) -> SystemInfo {
    SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string()),
        app_version: app
            .config()
            .version
            .clone()
            .unwrap_or_else(|| "0.1.0".to_string()),
    }
}

// ── Workspace: discover nested repos ────────────────────────────────────────

/// Immediate subdirectories of `cwd` that contain `.git` (hidden dirs excluded); used for multi-repo pickers.
#[tauri::command]
fn list_project_folders(cwd: String) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err("Path does not exist".to_string());
    }

    let mut folders = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&path) {
        for entry in entries.flatten() {
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.starts_with('.') {
                    let git_dir = entry.path().join(".git");
                    if git_dir.exists() {
                        folders.push(entry.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    Ok(folders)
}

// ── Git: detailed status, diffs, log, staging ───────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDetailedStatus {
    pub branch: String,
    pub staged: Vec<GitFileStatus>,
    pub unstaged: Vec<GitFileStatus>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptItem {
    pub name: String,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptsList {
    pub workspace: Vec<PromptItem>,
    pub general: Vec<PromptItem>,
}

fn parse_status_code(code: &str) -> &str {
    match code.trim() {
        "M" | "MM" => "modified",
        "A" | "AM" => "added",
        "D" => "deleted",
        "R" => "renamed",
        "C" => "copied",
        "??" => "untracked",
        "UU" => "conflict",
        _ => "modified",
    }
}

fn batch_diff_stats(cwd: &str, staged: bool) -> std::collections::HashMap<String, (u32, u32)> {
    let args: Vec<&str> = if staged {
        vec!["diff", "--cached", "--numstat"]
    } else {
        vec!["diff", "--numstat"]
    };
    let output = run_git(cwd, &args).unwrap_or_default();
    let mut map = std::collections::HashMap::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            let a = parts[0].parse::<u32>().unwrap_or(0);
            let d = parts[1].parse::<u32>().unwrap_or(0);
            map.insert(parts[2].to_string(), (a, d));
        }
    }
    map
}

/// Porcelain lines split into staged vs unstaged rows with `--numstat` additions/deletions per path.
#[tauri::command]
fn get_git_status_detailed(cwd: String) -> Result<GitDetailedStatus, String> {
    let branch = run_git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|| "unknown".to_string());

    let status_output = run_git(&cwd, &["status", "--porcelain"]).unwrap_or_default();

    let staged_stats = batch_diff_stats(&cwd, true);
    let unstaged_stats = batch_diff_stats(&cwd, false);

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();

    for line in status_output.lines() {
        if line.len() < 4 {
            continue;
        }
        let index_status = &line[0..1];
        let worktree_status = &line[1..2];
        let file_path = line[3..].to_string();

        if index_status != " " && index_status != "?" {
            let (a, d) = staged_stats.get(&file_path).copied().unwrap_or((0, 0));
            staged.push(GitFileStatus {
                path: file_path.clone(),
                status: parse_status_code(index_status).to_string(),
                additions: a,
                deletions: d,
            });
        }

        if worktree_status != " " || index_status == "?" {
            let status_str = if index_status == "?" {
                "untracked"
            } else {
                parse_status_code(worktree_status)
            };
            let (a, d) = if status_str == "untracked" {
                (0, 0)
            } else {
                unstaged_stats.get(&file_path).copied().unwrap_or((0, 0))
            };
            unstaged.push(GitFileStatus {
                path: file_path,
                status: status_str.to_string(),
                additions: a,
                deletions: d,
            });
        }
    }

    Ok(GitDetailedStatus {
        branch,
        staged,
        unstaged,
    })
}

/// Unified diff for a path; for untracked files with no blob, synthesizes a `/dev/null` patch from disk so the UI still shows content.
#[tauri::command]
fn get_git_diff(cwd: String, file_path: String, staged: bool) -> Result<String, String> {
    let args: Vec<&str> = if staged {
        vec!["diff", "--cached", "--", &file_path]
    } else {
        vec!["diff", "--", &file_path]
    };
    let diff = run_git(&cwd, &args).unwrap_or_default();

    if diff.is_empty() && !staged {
        let show = run_git(&cwd, &["show", &format!(":{}", file_path)]);
        if show.is_none() {
            if let Ok(content) = std::fs::read_to_string(PathBuf::from(&cwd).join(&file_path)) {
                let lines: Vec<String> = content
                    .lines()
                    .enumerate()
                    .map(|(_i, l)| format!("+{}", l))
                    .collect();
                return Ok(format!(
                    "--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n{}",
                    file_path,
                    lines.len(),
                    lines.join("\n")
                ));
            }
        }
    }
    Ok(diff)
}

#[tauri::command]
fn get_git_log(cwd: String, limit: u32) -> Result<Vec<CommitEntry>, String> {
    let limit_str = format!("-{}", limit);
    let output = run_git(
        &cwd,
        &[
            "log",
            &limit_str,
            "--pretty=format:%H%n%h%n%s%n%an%n%ai%n---END---",
        ],
    )
    .unwrap_or_default();

    let mut entries = Vec::new();
    let mut lines = output.lines().peekable();
    while lines.peek().is_some() {
        let sha = match lines.next() {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => break,
        };
        let short_sha = lines.next().unwrap_or("").to_string();
        let message = lines.next().unwrap_or("").to_string();
        let author = lines.next().unwrap_or("").to_string();
        let date = lines.next().unwrap_or("").to_string();
        // consume the ---END--- separator
        let _ = lines.next();

        entries.push(CommitEntry {
            sha,
            short_sha,
            message,
            author,
            date,
        });
    }

    Ok(entries)
}

#[tauri::command]
fn git_stage_file(cwd: String, file_path: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["add", "--", &file_path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git add: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add failed: {stderr}"));
    }
    Ok(())
}

#[tauri::command]
fn git_unstage_file(cwd: String, file_path: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["reset", "HEAD", "--", &file_path])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git reset: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git reset failed: {stderr}"));
    }
    Ok(())
}

#[tauri::command]
fn git_commit(cwd: String, message: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run git commit: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git commit failed: {stderr}"));
    }
    Ok(())
}

#[tauri::command]
fn get_git_commit_diff(cwd: String, sha: String) -> Result<String, String> {
    run_git(&cwd, &["show", "--format=", &sha])
        .ok_or_else(|| "Failed to get commit diff".to_string())
}

// ── Filesystem (explorer; heavy dirs omitted) ─────────────────────────────────

/// Lists one level; skips dotfiles and common build/vendor folders to keep trees navigable in the UI.
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let dir_path = PathBuf::from(&path);
    if !dir_path.exists() {
        return Err("Path does not exist".to_string());
    }

    let mut entries = Vec::new();
    let read_dir =
        std::fs::read_dir(&dir_path).map_err(|e| format!("Failed to read directory: {e}"))?;

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        if is_dir
            && matches!(
                name.as_str(),
                "node_modules" | "target" | "dist" | "build" | "__pycache__" | ".next" | ".nuxt"
            )
        {
            continue;
        }

        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            size,
        });
    }

    entries.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(entries)
}

/// Reads as UTF-8 (lossy); default cap ~512 KiB with `truncated` when larger.
#[tauri::command]
fn read_file_content(path: String, max_bytes: Option<u64>) -> Result<FileContent, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err("File does not exist".to_string());
    }

    let max = max_bytes.unwrap_or(512_000);
    let meta =
        std::fs::metadata(&file_path).map_err(|e| format!("Failed to read metadata: {e}"))?;

    let truncated = meta.len() > max;

    let bytes = std::fs::read(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;
    let slice = if truncated {
        &bytes[..max as usize]
    } else {
        &bytes
    };
    let content = String::from_utf8_lossy(slice).to_string();

    Ok(FileContent { content, truncated })
}

/// Writes bytes as-is; parent must exist (no `mkdir -p`).
#[tauri::command]
fn write_file_content(path: String, content: String) -> Result<(), String> {
    let file_path = PathBuf::from(&path);
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            return Err("Parent directory does not exist".to_string());
        }
    }
    std::fs::write(&file_path, content.as_bytes()).map_err(|e| format!("Failed to write file: {e}"))
}

fn read_prompts_from_dir(dir: &PathBuf) -> Vec<PromptItem> {
    let mut prompts = Vec::new();
    if !dir.exists() {
        return prompts;
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let name = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let content = std::fs::read_to_string(&path).unwrap_or_default();
                prompts.push(PromptItem {
                    name,
                    path: path.to_string_lossy().to_string(),
                    content,
                });
            }
        }
    }

    prompts.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    prompts
}

// ── Prompts (`~/.codex/prompts` and workspace `.codex/prompts`) ───────────────

#[tauri::command]
fn list_prompts(cwd: Option<String>) -> Result<PromptsList, String> {
    let general_dir = codex_dir()?.join("prompts");
    let general = read_prompts_from_dir(&general_dir);

    let workspace = if let Some(ref cwd_path) = cwd {
        let ws_dir = PathBuf::from(cwd_path).join(".codex").join("prompts");
        read_prompts_from_dir(&ws_dir)
    } else {
        Vec::new()
    };

    Ok(PromptsList { workspace, general })
}

#[tauri::command]
fn read_prompt(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path)        .map_err(|e| format!("Failed to read prompt: {e}"))
}

// ── Native folder picker & OS file manager ──────────────────────────────────

#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let result = app
        .dialog()
        .file()
        .set_title("Select Project Folder")
        .blocking_pick_folder();

    Ok(result.map(|p| p.to_string()))
}

/// Opens `path` in Explorer / Finder / `xdg-open` depending on the host OS.
#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }
    Ok(())
}

// ── Claude & Codex on-disk config (import / raw read-write for providers UI) ─

fn claude_dir() -> Result<PathBuf, String> {
    dirs_next::home_dir()
        .map(|home| home.join(".claude"))
        .ok_or("Cannot find home directory".to_string())
}

#[tauri::command]
fn read_claude_settings() -> Result<String, String> {
    let settings_path = claude_dir()?.join("settings.json");
    if !settings_path.exists() {
        return Ok("{}".to_string());
    }
    std::fs::read_to_string(&settings_path)
        .map_err(|e| format!("Failed to read Claude settings: {e}"))
}

#[tauri::command]
fn write_claude_settings(json: String) -> Result<(), String> {
    let claude = claude_dir()?;
    std::fs::create_dir_all(&claude).map_err(|e| format!("Failed to create .claude dir: {e}"))?;
    let settings_path = claude.join("settings.json");
    std::fs::write(&settings_path, json.as_bytes())
        .map_err(|e| format!("Failed to write Claude settings: {e}"))
}

#[tauri::command]
fn read_codex_auth() -> Result<String, String> {
    let auth_path = codex_dir()?.join("auth.toml");
    if !auth_path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&auth_path).map_err(|e| format!("Failed to read Codex auth: {e}"))
}

#[tauri::command]
fn read_codex_config_full() -> Result<String, String> {
    let config_path = codex_dir()?.join("config.toml");
    if !config_path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&config_path).map_err(|e| format!("Failed to read Codex config: {e}"))
}

#[tauri::command]
fn write_codex_full_config(auth: String, config: String) -> Result<(), String> {
    let dir = codex_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create .codex dir: {e}"))?;
    std::fs::write(dir.join("auth.toml"), auth.as_bytes())
        .map_err(|e| format!("Failed to write auth.toml: {e}"))?;
    std::fs::write(dir.join("config.toml"), config.as_bytes())
        .map_err(|e| format!("Failed to write config.toml: {e}"))?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedProviderConfig {
    pub settings_config: String,
}

/// Reads the other app's config from well-known paths so the desktop can seed provider settings without manual copy-paste.
#[tauri::command]
fn import_current_provider_config(app_type: String) -> Result<ImportedProviderConfig, String> {
    match app_type.as_str() {
        "claude" => {
            let settings_path = claude_dir()?.join("settings.json");
            let content = if settings_path.exists() {
                std::fs::read_to_string(&settings_path)
                    .map_err(|e| format!("Failed to read Claude settings: {e}"))?
            } else {
                "{}".to_string()
            };
            Ok(ImportedProviderConfig {
                settings_config: content,
            })
        }
        "codex" => {
            let dir = codex_dir()?;
            let auth = if dir.join("auth.toml").exists() {
                std::fs::read_to_string(dir.join("auth.toml"))
                    .map_err(|e| format!("Failed to read auth.toml: {e}"))?
            } else {
                String::new()
            };
            let config = if dir.join("config.toml").exists() {
                std::fs::read_to_string(dir.join("config.toml"))
                    .map_err(|e| format!("Failed to read config.toml: {e}"))?
            } else {
                String::new()
            };
            let blob = serde_json::json!({ "auth": auth, "config": config });
            Ok(ImportedProviderConfig {
                settings_config: blob.to_string(),
            })
        }
        _ => Err(format!("Unsupported app type: {app_type}")),
    }
}

// ── Process cleanup & Tauri entry ───────────────────────────────────────────

fn cleanup_codex_server() {
    if let Ok(mut guard) = CODEX_SERVER_PROCESS.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Initialize the Rust-managed SQLite database
            let app_dir = app.path().app_data_dir().expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_dir).ok();
            let db_path = app_dir.join("codex.db");
            database::init(&db_path).expect("failed to initialize database");

            app.manage(automation_scheduler::AutomationSchedulerState::default());
            automation_scheduler::start_background_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_git_info,
            get_git_status_detailed,
            get_git_diff,
            get_git_log,
            git_stage_file,
            git_unstage_file,
            git_commit,
            get_git_commit_diff,
            list_directory,
            read_file_content,
            write_file_content,
            dynamic_tools::tool_read_file,
            dynamic_tools::tool_list_directory,
            dynamic_tools::tool_search_in_files,
            list_prompts,
            read_prompt,
            pick_folder,
            read_codex_config,
            read_active_workspace_roots,
            write_codex_config,
            get_system_info,
            list_project_folders,
            open_in_explorer,
            start_codex_server,
            stop_codex_server,
            get_codex_server_status,
            find_codex_candidates,
            pick_codex_binary,
            read_claude_settings,
            write_claude_settings,
            read_codex_auth,
            read_codex_config_full,
            write_codex_full_config,
            import_current_provider_config,
            automation_scheduler::sync_automation_scheduler,
            claude_api::claude_send_message,
            claude_api::claude_interrupt,
            // Database commands – settings
            database::db_get_setting,
            database::db_set_setting,
            database::db_get_all_settings,
            // Database commands – chat config
            database::db_get_chat_config,
            database::db_save_chat_config,
            database::db_delete_chat_config,
            // Database commands – chat history
            database::db_add_chat_message,
            database::db_get_chat_messages,
            database::db_get_all_chat_history,
            database::db_search_chat_history,
            // Database commands – connections
            database::db_list_connections,
            database::db_save_connection,
            database::db_delete_connection,
            database::db_set_default_connection,
            // Database commands – providers
            database::db_list_providers,
            database::db_get_current_provider_id,
            database::db_add_provider,
            database::db_update_provider,
            database::db_delete_provider,
            database::db_switch_provider,
            // Database commands – automations
            database::db_list_automations,
            database::db_get_automation,
            database::db_create_automation,
            database::db_update_automation,
            database::db_delete_automation,
            // Database commands – automation runs
            database::db_list_automation_runs,
            database::db_list_running_automation_runs,
            database::db_create_automation_run,
            database::db_update_automation_run,
            // Database commands – Claude sessions
            database::db_create_claude_session,
            database::db_list_claude_sessions,
            database::db_get_claude_session,
            database::db_update_claude_session,
            database::db_delete_claude_session,
            // Database commands – Claude messages
            database::db_add_claude_message,
            database::db_get_claude_messages,
            database::db_delete_claude_message,
            // Database commands – scheduling helpers
            database::compute_next_run,
            database::compute_retry_delay,
            // Database commands – usage & analytics
            database::db_get_usage_summary,
            database::db_get_usage_trends,
            database::db_get_provider_stats,
            database::db_get_model_stats,
            database::db_get_request_logs,
            database::db_get_request_detail,
            // Database commands – model pricing
            database::db_list_model_pricing,
            database::db_upsert_model_pricing,
            database::db_delete_model_pricing,
            // Database commands – generic raw SQL (Kanban)
            database::db_raw_execute,
            database::db_raw_select,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                cleanup_codex_server();
            }
        });
}
