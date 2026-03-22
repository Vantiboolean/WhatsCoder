//! Spawns the Claude Code CLI with `--output-format stream-json` and forwards parsed stdout lines to the webview as Tauri events.
//! Windows uses a prompt temp file instead of a pipe when needed; at most one CLI stream runs at a time (`IS_STREAMING`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{create_dir_all, remove_file, File, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Command as StdCommand, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{timeout, Duration};

static ABORT_FLAG: LazyLock<Arc<Mutex<bool>>> = LazyLock::new(|| Arc::new(Mutex::new(false)));
static IS_STREAMING: LazyLock<Arc<Mutex<bool>>> = LazyLock::new(|| Arc::new(Mutex::new(false)));
static ACTIVE_CLAUDE_PROCESS: LazyLock<Arc<AsyncMutex<Option<Child>>>> =
    LazyLock::new(|| Arc::new(AsyncMutex::new(None)));

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct ClaudeSendConfig {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub history: Vec<ChatMessage>,
    pub system_prompt: Option<String>,
    pub session_id: String,
    pub claude_session_id: Option<String>,
    pub working_directory: Option<String>,
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// Payload for `claude-stream-chunk`: `event_type` is UI-facing (`text`, `thinking`, `tool_use_start`, `tool_result`, …).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StreamChunkPayload {
    pub session_id: String,
    pub event_type: String,
    pub data: String,
}

/// Emitted as `claude-stream-done` when the CLI exits cleanly (includes usage and session id for resume).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StreamDonePayload {
    pub session_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub model: String,
    pub stop_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
}

/// Emitted as `claude-stream-error` when `claude_send_message` returns `Err`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StreamErrorPayload {
    pub session_id: String,
    pub error: String,
}

struct ClaudeCliModelConfig {
    cli_model: Option<String>,
    context_1m: bool,
}

struct ClaudeRunOutcome {
    input_tokens: u64,
    output_tokens: u64,
    model: String,
    stop_reason: String,
    claude_session_id: Option<String>,
}

struct ClaudeRunError {
    message: String,
    can_retry_without_resume: bool,
}

struct ClaudeLaunchConfig {
    program: String,
    prefix_args: Vec<String>,
}

struct PromptTempFileGuard(Option<PathBuf>);

impl PromptTempFileGuard {
    fn new(path: Option<PathBuf>) -> Self {
        Self(path)
    }

    fn kind(&self) -> &'static str {
        if self.0.is_some() {
            "temp-file"
        } else {
            "pipe"
        }
    }
}

impl Drop for PromptTempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = remove_file(path);
        }
    }
}

fn claude_debug_log_path() -> Option<PathBuf> {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .ok()
        .or_else(dirs_next::data_dir)?;
    Some(base.join("com.whats-coder.desktop").join("claude-debug.log"))
}

fn write_claude_debug_log(stage: &str, detail: impl AsRef<str>) {
    let Some(path) = claude_debug_log_path() else {
        return;
    };

    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{ts}] {stage}: {}", detail.as_ref());
    }
}

/// Guards with `IS_STREAMING` so a second invoke fails fast; always clears the flag and emits `claude-stream-error` on failure.
#[tauri::command]
pub async fn claude_send_message(app: AppHandle, config: ClaudeSendConfig) -> Result<(), String> {
    {
        let mut streaming = IS_STREAMING.lock().map_err(|e| e.to_string())?;
        if *streaming {
            return Err("A Claude request is already in progress".to_string());
        }
        *streaming = true;
    }

    if let Ok(mut flag) = ABORT_FLAG.lock() {
        *flag = false;
    }

    let session_id = config.session_id.clone();
    let result = stream_claude_response(app.clone(), config).await;

    {
        let mut streaming = IS_STREAMING.lock().map_err(|e| e.to_string())?;
        *streaming = false;
    }

    if let Err(e) = &result {
        let _ = app.emit(
            "claude-stream-error",
            StreamErrorPayload {
                session_id,
                error: e.clone(),
            },
        );
    }

    result
}

