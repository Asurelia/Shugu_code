use futures_util::StreamExt;
use serde::Deserialize;
use tauri::Emitter;

/// Arguments received from the JS `invoke("chat_send", {...})` call.
/// JS uses camelCase, so we rename all fields accordingly.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendArgs {
    pub prompt: String,
    pub model: String,
    /// "anthropic" | "openai" | "ollama" | "custom"
    pub protocol: String,
    /// Base URL for the provider, e.g. "https://api.anthropic.com"
    ///
    /// SECURITY NOTE: For the `custom` protocol this value is user-supplied and
    /// is used directly in an outbound HTTP request — a known SSRF surface.
    /// This is acceptable for a desktop app where the user configures their own
    /// providers, but a future improvement should validate against an allowlist
    /// of user-approved origins before sending.
    pub base_url: String,
    /// Optional API key. If `Some` and non-empty it takes precedence over the
    /// corresponding environment variable.
    pub api_key: Option<String>,
    /// Reserved for future multi-turn conversation tracking; unused today.
    pub conversation_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Streaming delta event emitted to the frontend via `chat://delta`.
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDelta {
    conversation_id: Option<String>,
    chunk: String,
    done: bool,
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/// Returns the API key to use for the given protocol.
///
/// Priority: explicit `api_key` arg → env var → `Ok("")` for Ollama.
fn resolve_key(protocol: &str, api_key: &Option<String>) -> Result<String, String> {
    if let Some(k) = api_key {
        if !k.is_empty() {
            return Ok(k.clone());
        }
    }
    match protocol {
        "ollama" => Ok(String::new()),
        "anthropic" => std::env::var("ANTHROPIC_API_KEY").map_err(|_| {
            "no API key for anthropic (set ANTHROPIC_API_KEY or pass apiKey)".to_string()
        }),
        "openai" => std::env::var("OPENAI_API_KEY").map_err(|_| {
            "no API key for openai (set OPENAI_API_KEY or pass apiKey)".to_string()
        }),
        "custom" => std::env::var("SHUGU_CUSTOM_API_KEY").map_err(|_| {
            "no API key for custom (set SHUGU_CUSTOM_API_KEY or pass apiKey)".to_string()
        }),
        other => Err(format!("unsupported protocol: {}", other)),
    }
}

// ---------------------------------------------------------------------------
// Shared line-buffered stream reader
// ---------------------------------------------------------------------------

/// Drains a `bytes_stream()` response into complete UTF-8 lines via a
/// byte-level buffer.  Handles arbitrary chunk boundaries (including chunks
/// that split multi-byte UTF-8 sequences mid-codepoint) by accumulating raw
/// bytes and slicing only at `\n` boundaries.
async fn collect_lines<F>(
    response: reqwest::Response,
    mut on_line: F,
) -> Result<(), String>
where
    F: FnMut(&str),
{
    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&bytes);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim_end_matches(['\n', '\r']);
            on_line(line);
        }
    }
    // Flush any remainder (stream ended without a trailing newline).
    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim_end_matches(['\n', '\r']);
        if !line.is_empty() {
            on_line(line);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-protocol streaming helpers
// ---------------------------------------------------------------------------

/// Anthropic SSE streaming (`event: content_block_delta` / `data: {...}`).
///
/// Requests `"stream": true`.  For each `data:` line whose JSON has
/// `type == "content_block_delta"`, emits `delta.text`.  Unknown/keep-alive
/// lines are silently skipped.
async fn call_anthropic(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
    api_key: &str,
    conversation_id: &Option<String>,
) -> Result<String, String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "stream": true,
        "messages": [{"role": "user", "content": prompt}]
    });

    let response = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("anthropic API error {}: {}", status, text));
    }

    let mut acc = String::new();
    let conv_id = conversation_id.clone();
    let app_ref = app.clone();

    collect_lines(response, |line| {
        // SSE data lines start with "data: "; skip all others.
        let Some(payload) = line.strip_prefix("data: ") else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { return };
        if v["type"].as_str() != Some("content_block_delta") { return }
        let Some(text) = v["delta"]["text"].as_str() else { return };
        acc.push_str(text);
        let delta = ChatDelta { conversation_id: conv_id.clone(), chunk: text.to_string(), done: false };
        let _ = app_ref.emit("chat://delta", delta);
    }).await?;

    Ok(acc)
}

