//! Phase 2 — tool definitions, schema, dispatcher, and SSE accumulator.
//!
//! ## What lives here
//!
//! * [`ToolDef`] / [`ToolCall`] / [`ToolResult`] — the in-process types
//!   that thread tool metadata + invocations + results through the
//!   agent runtime.
//! * [`AGENT_TOOLS`] — the closed catalog (3 file-system tools for now;
//!   shell/web/sub-agents come in Phase 3).
//! * [`tools_json_openai`] / [`tools_json_anthropic`] — wire-format
//!   renderers. OpenAI wraps each tool under `{"type":"function","function":{...}}`;
//!   Anthropic uses a flat `{name, description, input_schema}`.
//! * [`ToolCallAccumulator`] — assembles streamed OpenAI `delta.tool_calls`
//!   fragments into complete [`ToolCall`] values. Anthropic's
//!   `content_block_delta` accumulation lives directly in `chat.rs` (it's
//!   event-state-machine code, not a reusable struct).
//! * [`execute_tool`] — the dispatcher. NEVER returns `Err`: any failure
//!   becomes a [`ToolResult`] with `is_error: true` so the LLM sees the
//!   error in the next round and can adapt rather than the agent dying.
//!
//! ## Security
//!
//! Path validation is the responsibility of the inner helpers in
//! `crate::commands::fs` (`safe_resolve` / `safe_resolve_for_write` —
//! both canonicalize before checking that the result lives under the
//! workspace root). This file does NOT re-implement path guards.

use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

/// Provider-agnostic description of a single tool. The `parameters` field
/// is a JSON Schema object the model uses to plan its `arguments` JSON.
#[derive(Clone, Debug, Serialize)]
pub(super) struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: serde_json::Value,
}

/// A single tool invocation decoded from the LLM's streamed response.
/// `arguments` is the raw JSON string the model emitted — we re-parse it
/// in the dispatcher per-tool so each tool gets typed access to its own
/// args shape. Keeping `arguments: String` (not pre-parsed) avoids a
/// useless round-trip through `serde_json::Value` for tools that need
/// the original bytes.
///
/// `pub(crate)` so the streaming helpers in `chat.rs` can build
/// `AssistantTurn { tool_calls: Vec<ToolCall> }`.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// The result of executing one tool call. Always present (never an `Err`
/// from the dispatcher) — failures become `is_error: true` with the
/// reason in `content`. The LLM consumes the next turn with this result
/// and can adapt.
///
/// `pub(crate)` so the chat tool loop in `commands::chat` can build
/// `AgentMessage::ToolResults(Vec<ToolResult>)` for its own multi-turn history
/// (Lot A — Task 11) — same reuse as the agent runner, no duplicate type.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct ToolResult {
    pub id: String,
    pub name: String,
    pub is_error: bool,
    pub content: String,
}

// ────────────────────────────────────────────────────────────────────
// Tool registry — closed set for Phase 2
// ────────────────────────────────────────────────────────────────────

