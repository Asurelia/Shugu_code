use futures_util::StreamExt;
use serde::Deserialize;
use tauri::Emitter;
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
    abort: Option<Arc<AtomicBool>>,
    on_chunk: &mut (dyn FnMut(&str, &str) + Send),
) -> Result<AssistantTurn, String> {
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let mut system_parts: Vec<String> = Vec::new();
    let mut convo: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        if m.role == "system" {
            system_parts.push(m.content.clone());
        } else {
            convo.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
    }
    // Tool-use turns produce more output (tool_call JSON + commentary);
    // bump the cap. Non-tool turns keep the 1024 default to preserve
    // chat_send's existing latency profile.
    let max_tokens: u32 = if with_tools { 4096 } else { 1024 };
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "stream": true,
        "messages": convo,
    });
    if !system_parts.is_empty() {
        body["system"] = serde_json::Value::String(system_parts.join("\n\n"));
    }
    if with_tools {
        body["tools"] = tools_json_anthropic();
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
                                b.tool_input_acc.push_str(partial);
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

    let messages_json: Vec<_> = messages
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "messages": messages_json,
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
        body["tools"] = tools_json_openai();
        body["tool_choice"] = serde_json::json!("auto");
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
    let mut content_chunks = 0u32;
    let mut reasoning_chunks = 0u32;
    let mut tool_chunks = 0u32;

    eprintln!("[chat:{protocol}] streaming model={model} url={url} with_tools={with_tools}");

    collect_lines(response, abort, |line| {
        let Some(payload) = line.strip_prefix("data: ") else { return };
        // Terminal sentinel — not JSON; just stop accumulating.
        if payload.trim() == "[DONE]" { return }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { return };
        // Visible answer chunk (the standard OpenAI field).
        if let Some(text) = v["choices"][0]["delta"]["content"].as_str() {
            if !text.is_empty() {
                acc.push_str(text);
                content_chunks += 1;
                on_chunk("content", text);
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

    let tool_calls = tc_acc.finish();

    eprintln!(
        "[chat:{protocol}] stream complete — {content_chunks} content + {reasoning_chunks} reasoning + {tool_chunks} tool-call chunks ({} tool_calls assembled)",
        tool_calls.len()
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

    let client = reqwest::Client::new();
    let protocol_str = protocol.as_str();

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
    // longer emit Tauri events themselves — instead they call this
    // closure once per chunk with `(kind, chunk)` where kind ∈ {"content",
    // "reasoning"}. We wrap each call into a ChatDelta and broadcast on
    // `chat://delta` so the existing useChatStream / chat-sync listener
    // path stays unchanged.
    let app_ref = app.clone();
    let conv_id = conversation_id.clone();
    let mut on_chunk = move |kind: &str, chunk: &str| {
        // We only send "content" and "reasoning" through here; map both
        // to the static-str variants the existing ChatDelta type expects.
        let delta_kind: &'static str = if kind == "reasoning" { "reasoning" } else { "content" };
        let delta = ChatDelta {
            conversation_id: conv_id.clone(),
            chunk: chunk.to_string(),
            kind: delta_kind,
            done: false,
        };
        let _ = app_ref.emit("chat://delta", delta);
    };

    // The chat surface never issues tool calls — always pass with_tools:false
    // so the body stays exactly as Phase 1 had it. The new AssistantTurn
    // return type carries `content` + `tool_calls`; we use only `content`
    // here (the `tool_calls` field will be empty since with_tools is false).
    let result: Result<AssistantTurn, String> = match protocol_str {
        "anthropic" => {
            let key = resolve_key(protocol_str, &api_key)?;
            call_anthropic(&client, &base_url, &model, &messages, &key, /* with_tools */ false, abort_flag.clone(), &mut on_chunk).await
        }
        "openai" | "custom" => {
            let key = resolve_key(protocol_str, &api_key)?;
            call_openai_compat(&client, &base_url, &model, &messages, &key, protocol_str, &chat_template_kwargs, /* with_tools */ false, abort_flag.clone(), &mut on_chunk).await
        }
        "ollama" => {
            call_ollama(&client, &base_url, &model, &messages, abort_flag.clone(), &mut on_chunk).await
        }
        other => Err(format!("unsupported protocol: {}", other)),
    };

    // Clean up the abort flag from the registry (always, regardless of result).
    if let Some(id) = &conversation_id {
        if let Ok(mut reg) = abort_registry.0.lock() {
            reg.remove(id);
        }
    }

    let result: Result<String, String> = result.map(|turn| turn.content);

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
