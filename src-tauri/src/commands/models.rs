use serde::Serialize;

// Minimal Rust-side model list returned by the `models_list` Tauri command.
// The extended catalog (with groups + meta tags for the UI) lives in
// `src/lib/providers.ts` (MODEL_CATALOG). Keep the entries below as a
// subset of that catalog — when adding a model here, mirror it in the TS
// catalog so the web/dev mock and the Tauri command stay aligned.
// TS ↔ Rust sharing without a JSON build step isn't worth the friction
// while the list is < 20 entries.

#[derive(Serialize)]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub protocol: String,
}

#[tauri::command]
pub fn models_list() -> Vec<Provider> {
    vec![
        Provider { id: "anthropic/claude-haiku-4-5".into(), label: "claude-haiku-4-5".into(), protocol: "anthropic".into() },
        Provider { id: "anthropic/claude-sonnet-5".into(),  label: "claude-sonnet-5".into(),  protocol: "anthropic".into() },
        Provider { id: "openai/gpt-4o-mini".into(),         label: "gpt-4o-mini".into(),      protocol: "openai".into() },
        Provider { id: "ollama/qwen2.5:32b".into(),         label: "qwen2.5:32b".into(),      protocol: "ollama".into() },
    ]
}

// ────────────────────────────────────────────────────────────────────
// Remote model discovery (CORS-safe, proxified through reqwest)
// ────────────────────────────────────────────────────────────────────
//
// Why this lives in Rust:
//
// The frontend used to call `fetch(baseUrl + "/v1/models")` directly from
// `modelDiscovery.ts`. That `fetch` is the webview's native one, which DOES
// subject the call to CORS — despite the file's misleading "Tauri webview,
// so CORS does not apply" comment. Some providers (Anthropic, OpenAI) return
// permissive `Access-Control-Allow-Origin: *` headers so it accidentally
// worked; others (OpenCode Go in particular) don't, surfacing as a vague
// `TypeError: Failed to fetch` with zero diagnostic info.
//
// Moving the probe to Rust gets us:
//   1. Zero CORS — reqwest is a server-side HTTP client.
//   2. Real error messages — we can surface the status code, body excerpt,
//      etc., back to the UI instead of a generic webview rejection.
//   3. Consistency — every other outbound HTTP call in the app already
//      goes through Rust (chat streaming, image gen, llama probe). The JS
//      `fetch` here was the lone outlier and the first one to misbehave.
//
// Three protocol shapes covered (mirrors the dispatcher in chat.rs):
//   - anthropic → GET /v1/models      (header `x-api-key`)
//   - openai    → GET /v1/models      (header `Authorization: Bearer …`,
//                                      with the same trailing-`/v1` smart
//                                      bascule that chat.rs already does)
//   - ollama    → GET /api/tags       (no key)
//
// `custom` from the frontend resolves to one of the three above before
// hitting this command — the frontend already stores the user's chosen
// protocol under `provider.<id>.protocol`.

/// Probe a provider's "list models" endpoint and return the bare list of
/// model ids. NEVER returns provider-specific JSON shapes — that's the
/// frontend's job to map onto its `DiscoveredModel` type.
///
/// `api_key: None` is allowed; the request goes out unauthenticated, which
/// is the right thing for local servers (Ollama, llama.cpp, LM Studio).
#[tauri::command]
pub async fn models_discover_external(
    protocol: String,
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    // One-shot client: this command is called a few times per discovery
    // cycle (every 60 s at most), not in a hot loop — no point pooling.
    let client = reqwest::Client::builder()
        // Local llama-server takes a few seconds to wake up after a cold
        // boot; remote APIs occasionally hang. 30 s is generous for a list
        // call and still bounds the UI's "Loading…" state.
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client build: {e}"))?;

    let base = base_url.trim_end_matches('/');

    match protocol.as_str() {
        "anthropic" => {
            let key = api_key.ok_or_else(|| "anthropic discovery needs an api key".to_string())?;
            let url = format!("{base}/v1/models");
            let resp = client
                .get(&url)
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .send()
                .await
                .map_err(|e| format!("http: {e}"))?;
            parse_data_id_array(resp).await
        }
        "openai" | "custom" => {
            // Smart `/v1` bascule — accept both `https://host` and
            // `https://host/v1` as configured baseUrl, same convention the
            // chat dispatcher uses (chat.rs:336-340).
            let url = if base.ends_with("/v1") {
                format!("{base}/models")
            } else {
                format!("{base}/v1/models")
            };
            let mut req = client.get(&url).header("content-type", "application/json");
            if let Some(k) = api_key.as_deref() {
                if !k.is_empty() {
                    req = req.header("Authorization", format!("Bearer {k}"));
                }
            }
            let resp = req.send().await.map_err(|e| format!("http: {e}"))?;
            parse_data_id_array(resp).await
        }
        "ollama" => {
            let url = format!("{base}/api/tags");
            let resp = client
                .get(&url)
                .send()
                .await
                .map_err(|e| format!("http: {e}"))?;
            parse_ollama_tags(resp).await
        }
        other => Err(format!("unknown protocol: {other}")),
    }
}

/// Helper: read response, surface non-2xx with a body excerpt, then extract
/// `data[].id` from the JSON. Used by anthropic + openai-compat.
async fn parse_data_id_array(resp: reqwest::Response) -> Result<Vec<String>, String> {
    let status = resp.status();
    if !status.is_success() {
        // Pull a short body excerpt — most APIs return useful error JSON
        // (e.g. {"error":{"message":"..."}}); the user-visible card needs
        // this to distinguish "wrong key" from "endpoint down".
        let body = resp.text().await.unwrap_or_default();
        let excerpt: String = body.chars().take(300).collect();
        return Err(format!("HTTP {status}: {excerpt}"));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("parse json: {e}"))?;
    let arr = json
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "response missing `data` array".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect())
}

/// Helper: parse Ollama's `/api/tags` response (`{models: [{name, ...}]}`).
async fn parse_ollama_tags(resp: reqwest::Response) -> Result<Vec<String>, String> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let excerpt: String = body.chars().take(300).collect();
        return Err(format!("HTTP {status}: {excerpt}"));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("parse json: {e}"))?;
    let arr = json
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "response missing `models` array".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|item| item.get("name").and_then(|v| v.as_str()).map(String::from))
        .collect())
}