/// Sets the abort flag and kills the active CLI child so stdout draining stops promptly.
#[tauri::command]
pub async fn claude_interrupt() -> Result<(), String> {
    if let Ok(mut flag) = ABORT_FLAG.lock() {
        *flag = true;
    }

    let mut active = ACTIVE_CLAUDE_PROCESS.lock().await;
    if let Some(child) = active.as_mut() {
        let _ = child.kill().await;
    }

    Ok(())
}

/// On success emits `claude-stream-done` with usage; if resume fails before any output, retries once **without** `--resume` (stale session file).
async fn stream_claude_response(app: AppHandle, config: ClaudeSendConfig) -> Result<(), String> {
    let resume_requested = config
        .claude_session_id
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    let working_directory_exists = config
        .working_directory
        .as_deref()
        .map(|value| PathBuf::from(value).exists())
        .unwrap_or(true);
    let allow_resume = resume_requested && working_directory_exists;

    write_claude_debug_log(
        "stream_claude_response:start",
        format!(
            "desktop_session_id={} selected_model={} working_directory={:?} allow_resume={} resume_requested={}",
            config.session_id,
            config.model,
            config.working_directory,
            allow_resume,
            resume_requested
        ),
    );

    let outcome = match run_claude_stream(app.clone(), &config, allow_resume).await {
        Ok(result) => result,
        Err(error) if error.can_retry_without_resume => {
            write_claude_debug_log(
                "stream_claude_response:retry_without_resume",
                format!("desktop_session_id={} message={}", config.session_id, error.message),
            );
            run_claude_stream(app.clone(), &config, false)
                .await
                .map_err(|retry_error| retry_error.message)?
        }
        Err(error) => {
            write_claude_debug_log(
                "stream_claude_response:error",
                format!("desktop_session_id={} message={}", config.session_id, error.message),
            );
            return Err(error.message);
        }
    };

    write_claude_debug_log(
        "stream_claude_response:done",
        format!(
            "desktop_session_id={} model={} stop_reason={} claude_session_id={:?}",
            config.session_id, outcome.model, outcome.stop_reason, outcome.claude_session_id
        ),
    );

    let _ = app.emit(
        "claude-stream-done",
        StreamDonePayload {
            session_id: config.session_id,
            input_tokens: outcome.input_tokens,
            output_tokens: outcome.output_tokens,
            model: outcome.model,
            stop_reason: outcome.stop_reason,
            claude_session_id: outcome.claude_session_id,
        },
    );

    Ok(())
}