/// OpenAI-compatible SSE streaming (`data: {...}` / `data: [DONE]`).
///
/// Requests `"stream": true`.  Picks `choices[0].delta.content` when present;
/// ignores role-only or null-content frames; stops on literal `[DONE]`.
async fn call_openai_compat(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
    api_key: &str,
    protocol: &str,
    conversation_id: &Option<String>,
) -> Result<String, String> {
    // Normalise: strip trailing slash, then decide whether to append /v1.
    let base = base_url.trim_end_matches('/');
    let url = if base.ends_with("/v1") {
        format!("{}/chat/completions", base)
    } else {
        format!("{}/v1/chat/completions", base)
    };

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": [{"role": "user", "content": prompt}]
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("{} API error {}: {}", protocol, status, text));
    }

    let mut acc = String::new();
    let conv_id = conversation_id.clone();
    let app_ref = app.clone();

    collect_lines(response, |line| {
        let Some(payload) = line.strip_prefix("data: ") else { return };
        // Terminal sentinel — not JSON; just stop accumulating.
        if payload.trim() == "[DONE]" { return }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { return };
        let Some(text) = v["choices"][0]["delta"]["content"].as_str() else { return };
        acc.push_str(text);
        let delta = ChatDelta { conversation_id: conv_id.clone(), chunk: text.to_string(), done: false };
        let _ = app_ref.emit("chat://delta", delta);
    }).await?;

    Ok(acc)
}

/// Ollama newline-delimited JSON streaming (`/api/chat` with `"stream": true`).
///
/// Each line is a JSON object with `message.content` and a `done` bool.
/// Emits each `message.content`; stops when `done` is `true`.
async fn call_ollama(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
    conversation_id: &Option<String>,
) -> Result<String, String> {
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": true
    });

    let response = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("ollama API error {}: {}", status, text));
    }

    let mut acc = String::new();
    let conv_id = conversation_id.clone();
    let app_ref = app.clone();

    collect_lines(response, |line| {
        if line.is_empty() { return }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
        let Some(text) = v["message"]["content"].as_str() else { return };
        if !text.is_empty() {
            acc.push_str(text);
            let delta = ChatDelta { conversation_id: conv_id.clone(), chunk: text.to_string(), done: false };
            let _ = app_ref.emit("chat://delta", delta);
        }
    }).await?;

    Ok(acc)
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

/// Provider-agnostic streaming chat dispatcher.
///
/// Dispatches to Anthropic, OpenAI-compatible, or Ollama backends based on
/// the `protocol` field, streaming tokens back to the frontend via
/// `app.emit("chat://delta", ChatDelta { chunk, done: false })` as they
/// arrive.  After the stream ends a final `ChatDelta { chunk: "", done: true }`
/// is emitted before the command resolves with the complete accumulated text.
///
/// Follow-up TODOs:
/// - Cancellation: expose an abort handle so the frontend can cancel mid-stream.
/// - Per-message history: thread `conversation_id` through a message store and
///   pass the full history in the `messages` array.
/// - SSRF allowlist: for `custom` protocol, validate `base_url` against a
///   user-managed allowlist before making any outbound request.
/// - Error mid-stream UX: emit a `done: true` delta with an `error` field so
///   the frontend can display partial text + an error indicator.
#[tauri::command]
pub async fn chat_send(app: tauri::AppHandle, args: ChatSendArgs) -> Result<String, String> {
    let model = if args.model.is_empty() {
        "claude-haiku-4-5".to_string()
    } else {
        args.model.clone()
    };

    let client = reqwest::Client::new();
    let protocol = args.protocol.as_str();

    let result = match protocol {
        "anthropic" => {
            let key = resolve_key(protocol, &args.api_key)?;
            call_anthropic(&app, &client, &args.base_url, &model, &args.prompt, &key, &args.conversation_id).await
        }
        "openai" | "custom" => {
            let key = resolve_key(protocol, &args.api_key)?;
            call_openai_compat(&app, &client, &args.base_url, &model, &args.prompt, &key, protocol, &args.conversation_id).await
        }
        "ollama" => {
            call_ollama(&app, &client, &args.base_url, &model, &args.prompt, &args.conversation_id).await
        }
        other => Err(format!("unsupported protocol: {}", other)),
    };

    // Emit a terminal `done` delta regardless of success/failure so the
    // frontend always receives a completion signal.
    let done_delta = ChatDelta {
        conversation_id: args.conversation_id.clone(),
        chunk: String::new(),
        done: true,
    };
    let _ = app.emit("chat://delta", done_delta);

    result
}
