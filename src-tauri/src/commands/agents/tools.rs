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
                            "description": "Exact text to find — must be unique in the file. Copy it verbatim (with context)."
                        },
                        "new_string": {
                            "type": "string",
                            "description": "Replacement text for that snippet."
                        }
                    },
                    "required": ["path", "old_string", "new_string"]
                }),
            },
            ToolDef {
                name: "run_command",
                description: "Run a shell command in a SANDBOXED, network-isolated container with the \
                              workspace mounted (e.g. `node --test`, `node script.mjs`). Returns the \
                              REAL exit code + stdout + stderr — use it to actually RUN your code/tests, \
                              see what fails, and fix it before finishing. No network access; available \
                              only on the measurement bench (a disposable copy), disabled on the live \
                              project.",
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
    allow_exec: bool,
    app: &AppHandle,
    role: &str,
) -> ToolResult {
    match dispatch_inner(call, workspace_root, allow_exec, app, role) {
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
    allow_exec: bool,
    app: &AppHandle,
    role: &str,
) -> Result<String, String> {
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
        "fs_search" => {
            let query = args["query"]
                .as_str()
                .ok_or_else(|| "missing required field: query".to_string())?;
            // Reuse the workspace grep engine, but anchored at the AGENT's root
            // (the bench's sandbox copy when overridden) — never the global state.
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
            // Read the FULL file (no cap) so a truncated read can never corrupt it.
            let content = crate::commands::fs::read_file_inner(root, path, None)?;
            let count = content.matches(old).count();
            if count == 0 {
                return Err(format!(
                    "old_string not found in {path} — read the file (fs_read_file) and copy an exact snippet"
                ));
            }
            if count > 1 {
                return Err(format!(
                    "old_string appears {count} times in {path} — add surrounding context to make it unique"
                ));
            }
            let updated = content.replacen(old, new, 1);
            let bytes = crate::commands::fs::write_file_inner(root, path, &updated)?;
            Ok(format!("edited {path} ({bytes} bytes written)"))
        }
        "run_command" => {
            // Safety gate: execution runs arbitrary code, which a path-guard can't
            // contain. Only the bench (workspace = disposable copy) sets allow_exec.
            if !allow_exec {
                return Err("run_command is disabled here (safety): execution runs only on the \
                            measurement bench's disposable copy, never the live project"
                    .to_string());
            }
            let command = args["command"]
                .as_str()
                .ok_or_else(|| "missing required field: command".to_string())?;
            let timeout_secs = args["timeoutSecs"].as_u64().unwrap_or(60).clamp(1, 300);
            let res = super::sandbox::run_in_sandbox(root, command, timeout_secs);
            // ALWAYS Ok: a non-zero exit (failing test) is DATA the agent must see
            // and react to, not a tool error — and a docker-unavailable result must
            // NOT count as a tool_error (that would drive evolution on an infra
            // problem, exactly the canonicalize-bug trap). The agent reads the
            // full picture and decides.
            let status = if res.timed_out {
                format!("TIMED OUT after {timeout_secs}s")
            } else {
                format!("exit {}", res.exit_code)
            };
            Ok(format!(
                "[{status}]\n--- stdout ---\n{}\n--- stderr ---\n{}",
                res.stdout, res.stderr
            ))
        }
        "skill_save" => {
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
            super::skills::save_skill(app, role, name, when_to_use, body)?;
            Ok(format!(
                "skill '{name}' saved for role '{role}' — it will load automatically in future runs"
            ))
        }
        other => Err(format!("unknown tool: {other}")),
    }
}
