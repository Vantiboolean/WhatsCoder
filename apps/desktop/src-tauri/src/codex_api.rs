//! Codex Responses API (HTTP SSE) bridge.
//! POSTs to `https://chatgpt.com/backend-api/codex/responses` with OAuth Bearer token,
//! parses the SSE stream, and forwards events to the webview as Tauri events.
//! At most one stream runs at a time (`CODEX_IS_STREAMING`).

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};

const CODEX_API_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_DEFAULT_MODEL: &str = "codex-mini-latest";

// ── Global state ──────────────────────────────────────────────────

static CODEX_ABORT_FLAG: LazyLock<Arc<Mutex<bool>>> =
    LazyLock::new(|| Arc::new(Mutex::new(false)));
static CODEX_IS_STREAMING: LazyLock<Arc<Mutex<bool>>> =
    LazyLock::new(|| Arc::new(Mutex::new(false)));

// ── Input / config types ──────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodexChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct CodexSendConfig {
    /// Display / storage model id — resolved to a Codex model name internally.
    #[serde(default)]
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub history: Vec<CodexChatMessage>,
    /// Desktop-side session UUID (used as Tauri event correlation id).
    pub session_id: String,
    /// `response.id` from the previous turn — used to continue a conversation.
    pub previous_response_id: Option<String>,
}

// ── Event payload types (mirror claude_api for frontend symmetry) ──

