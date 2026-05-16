mod commands;

use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
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
        // Workspace root — set by fs_open_folder, read by all other fs commands.
        .manage(Mutex::new(None::<std::path::PathBuf>))
        .manage(commands::terminal::PtyRegistry::default())
        .manage(commands::llama::LlamaServerState::default())
        .setup(|app| {
            // Spawn the filesystem watcher before restoring the workspace root
            // so the watcher is ready to receive the seed path below.
            let watcher_tx = commands::watcher::spawn_watcher(app.handle().clone());
            app.manage(commands::watcher::WatcherCtl(watcher_tx.clone()));

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
                    // Seed the watcher with the restored root so file-change
                    // events are watched immediately on startup.
                    let _ = watcher_tx.send(canonical);
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
            commands::credentials::cred_set,
            commands::credentials::cred_get,
            commands::credentials::cred_delete,
            commands::llama::llama_start,
            commands::llama::llama_stop,
            commands::llama::llama_status,
            commands::llama::llama_force_stop_external,
            commands::fs::fs_open_folder,
            commands::fs::fs_read_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::terminal::term_spawn,
            commands::terminal::term_write,
            commands::terminal::term_resize,
            commands::terminal::term_kill,
            commands::terminal::term_snapshot,
            commands::image::image_generate,
            commands::models::models_list,
            commands::vector::vec_index,
            commands::vector::vec_search,
            commands::vector::vec_delete,
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
            // it reappears as a port-8080 zombie on next launch (which the
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
            }
        });
}