/// Lazily-built static slice. `serde_json::json!` is not `const`-fold-able,
/// so we build the slice via a `OnceLock` rather than a literal `const`.
fn agent_tools() -> &'static [ToolDef] {
    use std::sync::OnceLock;
    static TOOLS: OnceLock<Vec<ToolDef>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        vec![
            ToolDef {
                name: "fs_read_file",
                description: "Read a workspace-relative file and return its UTF-8 content. \
                              Returns an error string when the file is binary, >5 MiB, or outside \
                              the workspace. Without offset/limit, output is capped at 32 KiB with a \
                              truncation sentinel. For a large file, page through it with `offset` \
                              (1-based start line) and `limit` (number of lines).",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Workspace-relative POSIX path, e.g. \"src/lib/db.ts\". \
                                            MUST be relative — absolute or traversal paths are rejected."
                        },
                        "offset": {
                            "type": "integer",
                            "description": "Optional 1-based line to start from (paginated read of a large file)."
                        },
                        "limit": {
                            "type": "integer",
                            "description": "Optional number of lines to return from `offset` (default 400 when offset is set)."
                        }
                    },
                    "required": ["path"]
                }),
            },
            ToolDef {
                name: "fs_write_file",
                description: "Atomically write (or overwrite) a workspace-relative file. Creates \
                              missing parent directories. Rejects paths outside the workspace. \
                              WARNING: overwrites without confirmation — read first if unsure.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Workspace-relative POSIX path."
                        },
                        "content": {
                            "type": "string",
                            "description": "Full UTF-8 content to write."
                        }
                    },
                    "required": ["path", "content"]
                }),
            },
            ToolDef {
                name: "fs_list_dir",
                description: "List the immediate children of a workspace-relative directory. Returns \
                              a JSON array of {name, is_dir} objects. NOT recursive — call again on \
                              each is_dir entry to walk deeper.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Workspace-relative POSIX path. Use \".\" or \"\" for the workspace root."
                        }
                    },
                    "required": ["path"]
                }),
            },
            ToolDef {
                name: "todo_write",
                description: "Record or update your short plan for this task as a checklist. Call this \
                              FIRST to lay out the steps, then again to update statuses as you progress. \
                              Pass the FULL current list each time — the latest call replaces the previous. \
                              Purely advisory: it surfaces your plan to the user and never touches files.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "todos": {
                            "type": "array",
                            "description": "The full current checklist, in order.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "text": {
                                        "type": "string",
                                        "description": "Short imperative step, e.g. \"Write index.html\"."
                                    },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "completed"],
                                        "description": "Step state."
                                    }
                                },
                                "required": ["text", "status"]
                            }
                        }
                    },
                    "required": ["todos"]
                }),
            },
            ToolDef {
                name: "fs_search",
                description: "Search the whole workspace for a pattern (ripgrep-style) and return \
                              matching lines as `path:line: preview`. Use this FIRST to LOCATE where \
                              something is defined or used — far faster and more reliable than listing \
                              and reading files one by one. Literal substring by default; set regex=true \
                              for a Rust regex. Capped at 80 matches.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Text to find. Literal substring unless `regex` is true."
                        },
                        "regex": {
                            "type": "boolean",
                            "description": "If true, treat `query` as a Rust regex. Default false."
                        },
                        "case_sensitive": {
                            "type": "boolean",
                            "description": "Case-sensitive match. Default false (case-insensitive)."
                        }
                    },
                    "required": ["query"]
                }),
            },
            ToolDef {
                name: "fs_edit",
                description: "Surgically edit an EXISTING file: replace one exact, unique snippet with \
                              new text, leaving everything else untouched. PREFER this over fs_write_file \
                              for changes to existing files — no need to reproduce the whole file. \
                              `old_string` must match EXACTLY and appear EXACTLY ONCE (include enough \
                              surrounding lines to be unique), otherwise the edit is rejected so you can \
                              retry with more context.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Workspace-relative POSIX path of the file to edit."
                        },
                        "old_string": {
                            "type": "string",
                            "description": "Exact text to find. Must be unique in the file unless replace_all is true. Copy it verbatim (with context)."
                        },
                        "new_string": {
                            "type": "string",
                            "description": "Replacement text for that snippet."
                        },
                        "replace_all": {
                            "type": "boolean",
                            "description": "If true, replace EVERY occurrence of old_string (e.g. renaming a symbol). Default false (requires a single unique match)."
                        }
                    },
                    "required": ["path", "old_string", "new_string"]
                }),
            },
            ToolDef {
                name: "fs_delete",
                description: "Delete a workspace-relative FILE. Use sparingly and only when the task \
                              calls for it — the user's git history is the safety net. Rejects paths \
                              outside the workspace and directories.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Workspace-relative POSIX path of the file to delete." }
                    },
                    "required": ["path"]
                }),
            },
            ToolDef {
                name: "fs_move",
                description: "Rename or move a workspace-relative file from `from` to `to`. Creates \
                              missing parent directories for the destination. Refuses to overwrite an \
                              existing destination (delete it first if intended).",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "from": { "type": "string", "description": "Existing workspace-relative source path." },
                        "to": { "type": "string", "description": "Workspace-relative destination path." }
                    },
                    "required": ["from", "to"]
                }),
            },
            ToolDef {
                name: "run_command",
                description: "Run a shell command directly in the workspace, with the machine's real \
                              toolchain (node, pnpm, npm, cargo, git…) and network access. Returns the \
                              REAL exit code + stdout + stderr — use it to actually RUN your code/tests, \
                              see what fails, and fix it before finishing. The user's git history is the \
                              safety net: stay surgical, never run destructive commands outside the task.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "Shell command, run in the workspace root. E.g. \"node --test\"."
                        },
                        "timeoutSecs": {
                            "type": "integer",
                            "description": "Wall-clock cap in seconds (default 60, max 300)."
                        }
                    },
                    "required": ["command"]
                }),
            },
            ToolDef {
                name: "capture_screen",
                description: "Capture the user's screen to VERIFY visually what you just built — \
                              the screenshot comes back to you as an IMAGE in the next message, so \
                              you can actually SEE the rendered UI (the user has the app/preview/\
                              browser open on screen). Use it after launching or refreshing a UI \
                              you changed, then state what you observe versus what was expected. \
                              The screenshot also appears in the chat timeline so the user sees \
                              the proof too.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "monitor": {
                            "type": "integer",
                            "description": "Monitor index (omit = primary monitor)."
                        },
                        "delay_ms": {
                            "type": "integer",
                            "description": "Wait before capturing, in ms — give the UI time to render. Default 500, max 5000."
                        }
                    }
                }),
            },
            ToolDef {
                name: "skill_save",
                description: "Save a REUSABLE skill you've just figured out so future runs apply it \
                              instantly — a learned procedure, recipe, or hard-won project fact. Call \
                              it after solving something non-trivial worth remembering. Your saved \
                              skills are loaded into your context automatically on every future run \
                              for this role (this is how you LEARN and get faster over time). Saving \
                              the same name again refines that skill.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Short unique skill name, e.g. \"add_canvas_tool\"."
                        },
                        "when_to_use": {
                            "type": "string",
                            "description": "One line: the situation where this skill applies."
                        },
                        "body": {
                            "type": "string",
                            "description": "The reusable procedure / recipe / knowledge — concise and directly actionable."
                        }
                    },
                    "required": ["name", "body"]
                }),
            },
            ToolDef {
                name: "code_search",
                description: "Semantic code search over the project's VECTOR index (embeddings). \
                              Returns the most RELEVANT code locations for a natural-language query \
                              (e.g. \"where is the auth token refreshed\") — smarter than fs_search \
                              (literal/regex) when you don't know the exact identifier. Each hit is a \
                              closeness score + `path#Lstart-end`; then fs_read_file those paths. \
                              Returns empty if the index isn't built yet for this workspace.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Natural-language description of the code you're looking for."
                        },
                        "k": {
                            "type": "integer",
                            "description": "How many hits to return (default 8, max 20)."
                        }
                    },
                    "required": ["query"]
                }),
            },
            ToolDef {
                name: "web_search",
                description: "Search the public web and return the top results (title, URL, snippet). \
                              Use it for up-to-date information, library docs, an error message, or \
                              anything NOT in the local project. Uses a real search API (Brave/Tavily) \
                              when the user configured a key, otherwise a best-effort keyless engine. \
                              Read the snippets, then call web_fetch on the most relevant URL to read \
                              the full page.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The web search query (plain text)."
                        },
                        "max_results": {
                            "type": "integer",
                            "description": "How many results to return (default 5, max 10)."
                        }
                    },
                    "required": ["query"]
                }),
            },
            ToolDef {
                name: "web_fetch",
                description: "Fetch a web page (or raw text/JSON URL) and return its readable text \
                              content — HTML is stripped to plain text. Use it AFTER web_search to \
                              actually read a result, or on any URL the user gives you. Output is \
                              capped (default ~48k chars) with a truncation marker. http/https only.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "Absolute http(s) URL to fetch."
                        },
                        "max_chars": {
                            "type": "integer",
                            "description": "Max characters to return (default 48000, max 200000)."
                        }
                    },
                    "required": ["url"]
                }),
            },
            ToolDef {
                name: "advisor",
                description: "Consult a senior ADVISOR that sees your ENTIRE conversation transcript — \
                              the task, every tool call you've made, every result you've seen. It takes \
                              NO parameters: when you call advisor(), your full history is forwarded \
                              automatically. It returns a concise strategic plan or course-correction \
                              (text only, no tools). Call advisor BEFORE substantive work (before writing/\
                              editing or committing to an approach), when STUCK (errors recurring, approach \
                              not converging), and BEFORE you declare the task done. On tasks longer than a \
                              few steps, call it at least once before committing to an approach and once \
                              before finishing. Weigh its advice seriously, then continue.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {}
                }),
            },
        ]
    })
}