/// Parses NDJSON lines; first stdout line is waited with a **15s** timeout to catch hung spawns. Nested `stream_event` types become `claude-stream-chunk`.
async fn run_claude_stream(
    app: AppHandle,
    config: &ClaudeSendConfig,
    allow_resume: bool,
) -> Result<ClaudeRunOutcome, ClaudeRunError> {
    let final_prompt = if allow_resume {
        config.prompt.clone()
    } else {
        build_prompt_with_history(&config.prompt, &config.history)
    };
    let model_config = resolve_claude_cli_model(&config.model);
    let binary = find_claude_binary();
    let launch = build_claude_launch_config(&binary);
    let env = build_claude_env(&config.env);
    let (stdin_stdio, prompt_transport) = build_prompt_stdin(&final_prompt)?;

    write_claude_debug_log(
        "run_claude_stream:prepare",
        format!(
            "desktop_session_id={} allow_resume={} binary={} launch_program={} prefix_args={:?} cli_model={:?} context_1m={} prompt_len={} prompt_transport={} env_summary={{home:{},userprofile:{},appdata:{},localappdata:{},comspec:{},systemroot:{},windir:{},gitbash:{}}}",
            config.session_id,
            allow_resume,
            binary,
            launch.program,
            launch.prefix_args,
            model_config.cli_model,
            model_config.context_1m,
            final_prompt.len(),
            prompt_transport.kind(),
            env.contains_key("HOME"),
            env.contains_key("USERPROFILE"),
            env.contains_key("APPDATA"),
            env.contains_key("LOCALAPPDATA"),
            env.contains_key("COMSPEC"),
            env.contains_key("SystemRoot"),
            env.contains_key("WINDIR"),
            env.contains_key("CLAUDE_CODE_GIT_BASH_PATH")
        ),
    );

    let mut command = tokio::process::Command::new(&launch.program);
    command
        .args(&launch.prefix_args)
        .arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg(
            config
                .permission_mode
                .clone()
                .unwrap_or_else(|| "acceptEdits".to_string()),
        )
        .stdin(stdin_stdio)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    if let Some(cli_model) = model_config.cli_model.as_deref() {
        if !cli_model.trim().is_empty() {
            command.arg("--model").arg(cli_model.trim());
        }
    }

    if model_config.context_1m {
        command.arg("--betas").arg("context-1m-2025-08-07");
    }

    if let Some(system_prompt) = config.system_prompt.as_deref() {
        if !system_prompt.trim().is_empty() {
            command
                .arg("--append-system-prompt")
                .arg(system_prompt.trim());
        }
    }

    if allow_resume {
        if let Some(claude_session_id) = config.claude_session_id.as_deref() {
            if !claude_session_id.trim().is_empty() {
                command.arg("--resume").arg(claude_session_id.trim());
            }
        }
    }

    if let Some(working_directory) = config.working_directory.as_deref() {
        let path = PathBuf::from(working_directory);
        if path.exists() {
            command.current_dir(path);
        }
    }

    command.env_clear().envs(env);

    let mut child = command.spawn().map_err(|e| ClaudeRunError {
        message: format!("Failed to start Claude Code: {e}"),
        can_retry_without_resume: false,
    })?;

    write_claude_debug_log(
        "run_claude_stream:spawned",
        format!(
            "desktop_session_id={} child_id={:?}",
            config.session_id,
            child.id()
        ),
    );

    let stdout = child.stdout.take().ok_or_else(|| ClaudeRunError {
        message: "Failed to open Claude Code stdout".to_string(),
        can_retry_without_resume: false,
    })?;
    let stderr = child.stderr.take().ok_or_else(|| ClaudeRunError {
        message: "Failed to open Claude Code stderr".to_string(),
        can_retry_without_resume: false,
    })?;

    if prompt_transport.0.is_none() {
        let mut stdin = child.stdin.take().ok_or_else(|| ClaudeRunError {
            message: "Failed to open Claude Code stdin".to_string(),
            can_retry_without_resume: false,
        })?;
        stdin
            .write_all(final_prompt.as_bytes())
            .await
            .map_err(|e| ClaudeRunError {
                message: format!("Failed to write prompt to Claude Code: {e}"),
                can_retry_without_resume: false,
            })?;
        stdin.write_all(b"\n").await.map_err(|e| ClaudeRunError {
            message: format!("Failed to finalize prompt for Claude Code: {e}"),
            can_retry_without_resume: false,
        })?;
        let _ = stdin.shutdown().await;
    }

    {
        let mut active = ACTIVE_CLAUDE_PROCESS.lock().await;
        *active = Some(child);
    }

    let desktop_session_id = config.session_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut output = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            write_claude_debug_log(
                "run_claude_stream:stderr_line",
                format!("desktop_session_id={} line={}", desktop_session_id, trimmed),
            );
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(trimmed);
        }
        output
    });

    let mut reader = BufReader::new(stdout).lines();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut stop_reason = String::from("end_turn");
    let mut response_model = config.model.clone();
    let mut claude_session_id = if allow_resume {
        config.claude_session_id.clone()
    } else {
        None
    };
    let mut final_error: Option<String> = None;
    let mut observed_response_activity = false;

    let mut saw_first_output = false;

    loop {
        let next_line = if saw_first_output {
            reader.next_line().await
        } else {
            match timeout(Duration::from_secs(15), reader.next_line()).await {
                Ok(result) => result,
                Err(_) => {
                    write_claude_debug_log(
                        "run_claude_stream:first_output_timeout",
                        format!("desktop_session_id={}", config.session_id),
                    );
                    let mut active = ACTIVE_CLAUDE_PROCESS.lock().await;
                    if let Some(child) = active.as_mut() {
                        let _ = child.kill().await;
                    }
                    return Err(ClaudeRunError {
                        message: "Claude Code produced no output within 15 seconds".to_string(),
                        can_retry_without_resume: false,
                    });
                }
            }
        };

        let Some(line) = next_line.map_err(|e| ClaudeRunError {
            message: format!("Failed reading Claude Code output: {e}"),
            can_retry_without_resume: false,
        })? else {
            break;
        };

        saw_first_output = true;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let preview = if trimmed.len() > 240 {
            format!("{}...", &trimmed[..240])
        } else {
            trimmed.to_string()
        };
        write_claude_debug_log(
            "run_claude_stream:stdout_line",
            format!("desktop_session_id={} line={}", config.session_id, preview),
        );

        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => {
                write_claude_debug_log(
                    "run_claude_stream:stdout_parse_error",
                    format!("desktop_session_id={} raw={}", config.session_id, preview),
                );
                continue;
            }
        };

        process_stream_json_event(
            &app,
            &config.session_id,
            &parsed,
            &mut claude_session_id,
            &mut response_model,
            &mut input_tokens,
            &mut output_tokens,
            &mut stop_reason,
            &mut final_error,
            &mut observed_response_activity,
        );
    }

    let interrupted = ABORT_FLAG.lock().map(|flag| *flag).unwrap_or(false);
    let stderr_output = stderr_task.await.unwrap_or_default();
    let status = {
        let mut active = ACTIVE_CLAUDE_PROCESS.lock().await;
        if let Some(mut child) = active.take() {
            child.wait().await.map_err(|e| ClaudeRunError {
                message: format!("Failed to wait for Claude Code: {e}"),
                can_retry_without_resume: false,
            })?
        } else {
            return Err(ClaudeRunError {
                message: "Claude Code process handle was lost".to_string(),
                can_retry_without_resume: false,
            });
        }
    };

    if interrupted {
        write_claude_debug_log(
            "run_claude_stream:interrupted",
            format!("desktop_session_id={}", config.session_id),
        );
        return Ok(ClaudeRunOutcome {
            input_tokens,
            output_tokens,
            model: response_model,
            stop_reason: "interrupted".to_string(),
            claude_session_id,
        });
    }

    if let Some(error) = final_error {
        write_claude_debug_log(
            "run_claude_stream:final_error",
            format!("desktop_session_id={} error={}", config.session_id, error),
        );
        return Err(ClaudeRunError {
            message: error,
            can_retry_without_resume: allow_resume && !observed_response_activity,
        });
    }

    if !status.success() {
        let mut message = format!("Claude Code exited with status {}", status);
        if !stderr_output.trim().is_empty() {
            message.push_str(": ");
            message.push_str(stderr_output.trim());
        }
        write_claude_debug_log(
            "run_claude_stream:status_error",
            format!("desktop_session_id={} message={}", config.session_id, message),
        );
        return Err(ClaudeRunError {
            message,
            can_retry_without_resume: allow_resume && !observed_response_activity,
        });
    }

    write_claude_debug_log(
        "run_claude_stream:success",
        format!(
            "desktop_session_id={} model={} stop_reason={} claude_session_id={:?} input_tokens={} output_tokens={}",
            config.session_id, response_model, stop_reason, claude_session_id, input_tokens, output_tokens
        ),
    );

    Ok(ClaudeRunOutcome {
        input_tokens,
        output_tokens,
        model: response_model,
        stop_reason,
        claude_session_id,
    })
}

