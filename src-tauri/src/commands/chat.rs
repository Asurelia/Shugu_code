use serde::Deserialize;

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
// Per-protocol helpers
// ---------------------------------------------------------------------------

async fn call_anthropic(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
    api_key: &str,
) -> Result<String, String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
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

    let v: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    v["content"][0]["text"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("unexpected anthropic response shape: {}", v))
}

async fn call_openai_compat(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
    api_key: &str,
    protocol: &str,
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

    let v: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("unexpected {} response shape: {}", protocol, v))
}

async fn call_ollama(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": false
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

    let v: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    v["message"]["content"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("unexpected ollama response shape: {}", v))
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

/// Provider-agnostic chat dispatcher.
///
/// Dispatches to Anthropic, OpenAI-compatible, or Ollama backends based on
/// the `protocol` field. The `conversation_id` field is accepted for
/// forward-compatibility but is not yet used.
///
/// Follow-up TODOs:
/// - Streaming: replace this command with a streaming version that emits
///   `app.emit("chat://delta", ...)` chunks using `tauri::Emitter`.
/// - Per-message history: thread `conversation_id` through a message store and
///   pass the full history in the `messages` array.
/// - SSRF allowlist: for `custom` protocol, validate `base_url` against a
///   user-managed allowlist before making any outbound request.
#[tauri::command]
pub async fn chat_send(args: ChatSendArgs) -> Result<String, String> {
    // Silence the unused-field warning for conversation_id (reserved for future use).
    let _ = &args.conversation_id;

    let model = if args.model.is_empty() {
        "claude-haiku-4-5".to_string()
    } else {
        args.model.clone()
    };

    let client = reqwest::Client::new();
    let protocol = args.protocol.as_str();

    match protocol {
        "anthropic" => {
            let key = resolve_key(protocol, &args.api_key)?;
            call_anthropic(&client, &args.base_url, &model, &args.prompt, &key).await
        }
        "openai" | "custom" => {
            let key = resolve_key(protocol, &args.api_key)?;
            call_openai_compat(&client, &args.base_url, &model, &args.prompt, &key, protocol).await
        }
        "ollama" => {
            call_ollama(&client, &args.base_url, &model, &args.prompt).await
        }
        other => Err(format!("unsupported protocol: {}", other)),
    }
}
