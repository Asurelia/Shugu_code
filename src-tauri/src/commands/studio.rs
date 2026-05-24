//! Studio projects — persisted snapshots of generated designs (Projets tab).
//!
//! A "project" = a row in `studio_projects` + a folder snapshot under
//! `<workspace>/.shugu-forge/projects/<id>/` (a copy of the disposable
//! `.shugu-forge/preview/` taken at save time). Auto-created on the first
//! generation of a session and refreshed on each subsequent generation (the
//! `preview` dir is a single shared folder, overwritten across sessions, so we
//! snapshot to keep each project's files correct); "Save as" forks a named,
//! frozen copy.
//!
//! Persistence reuses the agents module's rusqlite connection
//! (`agents::get_conn`) so all local-first state lives in one `shugu.db`.
//! Conversation history is NOT duplicated here — a project links to its
//! `conversation_id` and the UI rebuilds the turn log from `agents` /
//! `agent_events` (DRY).
//!
//! Security: every filesystem path is built from the managed workspace root +
//! a fixed `.shugu-forge/...` prefix (+ a UUID), and `load` re-verifies the
//! stored snapshot dir lives under `<workspace>/.shugu-forge/projects/` before
//! copying. Deletion is a soft-delete (`deleted_at`) — the folder is never
//! hard-removed.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

const PREVIEW_SUBDIR: &str = ".shugu-forge/preview";
const PROJECTS_SUBDIR: &str = ".shugu-forge/projects";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One saved Studio project. Serializes camelCase to match the TS
/// `StudioProject` interface (src/features/studio/studioProjects.ts).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProject {
    pub id: String,
    pub name: String,
    pub conversation_id: Option<String>,
    pub workspace_root: String,
    pub dir: String,
    /// "auto" (per-session, refreshed on each generation) | "saved" (frozen fork).
    pub kind: String,
    pub created_at: i64,
    pub updated_at: i64,
}

const SELECT_COLS: &str =
    "id, name, conversation_id, workspace_root, dir, kind, created_at, updated_at";