/// Dispatches each stdout JSON object's top-level `type` (`system`, `stream_event`, `user`, `result`).
fn process_stream_json_event(
    app: &AppHandle,
    desktop_session_id: &str,
    event: &Value,
    claude_session_id: &mut Option<String>,
    response_model: &mut String,
    input_tokens: &mut u64,
    output_tokens: &mut u64,
    stop_reason: &mut String,
    final_error: &mut Option<String>,
    observed_response_activity: &mut bool,
) {
    write_claude_debug_log(
        "process_stream_json_event",
        format!(
            "desktop_session_id={} event_type={}",
            desktop_session_id,
            event["type"].as_str().unwrap_or_default()
        ),
    );

    match event["type"].as_str().unwrap_or_default() {
        "system" => {
            if let Some(session_id) = event["session_id"].as_str() {
                *claude_session_id = Some(session_id.to_string());
            }
            if let Some(model) = event["model"].as_str() {
                *response_model = model.to_string();
            }
        }
        "stream_event" => process_stream_event(
            app,
            desktop_session_id,
            &event["event"],
            response_model,
            input_tokens,
            output_tokens,
            stop_reason,
            observed_response_activity,
        ),
        "user" => process_user_event(app, desktop_session_id, event, observed_response_activity),
        "result" => {
            if let Some(session_id) = event["session_id"].as_str() {
                *claude_session_id = Some(session_id.to_string());
            }
            if let Some(reason) = event["stop_reason"].as_str() {
                *stop_reason = reason.to_string();
            }
            if let Some(usage) = event.get("usage") {
                if let Some(tokens) = usage["input_tokens"].as_u64() {
                    *input_tokens = tokens;
                }
                if let Some(tokens) = usage["output_tokens"].as_u64() {
                    *output_tokens = tokens;
                }
            }

            if let Some(model_usage) = event["modelUsage"].as_object() {
                if let Some((model_name, _)) = model_usage.iter().next() {
                    *response_model = model_name.clone();
                }
            }

            if event["is_error"].as_bool().unwrap_or(false) {
                let message = event["result"]
                    .as_str()
                    .or_else(|| event["subtype"].as_str())
                    .unwrap_or("Claude Code returned an error")
                    .to_string();
                *final_error = Some(message);
            }
        }
        _ => {}
    }
}

