mod commands;

use std::sync::Mutex;
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::chat::chat_send,
            commands::fs::fs_open_folder,
            commands::fs::fs_read_dir,
            commands::fs::fs_read_file,
            commands::fs::fs_write_file,
            commands::fs::fs_create_file,
            commands::fs::fs_create_dir,
            commands::fs::fs_rename,
            commands::fs::fs_delete,
            commands::terminal::term_run,
            commands::image::image_generate,
            commands::models::models_list,
            commands::vector::vec_index,
            commands::vector::vec_search,
            commands::vector::vec_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
