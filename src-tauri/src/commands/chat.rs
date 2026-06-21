use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{Emitter, Manager};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;

use crate::commands::agents::{tools_json_anthropic, tools_json_openai, ToolCall, ToolCallAccumulator};

// ---------------------------------------------------------------------------
// Abort registry — tracks in-flight chat streams so the frontend can cancel.
// ---------------------------------------------------------------------------

/// Per-conversation abort flags.  `chat_send` registers a fresh
/// `Arc<AtomicBool>` when it starts streaming; `chat_abort` looks up the
/// flag and sets it.  `collect_lines` polls the flag on every chunk boundary
/// and returns early when it fires.
///
/// Using Tauri State (`.manage()` in `lib.rs`) rather than a file-level static
/// is the canonical Tauri 2 pattern — the same pattern used by `PtyRegistry`,
/// `LlamaServerState`, and `AgentManagerState`.  A global static Lazy would
/// work but leaks across test harnesses and is harder to mock.
#[derive(Default)]
pub struct ChatAbortRegistry(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

// ────────────────────────────────────────────────────────────────────────
// AssistantTurn — Phase 2 return shape for the streaming helpers.
//
// One assistant turn may include BOTH text content AND tool_calls (a model
// can comment on what it's about to do while emitting tool invocations).
// The runner consumes both fields; `chat_send` ignores `tool_calls` (the
// chat surface never sets `with_tools: true`).
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub(crate) struct AssistantTurn {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
}

/// One message in a chat conversation history, mirroring the OpenAI/Anthropic
/// JSON shape `{role, content}`. Role values accepted: "user", "assistant",
/// "system". The frontend maps its internal "ai" → "assistant" before sending.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Serialize a chat `messages` array into a single prompt for `codex exec`
/// (which takes one prompt, not a messages array). Prior turns become labelled
/// context; the trailing user turn is the task. We drop our `system` message —
/// Codex injects its own system prompt, and forwarding ours risks conflicting
/// instructions.
fn build_codex_prompt(messages: &[ChatMessage]) -> String {
    let mut out = String::new();
    for m in messages {
        if m.role == "system" {
            continue;
        }
        let who = if m.role == "assistant" { "Assistant" } else { "User" };
        out.push_str(who);
        out.push_str(": ");
        out.push_str(&m.content);
        out.push_str("\n\n");
    }
    out.trim_end().to_string()
}

/// Parse a data URL like `data:image/png;base64,iVBORw0KG...` into
/// `(media_type, base64_payload)`. Returns `None` for malformed input or
/// non-base64 encodings (we only support base64 for image attachments —
/// the only format Anthropic/OpenAI accept for vision).
fn parse_data_url(s: &str) -> Option<(String, String)> {
    let rest = s.strip_prefix("data:")?;
    let comma = rest.find(',')?;
    let header = &rest[..comma];
    let payload = &rest[comma + 1..];
    if !header.contains(";base64") {
        return None;
    }
    let media_type = header.split(';').next()?.to_string();
    if media_type.is_empty() {
        return None;
    }
    Some((media_type, payload.to_string()))
}

// Arguments arrive as individual command parameters (matching the pattern
// used by every other command in this crate — fs_read_file, term_spawn, etc.).
// Tauri 2 automatically maps camelCase JS keys (`baseUrl`, `apiKey`,
// `conversationId`) onto snake_case Rust parameter names, so no rename
// attribute is needed.
//
// SECURITY NOTE: For the `custom` protocol the `base_url` value is
// user-supplied and is used directly in an outbound HTTP request — a known
// SSRF surface. This is acceptable for a desktop app where the user configures
// their own providers, but a future improvement should validate against an
// allowlist of user-approved origins before sending.

// ---------------------------------------------------------------------------
// Streaming delta event emitted to the frontend via `chat://delta`.
// ---------------------------------------------------------------------------

/// Streamed chunk from the provider, broadcast to the frontend as a
/// `chat://delta` event.
///
/// `kind` distinguishes the regular visible answer from a model's
/// "reasoning trace" (Qwen 3.5 / DeepSeek-style `<think>...</think>` blocks,
/// returned by modern llama-server in `delta.reasoning_content`). The
/// frontend renders the two streams in distinct UI regions: reasoning in
/// a collapsed/dimmed panel above the visible answer. Without this split
/// the reasoning chunks were silently dropped — the user saw the typing
/// indicator while reasoning happened (often 80% of the generation time
/// for thinking models), then the visible answer arrived "as a block",
/// which read like "no streaming at all".
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatDelta {
    conversation_id: Option<String>,
    chunk: String,
    /// `"content"` for the visible answer, `"reasoning"` for `<think>`
    /// content. The `done` event carries `"content"` purely as a default;
    /// consumers should branch on `done` first.
    kind: &'static str,
    done: bool,
}

/// Coalescing emitter for `chat://delta` — accumulates token-level chunks and
/// broadcasts ONE merged delta per ~50 ms window (or on a content/reasoning
/// kind switch) instead of one event per token. Every `chat://delta` is
/// delivered to BOTH webviews (main + mascot); at 30+ tokens/s the per-token
/// firehose saturated the mascot's main thread (freeze observed 2026-06-13).
/// Same idea as `agents::delta_buffer`, but stream-local: one coalescer lives
/// for the duration of a single `chat_send` / tool loop, no global map.
///
/// Ordering contract: callers MUST `flush()` before emitting anything else on
/// the conversation (`kind:"tool"` activity, `chat://writes`, the terminal
/// `done` delta) so buffered text never arrives after events that follow it.
struct ChatDeltaCoalescer {
    app: tauri::AppHandle,
    conversation_id: Option<String>,
    kind: &'static str,
    acc: String,
    window_start: std::time::Instant,
}

impl ChatDeltaCoalescer {
    const FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

    fn new(app: tauri::AppHandle, conversation_id: Option<String>) -> Self {
        Self {
            app,
            conversation_id,
            kind: "content",
            acc: String::new(),
            window_start: std::time::Instant::now(),
        }
    }

    /// Accumulate one chunk; emits the merged buffer when the kind changes
    /// (content ↔ reasoning must not interleave inside one delta) or when the
    /// current window is older than [`Self::FLUSH_INTERVAL`].
    fn push(&mut self, kind: &str, chunk: &str) {
        let delta_kind: &'static str = if kind == "reasoning" { "reasoning" } else { "content" };
        if self.kind != delta_kind {
            self.flush();
            self.kind = delta_kind;
        }
        if self.acc.is_empty() {
            self.window_start = std::time::Instant::now();
        }
        self.acc.push_str(chunk);
        if self.window_start.elapsed() >= Self::FLUSH_INTERVAL {
            self.flush();
        }
    }

    /// Emit the accumulated buffer as a single non-terminal delta (no-op when
    /// empty, so calling it defensively is free).
    fn flush(&mut self) {
        if self.acc.is_empty() {
            return;
        }
        let delta = ChatDelta {
            conversation_id: self.conversation_id.clone(),
            chunk: std::mem::take(&mut self.acc),
            kind: self.kind,
            done: false,
        };
        let _ = self.app.emit("chat://delta", delta);
    }
}

impl Drop for ChatDeltaCoalescer {
    /// Safety net for early-return paths. `run_chat_tool_loop` flushes
    /// explicitly after each streamed turn, but a mid-stream provider error
    /// (`call_*_structured(...).await?`) returns via `?` BEFORE that flush —
    /// the last <50 ms of streamed text would be lost. Dropping the coalescer
    /// at every scope exit flushes that tail. On the success path `acc` is
    /// already empty after the explicit flush, so this is a no-op (and the
    /// owning function returns before the caller emits its terminal `done`
    /// delta, so ordering is preserved).
    fn drop(&mut self) {
        self.flush();
    }
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/// Returns the API key to use for the given protocol.
///
/// Priority: explicit `api_key` arg (non-empty) → env var (if set) → empty
/// string for every protocol EXCEPT Anthropic.
///
/// Why empty is OK for openai/custom/ollama:
///   - Ollama doesn't authenticate requests at all.
///   - llama.cpp's `llama-server`, LM Studio, vLLM, and similar local
///     OpenAI-compat servers either don't require a key or accept any value;
///     when no key is provided we OMIT the `Authorization` header entirely
///     downstream in `call_openai_compat`.
///   - A remote OpenAI-compat endpoint that DOES require a key will reject
///     with a clear HTTP 401 — surfacing that as the visible error is better
///     UX than a pre-emptive "no API key" before we've even tried.
///
/// Clients HTTP partagés (lot timeouts 2026-06-10) — avant ça, chaque site
/// faisait `reqwest::Client::new()` SANS timeout : un provider qui ne répond
/// plus pendait indéfiniment (chat, FIM, runner d'agents, images).
///
/// `streaming_client` — pour les appels LLM en streaming (SSE/NDJSON) : connect
/// borné + `read_timeout` = silence max entre DEUX chunks, PAS une durée totale
/// (une longue réponse reste vivante tant qu'elle émet). 300 s couvre le
/// prompt-processing lent d'un llama.cpp CPU sur gros contexte tout en
/// décoinçant un pair mort.
pub(crate) fn streaming_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// `request_client` — pour les appels one-shot (JSON, pas de stream) : deadline
/// TOTALE dure en plus du connect borné.
pub(crate) fn request_client(total_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(total_secs))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Anthropic always needs `x-api-key` to be set, so we still hard-fail there.
pub(crate) fn resolve_key(protocol: &str, api_key: &Option<String>) -> Result<String, String> {
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
        "openai" => Ok(std::env::var("OPENAI_API_KEY").unwrap_or_default()),
        "custom" => Ok(std::env::var("SHUGU_CUSTOM_API_KEY").unwrap_or_default()),
        other => Err(format!("unsupported protocol: {}", other)),
    }
}

// ---------------------------------------------------------------------------
// SSRF allowlist for the `custom` provider base_url
//
// The `custom` protocol takes a user-supplied `base_url` that is used VERBATIM
// in an outbound HTTP request from the Rust backend (which, unlike the webview,
// is not constrained by the app CSP). A malicious or careless config value can
// therefore be pointed at internal infrastructure — a cloud metadata endpoint
// (169.254.169.254), a service bound to loopback, or another host on the
// private LAN — turning the chat command into a Server-Side Request Forgery
// pivot. We refuse such targets by default.
//
// Policy (custom protocol only — the built-in anthropic/openai/ollama paths are
// untouched):
//   * Reject when the host is a loopback / private / link-local / CGNAT /
//     unique-local / unspecified IP literal, or the name "localhost" (and the
//     IPv6 loopback name). Both raw IPv4/IPv6 literals AND IPv4-mapped IPv6
//     (`::ffff:a.b.c.d`) are classified.
//   * Allow public IPs and ordinary hostnames. We deliberately do NOT resolve
//     DNS here: a name → private-IP rebind is a TOCTOU we cannot win at this
//     layer (the resolved address can change between our check and reqwest's
//     connect), and blocking on a *speculative* resolution would break
//     legitimate public hosts behind split-horizon DNS. Hostname targets are
//     the user's own configured provider; the literal-IP guard covers the
//     realistic SSRF-pivot shapes.
//   * Explicit override: set `SHUGU_CUSTOM_ALLOW_PRIVATE=1` to permit private /
//     loopback targets (the common case being a self-hosted OpenAI-compatible
//     server on the LAN or localhost that the user runs ON PURPOSE).
//   * Scheme: only `http` / `https` are accepted. A non-TLS `http://` target is
//     allowed but logged with a warning — local servers legitimately speak
//     plain HTTP, so this is advisory, not fatal.
// ---------------------------------------------------------------------------

/// Environment override that re-enables private/loopback `custom` base URLs.
const CUSTOM_ALLOW_PRIVATE_ENV: &str = "SHUGU_CUSTOM_ALLOW_PRIVATE";

/// True when the user opted in to private/loopback custom endpoints.
fn custom_allow_private() -> bool {
    matches!(
        std::env::var(CUSTOM_ALLOW_PRIVATE_ENV).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("on")
    )
}

/// Classify an [`std::net::IpAddr`] as non-routable / internal for SSRF
/// purposes. Covers, across both families:
///   * loopback (127.0.0.0/8, ::1)
///   * unspecified (0.0.0.0, ::)
///   * IPv4 private (10/8, 172.16/12, 192.168/16) + link-local (169.254/16)
///     + CGNAT shared address space (100.64/10)
///   * IPv6 unique-local (fc00::/7) + link-local (fe80::/10)
///   * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) — re-classified via the embedded v4.
fn is_internal_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // 100.64.0.0/10 — Carrier-Grade NAT (shared address space,
                // RFC 6598). `Ipv4Addr::is_shared` is unstable, so test the
                // /10 prefix by hand: first octet 100, second octet 64..=127.
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            // IPv4-mapped addresses (`::ffff:a.b.c.d`, the 64:ff9b-free
            // ::ffff:0:0/96 block) embed a v4 address; classify by that embedded
            // address so `::ffff:127.0.0.1` is caught just like `127.0.0.1`.
            // (`Ipv6Addr::to_ipv4` is intentionally NOT used — it is deprecated
            // because it also matches the deprecated IPv4-compatible range and
            // misclassifies `::1`.)
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_internal_ip(IpAddr::V4(v4));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                // fe80::/10 link-local.
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // fc00::/7 unique-local.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

/// Validate a `custom`-protocol `base_url` against the SSRF allowlist.
///
/// Returns `Ok(())` when the URL may be requested, or `Err(message)` with a
/// user-facing explanation (including the override hint) when it must be
/// blocked. Emits an `eprintln!` warning for non-TLS `http://` targets. See the
/// module section comment above for the full policy.
pub(crate) fn validate_custom_base_url(base_url: &str) -> Result<(), String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err("custom provider base_url is empty".to_string());
    }

    // `reqwest::Url` is `url::Url` re-exported — parse with the dependency we
    // already pull in (no new crate).
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|e| format!("custom provider base_url is not a valid URL: {e}"))?;

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "custom provider base_url must use http or https (got {scheme:?})"
        ));
    }

    let allow_private = custom_allow_private();

    // Host classification. We read the host as a string (the `url` crate is a
    // transitive-only dependency, so we deliberately avoid naming `url::Host`)
    // and decide IP-literal vs domain ourselves via `IpAddr::from_str`. The
    // brackets that `host_str()` keeps around IPv6 literals are stripped just
    // below before parsing.
    let host = parsed
        .host_str()
        .ok_or_else(|| "custom provider base_url has no host".to_string())?;

    // `host_str()` keeps the surrounding brackets for IPv6 literals
    // (`[::1]`, `[::ffff:127.0.0.1]`). Strip them before attempting to parse the
    // host as an IP; otherwise the literal falls through to the domain branch
    // and bypasses the IP classification entirely.
    let ip_candidate = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);

    if let Ok(ip) = ip_candidate.parse::<std::net::IpAddr>() {
        // Literal IP target — apply the full internal-range classification.
        if !allow_private && is_internal_ip(ip) {
            return Err(blocked_host_message(host));
        }
    } else {
        // Domain target — block only the canonical loopback names by string
        // match (they never appear as IP literals but resolve to loopback
        // everywhere). Public/private hostname resolution is intentionally NOT
        // performed here (see the policy note above).
        let lower = host.to_ascii_lowercase();
        let is_loopback_name = lower == "localhost"
            || lower.ends_with(".localhost")
            || lower == "ip6-localhost"
            || lower == "ip6-loopback";
        if !allow_private && is_loopback_name {
            return Err(blocked_host_message(host));
        }
    }

    // Advisory (non-fatal) warning for cleartext transport. Local servers
    // legitimately speak plain HTTP, so we never block on this — we just make
    // the cleartext hop visible in the logs.
    if scheme == "http" {
        eprintln!(
            "[chat:custom] WARNING base_url uses cleartext http (no TLS): {trimmed} — \
             API keys and prompts travel unencrypted to this host"
        );
    }

    Ok(())
}