// ────────────────────────────────────────────────────────────────────
// Provider-specific JSON renderers
// ────────────────────────────────────────────────────────────────────

/// Render `AGENT_TOOLS` in the OpenAI `tools` body field format.
/// `pub(crate)` so `chat.rs` can inject this into the request body when
/// the caller passes `with_tools: true`.
pub(crate) fn tools_json_openai() -> serde_json::Value {
    let tools: Vec<serde_json::Value> = agent_tools()
        .iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            })
        })
        .collect();
    serde_json::Value::Array(tools)
}

/// Render `AGENT_TOOLS` in the Anthropic `tools` body field format.
/// `pub(crate)` so `chat.rs` can inject this into the request body when
/// the caller passes `with_tools: true`.
pub(crate) fn tools_json_anthropic() -> serde_json::Value {
    let tools: Vec<serde_json::Value> = agent_tools()
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            })
        })
        .collect();
    serde_json::Value::Array(tools)
}

// ────────────────────────────────────────────────────────────────────
// Streaming accumulator for OpenAI tool_call fragments
// ────────────────────────────────────────────────────────────────────

/// Accumulates streaming `tool_call` fragments from OpenAI SSE deltas
/// into complete [`ToolCall`] values. One instance per streaming
/// response.
///
/// OpenAI emits tool_calls across multiple chunks keyed by an `index`
/// field — the first chunk carries `id` + `function.name` + an initial
/// `arguments` fragment, subsequent chunks carry only more `arguments`
/// fragments under the same index. We accumulate by index and produce
/// the final ordered list at stream-end.
#[derive(Default)]
pub(crate) struct ToolCallAccumulator {
    ids: std::collections::HashMap<usize, String>,
    names: std::collections::HashMap<usize, String>,
    args: std::collections::HashMap<usize, String>,
    max_index: usize,
    saw_any: bool,
}

