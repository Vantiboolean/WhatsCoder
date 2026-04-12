//! OpenAI PKCE OAuth flow for Codex / ChatGPT Plus authentication.
//!
//! Mirrors the CodePilot `openai-oauth.ts` + `openai-oauth-manager.ts` implementation.
//! Flow: generate PKCE → open browser → receive callback on :1455 → exchange code →
//!       parse JWT → store tokens in app_settings.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::time::{timeout, Duration};

// ── Constants ─────────────────────────────────────────────────────────────────

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CALLBACK_PORT: u16 = 1455;
/// Refresh 5 minutes before expiry (in milliseconds)
const REFRESH_BUFFER_MS: u64 = 5 * 60 * 1000;
const TOKEN_SETTING_KEYS: &[&str] = &[
    "codex_oauth_access_token",
    "codex_oauth_refresh_token",
    "codex_oauth_id_token",
    "codex_oauth_expires_at",
    "codex_oauth_email",
    "codex_oauth_plan",
    "codex_oauth_account_id",
];

// ── Pending OAuth state ───────────────────────────────────────────────────────

struct PendingOAuth {
    state: String,
    code_verifier: String,
}

static PENDING_OAUTH: LazyLock<Mutex<Option<PendingOAuth>>> =
    LazyLock::new(|| Mutex::new(None));

// ── Public types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    pub authenticated: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    id_token: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

fn random_base64url(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(&bytes)
}

fn sha256_base64url(input: &str) -> String {
    let hash = Sha256::digest(input.as_bytes());
    URL_SAFE_NO_PAD.encode(&hash)
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", byte));
            }
        }
    }
    out
}

// ── Auth URL builder ──────────────────────────────────────────────────────────

pub fn build_auth_url() -> String {
    let code_verifier = random_base64url(32);
    let code_challenge = sha256_base64url(&code_verifier);
    let state = random_base64url(32);

    // Store pending state for callback verification
    if let Ok(mut guard) = PENDING_OAUTH.lock() {
        *guard = Some(PendingOAuth {
            state: state.clone(),
            code_verifier,
        });
    }

    let params: &[(&str, &str)] = &[
        ("client_id", CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", REDIRECT_URI),
        ("scope", "openid profile email offline_access"),
        ("code_challenge", &code_challenge),
        ("code_challenge_method", "S256"),
        ("state", &state),
        ("codex_cli_simplified_flow", "true"),
        ("id_token_add_organizations", "true"),
    ];

    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    format!("{}?{}", AUTH_URL, query)
}

// ── Token exchange ────────────────────────────────────────────────────────────

async fn exchange_code(code: &str, code_verifier: &str) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();

    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("redirect_uri", REDIRECT_URI),
        ("code_verifier", code_verifier),
    ];

    let response = client
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed {status}: {text}"));
    }

    response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("Token parse error: {e}"))
}

async fn refresh_access_token(refresh_token: &str) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();

    let params = [
        ("grant_type", "refresh_token"),
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
    ];

    let response = client
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("Token refresh failed {status}: {text}"));
    }

    response
        .json::<TokenResponse>()
        .await
        .map_err(|e| format!("Token refresh parse error: {e}"))
}

// ── JWT claim parsing ─────────────────────────────────────────────────────────

fn parse_jwt_claims(id_token: &str) -> HashMap<String, Value> {
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() < 2 {
        return HashMap::new();
    }
    // Base64url decode without padding
    let payload = parts[1];
    // Pad to multiple of 4
    let padded = match payload.len() % 4 {
        2 => format!("{payload}=="),
        3 => format!("{payload}="),
        _ => payload.to_string(),
    };
    URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(&padded))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, Value>>(&bytes).ok())
        .unwrap_or_default()
}

