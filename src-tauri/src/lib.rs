mod commands;

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Listener, Manager};
use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};

const MIGRATION_V1: &str = "
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    env TEXT,
    parent_id TEXT,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT,
    body TEXT,
    code_lang TEXT,
    code_text TEXT,
    image INTEGER NOT NULL DEFAULT 0,
    ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    negative TEXT,
    ratio TEXT,
    model TEXT,
    seed INTEGER,
    steps INTEGER,
    guidance REAL,
    style TEXT,
    hue INTEGER,
    status TEXT,
    result_url TEXT,
    ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
";

const MIGRATION_V2: &str = "
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    source TEXT,
    message TEXT NOT NULL,
    ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
";

// V3 — persist the reasoning trace (Qwen 3.5 / DeepSeek-R1 / Llama-3.3-R
// `<think>...</think>` content) alongside each AI message. The trace is
// ephemeral by default in most chat UIs (Claude, ChatGPT o1) but Shugu's
// user explicitly wants to be able to re-read it later, hence persistence.
// Stored separately from `body` so chat history sent back to the model on
// the next turn (chat-sync builds it from `body`/`text`/`code_text`)
// remains clean — the reasoning is a UI affordance, not part of the
// dialogue.
const MIGRATION_V3: &str = "
ALTER TABLE messages ADD COLUMN reasoning TEXT;
";

// V6 — soft-delete + edit tracking + branching scaffold.
//
//   * edited_at  — NULL = never edited, otherwise the ms-timestamp of last
//                  edit. Lets the UI show a small "edited" badge and
//                  preserves an audit trail without versioning row history.
//   * deleted_at — NULL = live message; otherwise the ms-timestamp of the
//                  soft-delete. `listByConversation` filters these out so
//                  they are invisible to the user and to the LLM history
//                  builder (chat-sync). Preserved for undo and audit.
//   * parent_id  — branching scaffold only (Phase C). NULL for all current
//                  messages; the regenerate flow will populate it in a
//                  future schema version. Index created now so the column
//                  is ready for efficient range queries.
const MIGRATION_V6: &str = "
ALTER TABLE messages ADD COLUMN edited_at INTEGER;
ALTER TABLE messages ADD COLUMN deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN parent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
";

// V5 — wire chat messages to the agent system (Phase 1).
//
// Two new columns on `messages`:
//   * `agent_id`   — UUID of the agent whose output this message relays.
//                    NULL for regular chat messages (the vast majority).
//                    Matches `agents.id` (no FK constraint to avoid a
//                    cascade-delete contract we haven't designed yet).
//   * `via_agent`  — 0 by default; 1 when this message is a VERBATIM
//                    orchestrator output. Drives the "via orchestrator"
//                    badge in the chat UI + the role rewrite when
//                    rebuilding history for the chat model's next turn.
//
// Index on agent_id supports the (future) "open the message that this
// agent produced" navigation flow.
const MIGRATION_V5: &str = "
ALTER TABLE messages ADD COLUMN agent_id TEXT;
ALTER TABLE messages ADD COLUMN via_agent INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
";