/// Handles nested `stream_event.type` values (`message_start`, `content_block_delta`, …) and emits token/text deltas.
fn process_stream_event(
    app: &AppHandle,
    desktop_session_id: &str,
    event: &Value,
    response_model: &mut String,
    input_tokens: &mut u64,
    output_tokens: &mut u64,
    stop_reason: &mut String,
    observed_response_activity: &mut bool,
) {
    match event["type"].as_str().unwrap_or_default() {
        "message_start" => {
            if let Some(message) = event.get("message") {
                if let Some(model) = message["model"].as_str() {
                    *response_model = model.to_string();
                }
                if let Some(usage) = message.get("usage") {
                    if let Some(tokens) = usage["input_tokens"].as_u64() {
                        *input_tokens = tokens;
                    }
                }
            }
        }
        "content_block_start" => {
            if event["content_block"]["type"].as_str() == Some("tool_use") {
                *observed_response_activity = true;
                let tool_data = serde_json::json!({
                    "id": event["content_block"]["id"],
                    "name": event["content_block"]["name"],
                    "input": event["content_block"]["input"],
                });
                let _ = app.emit(
                    "claude-stream-chunk",
                    StreamChunkPayload {
                        session_id: desktop_session_id.to_string(),
                        event_type: "tool_use_start".to_string(),
                        data: tool_data.to_string(),
                    },
                );
            }
        }
        "content_block_delta" => {
            if let Some(delta_type) = event["delta"]["type"].as_str() {
                match delta_type {
                    "text_delta" => {
                        if let Some(text) = event["delta"]["text"].as_str() {
                            *observed_response_activity = true;
                            let _ = app.emit(
                                "claude-stream-chunk",
                                StreamChunkPayload {
                                    session_id: desktop_session_id.to_string(),
                                    event_type: "text".to_string(),
                                    data: text.to_string(),
                                },
                            );
                        }
                    }
                    "thinking_delta" => {
                        if let Some(thinking) = event["delta"]["thinking"].as_str() {
                            *observed_response_activity = true;
                            let _ = app.emit(
                                "claude-stream-chunk",
                                StreamChunkPayload {
                                    session_id: desktop_session_id.to_string(),
                                    event_type: "thinking".to_string(),
                                    data: thinking.to_string(),
                                },
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
        "message_delta" => {
            if let Some(reason) = event["delta"]["stop_reason"].as_str() {
                *stop_reason = reason.to_string();
            }
            if let Some(usage) = event.get("usage") {
                if let Some(tokens) = usage["output_tokens"].as_u64() {
                    *output_tokens = tokens;
                }
            }
        }
        _ => {}
    }
}

/// Forwards `tool_result` entries from `type: user` stdout records so the UI can show tool outcomes.
fn process_user_event(
    app: &AppHandle,
    desktop_session_id: &str,
    event: &Value,
    observed_response_activity: &mut bool,
) {
    let Some(content) = event["message"]["content"].as_array() else {
        return;
    };

    for block in content {
        if block["type"].as_str() != Some("tool_result") {
            continue;
        }

        *observed_response_activity = true;
        let payload = serde_json::json!({
            "tool_use_id": block["tool_use_id"],
            "content": extract_tool_result_content(block.get("content")),
            "is_error": block["is_error"].as_bool().unwrap_or(false),
        });
        let _ = app.emit(
            "claude-stream-chunk",
            StreamChunkPayload {
                session_id: desktop_session_id.to_string(),
                event_type: "tool_result".to_string(),
                data: payload.to_string(),
            },
        );
    }
}

fn resolve_claude_cli_model(selection_id: &str) -> ClaudeCliModelConfig {
    match selection_id.trim() {
        "" | "claude-default" | "sonnet" | "claude-sonnet-4-20250514" => ClaudeCliModelConfig {
            cli_model: None,
            context_1m: false,
        },
        "claude-sonnet-1m" => ClaudeCliModelConfig {
            cli_model: Some("sonnet".to_string()),
            context_1m: true,
        },
        "claude-opus" | "opus" | "claude-opus-4-20250514" => ClaudeCliModelConfig {
            cli_model: Some("opus".to_string()),
            context_1m: false,
        },
        "claude-opus-1m" => ClaudeCliModelConfig {
            cli_model: Some("opus".to_string()),
            context_1m: true,
        },
        "claude-haiku" | "haiku" | "claude-haiku-4-5-20251001" => ClaudeCliModelConfig {
            cli_model: Some("haiku".to_string()),
            context_1m: false,
        },
        "claude-sonnet-4" | "claude-sonnet-4-0" => ClaudeCliModelConfig {
            cli_model: Some("claude-sonnet-4-0".to_string()),
            context_1m: false,
        },
        other => ClaudeCliModelConfig {
            cli_model: Some(other.to_string()),
            context_1m: false,
        },
    }
}

fn extract_tool_result_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn build_prompt_with_history(prompt: &str, history: &[ChatMessage]) -> String {
    if history.is_empty() {
        return prompt.to_string();
    }

    let mut lines = vec![
        "<conversation_history>".to_string(),
        "This is prior conversation context for continuity.".to_string(),
    ];

    for message in history {
        let label = if message.role == "assistant" {
            "Assistant"
        } else {
            "Human"
        };
        lines.push(format!("{label}: {}", message.content));
    }

    lines.push("</conversation_history>".to_string());
    lines.push(String::new());
    lines.push(prompt.to_string());
    lines.join("\n")
}

fn build_prompt_stdin(prompt: &str) -> Result<(Stdio, PromptTempFileGuard), ClaudeRunError> {
    if cfg!(target_os = "windows") {
        let path = create_prompt_temp_file(prompt)?;
        let file = File::open(&path).map_err(|e| ClaudeRunError {
            message: format!("Failed to reopen Claude prompt temp file: {e}"),
            can_retry_without_resume: false,
        })?;
        return Ok((Stdio::from(file), PromptTempFileGuard::new(Some(path))));
    }

    Ok((Stdio::piped(), PromptTempFileGuard::new(None)))
}

fn create_prompt_temp_file(prompt: &str) -> Result<PathBuf, ClaudeRunError> {
    let mut path = std::env::temp_dir();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    path.push(format!(
        "whats-coder-claude-prompt-{}-{stamp}.txt",
        std::process::id()
    ));

    std::fs::write(&path, format!("{prompt}\n")).map_err(|e| ClaudeRunError {
        message: format!("Failed to create Claude prompt temp file: {e}"),
        can_retry_without_resume: false,
    })?;

    Ok(path)
}

fn build_claude_env(env_overrides: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();

    if let Some(home) = dirs_next::home_dir() {
        let home_str = home.to_string_lossy().to_string();
        env.entry("HOME".to_string())
            .or_insert_with(|| home_str.clone());
        env.entry("USERPROFILE".to_string()).or_insert(home_str);
    }

    env.insert("PATH".to_string(), build_expanded_path());
    env.remove("CLAUDECODE");

    if cfg!(target_os = "windows") {
        env.entry("COMSPEC".to_string())
            .or_insert_with(|| r"C:\Windows\System32\cmd.exe".to_string());
        env.entry("SystemRoot".to_string())
            .or_insert_with(|| r"C:\Windows".to_string());
        env.entry("WINDIR".to_string())
            .or_insert_with(|| r"C:\Windows".to_string());
    }

    if cfg!(target_os = "windows") && !env.contains_key("CLAUDE_CODE_GIT_BASH_PATH") {
        if let Some(git_bash) = find_git_bash() {
            env.insert("CLAUDE_CODE_GIT_BASH_PATH".to_string(), git_bash);
        }
    }

    for (key, value) in env_overrides {
        if !value.is_empty() {
            env.insert(key.clone(), value.clone());
        }
    }

    env
}

fn build_claude_launch_config(binary: &str) -> ClaudeLaunchConfig {
    if is_windows_cmd_wrapper(binary) {
        ClaudeLaunchConfig {
            program: "cmd".to_string(),
            prefix_args: vec!["/C".to_string(), binary.to_string()],
        }
    } else {
        ClaudeLaunchConfig {
            program: binary.to_string(),
            prefix_args: Vec::new(),
        }
    }
}

fn is_windows_cmd_wrapper(binary: &str) -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }

    PathBuf::from(binary)
        .extension()
        .and_then(OsStr::to_str)
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false)
}

fn build_expanded_path() -> String {
    let delimiter = if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    };
    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = current
        .split(delimiter)
        .filter(|part| !part.trim().is_empty())
        .map(|part| part.to_string())
        .collect();
    let mut seen: HashSet<String> = parts.iter().cloned().collect();

    for extra in extra_path_dirs() {
        let extra_str = extra.to_string_lossy().to_string();
        if !extra_str.is_empty() && seen.insert(extra_str.clone()) {
            parts.push(extra_str);
        }
    }

    parts.join(&delimiter.to_string())
}

fn extra_path_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs_next::home_dir() else {
        return Vec::new();
    };

    if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Roaming"));
        let localappdata = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Local"));
        vec![
            home.join(".local").join("bin"),
            home.join(".claude").join("bin"),
            home.join(".bun").join("bin"),
            home.join(".nvm").join("current").join("bin"),
            appdata.join("npm"),
            localappdata.join("npm"),
            home.join(".npm-global").join("bin"),
        ]
    } else {
        vec![
            home.join(".local").join("bin"),
            home.join(".claude").join("bin"),
            home.join(".bun").join("bin"),
            home.join(".nvm").join("current").join("bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            home.join(".npm-global").join("bin"),
        ]
    }
}

fn find_claude_binary() -> String {
    for candidate in claude_candidate_paths() {
        if probe_claude_binary(&candidate) {
            return candidate;
        }
    }

    if cfg!(target_os = "windows") {
        if let Ok(output) = StdCommand::new("where")
            .arg("claude")
            .env("PATH", build_expanded_path())
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for candidate in stdout
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                {
                    if probe_claude_binary(candidate) {
                        return candidate.to_string();
                    }
                }
            }
        }
    } else if let Ok(output) = StdCommand::new("which")
        .arg("claude")
        .env("PATH", build_expanded_path())
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for candidate in stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                if probe_claude_binary(candidate) {
                    return candidate.to_string();
                }
            }
        }
    }

    "claude".to_string()
}

