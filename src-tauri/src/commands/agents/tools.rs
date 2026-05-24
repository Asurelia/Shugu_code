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

use serde::{Deserialize, Serialize};

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
#[derive(Clone, Debug, Serialize)]
pub(super) struct ToolResult {
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
                              the workspace. Output is capped at 32 KiB with a truncation sentinel; \
                              use this to inspect existing code before proposing any edit.",
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Workspace-relative POSIX path, e.g. \"src/lib/db.ts\". \
                                            MUST be relative — absolute or traversal paths are rejected."
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
pub(super) fn execute_tool(call: &ToolCall, workspace_root: &Path) -> ToolResult {
    match dispatch_inner(call, workspace_root) {
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

fn dispatch_inner(call: &ToolCall, root: &Path) -> Result<String, String> {
    let args: serde_json::Value = serde_json::from_str(&call.arguments)
        .map_err(|e| format!("argument parse error: {e}"))?;

    match call.name.as_str() {
        "fs_read_file" => {
            let path = args["path"]
                .as_str()
                .ok_or_else(|| "missing required field: path".to_string())?;
            // 32 KiB soft cap is the LLM-context budget — files larger
            // than this are returned truncated with a sentinel so the
            // model knows. Phase 3 may expose a `byte_range` parameter
            // for paginated reads of larger files.
            const AGENT_READ_CAP: usize = 32 * 1024;
            crate::commands::fs::read_file_inner(root, path, Some(AGENT_READ_CAP))
        }
        "fs_write_file" => {
            let path = args["path"]
                .as_str()
                .ok_or_else(|| "missing required field: path".to_string())?;
            let content = args["content"]
                .as_str()
                .ok_or_else(|| "missing required field: content".to_string())?;
            let bytes = crate::commands::fs::write_file_inner(root, path, content)?;
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
        other => Err(format!("unknown tool: {other}")),
    }
}