impl ToolCallAccumulator {
    pub(crate) fn ingest(&mut self, v: &serde_json::Value) {
        let Some(arr) = v["choices"][0]["delta"]["tool_calls"].as_array() else {
            return;
        };
        self.saw_any = true;
        for item in arr {
            let idx = item["index"].as_u64().unwrap_or(0) as usize;
            if idx > self.max_index {
                self.max_index = idx;
            }
            if let Some(id) = item["id"].as_str() {
                self.ids.insert(idx, id.to_string());
            }
            if let Some(name) = item["function"]["name"].as_str() {
                self.names.insert(idx, name.to_string());
            }
            if let Some(args) = item["function"]["arguments"].as_str() {
                self.args.entry(idx).or_default().push_str(args);
            }
        }
    }

    pub(crate) fn finish(self) -> Vec<ToolCall> {
        if !self.saw_any {
            return Vec::new();
        }
        let mut out = Vec::new();
        for idx in 0..=self.max_index {
            if let (Some(id), Some(name)) = (self.ids.get(&idx), self.names.get(&idx)) {
                out.push(ToolCall {
                    id: id.clone(),
                    name: name.clone(),
                    arguments: self.args.get(&idx).cloned().unwrap_or_default(),
                });
            }
        }
        out
    }
}

// ────────────────────────────────────────────────────────────────────
// Dispatcher
// ────────────────────────────────────────────────────────────────────

