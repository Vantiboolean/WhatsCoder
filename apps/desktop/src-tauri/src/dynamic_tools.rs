//! Tauri commands wired as **model-invokable** filesystem tools: read slices of text files, shallow
//! directory listing, and bounded recursive search. Defaults cap payload size and skip vendor/build
//! trees so large repos cannot exhaust memory or context windows in one call.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Default bytes returned for `tool_read_file` when the frontend does not pass a cap.
const DEFAULT_READ_MAX_BYTES: usize = 32_768;
/// Max entries returned from `tool_list_directory` before `truncated` is set.
const DEFAULT_LIST_LIMIT: usize = 200;
/// Default max lines/hits returned from `tool_search_in_files`.
const DEFAULT_SEARCH_RESULTS: usize = 40;
/// Files larger than this are skipped in search (still increments scan count) to avoid reading huge blobs.
const MAX_SEARCH_FILE_BYTES: u64 = 256 * 1024;
/// Hard stop on walk breadth: worst-case work is bounded even on deep monorepos.
const MAX_SCANNED_FILES: usize = 800;

/// Pruned from list and search alongside any dot-prefixed directory name.
const SKIPPED_DIRS: [&str; 8] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".next",
    ".nuxt",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolReadFileResult {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolListDirectoryResult {
    pub path: String,
    pub entries: Vec<ToolDirectoryEntry>,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSearchMatch {
    pub path: String,
    pub line_number: usize,
    pub line_text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSearchInFilesResult {
    pub root_path: String,
    pub matches: Vec<ToolSearchMatch>,
    pub scanned_files: usize,
    pub truncated: bool,
}

fn should_skip_dir_name(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.contains(&name)
}

fn resolve_path(cwd: Option<&str>, path: Option<&str>) -> Result<PathBuf, String> {
    let candidate = path.unwrap_or(".");
    let raw = PathBuf::from(candidate);
    let joined = if raw.is_absolute() {
        raw
    } else if let Some(base) = cwd {
        PathBuf::from(base).join(raw)
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to resolve current directory: {e}"))?
            .join(raw)
    };

    match joined.canonicalize() {
        Ok(path) => Ok(path),
        Err(_) => Ok(joined),
    }
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8_192).any(|byte| *byte == 0)
}

fn read_text_file(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read file: {e}"))?;
    if is_binary(&bytes) {
        return Err("Binary files are not supported by this tool".to_string());
    }
    Ok(bytes)
}

#[tauri::command]
pub fn tool_read_file(
    cwd: Option<String>,
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_bytes: Option<usize>,
) -> Result<ToolReadFileResult, String> {
    let resolved = resolve_path(cwd.as_deref(), Some(&path))?;
    if !resolved.exists() {
        return Err(format!(
            "Path does not exist: {}",
            resolved.to_string_lossy()
        ));
    }
    if !resolved.is_file() {
        return Err(format!(
            "Path is not a file: {}",
            resolved.to_string_lossy()
        ));
    }

    let bytes = read_text_file(&resolved)?;
    let cap = max_bytes.unwrap_or(DEFAULT_READ_MAX_BYTES).max(1);
    let truncated = bytes.len() > cap;
    let slice = if truncated { &bytes[..cap] } else { &bytes[..] };
    let text = String::from_utf8_lossy(slice).to_string();
    let normalized = text.replace("\r\n", "\n");
    let all_lines: Vec<&str> = normalized.split('\n').collect();
    let total_lines = all_lines.len().max(1);

    let start = start_line.unwrap_or(1).max(1);
    let requested_end = end_line.unwrap_or(total_lines).max(start);
    let start_index = start.saturating_sub(1).min(total_lines.saturating_sub(1));
    let end_index = requested_end.min(total_lines);
    let selected = all_lines[start_index..end_index].join("\n");
    let actual_end_line = start_index + selected.split('\n').count().max(1) - 1;

    Ok(ToolReadFileResult {
        path: resolved.to_string_lossy().to_string(),
        content: selected,
        truncated,
        start_line: start_index + 1,
        end_line: actual_end_line,
        total_lines,
    })
}

#[tauri::command]
pub fn tool_list_directory(
    cwd: Option<String>,
    path: Option<String>,
    limit: Option<usize>,
) -> Result<ToolListDirectoryResult, String> {
    let resolved = resolve_path(cwd.as_deref(), path.as_deref())?;
    if !resolved.exists() {
        return Err(format!(
            "Path does not exist: {}",
            resolved.to_string_lossy()
        ));
    }
    if !resolved.is_dir() {
        return Err(format!(
            "Path is not a directory: {}",
            resolved.to_string_lossy()
        ));
    }

    let read_dir = fs::read_dir(&resolved).map_err(|e| format!("Failed to read directory: {e}"))?;
    let cap = limit.unwrap_or(DEFAULT_LIST_LIMIT).max(1);
    let mut entries = Vec::new();

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_dir_name(&name) {
            continue;
        }

        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let metadata = entry.metadata().ok();
        entries.push(ToolDirectoryEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_directory: file_type.is_dir(),
            size: metadata.as_ref().map(|value| value.len()).unwrap_or(0),
        });
    }

    entries.sort_by(
        |left, right| match (left.is_directory, right.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        },
    );
    let truncated = entries.len() > cap;
    if truncated {
        entries.truncate(cap);
    }

    Ok(ToolListDirectoryResult {
        path: resolved.to_string_lossy().to_string(),
        entries,
        truncated,
    })
}