#[derive(Debug, Serialize, Clone)]
pub struct CodexStreamChunkPayload {
    pub session_id: String,
    pub event_type: String,
    pub data: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexStreamDonePayload {
    pub session_id: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub model: String,
    pub stop_reason: String,
    pub response_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CodexStreamErrorPayload {
    pub session_id: String,
    pub error: String,
}

// ── Tauri commands ────────────────────────────────────────────────

/// Start a Codex streaming turn. Guards with `CODEX_IS_STREAMING` so a second
/// concurrent invoke fails fast. Emits `codex-stream-error` on failure.
#[tauri::command]
pub async fn codex_send_message(
    app: AppHandle,
    config: CodexSendConfig,
) -> Result<(), String> {
    {
        let mut streaming = CODEX_IS_STREAMING.lock().map_err(|e| e.to_string())?;
        if *streaming {
            return Err("A Codex request is already in progress".to_string());
        }
        *streaming = true;
    }

    if let Ok(mut flag) = CODEX_ABORT_FLAG.lock() {
        *flag = false;
    }

    let session_id = config.session_id.clone();
    let result = stream_codex_response(app.clone(), config).await;

    {
        let mut streaming = CODEX_IS_STREAMING.lock().map_err(|e| e.to_string())?;
        *streaming = false;
    }

    if let Err(ref e) = result {
        if e.starts_with("Codex auth error:") {
            let _ = app.emit("codex-auth-complete", crate::codex_oauth::get_auth_status());
        }
        let _ = app.emit(
            "codex-stream-error",
            CodexStreamErrorPayload {
                session_id,
                error: e.clone(),
            },
        );
    }

    result
}

/// Set the abort flag so the streaming loop exits after the current chunk.
#[tauri::command]
pub fn codex_abort_message() -> Result<(), String> {
    if let Ok(mut flag) = CODEX_ABORT_FLAG.lock() {
        *flag = true;
    }
    Ok(())
}

// ── Core streaming logic ──────────────────────────────────────────

async fn stream_codex_response(app: AppHandle, config: CodexSendConfig) -> Result<(), String> {
    // 1. Get a valid OAuth token (refreshes automatically if near expiry).
    let access_token = crate::codex_oauth::get_valid_access_token()
        .await
        .map_err(|e| format!("Codex auth error: {e}"))?;
    let account_id = crate::codex_oauth::get_account_id();

    // 2. Build the request body.
    let body = build_request_body(&config);

    // 3. POST with SSE headers.
    let client = reqwest::Client::new();
    let mut req = client
        .post(CODEX_API_ENDPOINT)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json")
        .json(&body);

    if let Some(ref aid) = account_id {
        req = req.header("chatgpt-account-id", aid.as_str());
    }

    let response = req.send().await.map_err(|e| format!("Codex HTTP error: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let msg = parse_api_error(&text).unwrap_or_else(|| text.clone());
        return Err(format!("Codex API error {status}: {msg}"));
    }

    // 4. Parse SSE stream.
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut response_model = resolve_model_name(&config.model);
    let mut stop_reason = "end_turn".to_string();
    let mut response_id: Option<String> = None;

    while let Some(chunk_result) = stream.next().await {
        if CODEX_ABORT_FLAG.lock().map(|f| *f).unwrap_or(false) {
            stop_reason = "interrupted".to_string();
            break;
        }

        let chunk = chunk_result.map_err(|e| format!("Stream read error: {e}"))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        // Process complete SSE events (separated by "\n\n").
        while let Some(event_end) = buffer.find("\n\n") {
            let event_block = buffer[..event_end].to_string();
            buffer.drain(..event_end + 2);

            process_sse_event(
                &app,
                &config.session_id,
                &event_block,
                &mut response_id,
                &mut response_model,
                &mut input_tokens,
                &mut output_tokens,
                &mut stop_reason,
            );
        }
    }

    // Emit done.
    let _ = app.emit(
        "codex-stream-done",
        CodexStreamDonePayload {
            session_id: config.session_id,
            input_tokens,
            output_tokens,
            model: response_model,
            stop_reason,
            response_id,
        },
    );

    Ok(())
}

// ── SSE event processing ──────────────────────────────────────────

fn process_sse_event(
    app: &AppHandle,
    session_id: &str,
    event_block: &str,
    response_id: &mut Option<String>,
    response_model: &mut String,
    input_tokens: &mut u64,
    output_tokens: &mut u64,
    stop_reason: &mut String,
) {
    // Parse SSE lines: "event: <type>" and "data: <json>"
    let mut event_type = String::new();
    let mut data_lines: Vec<&str> = Vec::new();

    for line in event_block.lines() {
        if let Some(t) = line.strip_prefix("event: ") {
            event_type = t.trim().to_string();
        } else if let Some(d) = line.strip_prefix("data: ") {
            data_lines.push(d);
        }
    }

    if data_lines.is_empty() {
        return;
    }

    let data_str = data_lines.join("");
    if data_str == "[DONE]" {
        return;
    }

    let parsed: Value = match serde_json::from_str(&data_str) {
        Ok(v) => v,
        Err(_) => return,
    };

    // Determine event type from `event:` line or `type` field in payload.
    let ev = if event_type.is_empty() {
        parsed["type"].as_str().unwrap_or("").to_string()
    } else {
        event_type
    };

    match ev.as_str() {
        // Response created — capture metadata.
        "response.created" | "response.in_progress" => {
            if let Some(id) = parsed["response"]["id"].as_str() {
                *response_id = Some(id.to_string());
            }
            if let Some(model) = parsed["response"]["model"].as_str() {
                *response_model = model.to_string();
            }
        }

        // Text delta — the main streaming text.
        "response.output_text.delta" => {
            if let Some(text) = parsed["delta"].as_str() {
                let _ = app.emit(
                    "codex-stream-chunk",
                    CodexStreamChunkPayload {
                        session_id: session_id.to_string(),
                        event_type: "text".to_string(),
                        data: text.to_string(),
                    },
                );
            }
        }

        // Reasoning delta (thinking).
        "response.reasoning_summary_text.delta" => {
            if let Some(text) = parsed["delta"].as_str() {
                let _ = app.emit(
                    "codex-stream-chunk",
                    CodexStreamChunkPayload {
                        session_id: session_id.to_string(),
                        event_type: "thinking".to_string(),
                        data: text.to_string(),
                    },
                );
            }
        }

        // Function/tool call started.
        "response.output_item.added" => {
            if parsed["item"]["type"].as_str() == Some("function_call") {
                let tool_data = json!({
                    "id": parsed["item"]["id"],
                    "name": parsed["item"]["name"],
                    "call_id": parsed["item"]["call_id"],
                });
                let _ = app.emit(
                    "codex-stream-chunk",
                    CodexStreamChunkPayload {
                        session_id: session_id.to_string(),
                        event_type: "tool_use_start".to_string(),
                        data: tool_data.to_string(),
                    },
                );
            }
        }

        // Function call argument delta.
        "response.function_call_arguments.delta" => {
            if let Some(delta) = parsed["delta"].as_str() {
                let payload = json!({
                    "call_id": parsed["call_id"],
                    "delta": delta,
                });
                let _ = app.emit(
                    "codex-stream-chunk",
                    CodexStreamChunkPayload {
                        session_id: session_id.to_string(),
                        event_type: "tool_input_delta".to_string(),
                        data: payload.to_string(),
                    },
                );
            }
        }

        // Response fully completed — capture final usage stats.
        "response.completed" => {
            if let Some(id) = parsed["response"]["id"].as_str() {
                *response_id = Some(id.to_string());
            }
            if let Some(model) = parsed["response"]["model"].as_str() {
                *response_model = model.to_string();
            }
            if let Some(usage) = parsed["response"].get("usage") {
                if let Some(tokens) = usage["input_tokens"].as_u64() {
                    *input_tokens = tokens;
                }
                if let Some(tokens) = usage["output_tokens"].as_u64() {
                    *output_tokens = tokens;
                }
            }
            if let Some(reason) = parsed["response"]["incomplete_details"]["reason"].as_str() {
                *stop_reason = reason.to_string();
            } else {
                *stop_reason = "end_turn".to_string();
            }
        }

        // API-level error event.
        "error" => {
            let msg = parsed["message"]
                .as_str()
                .or_else(|| parsed["error"]["message"].as_str())
                .unwrap_or("Unknown Codex API error")
                .to_string();
            let _ = app.emit(
                "codex-stream-chunk",
                CodexStreamChunkPayload {
                    session_id: session_id.to_string(),
                    event_type: "error".to_string(),
                    data: msg,
                },
            );
        }

        _ => {}
    }
}

// ── Request building ──────────────────────────────────────────────

fn build_request_body(config: &CodexSendConfig) -> Value {
    let model = resolve_model_name(&config.model);

    // Build input array from history + current prompt.
    let mut input: Vec<Value> = config
        .history
        .iter()
        .map(|msg| build_input_message(&msg.role, &msg.content))
        .collect();
    input.push(build_input_message("user", &config.prompt));

    let mut body = json!({
        "model": model,
        "input": input,
        "stream": true,
        "store": false,
    });

    // If continuing a prior conversation, attach `previous_response_id`.
    if let Some(ref prev_id) = config.previous_response_id {
        if !prev_id.trim().is_empty() {
            body["previous_response_id"] = json!(prev_id);
        }
    }

    body
}

fn build_input_message(role: &str, content: &str) -> Value {
    let content_type = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };
    json!({
        "role": role,
        "content": [{"type": content_type, "text": content}]
    })
}

fn resolve_model_name(selection: &str) -> String {
    match selection.trim() {
        "" | "codex-default" | "codex-mini" | "codex-mini-latest" => {
            CODEX_DEFAULT_MODEL.to_string()
        }
        "o4-mini" | "o4-mini-latest" => "o4-mini".to_string(),
        other => other.to_string(),
    }
}

// ── Error helpers ─────────────────────────────────────────────────

fn parse_api_error(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v["detail"]
        .as_str()
        .or_else(|| v["error"]["message"].as_str())
        .map(|s| s.to_string())
}