fn probe_claude_binary(candidate: &str) -> bool {
    let launch = build_claude_launch_config(candidate);
    StdCommand::new(&launch.program)
        .args(&launch.prefix_args)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PATH", build_expanded_path())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn claude_candidate_paths() -> Vec<String> {
    let Some(home) = dirs_next::home_dir() else {
        return vec!["claude".to_string()];
    };

    if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Roaming"));
        let localappdata = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home.join("AppData").join("Local"));
        vec![
            home.join(".local").join("bin").join("claude.exe"),
            home.join(".local").join("bin").join("claude.cmd"),
            home.join(".local").join("bin").join("claude.bat"),
            home.join(".claude").join("bin").join("claude.exe"),
            home.join(".claude").join("bin").join("claude.cmd"),
            home.join(".claude").join("bin").join("claude.bat"),
            home.join(".bun").join("bin").join("claude.exe"),
            home.join(".bun").join("bin").join("claude.cmd"),
            home.join(".nvm")
                .join("current")
                .join("bin")
                .join("claude.exe"),
            home.join(".nvm")
                .join("current")
                .join("bin")
                .join("claude.cmd"),
            home.join(".nvm")
                .join("current")
                .join("bin")
                .join("claude.bat"),
            appdata.join("npm").join("claude.cmd"),
            appdata.join("npm").join("claude.exe"),
            appdata.join("npm").join("claude.bat"),
            localappdata.join("npm").join("claude.cmd"),
            localappdata.join("npm").join("claude.exe"),
            localappdata.join("npm").join("claude.bat"),
            home.join(".npm-global").join("bin").join("claude.cmd"),
            home.join(".npm-global").join("bin").join("claude.exe"),
            home.join(".npm-global").join("bin").join("claude.bat"),
        ]
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
    } else {
        vec![
            home.join(".local").join("bin").join("claude"),
            home.join(".claude").join("bin").join("claude"),
            home.join(".bun").join("bin").join("claude"),
            home.join(".nvm").join("current").join("bin").join("claude"),
            PathBuf::from("/usr/local/bin/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/bin/claude"),
            PathBuf::from("/bin/claude"),
            home.join(".npm-global").join("bin").join("claude"),
        ]
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
    }
}

fn find_git_bash() -> Option<String> {
    if !cfg!(target_os = "windows") {
        return None;
    }

    if let Ok(env_path) = std::env::var("CLAUDE_CODE_GIT_BASH_PATH") {
        if PathBuf::from(&env_path).exists() {
            return Some(env_path);
        }
    }

    let common_paths = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for path in common_paths {
        if PathBuf::from(path).exists() {
            return Some(path.to_string());
        }
    }

    if let Ok(output) = StdCommand::new("where")
        .arg("git")
        .env("PATH", build_expanded_path())
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for git_exe in stdout
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                let git_path = PathBuf::from(git_exe);
                if let Some(git_dir) = git_path.parent().and_then(|parent| parent.parent()) {
                    let bash_path = git_dir.join("bin").join("bash.exe");
                    if bash_path.exists() {
                        return Some(bash_path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    None
}