fn extract_account_id(claims: &HashMap<String, Value>) -> Option<String> {
    // chatgpt_account_id top-level
    if let Some(v) = claims.get("chatgpt_account_id").and_then(|v| v.as_str()) {
        return Some(v.to_string());
    }
    // Nested under https://api.openai.com/auth
    if let Some(auth) = claims.get("https://api.openai.com/auth") {
        if let Some(id) = auth.get("chatgpt_account_id").and_then(|v| v.as_str()) {
            return Some(id.to_string());
        }
    }
    // organizations[0].id
    claims
        .get("organizations")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|o| o.get("id"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn extract_plan(claims: &HashMap<String, Value>) -> Option<String> {
    claims
        .get("chatgpt_plan_type")
        .or_else(|| {
            claims
                .get("https://api.openai.com/auth")
                .and_then(|a| a.get("chatgpt_plan_type"))
        })
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn unauthenticated_status() -> CodexAuthStatus {
    CodexAuthStatus {
        authenticated: false,
        email: None,
        plan: None,
        account_id: None,
    }
}

fn read_non_empty_setting(key: &str) -> Option<String> {
    crate::database::get_setting(key)
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty())
}

fn clear_token_bundle() -> Result<(), String> {
    for key in TOKEN_SETTING_KEYS {
        crate::database::delete_setting(key)?;
    }
    Ok(())
}

// ── HTTP callback server ──────────────────────────────────────────────────────

async fn run_callback_server(app: AppHandle) -> Result<(String, String), String> {
    let listener = TcpListener::bind(format!("127.0.0.1:{CALLBACK_PORT}"))
        .await
        .map_err(|e| format!("Cannot bind port {CALLBACK_PORT}: {e}"))?;

    let _ = app.emit("codex-auth-listener-ready", true);

    let (stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("Accept failed: {e}"))?;

    let (reader, mut writer) = tokio::io::split(stream);
    let mut buf = BufReader::new(reader);
    let mut request_line = String::new();
    buf.read_line(&mut request_line)
        .await
        .map_err(|e| format!("Read error: {e}"))?;

    let (code, state) = parse_callback_request_line(&request_line)?;

    // Respond to browser
    let html = b"<html><body style='font-family:sans-serif;padding:40px'>\
        <h2>&#10003; Login successful!</h2>\
        <p>You may now close this browser tab and return to the app.</p>\
        </body></html>";
    let _ = writer
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                html.len()
            )
            .as_bytes(),
        )
        .await;
    let _ = writer.write_all(html).await;
    let _ = writer.flush().await;

    Ok((code, state))
}