// V4 — multi-agent system foundation (Phase 0).
//
// `agents` holds one row per agent lifecycle (orchestrator, sub-agents,
// later). Status is the FSM state: pending → running → (complete | error
// | killed). `parent_id` lets us build the orchestrator → sub-agent tree
// without a separate join table. `conversation_id` ties an agent to the
// chat conversation that triggered it so the UI can surface "this chat
// spawned 3 agents".
//
// `agent_events` is an append-only audit log of everything that happens
// to an agent — spawn, model messages, tool calls + results, streaming
// deltas, completion, errors. The `payload` column is the serialized
// AgentEvent JSON (camelCase, see commands/agents.rs::AgentEvent). We
// keep events as a flat table (not a column on `agents`) because a
// single agent run can emit thousands of delta events; a TEXT column
// would blow up row sizes and break SQLite's preferred page model.
//
// Indexes target the three hot read paths:
//   - "which agents belong to this conversation?" → idx_agents_conv
//   - "who are the children of this agent?" → idx_agents_parent
//   - "give me the transcript of agent X in order" → idx_agent_events_agent_ts
//   - "what's the global event stream by time?" → idx_agent_events_ts
const MIGRATION_V4: &str = "
CREATE TABLE IF NOT EXISTS agents (
    id              TEXT    PRIMARY KEY,
    role            TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    parent_id       TEXT,
    model           TEXT    NOT NULL,
    task            TEXT    NOT NULL,
    conversation_id TEXT,
    created_at      INTEGER NOT NULL,
    finished_at     INTEGER,
    output          TEXT,
    error           TEXT
);
CREATE TABLE IF NOT EXISTS agent_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id  TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    kind      TEXT    NOT NULL,
    payload   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_conv          ON agents(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agents_parent        ON agents(parent_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_agent_ts ON agent_events(agent_id, ts);
CREATE INDEX IF NOT EXISTS idx_agent_events_ts      ON agent_events(ts);
";

// V7 — auto-evolving harness (Continual Harness, lot 1 P0).
//
// `harness_generations` stores one IMMUTABLE snapshot per (role, generation)
// of the agent harness: the system prompt `p`, plus memory `M`, subagents `G`
// and skills `K` as JSON. In lot 1 only `system_prompt` (P2) and `memory`
// (P3) are written; `subagents`/`skills` stay '[]' (wired for lot 2). Exactly
// one row per role has `active = 1` — the snapshot `load_active_harness`
// serves. Generation 0 is SEEDED from the hard-coded role prompts on first
// use, so behaviour is byte-identical to today until a Refiner writes a new
// generation. Rollback = flip `active` to an earlier generation; nothing is
// mutated in place, so the audit trail is the table itself.
//
// `agent_outcomes` is one row per agent run: success / stuck_reason + the
// iteration & tool-error counters, tied to the `generation` that produced
// the run. Per-generation metrics are therefore a GROUP BY (no
// denormalization), and a later anti-regression audit can compare a new
// generation's outcomes against its parent's.
const MIGRATION_V7: &str = "
CREATE TABLE IF NOT EXISTS harness_generations (
    id                TEXT    PRIMARY KEY,
    role              TEXT    NOT NULL,
    generation        INTEGER NOT NULL,
    parent_generation INTEGER,
    trigger_reason    TEXT,
    created_by        TEXT,
    system_prompt     TEXT    NOT NULL,
    memory            TEXT    NOT NULL DEFAULT '[]',
    subagents         TEXT    NOT NULL DEFAULT '[]',
    skills            TEXT    NOT NULL DEFAULT '[]',
    active            INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_role_gen ON harness_generations(role, generation);
CREATE INDEX        IF NOT EXISTS idx_harness_active   ON harness_generations(role, active);
CREATE TABLE IF NOT EXISTS agent_outcomes (
    agent_id      TEXT    PRIMARY KEY,
    role          TEXT    NOT NULL,
    generation    INTEGER,
    success       INTEGER,
    stuck_reason  TEXT,
    iterations    INTEGER NOT NULL DEFAULT 0,
    tool_errors   INTEGER NOT NULL DEFAULT 0,
    user_feedback TEXT,
    ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outcomes_role_gen ON agent_outcomes(role, generation);
";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: MIGRATION_V1,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "jobs_logs_settings",
            sql: MIGRATION_V2,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "messages_reasoning_column",
            sql: MIGRATION_V3,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "agents_system_foundation",
            sql: MIGRATION_V4,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "messages_agent_link",
            sql: MIGRATION_V5,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "message_edit_delete_scaffold",
            sql: MIGRATION_V6,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "harness_generations_outcomes",
            sql: MIGRATION_V7,
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:shugu.db", migrations)
                .build(),
        )
        // `preview://` — Design Studio live preview (Phase B). Serves
        // <workspace>/.shugu-forge/preview/ so the iframe renders a real
        // multi-file project (relative imports resolve under one origin).
        // No HTTP server, no new dependency. See commands/preview.rs.
        .register_uri_scheme_protocol("preview", |ctx, request| {
            commands::preview::serve(ctx.app_handle(), request.uri().path())
        })
        // Workspace root — set by fs_open_folder, read by all other fs commands.
        .manage(Mutex::new(None::<std::path::PathBuf>))
        .manage(commands::terminal::PtyRegistry::default())
        .manage(commands::llama::LlamaServerState::default())
        .manage(commands::agents::AgentManagerState::default())
        .manage(commands::chat::ChatAbortRegistry::default())
        // LOT 3 — LSP server registry (un LspSession par langId).
        .manage(commands::lsp::LspServerRegistry::default())
        .setup(|app| {
            // Debug instrumentation — relay JS uncaught errors into stdout.
            //
            // WebView2 crashes wipe the DevTools console: when the page dies,
            // the frontend log is gone. The two entry points (main.tsx,
            // mascot.tsx) attach window.onerror + onunhandledrejection that
            // emit a `debug://js-error` Tauri event with the message + stack.
            // We catch it here, `eprintln!` to stdout, and the tauri-dev.cmd
            // wrapper's Tee-Object pipes it into boot.log — so a JS crash
            // becomes visible in the same log the Monitor tail is watching.
            //
            // Hot path: this listener fires once per uncaught error. The
            // payload is the raw JSON string the frontend emitted (we don't
            // parse it here — the `[js-error]` prefix is enough to grep).
            app.listen("debug://js-error", |event| {
                eprintln!("[js-error] {}", event.payload());
            });

            // Spawn the filesystem watcher before restoring the workspace root
            // so the watcher is ready to receive the seed path below.
            let watcher_tx = commands::watcher::spawn_watcher(app.handle().clone());
            app.manage(commands::watcher::WatcherCtl(watcher_tx.clone()));

            // Spawn the dedicated .git/ watcher. Same lifecycle as the fs
            // watcher — receives the workspace root on open and resync's its
            // notify subscription on each change.
            let git_watcher_tx = commands::git_watcher::spawn_git_watcher(app.handle().clone());
            app.manage(commands::git_watcher::WatcherCtl(git_watcher_tx.clone()));

            // Restore the last workspace root from the settings table.
            // This runs after plugin init (so the DB migrations have run).
            // Any failure (missing row, path gone, DB error) is silently ignored —
            // we never crash app boot over a missing workspace.
            let _ = (|| -> Result<(), ()> {
                let restored = commands::fs::restore_workspace_root(app.handle());
                if let Some(canonical) = restored {
                    let state = app
                        .state::<Mutex<Option<std::path::PathBuf>>>();
                    let mut guard = state.lock().map_err(|_| ())?;
                    *guard = Some(canonical.clone());
                    // Seed both watchers with the restored root so file-change
                    // and .git/ events are watched immediately on startup.
                    let _ = watcher_tx.send(canonical.clone());
                    let _ = git_watcher_tx.send(canonical);
                }
                Ok(())
            })();

            // ──────────────────────────────────────────────────────────────
            // System tray icon — Discord/Steam-style "minimize to tray".
            //
            // The frontend's titlebar close button calls window.hide()
            // (not close()), which leaves the Rust runtime alive. This tray
            // icon is the user's only way back: left-click toggles the main
            // window's visibility, right-click reveals a menu with "Show
            // Shugu Forge" and "Quit". Quit calls app.exit(0) which tears
            // down ALL windows (main + mascot) plus the dev pipeline.
            //
            // The mascot window is intentionally not touched here — it has
            // its own visibility state (tucked / un-tucked / click-through)
            // and the user typically wants it to keep floating even when
            // the main IDE is hidden.
            let show_item = MenuItem::with_id(
                app, "tray-show", "Show Shugu Forge", true, None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(
                app, "tray-quit", "Fermer Shugu Forge", true, None::<&str>,
            )?;
            let tray_menu = Menu::with_items(
                app,
                &[&show_item, &separator, &quit_item],
            )?;

            // llama autostart at boot was REMOVED — Option A of the
            // "llama bundling" decision (2026-05-19). Local AI is now strictly
            // opt-in: the user picks a `llamacpp/*` model in Settings → the
            // `useLlamaLifecycle` hook fires `llama_start` on demand. The
            // binary is no longer bundled (see tauri.conf.json externalBin
            // emptied); users install via winget/scoop/release if they want
            // local-first. Bundle weight ~-1.5 GB, boot time instant, no more
            // 90s readiness-probe timeout polluting the dev console.

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(
                    app.default_window_icon()
                        .expect("default window icon missing in tauri.conf.json bundle")
                        .clone(),
                )
                .tooltip("Shugu Forge")
                .menu(&tray_menu)
                // Left-click does NOT open the menu — we use it as a quick
                // toggle (show ↔ hide). Right-click opens the menu by Tauri's
                // default behavior.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray-show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "tray-quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            match window.is_visible() {
                                Ok(true) => {
                                    let _ = window.hide();
                                }
                                Ok(false) => {
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
                                }
                                Err(_) => {}
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::chat::chat_send,
            commands::chat::chat_abort,
            commands::credentials::cred_set,
            commands::credentials::cred_get,
            commands::credentials::cred_delete,
            commands::llama::llama_start,
            commands::llama::llama_stop,
            commands::llama::llama_status,
            commands::llama::llama_force_stop_external,
            commands::llama::llama_autostart,
            commands::llama::llama_backend_info,
            commands::fs::fs_open_folder,
            commands::fs::fs_read_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::fs::fs_get_workspace_root,
            // LOT 2 — ripgrep workspace search (palette Cmd+Shift+F).
            commands::grep::fs_grep_workspace,
            // LOT 3 — Language Server Protocol bridge.
            commands::lsp::lsp_init,
            commands::lsp::lsp_send,
            commands::lsp::lsp_shutdown,
            commands::terminal::term_spawn,
            commands::terminal::term_write,
            commands::terminal::term_resize,
            commands::terminal::term_kill,
            commands::terminal::term_snapshot,
            commands::image::image_generate,
            commands::models::models_list,
            commands::models::models_discover_external,
            commands::vector::vec_index,
            commands::vector::vec_search,
            commands::vector::vec_delete,
            commands::model_bundle::model_bundle_catalog,
            commands::model_bundle::model_bundle_status,
            commands::model_bundle::model_bundle_download,
            commands::model_bundle::model_bundle_delete,
            commands::model_bundle::model_bundle_path,
            commands::model_bundle::model_bundle_installed_ids,
            commands::agents::agent_spawn,
            commands::agents::agent_kill,
            commands::agents::agent_list_active,
            commands::agents::agent_get_transcript,
            commands::agents::agent_list_by_conversation,
            commands::diag::js_diag,
            // LOT 2b — format document via CLI formatter (rustfmt/black/prettier/gofmt).
            commands::format::format_code,
            // LOT 3 — git decorations backend (HEAD content for inline diff).
            commands::git::git_is_repo,
            commands::git::git_show_head,
            // Git IDE integration (LOT 1) — read-side via git2, mutators via CLI.
            commands::git::git_status,
            commands::git::git_diff_file,
            commands::git::git_stage,
            commands::git::git_unstage,
            commands::git::git_discard,
            commands::git::git_stage_hunk,
            commands::git::git_unstage_hunk,
            commands::git::git_commit,
            commands::git::git_log,
            commands::git::git_branches,
            commands::git::git_checkout,
            commands::git::git_blame,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_fetch,
            commands::git::git_stash_list,
            commands::git::git_stash_save,
            commands::git::git_stash_apply,
            commands::git::git_remotes,
            commands::git::git_remote_add,
            commands::git::git_remote_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // RunEvent::Exit fires AFTER the exit decision is finalized (tray
            // "Fermer Shugu Forge" → app.exit(0), or process signal). This is
            // where we tear down any side-band children we spawned, because
            // tauri-plugin-shell's CommandChild does NOT kill on drop — the
            // claim in the older llama.rs header comment was wrong.
            //
            // Skipping this leaves llama-server alive after Shugu closes and
            // it reappears as a port-8090 zombie on next launch (which the
            // HTTP-probe path in llama_status now exposes as "external").
            //
            // Abnormal exits (process kill, panic before this fires) still
            // leak the child — Windows doesn't kill descendants automatically
            // and we don't (yet) put children in a Job Object with
            // KILL_ON_JOB_CLOSE. The probe-based detection on next launch is
            // the safety net for that case.
            if let tauri::RunEvent::Exit = event {
                // .inner() pins the &LlamaServerState borrow to a named
                // binding so the deref doesn't get dropped before the
                // MutexGuard tries to extend its lifetime — without this
                // explicit reference, rustc rejects `state.0.lock()` as
                // "borrowed value does not live long enough" in the run-
                // event closure context.
                let state = app_handle.state::<commands::llama::LlamaServerState>();
                let llama: &commands::llama::LlamaServerState = state.inner();
                if let Ok(mut guard) = llama.0.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                }

                // LOT 3 — Tear down all LSP children (typescript-language-server,
                // rust-analyzer, etc.). Sans ça, le sous-process node.exe ou
                // rust-analyzer.exe survit à Shugu et tient stdin ouvert
                // indéfiniment (same pattern que llama).
                let lsp_state = app_handle.state::<commands::lsp::LspServerRegistry>();
                commands::lsp::kill_all(lsp_state.inner());
            }
        });
}