fn search_file_for_query(
    path: &Path,
    query: &str,
    case_sensitive: bool,
    matches: &mut Vec<ToolSearchMatch>,
    max_results: usize,
) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to read metadata: {e}"))?;
    if metadata.len() > MAX_SEARCH_FILE_BYTES {
        return Ok(());
    }

    let bytes = read_text_file(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let query_lower = (!case_sensitive).then(|| query.to_lowercase());

    for (index, line) in text.lines().enumerate() {
        let is_match = if case_sensitive {
            line.contains(query)
        } else if let Some(query_value) = query_lower.as_ref() {
            line.to_lowercase().contains(query_value)
        } else {
            false
        };

        if !is_match {
            continue;
        }

        matches.push(ToolSearchMatch {
            path: path.to_string_lossy().to_string(),
            line_number: index + 1,
            line_text: line.trim().to_string(),
        });

        if matches.len() >= max_results {
            break;
        }
    }

    Ok(())
}

fn walk_and_search(
    path: &Path,
    query: &str,
    case_sensitive: bool,
    matches: &mut Vec<ToolSearchMatch>,
    scanned_files: &mut usize,
    max_results: usize,
    truncated: &mut bool,
) -> Result<(), String> {
    if matches.len() >= max_results || *scanned_files >= MAX_SCANNED_FILES {
        *truncated = true;
        return Ok(());
    }

    if path.is_file() {
        *scanned_files += 1;
        search_file_for_query(path, query, case_sensitive, matches, max_results)?;
        if matches.len() >= max_results {
            *truncated = true;
        }
        return Ok(());
    }

    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {e}"))?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            if should_skip_dir_name(&name) {
                continue;
            }
            walk_and_search(
                &entry_path,
                query,
                case_sensitive,
                matches,
                scanned_files,
                max_results,
                truncated,
            )?;
        } else if file_type.is_file() {
            *scanned_files += 1;
            search_file_for_query(&entry_path, query, case_sensitive, matches, max_results)?;
        }

        if matches.len() >= max_results || *scanned_files >= MAX_SCANNED_FILES {
            *truncated = true;
            break;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn tool_search_in_files(
    cwd: Option<String>,
    path: Option<String>,
    query: String,
    max_results: Option<usize>,
    case_sensitive: Option<bool>,
) -> Result<ToolSearchInFilesResult, String> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }

    let resolved = resolve_path(cwd.as_deref(), path.as_deref())?;
    if !resolved.exists() {
        return Err(format!(
            "Path does not exist: {}",
            resolved.to_string_lossy()
        ));
    }

    let cap = max_results.unwrap_or(DEFAULT_SEARCH_RESULTS).max(1);
    let mut matches = Vec::new();
    let mut scanned_files = 0usize;
    let mut truncated = false;

    walk_and_search(
        &resolved,
        trimmed_query,
        case_sensitive.unwrap_or(false),
        &mut matches,
        &mut scanned_files,
        cap,
        &mut truncated,
    )?;

    Ok(ToolSearchInFilesResult {
        root_path: resolved.to_string_lossy().to_string(),
        matches,
        scanned_files,
        truncated,
    })
}