fn parse_callback_request_line(line: &str) -> Result<(String, String), String> {
    // "GET /auth/callback?code=XXX&state=YYY HTTP/1.1"
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err(format!("Malformed request line: {line:?}"));
    }
    let path = parts[1];
    let qs = match path.find('?') {
        Some(i) => &path[i + 1..],
        None => return Err("No query string in callback".into()),
    };

    let mut code = None;
    let mut state = None;
    for pair in qs.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            let decoded = percent_decode(v);
            match k {
                "code" => code = Some(decoded),
                "state" => state = Some(decoded),
                _ => {}
            }
        }
    }

    Ok((
        code.ok_or("Missing code in callback")?,
        state.ok_or("Missing state in callback")?,
    ))
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next().unwrap_or('0');
            let h2 = chars.next().unwrap_or('0');
            if let Ok(b) = u8::from_str_radix(&format!("{h1}{h2}"), 16) {
                out.push(b as char);
            }
        } else if c == '+' {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

// ── Token DB helpers ──────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn save_token_bundle(
    tokens: &TokenResponse,
    email: Option<&str>,
    plan: Option<&str>,
    account_id: Option<&str>,
) -> Result<(), String> {
    crate::database::set_setting("codex_oauth_access_token", &tokens.access_token)?;
    crate::database::set_setting("codex_oauth_id_token", &tokens.id_token)?;

    if let Some(rt) = &tokens.refresh_token {
        crate::database::set_setting("codex_oauth_refresh_token", rt)?;
    }
    if let Some(secs) = tokens.expires_in {
        let expires_at_ms = now_ms() + secs * 1000;
        crate::database::set_setting("codex_oauth_expires_at", &expires_at_ms.to_string())?;
    }
    if let Some(e) = email {
        crate::database::set_setting("codex_oauth_email", e)?;
    }
    if let Some(p) = plan {
        crate::database::set_setting("codex_oauth_plan", p)?;
    }
    if let Some(a) = account_id {
        crate::database::set_setting("codex_oauth_account_id", a)?;
    }
    Ok(())
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn get_auth_status() -> CodexAuthStatus {
    let access_token = read_non_empty_setting("codex_oauth_access_token");
    if access_token.is_none() {
        return unauthenticated_status();
    }

    let expires_at_ms = read_non_empty_setting("codex_oauth_expires_at")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let refresh_token = read_non_empty_setting("codex_oauth_refresh_token");
    if expires_at_ms > 0 && now_ms() >= expires_at_ms && refresh_token.is_none() {
        let _ = clear_token_bundle();
        return unauthenticated_status();
    }

    CodexAuthStatus {
        authenticated: true,
        email: read_non_empty_setting("codex_oauth_email"),
        plan: read_non_empty_setting("codex_oauth_plan"),
        account_id: read_non_empty_setting("codex_oauth_account_id"),
    }
}

/// Returns a valid access token, refreshing automatically if near expiry.
pub async fn get_valid_access_token() -> Result<String, String> {
    let access_token = read_non_empty_setting("codex_oauth_access_token")
        .ok_or("Not authenticated with OpenAI")?;

    // Check expiry
    let expires_at_ms = crate::database::get_setting("codex_oauth_expires_at")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let current_ms = now_ms();
    if expires_at_ms > 0 && current_ms + REFRESH_BUFFER_MS < expires_at_ms {
        return Ok(access_token);
    }

    // Token expired or near expiry — try refresh
    let refresh_token = read_non_empty_setting("codex_oauth_refresh_token");

    if let Some(rt) = refresh_token {
        eprintln!("[codex-oauth] Access token near expiry, refreshing...");
        match refresh_access_token(&rt).await {
            Ok(new_tokens) => {
                let email = crate::database::get_setting("codex_oauth_email").ok().flatten();
                let plan = crate::database::get_setting("codex_oauth_plan").ok().flatten();
                let account_id = crate::database::get_setting("codex_oauth_account_id").ok().flatten();
                save_token_bundle(
                    &new_tokens,
                    email.as_deref(),
                    plan.as_deref(),
                    account_id.as_deref(),
                )?;
                return Ok(new_tokens.access_token);
            }
            Err(e) => {
                eprintln!("[codex-oauth] Token refresh failed: {e}. Clearing stored credentials.");
                clear_token_bundle()?;
                return Err(format!(
                    "OpenAI login expired and refresh failed: {e}. Please sign in again."
                ));
            }
        }
    }

    clear_token_bundle()?;
    Err("OpenAI login expired. Please sign in again.".to_string())
}

pub fn get_account_id() -> Option<String> {
    read_non_empty_setting("codex_oauth_account_id")
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

/// Returns the OpenAI OAuth authorization URL with embedded PKCE params.
#[tauri::command]
pub fn codex_get_auth_url() -> Result<String, String> {
    Ok(build_auth_url())
}

/// Returns current authentication status (no network call).
#[tauri::command]
pub fn codex_check_auth() -> CodexAuthStatus {
    get_auth_status()
}

/// Starts the local HTTP callback server (port 1455) and waits up to 5 minutes for
/// the browser to complete the OAuth redirect. Emits `codex-auth-complete` when done.
#[tauri::command]
pub async fn codex_handle_oauth_callback(app: AppHandle) -> Result<CodexAuthStatus, String> {
    let (expected_state, code_verifier) = {
        let guard = PENDING_OAUTH
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        match &*guard {
            Some(p) => (p.state.clone(), p.code_verifier.clone()),
            None => return Err("No pending OAuth flow — call codex_get_auth_url first".into()),
        }
    };

    let (code, state) = timeout(Duration::from_secs(300), run_callback_server(app.clone()))
        .await
        .map_err(|_| "OAuth callback timed out after 5 minutes".to_string())??;

    if state != expected_state {
        return Err(format!(
            "OAuth state mismatch (CSRF check failed): expected {expected_state}, got {state}"
        ));
    }

    // Clear pending state
    if let Ok(mut guard) = PENDING_OAUTH.lock() {
        *guard = None;
    }

    let tokens = exchange_code(&code, &code_verifier).await?;

    let claims = parse_jwt_claims(&tokens.id_token);
    let email = claims
        .get("email")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let plan = extract_plan(&claims);
    let account_id = extract_account_id(&claims);

    save_token_bundle(
        &tokens,
        email.as_deref(),
        plan.as_deref(),
        account_id.as_deref(),
    )?;

    let status = CodexAuthStatus {
        authenticated: true,
        email: email.clone(),
        plan: plan.clone(),
        account_id: account_id.clone(),
    };

    // Notify frontend
    let _ = app.emit("codex-auth-complete", &status);

    eprintln!("[codex-oauth] Login successful: email={email:?} plan={plan:?}");
    Ok(status)
}

/// Clears all stored OAuth tokens.
#[tauri::command]
pub fn codex_logout(app: AppHandle) -> Result<(), String> {
    clear_token_bundle()?;
    let _ = app.emit("codex-auth-complete", unauthenticated_status());
    eprintln!("[codex-oauth] Logged out");
    Ok(())
}

/// Explicitly refreshes the access token and returns updated auth status.
#[tauri::command]
pub async fn codex_refresh_token() -> Result<CodexAuthStatus, String> {
    get_valid_access_token().await?;
    Ok(get_auth_status())
}