/// Execute one tool call. NEVER returns `Err` — failures become
/// [`ToolResult`] with `is_error: true` so the calling LLM gets a clean
/// next-turn signal it can adapt to (e.g. "file not found, try X/Y/Z").
///
/// `workspace_root` is pre-resolved by the caller (one lock acquisition
/// per iteration, NOT per tool call — avoids contention with the fs
/// watcher and other workspace consumers).
pub(super) fn execute_tool(
    call: &ToolCall,
    workspace_root: &Path,
    app: &AppHandle,
    role: &str,
    last_exec_exit: &AtomicI64,
    agent_id: &str,
) -> ToolResult {
    match dispatch_inner(call, workspace_root, app, role, last_exec_exit, agent_id) {
        Ok(content) => ToolResult {
            id: call.id.clone(),
            name: call.name.clone(),
            is_error: false,
            content,
        },
        Err(err) => ToolResult {
            id: call.id.clone(),
            name: call.name.clone(),
            is_error: true,
            content: err,
        },
    }
}

fn dispatch_inner(
    call: &ToolCall,
    root: &Path,
    app: &AppHandle,
    role: &str,
    last_exec_exit: &AtomicI64,
    agent_id: &str,
) -> Result<String, String> {
    let args: serde_json::Value = serde_json::from_str(&call.arguments)
        .map_err(|e| format!("argument parse error: {e}"))?;

    match call.name.as_str() {
        "fs_read_file" => {
            let path = args["path"]
                .as_str()
                .ok_or_else(|| "missing required field: path".to_string())?;
            // 32 KiB soft cap is the LLM-context budget — files larger than this
            // are returned truncated with a sentinel so the model knows. With
            // `offset`/`limit` the model pages through a large file by lines.
            const AGENT_READ_CAP: usize = 32 * 1024;
            let offset = args["offset"].as_u64();
            let limit = args["limit"].as_u64();
            if offset.is_some() || limit.is_some() {
                let full = crate::commands::fs::read_file_inner(root, path, None)?;
                let start = offset.unwrap_or(1).max(1) as usize; // 1-based
                let count = limit.unwrap_or(400).clamp(1, 5000) as usize;
                let lines: Vec<&str> = full.lines().collect();
                let total = lines.len();
                if start > total {
                    return Ok(format!(
                        "(offset {start} dépasse les {total} lignes du fichier — rien à lire)"
                    ));
                }
                let end = (start - 1 + count).min(total);
                let slice = lines[start - 1..end].join("\n");
                // Cap dur de sortie (budget contexte), tronqué sur une frontière
                // de caractère pour ne jamais couper un codepoint UTF-8.
                let body = if slice.len() > AGENT_READ_CAP {
                    let mut cut = AGENT_READ_CAP;
                    while cut > 0 && !slice.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    format!("{}\n…[tronqué — réduis `limit`]", &slice[..cut])
                } else {
                    slice
                };
                Ok(format!("Lignes {start}-{end} sur {total} :\n{body}"))
            } else {
                crate::commands::fs::read_file_inner(root, path, Some(AGENT_READ_CAP))
            }
        }
        "fs_write_file" => {
            let path = args["path"]
                .as_str()
                .ok_or_else(|| "missing required field: path".to_string())?;
            let content = args["content"]
                .as_str()
                .ok_or_else(|| "missing required field: content".to_string())?;
            // Capture l'état AVANT l'écriture (None si le fichier n'existait pas →
            // créé ce tour). Émis comme event `Write` après un write réussi pour
            // alimenter la carte diff+Annuler du chat (cf. chat_tools::record_before).
            let before = crate::commands::fs::read_file_inner(root, path, None).ok();
            let bytes = crate::commands::fs::write_file_inner(root, path, content)?;
            let _ = super::persist_and_emit(
                app,
                &super::AgentEvent::Write {
                    agent_id: agent_id.to_string(),
                    path: path.to_string(),
                    before,
                },
            );
            Ok(format!("wrote {bytes} bytes to {path}"))
        }
        "fs_list_dir" => {
            let path = args["path"].as_str().unwrap_or(".");
            crate::commands::fs::list_dir_inner(root, path)
        }
        "todo_write" => {
            // No-op: the plan lives in the persisted toolCall args; the UI reads
            // the latest call. We just acknowledge with a count so the model
            // continues its loop.
            let n = args["todos"].as_array().map(|a| a.len()).unwrap_or(0);
            Ok(format!("recorded {n} todo(s)"))
        }
        "code_search" => {
            let query = args["query"]
                .as_str()
                .ok_or_else(|| "missing required field: query".to_string())?;
            let k = args["k"].as_u64().unwrap_or(8).clamp(1, 20) as u32;
            // Recherche SÉMANTIQUE sur l'index vectoriel du projet (collection
            // "code", peuplée par le workspace indexer). Rend le système vectoriel
            // — jusqu'ici réservé au RAG passif du chat-direct — appelable par
            // l'agent. Dégrade proprement si l'index n'est pas encore construit.
            match crate::commands::vector::vec_search_internal(app, "code", query, k) {
                Ok(hits) if hits.is_empty() => Ok(
                    "no semantic matches — the code index may not be built yet for this workspace. \
                     Use fs_search (literal/regex) instead, or open the workspace so it gets indexed."
                        .to_string(),
                ),
                Ok(hits) => {
                    let lines: Vec<String> = hits
                        .iter()
                        .map(|h| format!("  {:.3}  {}", h.distance, h.id))
                        .collect();
                    Ok(format!(
                        "Top {} semantic matches (closeness asc, then `path#Lstart-end` — read them with fs_read_file):\n{}",
                        lines.len(),
                        lines.join("\n"),
                    ))
                }
                Err(e) => Err(format!("code_search failed: {e}")),
            }
        }
        "fs_search" => {
            let query = args["query"]
                .as_str()
                .ok_or_else(|| "missing required field: query".to_string())?;
            // Reuse the workspace grep engine, but anchored at the AGENT's root
            // (the Atelier's creation dir when overridden) — never the global state.
            let opts = crate::commands::grep::GrepOpts {
                case_sensitive: args["case_sensitive"].as_bool().unwrap_or(false),
                regex: args["regex"].as_bool().unwrap_or(false),
                max_results: 80,
            };
            let matches = crate::commands::grep::grep_inner(root, query, &opts)?;
            if matches.is_empty() {
                return Ok(format!("no matches for {query:?}"));
            }
            let n = matches.len();
            let body = matches
                .iter()
                .map(|m| format!("{}:{}: {}", m.path, m.line, m.preview))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(format!("{n} match(es):\n{body}"))
        }
        "fs_edit" => {
            let path = args["path"]
                .as_str()
                .ok_or_else(|| "missing required field: path".to_string())?;
            let old = args["old_string"]
                .as_str()
                .ok_or_else(|| "missing required field: old_string".to_string())?;
            let new = args["new_string"]
                .as_str()
                .ok_or_else(|| "missing required field: new_string".to_string())?;
            if old.is_empty() {
                return Err("old_string must not be empty — use fs_write_file to create a file".to_string());
            }
            let replace_all = args["replace_all"].as_bool().unwrap_or(false);
            // Read the FULL file (no cap) so a truncated read can never corrupt it.
            let content = crate::commands::fs::read_file_inner(root, path, None)?;
            let count = content.matches(old).count();
            if count == 0 {
                return Err(format!(
                    "old_string not found in {path} — read the file (fs_read_file) and copy an exact snippet"
                ));
            }
            let (updated, replaced) = if replace_all {
                (content.replace(old, new), count)
            } else {
                if count > 1 {
                    return Err(format!(
                        "old_string appears {count} times in {path} — add surrounding context to make it unique, or set replace_all=true"
                    ));
                }
                (content.replacen(old, new, 1), 1)
            };
            let bytes = crate::commands::fs::write_file_inner(root, path, &updated)?;
            // `content` est l'état d'avant l'édition (le fichier existait forcément
            // — old_string a matché). Émis comme `before` pour le diff+Annuler.
            let _ = super::persist_and_emit(
                app,
                &super::AgentEvent::Write {
                    agent_id: agent_id.to_string(),
                    path: path.to_string(),
                    before: Some(content),
                },
            );
            Ok(format!("edited {path} ({replaced} replacement(s), {bytes} bytes written)"))
        }
        "fs_delete" => {
            let path = args["path"]
                .as_str()
                .ok_or_else(|| "missing required field: path".to_string())?;
            // Capture le contenu d'avant pour la carte diff + un éventuel undo
            // (restaurer = réécrire `before`). Le filet ultime reste git.
            let before = crate::commands::fs::read_file_inner(root, path, None).ok();
            crate::commands::fs::delete_file_inner(root, path)?;
            let _ = super::persist_and_emit(
                app,
                &super::AgentEvent::Write {
                    agent_id: agent_id.to_string(),
                    path: path.to_string(),
                    before,
                },
            );
            Ok(format!("deleted {path}"))
        }
        "fs_move" => {
            let from = args["from"]
                .as_str()
                .ok_or_else(|| "missing required field: from".to_string())?;
            let to = args["to"]
                .as_str()
                .ok_or_else(|| "missing required field: to".to_string())?;
            let bytes = crate::commands::fs::rename_inner(root, from, to)?;
            // Event Write sur la DESTINATION (créée) pour la carte diff. La source
            // disparue est couverte par git (filet de sécurité agent).
            let _ = super::persist_and_emit(
                app,
                &super::AgentEvent::Write {
                    agent_id: agent_id.to_string(),
                    path: to.to_string(),
                    before: None,
                },
            );
            Ok(format!("moved {from} → {to} ({bytes} bytes)"))
        }
        "run_command" => {
            // Exec directe sur la machine (pivot 2026-06-10) : le filet de
            // sécurité est git (l'utilisateur suit/annule les changements dans
            // l'onglet Git), plus aucun verrou allow_exec ni sandbox Docker.
            //
            // Couche gouvernée (P0-a) : la commande est classée (CommandRisk) et
            // exécutée sous une ExecutionPolicy. La policy effective ici est
            // TOUJOURS WorkspaceWrite — le mode Plan (ReadOnly) retire/bloque
            // `run_command` en amont dans runner.rs (is_write_tool), donc tout
            // appel qui arrive jusqu'ici tourne hors lecture-seule. Le verdict
            // de risque est SIGNALÉ (non bloquant) : un `[RISK: …]` en tête de
            // sortie pour que le modèle ET l'UI le voient, jamais un refus — la
            // fluidité prime, le filet reste git + le kill arbre-de-processus.
            let command = args["command"]
                .as_str()
                .ok_or_else(|| "missing required field: command".to_string())?;
            let timeout_secs = args["timeoutSecs"].as_u64().unwrap_or(60).clamp(1, 300);
            let policy = super::policy::ExecutionPolicy::WorkspaceWrite;
            let res = super::exec::run_command_direct(root, command, timeout_secs, policy);
            // Record the exit code for the skill gate: `skill_save` only persists
            // when the LAST run_command exited 0 (env-verified success). Timeout
            // (sentinel -2) and infra failure (-1) both block saving a skill.
            last_exec_exit.store(
                if res.timed_out { -2 } else { res.exit_code as i64 },
                Ordering::Relaxed,
            );
            // ALWAYS Ok: a non-zero exit (failing test) is DATA the agent must see
            // and react to, not a tool error — an infra failure must NOT count as
            // a tool_error (that would drive evolution on an infra problem). The
            // agent reads the full picture and decides.
            let status = if res.timed_out {
                format!("TIMED OUT after {timeout_secs}s")
            } else {
                format!("exit {}", res.exit_code)
            };
            // Prefix a non-blocking risk banner when the classifier flagged the
            // command. The model sees the ran-anyway result AND the warning so it
            // can self-correct (e.g. avoid a force-push next time); the UI parses
            // the same prefix to show a risk card. Safe commands get no banner.
            let risk_banner = if res.risk.is_danger() {
                let detail = res.risk.detail.as_deref().unwrap_or("commande à risque");
                let reason = res.risk.reason.unwrap_or("danger");
                format!("[RISK: {reason}] {detail}\n")
            } else {
                String::new()
            };
            Ok(format!(
                "{risk_banner}[{status}]\n--- stdout ---\n{}\n--- stderr ---\n{}",
                res.stdout, res.stderr
            ))
        }
        "capture_screen" => {
            // Vérification visuelle (« tests réels ») : capture l'écran, sauve
            // le plein format sur disque, émet l'event Screenshot (miniature
            // pour la timeline du fil) et retourne un MARQUEUR que le runner
            // détecte pour ré-injecter l'image en tour user multimodal
            // (openai-compat n'accepte pas d'image dans un message role:"tool").
            let monitor = args["monitor"].as_u64().map(|v| v as usize);
            let delay_ms = args["delay_ms"].as_u64().unwrap_or(500);
            let (path, thumb) = crate::commands::capture::capture_for_agent_blocking(
                app, agent_id, monitor, delay_ms,
            )?;
            let _ = super::persist_and_emit(
                app,
                &super::AgentEvent::Screenshot {
                    agent_id: agent_id.to_string(),
                    tool_call_id: call.id.clone(),
                    path: path.clone(),
                    thumb_data_url: thumb,
                },
            );
            Ok(format!("SCREENSHOT_SAVED:{path}"))
        }
        "skill_save" => {
            // Env-verified gate: a skill is only worth keeping if the real
            // environment just CONFIRMED the approach works — i.e. the last
            // `run_command` exited 0. This is Voyager's "critic", replaced by
            // ground truth. Refuse otherwise.
            let last = last_exec_exit.load(Ordering::Relaxed);
            if last != 0 {
                let seen = if last == i64::MIN { "aucun".to_string() } else { last.to_string() };
                return Err(format!(
                    "skill non sauvé : un skill ne se garde qu'APRÈS un test vérifié qui passe \
                     (dernier run_command = {seen}, attendu 0). Écris un test, lance-le avec \
                     run_command jusqu'à exit 0, PUIS sauve le skill."
                ));
            }
            let name = args["name"]
                .as_str()
                .ok_or_else(|| "missing required field: name".to_string())?;
            let body = args["body"]
                .as_str()
                .ok_or_else(|| "missing required field: body".to_string())?;
            let when_to_use = args["when_to_use"].as_str().unwrap_or("");
            if name.trim().is_empty() || body.trim().is_empty() {
                return Err("skill_save needs a non-empty name and body".to_string());
            }
            super::skills::save_skill(app, role, name, when_to_use, body, "agent")?;
            Ok(format!(
                "skill '{name}' saved for role '{role}' — it will load automatically in future runs"
            ))
        }
        other => Err(format!("unknown tool: {other}")),
    }
}