/// Shared "blocked" error body, including the opt-out hint.
fn blocked_host_message(host: &str) -> String {
    format!(
        "custom provider base_url points at a private/loopback host ({host}) — blocked to \
         prevent SSRF. Set {CUSTOM_ALLOW_PRIVATE_ENV}=1 to allow self-hosted/LAN endpoints."
    )
}

// ---------------------------------------------------------------------------
// Shared line-buffered stream reader
// ---------------------------------------------------------------------------

/// Drains a `bytes_stream()` response into complete UTF-8 lines via a
/// byte-level buffer.  Handles arbitrary chunk boundaries (including chunks
/// that split multi-byte UTF-8 sequences mid-codepoint) by accumulating raw
/// bytes and slicing only at `\n` boundaries.
///
/// `abort`: optional shared flag — when `Some(flag)` is provided, the loop
/// checks `flag.load(Relaxed)` before every network-read iteration and
/// returns `Ok(())` immediately (graceful truncation) when the flag is set.
/// This is the sole abort path for `chat_abort`; the closure cannot signal
/// early termination by itself because it can only `return`, not `break` the
/// outer `while let`.
pub(crate) async fn collect_lines<F>(
    response: reqwest::Response,
    abort: Option<Arc<AtomicBool>>,
    mut on_line: F,
) -> Result<(), String>
where
    F: FnMut(&str),
{
    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        // Check abort flag before processing each network chunk.
        if let Some(ref flag) = abort {
            if flag.load(Ordering::Relaxed) {
                return Ok(());
            }
        }
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
/// Phase 2: handles BOTH text content (`content_block_delta` with
/// `delta.type == "text_delta"`) AND tool_use blocks (`content_block_start`
/// with `content_block.type == "tool_use"` + subsequent `input_json_delta`
/// fragments). The tool_use input JSON is accumulated per-block-index and
/// drained into `AssistantTurn.tool_calls` at stream end.
///
/// `with_tools` toggles two things:
///   * adds the `tools` body field with [`tools_json_anthropic`] entries
///   * bumps `max_tokens` from 1024 → 4096 (tool-use turns include a
///     full tool_call JSON payload + text commentary; 1024 truncates in
///     practice)
///
/// The `on_chunk` callback is the SOLE side-effect destination for text
/// content. For tool_use block accumulation we keep state inside this
/// function (a `HashMap<usize, BlockState>`) — the runner sees the
/// completed tool_calls via the return value, not via the callback.
pub(crate) async fn call_anthropic(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    messages: &[ChatMessage],
    api_key: &str,
    with_tools: bool,
    attached_image: Option<&str>,
    abort: Option<Arc<AtomicBool>>,
    on_chunk: &mut (dyn FnMut(&str, &str) + Send),
) -> Result<AssistantTurn, String> {
    // Flat-history entry: project `&[ChatMessage]` into the Anthropic wire
    // shape (system extracted to the top-level field, last user message gets
    // the optional image), then delegate to the structured core. Output is
    // byte-identical to the pre-refactor body — chat_send is unaffected.
    let mut system_parts: Vec<String> = Vec::new();
    let mut convo: Vec<serde_json::Value> = Vec::new();
    // For vision: the image (if any) attaches to the LAST user message. We
    // identify that index up front so we can build multimodal content blocks
    // only for that single message.
    let last_user_idx = messages.iter().rposition(|m| m.role == "user");
    for (i, m) in messages.iter().enumerate() {
        if m.role == "system" {
            system_parts.push(m.content.clone());
            continue;
        }
        let is_last_user = Some(i) == last_user_idx;
        if is_last_user {
            if let Some(dataurl) = attached_image {
                if let Some((media_type, b64)) = parse_data_url(dataurl) {
                    convo.push(serde_json::json!({
                        "role": "user",
                        "content": [
                            { "type": "text", "text": m.content },
                            { "type": "image", "source": { "type": "base64", "media_type": media_type, "data": b64 } }
                        ]
                    }));
                    continue;
                }
            }
        }
        convo.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };
    call_anthropic_structured(
        client, base_url, model, convo, system, api_key, with_tools, /* tools */ None, abort,
        on_chunk,
    )
    .await
}

/// Structured Anthropic entry — takes a pre-built `messages` JSON array (native
/// `tool_use` / `tool_result` content blocks for the agent loop) + an explicit
/// `system` string. Shares the exact body assembly + SSE state machine with the
/// flat `call_anthropic` wrapper above (which builds `messages` from
/// `&[ChatMessage]`). Lot 3 — replaces the agent runner's degraded text
/// projection with native multi-turn tool messages.
///
/// `tools`: optional custom tool schema (Anthropic shape: array of
/// `{name, description, input_schema}`). When `Some`, it OVERRIDES the default
/// agent tool set — this is how the chat tool loop (Lot A — Task 11) injects its
/// read/write subset (`chat_tools::chat_tools_json_anthropic`). When `None` and
/// `with_tools` is true, the default `tools_json_anthropic()` (full agent set)
/// is used, so the agent runner's behavior is byte-identical to before.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn call_anthropic_structured(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    messages: Vec<serde_json::Value>,
    system: Option<String>,
    api_key: &str,
    with_tools: bool,
    tools: Option<serde_json::Value>,
    abort: Option<Arc<AtomicBool>>,
    on_chunk: &mut (dyn FnMut(&str, &str) + Send),
) -> Result<AssistantTurn, String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    // Tool-use turns produce more output (tool_call JSON + commentary);
    // bump the cap. Non-tool turns keep the 1024 default to preserve
    // chat_send's existing latency profile.
    let max_tokens: u32 = if with_tools { 4096 } else { 1024 };
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": true,
        "messages": messages,
    });
    if let Some(sys) = system {
        if !sys.is_empty() {
            body["system"] = serde_json::Value::String(sys);
        }
    }
    if with_tools {
        // Custom tools (the chat read/write subset) override the default agent
        // tool set when provided; otherwise fall back to the full agent tools.
        body["tools"] = tools.unwrap_or_else(tools_json_anthropic);
        // Anthropic auto-selects when tools are present — no tool_choice
        // field needed (default behavior is "auto").
    }

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

    // ── Streaming state machine ──────────────────────────────────────
    //
    // Anthropic emits content blocks of two types we care about: "text"
    // and "tool_use". Each is identified by an `index` field. We track
    // the kind + accumulated content per block so we can drain them at
    // stream-end into the appropriate field of the AssistantTurn.

    #[derive(Default)]
    struct BlockState {
        kind: String,
        tool_id: String,
        tool_name: String,
        tool_input_acc: String,
    }
    let mut blocks: std::collections::HashMap<usize, BlockState> = std::collections::HashMap::new();
    let mut text_acc = String::new();

    collect_lines(response, abort, |line| {
        let Some(payload) = line.strip_prefix("data: ") else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { return };

        match v["type"].as_str() {
            Some("content_block_start") => {
                let idx = v["index"].as_u64().unwrap_or(0) as usize;
                let cb = &v["content_block"];
                let kind = cb["type"].as_str().unwrap_or("text").to_string();
                let entry = blocks.entry(idx).or_default();
                entry.kind = kind.clone();
                if kind == "tool_use" {
                    entry.tool_id = cb["id"].as_str().unwrap_or("").to_string();
                    entry.tool_name = cb["name"].as_str().unwrap_or("").to_string();
                }
            }
            Some("content_block_delta") => {
                let idx = v["index"].as_u64().unwrap_or(0) as usize;
                let delta = &v["delta"];
                match delta["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(text) = delta["text"].as_str() {
                            text_acc.push_str(text);
                            on_chunk("content", text);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(partial) = delta["partial_json"].as_str() {
                            if let Some(b) = blocks.get_mut(&idx) {
                                // N'accumuler QUE pour un vrai bloc client `tool_use`.
                                // Avec la recherche native Anthropic, des blocs
                                // `server_tool_use` peuvent émettre leur propre
                                // input_json_delta ; sans ce garde, leurs args
                                // pourraient contaminer un tool-call client partageant
                                // le même index SSE (revue indépendante).
                                if b.kind == "tool_use" {
                                    b.tool_input_acc.push_str(partial);
                                }
                            }
                            // Signal — the agent runner will use this to
                            // update the UI "tool args streaming" indicator
                            // in the future. For now the runner ignores
                            // kind="tool_use_block" deltas (silent).
                            on_chunk("tool_use_block", "");
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    })
    .await?;

    // Drain tool_use blocks into ToolCall values.
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    // Iterate in index order so multi-tool turns preserve a stable order.
    let mut idxs: Vec<usize> = blocks.keys().copied().collect();
    idxs.sort();
    for idx in idxs {
        if let Some(b) = blocks.remove(&idx) {
            if b.kind == "tool_use" && !b.tool_id.is_empty() {
                tool_calls.push(ToolCall {
                    id: b.tool_id,
                    name: b.tool_name,
                    arguments: b.tool_input_acc,
                });
            }
        }
    }

    Ok(AssistantTurn {
        content: text_acc,
        tool_calls,
    })
}

/// OpenAI-compatible SSE streaming (`data: {...}` / `data: [DONE]`).
///
/// Requests `"stream": true`. Surfaces both `choices[0].delta.content`
/// (kind="content") and `choices[0].delta.reasoning_content` (kind=
/// "reasoning") to the `on_chunk` callback. Stops on literal `[DONE]`.
///
/// `chat_template_kwargs` (when Some) is forwarded as a top-level body
/// field — llama-server's OpenAI-compat extension forwards this to the
/// Jinja chat template renderer. Today's main use is `{"enable_thinking":
/// false}` to suppress the Qwen 3.5 / DeepSeek `<think>` prefix on
/// per-request basis (the model still SUPPORTS thinking; we just don't
/// ask the template to inject the trigger). Other providers ignore the
/// field if they don't recognise it.
pub(crate) async fn call_openai_compat(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    messages: &[ChatMessage],
    api_key: &str,
    protocol: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    with_tools: bool,
    attached_image: Option<&str>,
    abort: Option<Arc<AtomicBool>>,
    on_chunk: &mut (dyn FnMut(&str, &str) + Send),
) -> Result<AssistantTurn, String> {
    // Flat-history entry: project `&[ChatMessage]` into the OpenAI wire shape
    // (last user message gets the optional image), then delegate to the
    // structured core. Output is byte-identical to the pre-refactor body —
    // chat_send is unaffected.
    let last_user_idx = messages.iter().rposition(|m| m.role == "user");
    let messages_json: Vec<serde_json::Value> = messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let is_last_user = Some(i) == last_user_idx;
            if is_last_user {
                if let Some(dataurl) = attached_image {
                    // OpenAI accepts the full data URL directly in image_url.
                    // No need to split media_type / base64 like Anthropic.
                    if dataurl.starts_with("data:image/") {
                        return serde_json::json!({
                            "role": "user",
                            "content": [
                                { "type": "text", "text": m.content },
                                { "type": "image_url", "image_url": { "url": dataurl } }
                            ]
                        });
                    }
                }
            }
            serde_json::json!({ "role": m.role, "content": m.content })
        })
        .collect();
    call_openai_compat_structured(
        client, base_url, model, messages_json, api_key, protocol, chat_template_kwargs,
        with_tools, /* tools */ None, abort, on_chunk,
    )
    .await
}

/// Structured OpenAI-compat entry — takes a pre-built `messages` JSON array
/// (native `assistant.tool_calls` + `role:"tool"` result messages for the
/// agent loop). Shares the body assembly + SSE parser with the flat
/// `call_openai_compat` wrapper above. Lot 3 — replaces the agent runner's
/// degraded text projection with native multi-turn tool messages.
///
/// `tools`: optional custom tool schema (OpenAI shape: array of
/// `{type:"function", function:{name, description, parameters}}`). When `Some`,
/// it OVERRIDES the default agent tool set — the chat tool loop (Lot A — Task
/// 11) injects its read/write subset (`chat_tools::chat_tools_json_openai`).
/// When `None` and `with_tools` is true, the default `tools_json_openai()`
/// (full agent set) is used, so the agent runner's behavior is unchanged.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn call_openai_compat_structured(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    messages: Vec<serde_json::Value>,
    api_key: &str,
    protocol: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    with_tools: bool,
    tools: Option<serde_json::Value>,
    abort: Option<Arc<AtomicBool>>,
    on_chunk: &mut (dyn FnMut(&str, &str) + Send),
) -> Result<AssistantTurn, String> {
    // Normalise: strip trailing slash, then decide whether to append /v1.
    let base = base_url.trim_end_matches('/');
    let url = if base.ends_with("/v1") {
        format!("{}/chat/completions", base)
    } else {
        format!("{}/v1/chat/completions", base)
    };

    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages,
    });
    if let Some(kwargs) = chat_template_kwargs {
        body["chat_template_kwargs"] = kwargs.clone();
    }
    if with_tools {
        // OpenAI tool-use wire format. `tool_choice: "auto"` lets the
        // model decide whether to call a tool or answer directly —
        // alternatives are "none" (text-only) or `{type:"function",
        // function:{name:"X"}}` (force a specific tool). Auto matches
        // the agent runtime contract where the orchestrator decides.
        // Custom tools (the chat read/write subset) override the default agent
        // tool set when provided; otherwise fall back to the full agent tools.
        body["tools"] = tools.unwrap_or_else(tools_json_openai);
        body["tool_choice"] = serde_json::json!("auto");
    }
    // Recherche NATIVE OpenAI : les modèles `*-search-preview` cherchent le web
    // quand `web_search_options` est présent (résultats fondus dans le texte
    // final — aucun changement de parsing SSE). Inoffensif sur les modèles qui
    // ne reconnaissent pas le champ. Gate sur le nom de modèle (le choix d'un
    // modèle « search » EST le consentement de l'utilisateur).
    if crate::commands::search::openai_model_has_native_search(model) {
        body["web_search_options"] = serde_json::json!({});
    }

    // Local OpenAI-compat servers (llama.cpp, LM Studio, vLLM, …) often
    // don't accept ANY `Authorization` header. Send the Bearer only when we
    // actually have a key — remote endpoints that need one will still get
    // it; local endpoints stay clean.
    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }
    let response = req.send().await.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("{} API error {}: {}", protocol, status, text));
    }

    let mut acc = String::new();
    let mut tc_acc = ToolCallAccumulator::default();
    // Filtre MiniMax : sépare le `delta.content` en {prose visible propre,
    // raisonnement <think>, blocs d'outils XML}. No-op pour les providers qui
    // n'émettent aucun de ces marqueurs (OpenAI, Claude…) → zéro régression.
    let mut mm = crate::commands::chat_minimax::MinimaxContentFilter::new();
    let mut content_chunks = 0u32;
    let mut reasoning_chunks = 0u32;
    let mut tool_chunks = 0u32;

    eprintln!("[chat:{protocol}] streaming model={model} url={url} with_tools={with_tools}");

    collect_lines(response, abort, |line| {
        let Some(payload) = line.strip_prefix("data: ") else { return };
        // Terminal sentinel — not JSON; just stop accumulating.
        if payload.trim() == "[DONE]" { return }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { return };
        // Visible answer chunk (the standard OpenAI field). Routé via le filtre
        // MiniMax : le `<think>` part en reasoning, les blocs d'outils XML sont
        // mis de côté, et SEULE la prose visible nettoyée nourrit `acc` +
        // le canal "content". Les fragments retenus (marge anti-coupure) sont
        // vidés par `mm.finish()` après la boucle.
        if let Some(text) = v["choices"][0]["delta"]["content"].as_str() {
            if !text.is_empty() {
                content_chunks += 1;
                let emit = mm.feed(text);
                if !emit.visible.is_empty() {
                    acc.push_str(&emit.visible);
                    on_chunk("content", &emit.visible);
                }
                if !emit.reasoning.is_empty() {
                    reasoning_chunks += 1;
                    on_chunk("reasoning", &emit.reasoning);
                }
            }
        }
        // Reasoning chunk — modern llama-server (and DeepSeek's API)
        // surface `<think>...</think>` content in `delta.reasoning_content`
        // when the model's chat template has thinking enabled (Qwen 3.5,
        // DeepSeek-R1, Llama-3.3-Reasoning, …). We forward it to the
        // callback with kind="reasoning". We do NOT push reasoning into
        // `acc` (the final reply): the persisted message should only
        // contain the visible answer; the reasoning is ephemeral.
        if let Some(text) = v["choices"][0]["delta"]["reasoning_content"].as_str() {
            if !text.is_empty() {
                reasoning_chunks += 1;
                on_chunk("reasoning", text);
            }
        }
        // Phase 2: tool_call fragments. OpenAI streams partial
        // function.arguments JSON across multiple chunks keyed by
        // `index`. The accumulator assembles them; we drain at the
        // end of the stream into AssistantTurn.tool_calls.
        if v["choices"][0]["delta"]["tool_calls"].is_array() {
            tc_acc.ingest(&v);
            tool_chunks += 1;
            // Signal the runner that a tool_call is being streamed.
            // The agent UI today drops these (the ToolCall event is
            // emitted post-execution as the authoritative entry).
            on_chunk("tool_call_delta", "");
        }
    }).await?;

    // Vide la marge retenue du filtre (dernier fragment de prose/raisonnement).
    let tail = mm.finish();
    if !tail.visible.is_empty() {
        acc.push_str(&tail.visible);
        on_chunk("content", &tail.visible);
    }
    if !tail.reasoning.is_empty() {
        reasoning_chunks += 1;
        on_chunk("reasoning", &tail.reasoning);
    }

    let mut tool_calls = tc_acc.finish();
    // Outils émis en TEXTE par MiniMax (XML natif dans le content) → parsés en
    // ToolCall structurés. La boucle d'outils du chat (et le runner agent, même
    // chemin) les exécute ensuite normalement ; quand le toggle outils est
    // COUPÉ, l'appelant (chemin sans boucle) pose une note via
    // `summarize_tool_calls` plutôt qu'un message vide (il ignore sinon
    // `tool_calls`).
    //
    // Garde anti-double-exécution : on NE parse les blocs texte QUE si le modèle
    // n'a produit AUCUN tool_call natif (`delta.tool_calls`). Un modèle qui
    // émettrait les deux est pathologique — on fait alors confiance au canal
    // natif et on ignore le texte, plutôt que d'exécuter deux fois le même outil.
    let mm_tool_block_count = mm.tool_block_count();
    if mm_tool_block_count > 0 && tool_calls.is_empty() {
        tool_calls = crate::commands::chat_minimax::parse_tool_blocks(mm.tool_blocks(), 0);
    }

    eprintln!(
        "[chat:{protocol}] stream complete — {content_chunks} content + {reasoning_chunks} reasoning + {tool_chunks} tool-call chunks ({} tool_calls assembled, {mm_tool_block_count} minimax-text blocks)",
        tool_calls.len(),
    );

    Ok(AssistantTurn { content: acc, tool_calls })
}

