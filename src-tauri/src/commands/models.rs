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
        Provider {
            id: "anthropic/claude-haiku-4-5".into(),
            label: "claude-haiku-4-5".into(),
            protocol: "anthropic".into(),
        },
        Provider {
            id: "anthropic/claude-sonnet-5".into(),
            label: "claude-sonnet-5".into(),
            protocol: "anthropic".into(),
        },
        Provider {
            id: "openai/gpt-4o-mini".into(),
            label: "gpt-4o-mini".into(),
            protocol: "openai".into(),
        },
        Provider {
            id: "ollama/qwen2.5:32b".into(),
            label: "qwen2.5:32b".into(),
            protocol: "ollama".into(),
        },
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
    allow_private_local: Option<bool>,
) -> Result<Vec<String>, String> {
    // SSRF guard — `models_discover_external` takes a user-supplied `base_url`
    // and issues an outbound backend GET, exactly the same pivot surface as
    // `chat_send` (the Rust client is not constrained by the webview CSP). A
    // careless or malicious `custom` provider config could point this at a
    // cloud metadata endpoint (169.254.169.254), a loopback-bound service, or a
    // private-LAN host and read the probe result back through the discovery UI.
    //
    // We reuse the SAME policy + helper as chat.rs (`validate_custom_base_url`):
    // it blocks loopback / private / link-local / CGNAT / unique-local /
    // metadata IP literals and the loopback hostnames, honoring the
    // `SHUGU_CUSTOM_ALLOW_PRIVATE=1` opt-out for legitimately self-hosted/LAN
    // endpoints.
    //
    // Scope: anthropic / openai / custom — every protocol that funnels a
    // user-supplied `base_url` into the request. This is deliberately BROADER
    // than chat.rs's custom-only guard, for reasons specific to this command:
    //   * `openai` and `custom` share one match arm below (both take an
    //     arbitrary base_url), and the `anthropic` arm does too — there is no
    //     trusted/default endpoint to fall back on here.
    //   * the `protocol` discriminator is itself attacker-controlled, so a
    //     custom-only guard would be one relabel (`custom` → `openai`) away from
    //     a full bypass — and per the header note above, a custom provider often
    //     arrives here already labelled `openai`.
    // `ollama` is the sole exemption: it targets `http://localhost:11434` by
    // design, and guarding it would break the default local-Ollama discovery
    // flow. The guard runs FIRST — before the client is built and before the
    // anthropic key check — so a blocked target never opens a socket.
    // The built-in llama.cpp card is the one deliberately trusted local
    // exception. The flag alone is insufficient: the target must still parse
    // as localhost or a loopback IP, so it cannot become a generic SSRF bypass.
    let trusted_loopback = allow_private_local.unwrap_or(false)
        && reqwest::Url::parse(&base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .is_some_and(|host| {
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
    if matches!(protocol.as_str(), "anthropic" | "openai" | "custom") && !trusted_loopback {
        crate::commands::chat::validate_custom_base_url(&base_url)?;
    }

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
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("parse json: {e}"))?;
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
    let json: serde_json::Value = resp.json().await.map_err(|e| format!("parse json: {e}"))?;
    let arr = json
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "response missing `models` array".to_string())?;
    Ok(arr
        .iter()
        .filter_map(|item| item.get("name").and_then(|v| v.as_str()).map(String::from))
        .collect())
}

#[cfg(test)]
mod ssrf_discovery_tests {
    use super::models_discover_external;

    // The SSRF guard runs BEFORE the reqwest client is built, so a blocked
    // target returns the validation Err without touching the network — the
    // `block` cases below are deterministic and offline. They mirror the policy
    // proven exhaustively in chat.rs's `ssrf_tests`; here we assert the command
    // wires the guard in for EVERY base_url-consuming protocol
    // (anthropic / openai / custom) and short-circuits, while `ollama` stays
    // exempt. These assume `SHUGU_CUSTOM_ALLOW_PRIVATE` is UNSET (the default)
    // and never mutate the process env, so they stay deterministic under the
    // parallel test runner.

    /// Every protocol whose arm funnels a user-supplied base_url into the probe
    /// and is therefore guarded. `ollama` is intentionally absent.
    const GUARDED: [&str; 3] = ["anthropic", "openai", "custom"];

    /// Assert that discovery for `protocol` → `url` is rejected by the SSRF
    /// guard (validation error, no network hop). `None` api_key also proves the
    /// guard fires ahead of the anthropic key-presence check.
    async fn block(protocol: &str, url: &str) {
        let res = models_discover_external(protocol.to_string(), url.to_string(), None, None).await;
        assert!(
            res.is_err(),
            "{protocol} discovery to {url} should be blocked by the SSRF guard"
        );
        let msg = res.unwrap_err();
        assert!(
            msg.contains("SSRF")
                || msg.contains("http or https")
                || msg.contains("valid URL")
                || msg.contains("is empty"),
            "blocked {protocol} {url} should report the SSRF/validation reason, got: {msg}"
        );
    }

    #[tokio::test]
    async fn discovery_blocks_loopback_and_private_targets() {
        // Same shapes chat.rs blocks: loopback name, loopback/private/metadata
        // IP literals, IPv6 loopback + v4-mapped loopback. Checked across every
        // guarded protocol so relabelling the provider can't bypass the guard.
        for proto in GUARDED {
            for u in [
                "http://localhost:8090/v1",
                "http://127.0.0.1:8080",
                "http://10.1.2.3/v1",
                "https://192.168.0.10",
                "http://169.254.169.254/latest/meta-data",
                "http://[::1]:8080/v1",
                "http://[::ffff:127.0.0.1]:9000",
            ] {
                block(proto, u).await;
            }
        }
    }

    #[tokio::test]
    async fn discovery_rejects_bad_scheme_and_empty_base_url() {
        for proto in GUARDED {
            for u in ["", "ftp://example.com", "file:///etc/passwd", "not a url"] {
                block(proto, u).await;
            }
        }
    }

    #[tokio::test]
    async fn trusted_local_flag_only_exempts_loopback() {
        use tokio::time::{timeout, Duration};

        let private = models_discover_external(
            "openai".to_string(),
            "http://10.1.2.3/v1".to_string(),
            None,
            Some(true),
        )
        .await
        .expect_err("the built-in-local flag must not exempt a private LAN target");
        assert!(
            private.contains("SSRF"),
            "unexpected validation error: {private}"
        );

        match timeout(
            Duration::from_secs(5),
            models_discover_external(
                "openai".to_string(),
                "http://127.0.0.1:1/v1".to_string(),
                None,
                Some(true),
            ),
        )
        .await
        {
            Ok(res) => {
                let msg = res.expect_err("no OpenAI-compatible server on 127.0.0.1:1");
                assert!(
                    !msg.contains("SSRF"),
                    "trusted built-in loopback discovery must reach the transport layer: {msg}"
                );
            }
            Err(_elapsed) => {}
        }
    }

    #[tokio::test]
    async fn ollama_discovery_is_exempt_from_guard() {
        use tokio::time::{timeout, Duration};
        // ollama targets localhost by design — the guard must NOT fire for it,
        // or the default local-Ollama discovery flow breaks. We prove the guard
        // let it through by observing the call reach the NETWORK layer: a guarded
        // protocol would return the SSRF block error synchronously, long before
        // any socket work. We connect to 127.0.0.1:1 (a reserved port nothing
        // listens on). Two acceptable outcomes, both proving the exemption:
        //   * the connect is refused fast (RST, the usual loopback case) → the
        //     call returns a transport error, which is NOT the block message;
        //   * the SYN is silently dropped (some firewalled CI hosts) → the call
        //     is still running at the 5 s bound, which itself proves the guard
        //     did not short-circuit. The cap stops the suite inheriting the 30 s
        //     reqwest timeout.
        match timeout(
            Duration::from_secs(5),
            models_discover_external(
                "ollama".to_string(),
                "http://127.0.0.1:1".to_string(),
                None,
                None,
            ),
        )
        .await
        {
            Ok(res) => {
                let msg = res.expect_err("no ollama server on 127.0.0.1:1");
                assert!(
                    !msg.contains("blocked to prevent SSRF"),
                    "ollama must bypass the SSRF guard, but it was blocked: {msg}"
                );
            }
            // Still connecting at the 5 s bound → the guard did not block → exempt.
            Err(_elapsed) => {}
        }
    }
}