fn row_to_project(r: &rusqlite::Row<'_>) -> rusqlite::Result<StudioProject> {
    Ok(StudioProject {
        id: r.get(0)?,
        name: r.get(1)?,
        conversation_id: r.get(2)?,
        workspace_root: r.get(3)?,
        dir: r.get(4)?,
        kind: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

/// Current workspace root from managed state, or an error if none is open.
fn workspace_root(state: &Mutex<Option<PathBuf>>) -> Result<PathBuf, String> {
    let guard = state.lock().map_err(|e| format!("workspace lock: {e}"))?;
    guard.clone().ok_or_else(|| "no workspace open".to_string())
}

fn sub_path(root: &Path, subdir: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in subdir.split('/') {
        p.push(part);
    }
    p
}

fn preview_dir(root: &Path) -> PathBuf {
    sub_path(root, PREVIEW_SUBDIR)
}
fn projects_base(root: &Path) -> PathBuf {
    sub_path(root, PROJECTS_SUBDIR)
}
fn project_dir(root: &Path, id: &str) -> PathBuf {
    projects_base(root).join(id)
}

/// Recursively copy every file under `src` into `dst` (created if missing).
/// Symlinks are skipped — the preview is plain agent-generated files. Returns
/// the number of files copied.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<usize, String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("create {}: {e}", dst.display()))?;
    let mut count = 0usize;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
        if ft.is_dir() {
            count += copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

/// Snapshot the preview into a project folder (fresh: stale files are dropped).
fn snapshot_preview(root: &Path, id: &str) -> Result<(), String> {
    let src = preview_dir(root);
    if !src.is_dir() {
        return Err("no preview to snapshot".to_string());
    }
    let dst = project_dir(root, id);
    // Refresh: drop the previous snapshot of THIS project (our own folder under
    // .shugu-forge/projects/<id>) so deletions in the latest iteration aren't
    // left behind. Bounded to our own UUID folder — never user data.
    let _ = std::fs::remove_dir_all(&dst);
    copy_dir_recursive(&src, &dst)?;
    Ok(())
}

/// Auto-create or refresh the project tied to `conversation_id` for the current
/// workspace, snapshotting the current preview. Returns the project id.
#[tauri::command]
pub fn studio_project_upsert_auto(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
    name: String,
    conversation_id: Option<String>,
) -> Result<String, String> {
    let root = workspace_root(&root_state)?;
    let root_str = root.to_string_lossy().to_string();
    let conn_mutex = crate::commands::agents::get_conn(&app)?;
    let now = now_ms();

    let id = {
        let conn = conn_mutex.lock().map_err(|e| format!("db lock: {e}"))?;
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM studio_projects
                  WHERE kind = 'auto' AND deleted_at IS NULL
                    AND workspace_root = ?1 AND conversation_id IS ?2
                  LIMIT 1",
                params![root_str, conversation_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("query existing: {e}"))?;

        match existing {
            Some(id) => {
                conn.execute(
                    "UPDATE studio_projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
                    params![name, now, id],
                )
                .map_err(|e| format!("update: {e}"))?;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                let dir = project_dir(&root, &id).to_string_lossy().to_string();
                conn.execute(
                    "INSERT INTO studio_projects
                       (id, name, conversation_id, workspace_root, dir, kind, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'auto', ?6, ?6)",
                    params![id, name, conversation_id, root_str, dir, now],
                )
                .map_err(|e| format!("insert: {e}"))?;
                id
            }
        }
    };

    snapshot_preview(&root, &id)?;
    Ok(id)
}

/// Save the current preview as a NEW named, frozen project (a fork).
#[tauri::command]
pub fn studio_project_save_as(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
    name: String,
    conversation_id: Option<String>,
) -> Result<String, String> {
    let root = workspace_root(&root_state)?;
    let id = uuid::Uuid::new_v4().to_string();
    snapshot_preview(&root, &id)?;

    let conn_mutex = crate::commands::agents::get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| format!("db lock: {e}"))?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO studio_projects
           (id, name, conversation_id, workspace_root, dir, kind, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'saved', ?6, ?6)",
        params![
            id,
            name,
            conversation_id,
            root.to_string_lossy().to_string(),
            project_dir(&root, &id).to_string_lossy().to_string(),
            now
        ],
    )
    .map_err(|e| format!("insert: {e}"))?;
    Ok(id)
}

/// List the current workspace's projects, newest first (soft-deleted hidden).
#[tauri::command]
pub fn studio_project_list(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<Vec<StudioProject>, String> {
    let root = workspace_root(&root_state)?;
    let root_str = root.to_string_lossy().to_string();
    let conn_mutex = crate::commands::agents::get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| format!("db lock: {e}"))?;
    let sql = format!(
        "SELECT {SELECT_COLS} FROM studio_projects
          WHERE workspace_root = ?1 AND deleted_at IS NULL
          ORDER BY updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;
    let rows = stmt
        .query_map(params![root_str], row_to_project)
        .map_err(|e| format!("query: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row: {e}"))?);
    }
    Ok(out)
}

/// Restore a project's snapshot into the live preview dir (open the project).
#[tauri::command]
pub fn studio_project_load(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
    id: String,
) -> Result<(), String> {
    let root = workspace_root(&root_state)?;
    let conn_mutex = crate::commands::agents::get_conn(&app)?;
    let dir: String = {
        let conn = conn_mutex.lock().map_err(|e| format!("db lock: {e}"))?;
        conn.query_row(
            "SELECT dir FROM studio_projects WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| format!("project not found: {e}"))?
    };

    let src = PathBuf::from(&dir);
    // Defense-in-depth: the snapshot MUST live under this workspace's
    // .shugu-forge/projects/ before we copy it into the live preview.
    if !src.starts_with(projects_base(&root)) {
        return Err("project dir outside workspace".to_string());
    }
    if !src.is_dir() {
        return Err("project snapshot missing on disk".to_string());
    }

    let dst = preview_dir(&root);
    let _ = std::fs::remove_dir_all(&dst);
    copy_dir_recursive(&src, &dst)?;
    Ok(())
}

/// Rename a project.
#[tauri::command]
pub fn studio_project_rename(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    let conn_mutex = crate::commands::agents::get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| format!("db lock: {e}"))?;
    conn.execute(
        "UPDATE studio_projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now_ms(), id],
    )
    .map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Soft-delete a project (sets `deleted_at`). The snapshot folder is left on
/// disk — never a hard delete (Shugu policy).
#[tauri::command]
pub fn studio_project_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let conn_mutex = crate::commands::agents::get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| format!("db lock: {e}"))?;
    conn.execute(
        "UPDATE studio_projects SET deleted_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )
    .map_err(|e| format!("delete: {e}"))?;
    Ok(())
}