/// Ollama newline-delimited JSON streaming (`/api/chat` with `"stream": true`).
///
/// Each line is a JSON object with `message.content` and a `done` bool.
/// Forwards each `message.content` to the callback as `(kind="content",
/// text)`; stops when `done` is `true`. Ollama doesn't have a separate
/// reasoning channel today — if/when it does, add a `reasoning_content`
/// branch identical to call_openai_compat.
pub(crate) async fn call_ollama(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    messages: &[ChatMessage],
    abort: Option<Arc<AtomicBool>>,
    on_chunk: &mut (dyn FnMut(&str, &str) + Send),
) -> Result<AssistantTurn, String> {
    let url = format!("{}/api/chat", base_url.trim_end_matches('/'));
    let messages_json: Vec<_> = messages
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let body = serde_json::json!({
        "model": model,
        "messages": messages_json,
        "stream": true,
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

    collect_lines(response, abort, |line| {
        if line.is_empty() { return }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
        let Some(text) = v["message"]["content"].as_str() else { return };
        if !text.is_empty() {
            acc.push_str(text);
            on_chunk("content", text);
        }
    }).await?;

    // Phase 2: Ollama tool_use is model-specific and not handled here.
    // We return an empty tool_calls vec so the runner gracefully treats
    // Ollama agents as "text-only" — they can still answer but won't
    // exercise the fs tools. Phase 3 can route specific Ollama models
    // (mistral-nemo, llama3.1) through the OpenAI-compat tool path.
    Ok(AssistantTurn { content: acc, tool_calls: Vec::new() })
}

// ---------------------------------------------------------------------------
// Chat tool loop (Lot A — Task 11)
//
// When the read/write toggles are ON and the protocol natively supports
// tool-use (anthropic / openai / custom), `chat_send` drives a BOUNDED loop
// here instead of a single LLM call. The chat can then READ the workspace
// (fs_read_file / fs_list_dir / fs_search) and — when write tools are enabled —
// WRITE it (fs_write_file / fs_edit). Visibility flows through `chat://delta`
// with `kind:"tool"`; reversibility through a journal emitted on `chat://writes`
// at the end (the front offers "undo this message's changes" — Task 12/13).
//
// Shape mirrors `agents::runner::tool_use_loop` BUT, deliberately:
//   * emits on `chat://delta` / `chat://writes` (NOT `agent://lifecycle`)
//   * persists nothing (no agent_events rows)
//   * injects the CHAT tool subset (chat_tools::chat_tools_json_*) via the new
//     `tools: Option<Value>` param of the structured helpers
//   * resolves the REAL open workspace (runner::get_workspace_root)
// ---------------------------------------------------------------------------

/// Plafond de sécurité du nombre d'allers-retours LLM dans UN tour de chat
/// avec outils. Volontairement haut (MiniMax M3 a 1M de contexte → de longues
/// sessions multi-outils sont légitimes) : ce n'est PAS lui qui doit arrêter
/// le travail normal. La terminaison réelle vient de 3 garde-fous :
///   1. le modèle répond sans tool_call → on retourne (cas nominal) ;
///   2. la DERNIÈRE itération force `with_tools=false` → réponse texte ;
///   3. détection de blocage (même appel d'outil répété) → arrêt net.
/// Le bouton Stop coupe à tout moment. Un plafond fini reste indispensable :
/// une boucle infinie sur une API payante brûlerait le quota sans fin.
const CHAT_TOOL_MAX_ITERS: u32 = 64;

/// Short, human-readable activity label for one tool call, shown inline in the
/// chat via a `chat://delta` of `kind:"tool"`. Pure (no I/O). Derived from the
/// tool name + its args so the user SEES what the assistant is doing.
fn chat_tool_label(name: &str, args: &serde_json::Value) -> String {
    let p = args["path"].as_str().unwrap_or("");
    match name {
        "fs_read_file" => format!("🔍 a lu `{p}`"),
        "fs_list_dir" => format!("📁 a listé `{}`", if p.is_empty() { "." } else { p }),
        "fs_search" => {
            let q = args["query"].as_str().unwrap_or("");
            format!("🔎 grep `{q}`")
        }
        "fs_write_file" => format!("✏️ a écrit `{p}`"),
        "fs_edit" => format!("✏️ a modifié `{p}`"),
        "web_search" => {
            let q = args["query"].as_str().unwrap_or("");
            format!("🌐 a cherché « {q} »")
        }
        "web_fetch" => {
            let u = args["url"].as_str().unwrap_or("");
            format!("🌐 a lu {u}")
        }
        "code_search" => {
            let q = args["query"].as_str().unwrap_or("");
            format!("🧭 recherche sémantique « {q} »")
        }
        // BLOCKER 1 — libellé propre pour un outil MCP : `🔌 server__tool`.
        name if name.starts_with("mcp__") => {
            match crate::commands::mcp::split_namespaced(name) {
                Some((server, tool)) => format!("🔌 {server}__{tool}"),
                None => format!("🔌 {}", name.strip_prefix("mcp__").unwrap_or(name)),
            }
        }
        other => format!("⚙️ {other}"),
    }
}

/// Build the per-protocol request body shape from an `AgentMessage` history,
/// reusing the agent runner's builders so the wire format is identical.
/// Returns `(system, messages)`: Anthropic hoists `system` to a top-level field;
/// the OpenAI path keeps `system` as a `role:"system"` message inside `messages`
/// (so it returns `None` for the separate system here).
fn chat_build_request(
    history: &[crate::commands::agents::runner::AgentMessage],
    protocol: &str,
) -> (Option<String>, Vec<serde_json::Value>) {
    use crate::commands::agents::runner::{build_anthropic_native, build_openai_messages};
    match protocol {
        "anthropic" => {
            // build_anthropic_native returns (messages, system) — swap to the
            // (system, messages) order this helper promises.
            let (messages, system) = build_anthropic_native(history);
            (system, messages)
        }
        // openai / custom: system stays inline as a role:"system" message.
        _ => (None, build_openai_messages(history)),
    }
}

/// Drive the bounded chat tool loop. Returns the final assistant text.
///
/// `journal` accumulates every write performed during the turn (for the
/// `chat://writes` reversibility event the caller emits). When a tool is invoked
/// but no workspace is open, the loop feeds a clear error back to the model
/// instead of touching the filesystem.
#[allow(clippy::too_many_arguments)]
async fn run_chat_tool_loop(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
    api_key: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    messages: &[ChatMessage],
    write_enabled: bool,
    conversation_id: &Option<String>,
    abort: Option<Arc<AtomicBool>>,
    journal: &mut Vec<crate::commands::chat_tools::ChatWriteRecord>,
) -> Result<String, String> {
    use crate::commands::agents::runner::{get_workspace_root, AgentMessage};
    use crate::commands::agents::ToolResult;
    use crate::commands::chat_tools::{
        chat_tools_json_anthropic, chat_tools_json_openai, execute_chat_tool,
    };

    // The workspace root is required to execute ANY tool. We still answer
    // (text-only) when none is open, but a tool call reports the missing
    // workspace to the model rather than touching the filesystem.
    let root = get_workspace_root(app);

    // Project the flat chat history into the richer AgentMessage form so we can
    // append assistant-tool-call + tool-result turns as the loop progresses.
    let mut history: Vec<AgentMessage> = messages
        .iter()
        .map(|m| AgentMessage::Text {
            role: m.role.clone(),
            content: m.content.clone(),
        })
        .collect();

    // Détection de blocage : si le modèle répète le MÊME jeu d'appels d'outils
    // round après round, il ne tient pas compte des résultats (cas typique du
    // round-trip non consommé). On s'arrête alors net plutôt que d'épuiser le
    // budget — et le quota API. Signature = noms+arguments des appels du tour.
    let mut last_sig: Option<String> = None;
    let mut repeat: u32 = 0;

    // One coalescer for ALL loop iterations — flushed after every streamed
    // turn (before tool-activity deltas) so ordering survives the iteration
    // boundaries. See `ChatDeltaCoalescer` for the why.
    let mut coalescer = ChatDeltaCoalescer::new(app.clone(), conversation_id.clone());

    for iter in 0..CHAT_TOOL_MAX_ITERS {
        // The last allowed iteration forces a final text answer (no tools), the
        // same termination guarantee as `runner::tool_use_loop`'s last round.
        let last_iteration = iter == CHAT_TOOL_MAX_ITERS - 1;
        let with_tools = !last_iteration;

        let (system, msgs) = chat_build_request(&history, protocol);

        // The chat tool schema for this protocol (only when tools are allowed).
        // BLOCKER 1 — on fusionne les outils des serveurs MCP ACTIVÉS au tableau
        // de base. Sans serveur MCP activé, `enabled_tools_json` renvoie `[]` →
        // comportement chat strictement identique à avant (non-régression).
        let tools_json: Option<serde_json::Value> = if with_tools {
            let mut arr = match protocol {
                "anthropic" => chat_tools_json_anthropic(write_enabled),
                _ => chat_tools_json_openai(write_enabled),
            };
            let mgr = app.state::<crate::commands::mcp::McpManager>();
            let mcp_tools =
                crate::commands::mcp::enabled_tools_json(app, &mgr, protocol).await;
            if let Some(a) = arr.as_array_mut() {
                a.extend(mcp_tools);
            }
            // Recherche NATIVE (miroir du runner) : sur Claude récent + réglage ON,
            // remplace notre `web_search` client par l'outil serveur Anthropic
            // (on garde `web_fetch` client). Blocs serveur ignorés par le parseur.
            let prefer_native = crate::commands::mcp::read_setting(app, "search.preferNative")
                .as_deref()
                != Some("false");
            if prefer_native
                && protocol == "anthropic"
                && crate::commands::search::model_supports_native_search("anthropic", model)
            {
                if let Some(a) = arr.as_array_mut() {
                    a.retain(|t| t["name"].as_str() != Some("web_search"));
                    a.extend(crate::commands::search::anthropic_server_web_tools());
                }
            }
            Some(arr)
        } else {
            None
        };

        // Live-streaming sink — `content`/`reasoning` chunks feed the shared
        // coalescer (one merged `chat://delta` per ~50 ms instead of one per
        // token), same kind mapping as the legacy chat path. Tool-call
        // activity is emitted SEPARATELY below as `kind:"tool"`, after the
        // post-turn flush so it can never overtake the streamed text.
        let turn: AssistantTurn = match protocol {
            "anthropic" => {
                call_anthropic_structured(
                    client, base_url, model, msgs, system, api_key, with_tools, tools_json,
                    abort.clone(),
                    &mut |kind: &str, chunk: &str| coalescer.push(kind, chunk),
                )
                .await?
            }
            "openai" | "custom" => {
                call_openai_compat_structured(
                    client, base_url, model, msgs, api_key, protocol, chat_template_kwargs,
                    with_tools, tools_json, abort.clone(),
                    &mut |kind: &str, chunk: &str| coalescer.push(kind, chunk),
                )
                .await?
            }
            other => return Err(format!("chat tool loop: unsupported protocol {other}")),
        };

        // The turn's stream is over — flush the buffered tail BEFORE the final
        // answer / tool-activity deltas below so the streamed text always lands
        // first on the frontend (the Drop impl is a backstop for error paths).
        coalescer.flush();

        // Réponse finale dans DEUX cas :
        //   * pas d'appel d'outil (cas nominal) ;
        //   * `with_tools == false` (dernière itération forcée) : on a demandé
        //     une réponse texte, donc on NE ré-exécute PAS d'éventuels appels
        //     d'outils que le modèle aurait quand même émis EN TEXTE (MiniMax
        //     M3 le fait même sans champ `tools`). Sans ce second cas, la
        //     terminaison forcée échouait → « exceeded N iterations ».
        // Le contenu a déjà été streamé live par `sink`, on ne le ré-émet pas.
        if turn.tool_calls.is_empty() || !with_tools {
            let answer = if turn.content.trim().is_empty() && !turn.tool_calls.is_empty() {
                crate::commands::chat_minimax::summarize_tool_calls(&turn.tool_calls)
            } else {
                turn.content
            };
            return Ok(answer);
        }

        // Garde anti-blocage : même signature d'appels répétée ⇒ le modèle
        // n'avance plus (résultats non pris en compte). Arrêt avec un message
        // clair plutôt qu'une boucle qui brûle le quota.
        let sig = turn
            .tool_calls
            .iter()
            .map(|t| format!("{}:{}", t.name, t.arguments))
            .collect::<Vec<_>>()
            .join("|");
        if last_sig.as_deref() == Some(sig.as_str()) {
            repeat += 1;
        } else {
            repeat = 0;
            last_sig = Some(sig);
        }
        if repeat >= 2 {
            let prefix = if turn.content.trim().is_empty() {
                String::new()
            } else {
                format!("{}\n\n", turn.content.trim())
            };
            return Ok(format!(
                "{prefix}⚠ Le modèle a répété le même appel d'outil sans tenir compte des résultats — \
                 arrêt pour éviter une boucle. (Format de retour d'outils possiblement incompatible avec ce modèle.)"
            ));
        }

        // Record the assistant's tool-call turn in history.
        history.push(AgentMessage::AssistantWithTools {
            content: turn.content.clone(),
            tool_calls: turn.tool_calls.clone(),
        });

        // Execute each tool call, emitting a visibility delta first.
        let mut results: Vec<ToolResult> = Vec::new();
        for tc in &turn.tool_calls {
            let args: serde_json::Value =
                serde_json::from_str(&tc.arguments).unwrap_or_else(|_| serde_json::json!({}));

            // Visibility — a short activity line, emitted with kind:"tool".
            let _ = app.emit(
                "chat://delta",
                ChatDelta {
                    conversation_id: conversation_id.clone(),
                    chunk: chat_tool_label(&tc.name, &args),
                    kind: "tool",
                    done: false,
                },
            );

            // Execute the tool. BLOCKER 1 — les outils MCP (`mcp__server__tool`)
            // sont routés vers le manager MCP AVANT les outils fs workspace. Ils
            // ne dépendent pas du workspace et n'alimentent PAS le journal
            // d'annulation (qui ne concerne que les écritures fs locales).
            let (content, is_error) = if tc.name == "web_search" {
                // Recherche web (lecture seule) — async via le client reqwest.
                let query = args["query"].as_str().unwrap_or("").trim();
                let max = args["max_results"].as_u64().unwrap_or(5).clamp(1, 10) as usize;
                if query.is_empty() {
                    ("web_search: champ requis manquant : query".to_string(), true)
                } else {
                    crate::commands::search::web_search(client, query, max).await
                }
            } else if tc.name == "web_fetch" {
                // Lecture d'une page (lecture seule) — async.
                let url = args["url"].as_str().unwrap_or("").trim();
                let max_chars =
                    args["max_chars"].as_u64().unwrap_or(48_000).clamp(500, 200_000) as usize;
                if url.is_empty() {
                    ("web_fetch: champ requis manquant : url".to_string(), true)
                } else {
                    crate::commands::search::web_fetch(client, url, max_chars).await
                }
            } else if tc.name == "code_search" {
                // Recherche sémantique sur l'index vectoriel (lecture seule).
                let query = args["query"].as_str().unwrap_or("").trim();
                let k = args["k"].as_u64().unwrap_or(8).clamp(1, 20) as u32;
                if query.is_empty() {
                    ("code_search: champ requis manquant : query".to_string(), true)
                } else {
                    match crate::commands::vector::vec_search_internal(app, "code", query, k) {
                        Ok(hits) if hits.is_empty() => (
                            "aucun résultat sémantique — l'index n'est peut-être pas encore construit. \
                             Utilise fs_search (littéral/regex) à la place."
                                .to_string(),
                            false,
                        ),
                        Ok(hits) => (
                            format!(
                                "{} résultats (proximité croissante, `path#Lstart-end` — lis-les avec fs_read_file) :\n{}",
                                hits.len(),
                                hits.iter()
                                    .map(|h| format!("  {:.3}  {}", h.distance, h.id))
                                    .collect::<Vec<_>>()
                                    .join("\n"),
                            ),
                            false,
                        ),
                        Err(e) => (format!("code_search a échoué : {e}"), true),
                    }
                }
            } else if tc.name.starts_with("mcp__") {
                let mgr = app.state::<crate::commands::mcp::McpManager>();
                crate::commands::mcp::mcp_execute(app, &mgr, &tc.name, &args).await
            } else {
                // Outils fs : exécutés contre le vrai workspace (ou erreur si aucun).
                match &root {
                    Some(r) => execute_chat_tool(&tc.name, &args, r, write_enabled, journal),
                    None => (
                        "aucun workspace ouvert — impossible d'exécuter l'outil".to_string(),
                        true,
                    ),
                }
            };

            results.push(ToolResult {
                id: tc.id.clone(),
                name: tc.name.clone(),
                is_error,
                content,
            });
        }

        // Feed the results back and loop again.
        history.push(AgentMessage::ToolResults(results));
    }

    // Unreachable in practice: the last iteration runs with_tools=false, so the
    // model must return a tool-call-free answer (handled above). Defensive.
    Err(format!(
        "chat tool loop exceeded {CHAT_TOOL_MAX_ITERS} iterations without a final answer"
    ))
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
/// When `conversation_id` is `Some(id)`, a fresh `Arc<AtomicBool>` abort flag
/// is registered in `ChatAbortRegistry` for the duration of the stream.  The
/// companion `chat_abort` command sets the flag, causing `collect_lines` to
/// return early on the next chunk boundary.  The flag is always cleaned up
/// (removed from the registry) before `chat_send` returns, regardless of
/// success, abort, or error.
///
/// Follow-up TODOs:
/// - Per-message history: thread `conversation_id` through a message store and
///   pass the full history in the `messages` array.
/// - SSRF allowlist: for `custom` protocol, validate `base_url` against a
///   user-managed allowlist before making any outbound request.
/// - Error mid-stream UX: emit a `done: true` delta with an `error` field so
///   the frontend can display partial text + an error indicator.
#[tauri::command]
pub async fn chat_send(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
    model: String,
    protocol: String,
    base_url: String,
    api_key: Option<String>,
    conversation_id: Option<String>,
    chat_template_kwargs: Option<serde_json::Value>,
    // Codex-only: reasoning effort (none|minimal|low|medium|high|xhigh) passed
    // natively to the app-server `turn/start`. Ignored by the API protocols.
    reasoning_effort: Option<String>,
    // Optional `data:image/...;base64,...` URL for vision-enabled models.
    // When provided, it's injected into the LAST user message as a
    // multimodal content block (Anthropic `type:image` / OpenAI `image_url`).
    // Ignored by the ollama path (Ollama vision uses a different payload
    // shape that's out of MVP scope).
    attached_image: Option<String>,
    // Lot A — Task 11/12: chat fs tool loop toggles. Tauri maps the camelCase JS
    // args (`readTools` / `writeTools`) onto these snake_case params. When
    // `read_tools == Some(true)` and the protocol natively supports tool-use,
    // chat_send drives a bounded fs tool loop (read always, write if write_tools).
    // Absent/None ⇒ legacy single-call path (zero regression).
    read_tools: Option<bool>,
    write_tools: Option<bool>,
    abort_registry: tauri::State<'_, ChatAbortRegistry>,
) -> Result<String, String> {
    let model = if model.is_empty() {
        "claude-haiku-4-5".to_string()
    } else {
        model
    };

    if messages.is_empty() {
        return Err("messages array is empty".into());
    }

    let client = streaming_client()?;
    let protocol_str = protocol.as_str();

    // SSRF guard — the `custom` protocol routes a user-supplied base_url into an
    // outbound backend request (not constrained by the webview CSP). Reject
    // private/loopback targets unless explicitly allowed. The built-in
    // anthropic/openai/ollama paths use trusted/known endpoints and are exempt.
    if protocol_str == "custom" {
        validate_custom_base_url(&base_url)?;
    }

    // Register an abort flag for this conversation (if we have an ID).
    // The flag is shared between the streaming loop and the abort command.
    let abort_flag: Option<Arc<AtomicBool>> = conversation_id.as_ref().map(|id| {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut reg) = abort_registry.0.lock() {
            reg.insert(id.clone(), Arc::clone(&flag));
        }
        flag
    });

    // Build the chat-channel emit callback. The streaming helpers no
    // longer emit Tauri events themselves — instead they feed the coalescer
    // once per chunk with `(kind, chunk)` where kind ∈ {"content",
    // "reasoning"}. Chunks are merged into ONE `chat://delta` per ~50 ms
    // window instead of one broadcast per token; the existing useChatStream /
    // chat-sync listener path is unchanged, it just receives bigger chunks
    // less often.
    let mut coalescer = ChatDeltaCoalescer::new(app.clone(), conversation_id.clone());
    let mut on_chunk = |kind: &str, chunk: &str| coalescer.push(kind, chunk);

    // The chat surface never issues tool calls — always pass with_tools:false
    // so the body stays exactly as Phase 1 had it. The new AssistantTurn
    // return type carries `content` + `tool_calls`; we use only `content`
    // here (the `tool_calls` field will be empty since with_tools is false).
    let img_ref = attached_image.as_deref();

    // Lot A — Task 11: decide whether to drive the bounded fs tool loop.
    //
    // ALL of these must hold:
    //   * `read_tools == Some(true)` — the frontend toggle is ON. Absent/false
    //     ⇒ the legacy single-call path (zero regression while Task 12 is not
    //     yet wired, and whenever the user turns tools off).
    //   * protocol ∈ {anthropic, openai, custom} — native tool-use wire shape.
    //     ollama/codex keep their existing single-call (and read-only) behavior.
    //   * NO attached image — the structured helpers + AgentMessage builders
    //     don't carry multimodal content, so a vision turn falls back to the
    //     single-call path (vision + tools together is out of scope here).
    let protocol_supports_tools = matches!(protocol_str, "anthropic" | "openai" | "custom");
    let use_tool_loop =
        read_tools == Some(true) && protocol_supports_tools && attached_image.is_none();

    // Journal of writes performed during this turn (stays empty unless the loop
    // runs WITH write tools enabled). Emitted on `chat://writes` at the end so
    // the frontend can offer "undo this message's changes" (Task 12/13).
    let mut journal: Vec<crate::commands::chat_tools::ChatWriteRecord> = Vec::new();

    let result: Result<String, String> = if use_tool_loop {
        let write_enabled = write_tools == Some(true);
        let key = resolve_key(protocol_str, &api_key)?;
        run_chat_tool_loop(
            &app,
            &client,
            protocol_str,
            &base_url,
            &model,
            &key,
            &chat_template_kwargs,
            &messages,
            write_enabled,
            &conversation_id,
            abort_flag.clone(),
            &mut journal,
        )
        .await
    } else {
        // ── Legacy single-call path (behavior unchanged) ──────────────────
        let turn_result: Result<AssistantTurn, String> = match protocol_str {
            "anthropic" => {
                let key = resolve_key(protocol_str, &api_key)?;
                call_anthropic(&client, &base_url, &model, &messages, &key, /* with_tools */ false, img_ref, abort_flag.clone(), &mut on_chunk).await
            }
            "openai" | "custom" => {
                let key = resolve_key(protocol_str, &api_key)?;
                call_openai_compat(&client, &base_url, &model, &messages, &key, protocol_str, &chat_template_kwargs, /* with_tools */ false, img_ref, abort_flag.clone(), &mut on_chunk)
                    .await
                    .map(|mut turn| {
                        // Outils OFF : MiniMax peut quand même émettre des appels
                        // d'outils en texte (parsés en tool_calls), qu'on n'exécute
                        // PAS ici. Si la prose est vide, on pose une note lisible au
                        // lieu d'un message vide ; les tool_calls sont sinon ignorés.
                        if turn.content.trim().is_empty() && !turn.tool_calls.is_empty() {
                            turn.content =
                                crate::commands::chat_minimax::summarize_tool_calls(&turn.tool_calls);
                        }
                        turn
                    })
            }
            "ollama" => {
                // Ollama vision uses a different shape (a top-level `images` field
                // of base64 strings, not multimodal content blocks). Out of MVP
                // scope — image is silently ignored for the ollama path.
                call_ollama(&client, &base_url, &model, &messages, abort_flag.clone(), &mut on_chunk).await
            }
            "codex" => {
                // Codex (ChatGPT subscription, no API key) over the native app-server.
                // It takes a SINGLE prompt, so we serialize the non-system turns into a
                // transcript. ALWAYS read-only here — a chat answer must never mutate
                // files. `model` + `reasoning_effort` come from the picker and are
                // passed natively to `turn/start`. Image attachments out of MVP scope.
                let prompt = build_codex_prompt(&messages);
                let effort = reasoning_effort.as_deref();
                crate::commands::codex::codex_chat_turn(&app, &prompt, Some(model.as_str()), effort, &mut on_chunk)
                    .await
                    .map(|content| AssistantTurn { content, tool_calls: Vec::new() })
            }
            other => Err(format!("unsupported protocol: {}", other)),
        };
        turn_result.map(|turn| turn.content)
    };

    // Stream over (success, abort, or error) — flush any buffered tail before
    // the writes/done events below so the streamed text always lands first.
    coalescer.flush();

    // Clean up the abort flag from the registry (always, regardless of result).
    if let Some(id) = &conversation_id {
        if let Ok(mut reg) = abort_registry.0.lock() {
            reg.remove(id);
        }
    }

    // Emit the write journal (if any) so the frontend can offer reversal. Only a
    // tool loop with write tools enabled ever populates this — the legacy path
    // and read-only loops leave it empty.
    if !journal.is_empty() {
        let _ = app.emit(
            "chat://writes",
            serde_json::json!({
                "conversationId": conversation_id,
                "records": journal,
            }),
        );
    }

    // Emit a terminal `done` delta regardless of success/failure so the
    // frontend always receives a completion signal.
    let done_delta = ChatDelta {
        conversation_id: conversation_id.clone(),
        chunk: String::new(),
        kind: "content",
        done: true,
    };
    let _ = app.emit("chat://delta", done_delta);

    result
}

/// Abort an in-flight `chat_send` for the given conversation.
///
/// Sets the `Arc<AtomicBool>` flag registered by `chat_send` so that
/// `collect_lines` exits on the next chunk boundary.  If no stream is active
/// for `conversation_id` (e.g. the stream already finished), this is a no-op.
#[tauri::command]
pub fn chat_abort(
    conversation_id: String,
    abort_registry: tauri::State<'_, ChatAbortRegistry>,
) {
    if let Ok(reg) = abort_registry.0.lock() {
        if let Some(flag) = reg.get(&conversation_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Lot 5 (scaffold) — complétion Fill-In-the-Middle non-streaming.
///
/// Le tab-autocomplete (ghost text) utilise l'endpoint LEGACY `/v1/completions`
/// (format `prompt`, pas `messages`) car le FIM passe par des sentinelles dans
/// un prompt brut, pas par un tour de chat. Le frontend construit le prompt FIM
/// (cf. fimPrompt.ts) ; ici on poste + on retourne `choices[0].text`.
///
/// Seul le path openai-compatible est supporté (llama.cpp, vLLM, LM Studio,
/// Together…). anthropic/ollama n'exposent pas d'API FIM comparable ici →
/// erreur explicite. ⚠ QUALITÉ/LATENCE = réglage runtime (modèle FIM, taille de
/// fenêtre, max_tokens) : ce lot livre le tuyau, pas le réglage fin.
#[tauri::command]
pub async fn fim_complete(
    prompt: String,
    model: String,
    protocol: String,
    base_url: String,
    api_key: Option<String>,
    max_tokens: Option<u32>,
    stop: Option<Vec<String>>,
) -> Result<String, String> {
    if protocol != "openai" && protocol != "custom" {
        return Err(format!(
            "FIM completion not supported for protocol '{protocol}' — use an openai-compatible FIM endpoint"
        ));
    }
    // Same SSRF guard as chat_send: the `custom` FIM path also sends to a
    // user-supplied base_url from the backend.
    if protocol == "custom" {
        validate_custom_base_url(&base_url)?;
    }
    let key = resolve_key(&protocol, &api_key)?;
    let base = base_url.trim_end_matches('/');
    let url = if base.ends_with("/v1") {
        format!("{}/completions", base)
    } else {
        format!("{}/v1/completions", base)
    };

    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "max_tokens": max_tokens.unwrap_or(128),
        "stream": false,
        "temperature": 0.2,
    });
    if let Some(s) = stop {
        body["stop"] = serde_json::json!(s);
    }

    // FIM = complétion inline : au-delà de 60 s le ghost text n'a plus de sens.
    let client = request_client(60)?;
    let mut req = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body);
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", key));
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("FIM API error {}: {}", status, text));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    // /v1/completions → choices[0].text (certains serveurs renvoient aussi
    // "content" ; on tente text puis content en repli).
    let text = v["choices"][0]["text"]
        .as_str()
        .or_else(|| v["choices"][0]["content"].as_str())
        .unwrap_or("")
        .to_string();
    Ok(text)
}

#[cfg(test)]
mod ssrf_tests {
    use super::{is_internal_ip, validate_custom_base_url};
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("test ip literal")
    }

    #[test]
    fn classifies_loopback_and_private_v4_as_internal() {
        for s in [
            "127.0.0.1",
            "127.1.2.3",
            "10.0.0.1",
            "172.16.5.5",
            "172.31.255.254",
            "192.168.1.1",
            "169.254.169.254", // cloud metadata
            "100.64.0.1",      // CGNAT
            "0.0.0.0",
        ] {
            assert!(is_internal_ip(ip(s)), "{s} should be internal");
        }
    }

    #[test]
    fn classifies_public_v4_as_external() {
        for s in ["8.8.8.8", "1.1.1.1", "52.10.20.30", "172.32.0.1", "100.128.0.1"] {
            assert!(!is_internal_ip(ip(s)), "{s} should be external");
        }
    }

    #[test]
    fn classifies_v6_internal_including_mapped() {
        for s in [
            "::1",                 // loopback
            "::",                  // unspecified
            "fe80::1",             // link-local
            "fc00::1",             // unique-local
            "fdff::1",             // unique-local
            "::ffff:127.0.0.1",    // v4-mapped loopback
            "::ffff:192.168.0.1",  // v4-mapped private
            "::ffff:169.254.169.254",
        ] {
            assert!(is_internal_ip(ip(s)), "{s} should be internal");
        }
    }

    #[test]
    fn classifies_public_v6_as_external() {
        for s in ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"] {
            assert!(!is_internal_ip(ip(s)), "{s} should be external");
        }
    }

    // NOTE: these URL tests assume the default (override env UNSET). They never
    // mutate the process environment, so they stay deterministic under the
    // parallel test runner.

    #[test]
    fn blocks_loopback_name_and_localhost_subdomains() {
        for u in [
            "http://localhost:8090/v1",
            "https://LocalHost/v1",
            "http://api.localhost:1234",
            "http://ip6-localhost",
        ] {
            assert!(validate_custom_base_url(u).is_err(), "{u} should be blocked");
        }
    }

    #[test]
    fn blocks_private_and_metadata_ip_literals() {
        for u in [
            "http://127.0.0.1:8080",
            "http://10.1.2.3/v1",
            "https://192.168.0.10",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]:8080/v1",
            "http://[::ffff:127.0.0.1]:9000",
        ] {
            assert!(validate_custom_base_url(u).is_err(), "{u} should be blocked");
        }
    }

    #[test]
    fn allows_public_hosts_and_ips() {
        for u in [
            "https://api.openai.com/v1",
            "https://my-provider.example.com",
            "https://8.8.8.8/v1",
            "http://example.com", // public host over http: allowed (warned, not blocked)
        ] {
            assert!(validate_custom_base_url(u).is_ok(), "{u} should be allowed");
        }
    }

    #[test]
    fn rejects_non_http_schemes_and_empty() {
        for u in ["", "ftp://example.com", "file:///etc/passwd", "not a url"] {
            assert!(validate_custom_base_url(u).is_err(), "{u:?} should be rejected");
        }
    }
}
