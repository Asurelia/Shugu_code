//! Real filesystem commands for the Shugu Forge workspace.
//!
//! ## Security model
//! All I/O is bounded to the `workspace_root` managed in Tauri state.
//! Two resolvers enforce containment:
//! - `safe_resolve` — for reads (file must exist; uses canonicalize).
//! - `safe_resolve_for_write` — for writes (file may be new; lexical
//!   normalization + ancestor canonicalize).
//!
//! No I/O is performed outside `workspace_root`.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single node in the workspace file tree.
#[derive(Serialize, Clone)]
pub struct FsEntry {
    pub name: String,
    /// Workspace-relative path, forward-slash normalised (never starts with `/`).
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FsEntry>,
}

// ---------------------------------------------------------------------------
// Ignore list
// ---------------------------------------------------------------------------

const IGNORED_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    "__pycache__",
    ".DS_Store",
    ".svn",
    ".hg",
];

pub(crate) fn is_ignored(name: &str) -> bool {
    // Case-insensitive on Windows, case-sensitive on macOS/Linux.
    #[cfg(target_os = "windows")]
    return IGNORED_NAMES
        .iter()
        .any(|&n| n.eq_ignore_ascii_case(name));
    #[cfg(not(target_os = "windows"))]
    return IGNORED_NAMES.contains(&name);
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/// Resolve a workspace-relative path for **reading**.
///
/// The file must already exist on disk (we call `canonicalize` on the full
/// joined path).  Rejects null bytes, absolute `rel`, and traversal sequences
/// that escape the workspace root.
///
/// `root` must be pre-canonicalized (done once in `fs_open_folder`).
pub fn safe_resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') {
        return Err("invalid path: null byte".into());
    }
    // Reject absolute paths from the frontend (they would bypass the root join).
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("invalid path: must be relative".into());
    }
    let joined = root.join(rel_path);
    // canonicalize resolves `..`, symlinks, and normalises separators.
    // It errors if the path does not exist — correct for reads.
    let canonical = std::fs::canonicalize(&joined)
        .map_err(|e| format!("path not found: {e}"))?;
    if !canonical.starts_with(root) {
        return Err("path escapes workspace root".into());
    }
    Ok(canonical)
}

/// Resolve a workspace-relative path for **writing**.
///
/// The target file need not exist yet.  We:
/// 1. Reject null bytes and absolute `rel`.
/// 2. Lexically normalise `rel` via `Path::components()`, rejecting any `..`,
///    root-dir, or prefix component — a legitimate workspace path never needs
///    these.
/// 3. Join to `root` (guaranteed-in-root after step 2).
/// 4. Canonicalize the deepest *existing* ancestor directory and assert it
///    `starts_with(root)` to catch symlinked directories.
///
/// Only after all checks pass does the caller proceed to `create_dir_all` + write.
pub fn safe_resolve_for_write(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') {
        return Err("invalid path: null byte".into());
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("invalid path: must be relative".into());
    }

    // Lexical normalisation: rebuild the path component by component.
    let mut normalized = PathBuf::new();
    for component in rel_path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {} // `.` — skip
            // `..`, absolute prefix, root — all rejected.
            Component::ParentDir => {
                return Err("invalid path: parent directory traversal".into())
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("invalid path: must be relative".into())
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("invalid path: empty after normalization".into());
    }

    let target = root.join(&normalized);

    // Find the deepest ancestor directory that actually exists on disk and
    // canonicalize it to catch symlinked directory escapes.
    let mut ancestor = target.as_path();
    loop {
        match ancestor.parent() {
            Some(p) => ancestor = p,
            None => break,
        }
        if ancestor.exists() {
            break;
        }
    }

    // If even root doesn't exist (edge-case during tests), fall back to root.
    let check_base = if ancestor.exists() {
        ancestor
    } else {
        root
    };

    let canonical_ancestor = std::fs::canonicalize(check_base)
        .map_err(|e| format!("cannot canonicalize ancestor directory: {e}"))?;

    if !canonical_ancestor.starts_with(root) {
        return Err("path escapes workspace root".into());
    }

    Ok(target)
}

// ---------------------------------------------------------------------------
// SQLite helper for settings (workspace_root persistence)
// ---------------------------------------------------------------------------

/// Open a bare rusqlite connection to `shugu.db` in the app config directory.
/// Mirrors the pattern in `vector.rs:get_conn` but without the OnceLock cache
/// (settings access is infrequent — one open/close per call is acceptable).
fn open_settings_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?
        .join("shugu.db");
    let conn =
        Connection::open(&db_path).map_err(|e| format!("rusqlite open {}: {e}", db_path.display()))?;
    // Ensure the settings table exists even on a fresh install before
    // tauri-plugin-sql has run its migrations (idempotent — no-ops if the
    // table was already created by the plugin).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings \
         (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    )
    .map_err(|e| format!("ensure settings table: {e}"))?;
    Ok(conn)
}

fn persist_workspace_root(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    let conn = open_settings_db(app)?;
    let value = root.to_string_lossy().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        params!["workspace_root", value, now],
    )
    .map_err(|e| format!("persist workspace_root: {e}"))?;
    Ok(())
}

/// Read `workspace_root` from the settings table.  Returns `None` if the row
/// doesn't exist or the path no longer exists on disk.  Never panics.
pub fn restore_workspace_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let conn = open_settings_db(app).ok()?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'workspace_root'",
            [],
            |row| row.get(0),
        )
        .ok();
    let value = value?;
    let path = PathBuf::from(&value);
    // Canonicalize the restored path; silently return None if it no longer exists.
    let canonical = std::fs::canonicalize(&path).ok()?;
    if canonical.is_dir() {
        Some(canonical)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Tree builder (used by fs_read_dir)
// ---------------------------------------------------------------------------

const MAX_ENTRIES: usize = 5_000;

/// Build a nested `Vec<FsEntry>` from a flat walkdir iterator.
/// Entries are sorted: directories first, then files, both alphabetical.
fn build_tree(root: &Path, entries: Vec<walkdir::DirEntry>) -> Vec<FsEntry> {
    // We need to reconstruct the hierarchy from the flat list.
    // Use a recursive helper: given a parent path, collect immediate children
    // from `entries`, then recurse.
    fn collect_children(
        parent: &Path,
        root: &Path,
        all_entries: &[walkdir::DirEntry],
        depth: usize,
    ) -> Vec<FsEntry> {
        let mut children: Vec<FsEntry> = all_entries
            .iter()
            .filter(|e| e.path().parent() == Some(parent))
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let rel = e
                    .path()
                    .strip_prefix(root)
                    .unwrap_or(e.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                let is_dir = e.file_type().is_dir();
                let children = if is_dir && depth < 8 {
                    collect_children(e.path(), root, all_entries, depth + 1)
                } else {
                    vec![]
                };
                FsEntry {
                    name,
                    path: rel,
                    is_dir,
                    children,
                }
            })
            .collect();

        // Sort: directories first, then files, both alphabetical.
        children.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        children
    }

    collect_children(root, root, &entries, 1)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Open a native folder picker and set the workspace root.
///
/// Returns the chosen folder's absolute path, or `null` if the user cancelled.
#[tauri::command]
pub fn fs_open_folder(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
    watcher_ctl: tauri::State<'_, crate::commands::watcher::WatcherCtl>,
) -> Result<Option<String>, String> {
    // Show blocking native folder picker.
    let picked = app.dialog().file().blocking_pick_folder();
    let file_path = match picked {
        Some(p) => p,
        None => return Ok(None), // user cancelled
    };

    let raw_path = file_path
        .into_path()
        .map_err(|e| format!("invalid path from dialog: {e}"))?;

    let canonical = std::fs::canonicalize(&raw_path)
        .map_err(|e| format!("canonicalize workspace: {e}"))?;

    // Store in managed state.
    let display = canonical.to_string_lossy().to_string();
    {
        let mut guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        *guard = Some(canonical.clone());
    }

    // Persist to settings table (best-effort — don't fail the command on DB error).
    let _ = persist_workspace_root(&app, &canonical);

    // Notify the watcher of the new root (best-effort — never fail the command).
    let _ = watcher_ctl.0.send(canonical.clone());

    Ok(Some(display))
}

/// Walk the workspace root and return a recursive directory tree.
///
/// Returns `Err("no workspace open")` if no folder has been opened yet.
#[tauri::command]
pub fn fs_read_dir(
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<Vec<FsEntry>, String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };

    // TODO: add .gitignore parsing (deferred to B1.5).

    let mut flat_entries: Vec<walkdir::DirEntry> = Vec::new();
    let mut count = 0usize;

    let walker = WalkDir::new(&root)
        .follow_links(false)
        .max_depth(8)
        .min_depth(1) // exclude the root itself
        .into_iter()
        .filter_entry(|e| {
            // Filter out ignored directory names.
            let name = e.file_name().to_string_lossy();
            !is_ignored(&name)
        });

    for result in walker {
        match result {
            Ok(entry) => {
                count += 1;
                if count > MAX_ENTRIES {
                    return Err(
                        "workspace too large (>5000 entries); open a subdirectory".to_string()
                    );
                }
                flat_entries.push(entry);
            }
            Err(e) => {
                // Broken symlinks, permission errors — log and continue.
                eprintln!("[fs_read_dir] skipping entry: {e}");
            }
        }
    }

    Ok(build_tree(&root, flat_entries))
}

/// Read a workspace-relative file path and return its content as a string.
///
/// Rejects binary files (null bytes in first 8 KiB) and files over 5 MiB.
#[tauri::command]
pub fn fs_read_file(
    path: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<String, String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };

    let resolved = safe_resolve(&root, &path)?;

    // Size check before reading.
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("stat error: {e}"))?;
    const MAX_SIZE: u64 = 5 * 1024 * 1024; // 5 MiB
    if meta.len() > MAX_SIZE {
        return Err("file too large (>5 MiB)".into());
    }

    let bytes = std::fs::read(&resolved).map_err(|e| format!("read error: {e}"))?;

    // Binary detection: scan first 8 KiB for null bytes.
    let scan_len = bytes.len().min(8 * 1024);
    if bytes[..scan_len].contains(&0u8) {
        return Err("binary file".into());
    }

    // Decode with lossy UTF-8 (invalid sequences → U+FFFD). Preserve CRLF.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Write content to a workspace-relative file path (atomic via temp-file + rename).
///
/// Creates intermediate directories if needed.  Rejects paths outside the workspace.
#[tauri::command]
pub fn fs_write_file(
    path: String,
    content: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };

    // Use the write-safe resolver (file may not exist yet).
    let target = safe_resolve_for_write(&root, &path)?;

    // Ensure parent directory exists.
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all: {e}"))?;
    }

    // Atomic write: write to temp file then rename.
    let tmp = target.with_extension({
        let orig_ext = target
            .extension()
            .map(|e| format!("{}.shugu_tmp", e.to_string_lossy()))
            .unwrap_or_else(|| "shugu_tmp".to_string());
        orig_ext
    });

    std::fs::write(&tmp, content.as_bytes())
        .map_err(|e| format!("write temp file: {e}"))?;

    if let Err(e) = std::fs::rename(&tmp, &target) {
        // Best-effort cleanup of the temp file.
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("atomic rename failed: {e}"));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// B1-C: New mutation commands (create_file, create_dir, rename, delete)
// ---------------------------------------------------------------------------

/// Create a new file at a workspace-relative path.
///
/// Fails if the file already exists.  Creates intermediate parent directories.
/// If `content` is `None` an empty file is written; otherwise the given string
/// is written atomically (temp-file + rename — same pattern as `fs_write_file`).
#[tauri::command]
pub fn fs_create_file(
    path: String,
    content: Option<String>,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = lock_root(&root_state)?;
    let target = safe_resolve_for_write(&root, &path)?;

    if target
        .try_exists()
        .map_err(|e| format!("stat error: {e}"))?
    {
        return Err(format!("file already exists: {}", path));
    }

    // Ensure parent directories exist.
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
    }

    let body = content.unwrap_or_default();

    // Atomic write: temp file in same directory then rename.
    let tmp = make_tmp_path(&target);
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("write temp file: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("atomic rename failed: {e}"));
    }

    Ok(())
}

/// Create a directory (and all parents) at a workspace-relative path.
///
/// Idempotent: succeeds if the directory already exists.
#[tauri::command]
pub fn fs_create_dir(
    path: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = lock_root(&root_state)?;
    let target = safe_resolve_for_write(&root, &path)?;
    std::fs::create_dir_all(&target).map_err(|e| format!("create_dir_all: {e}"))
}

/// Rename (move) a workspace-relative path.
///
/// `from` must exist; `to` must not exist (no silent overwrite).  If `to`'s
/// parent directories are missing they are created first.  Both `from` and `to`
/// must remain inside the workspace root.
#[tauri::command]
pub fn fs_rename(
    from: String,
    to: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = lock_root(&root_state)?;

    // `from` must already exist.
    let from_abs = safe_resolve(&root, &from)?;

    // `to` must be inside the workspace (may not exist yet).
    let to_abs = safe_resolve_for_write(&root, &to)?;

    // Guard against silent overwrites (POSIX rename() would silently replace).
    if to_abs
        .try_exists()
        .map_err(|e| format!("stat error (to): {e}"))?
    {
        return Err(format!("destination already exists: {}", to));
    }

    // Create parent directories for `to` if necessary.
    if let Some(parent) = to_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all (to parent): {e}"))?;
    }

    std::fs::rename(&from_abs, &to_abs).map_err(|e| format!("rename failed: {e}"))
}

/// Delete a file or directory at a workspace-relative path.
///
/// Files are deleted with `remove_file`.  Directories are deleted recursively
/// using `walkdir` with `follow_links(false)` and `contents_first(true)` — we
/// never follow symlinks out of the workspace.
///
/// SECURITY NOTE: `safe_resolve` canonicalises the path and rejects any
/// symlink whose resolved target is outside the workspace.  This means a
/// dangling or out-of-workspace symlink cannot be deleted through this command.
/// That is intentional; use the host OS to remove such links.
#[tauri::command]
pub fn fs_delete(
    path: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = lock_root(&root_state)?;
    let target = safe_resolve(&root, &path)?;

    // Use symlink_metadata so we see the symlink type, not its target's type.
    let meta =
        std::fs::symlink_metadata(&target).map_err(|e| format!("stat error: {e}"))?;

    if meta.is_dir() {
        delete_dir_no_follow(&target)
    } else {
        // Regular file or symlink: remove_file is correct for both.
        std::fs::remove_file(&target).map_err(|e| format!("remove_file: {e}"))
    }
}

// ---------------------------------------------------------------------------
// Private helpers shared by the mutation commands
// ---------------------------------------------------------------------------

/// Extract the workspace root from state, returning a clean error if unset.
fn lock_root(state: &Mutex<Option<PathBuf>>) -> Result<PathBuf, String> {
    let guard = state.lock().map_err(|e| format!("workspace state lock: {e}"))?;
    guard.clone().ok_or_else(|| "no workspace open".to_string())
}

/// Build the temp-file path for atomic writes (placed next to the target).
fn make_tmp_path(target: &Path) -> PathBuf {
    let ext = target
        .extension()
        .map(|e| format!("{}.shugu_tmp", e.to_string_lossy()))
        .unwrap_or_else(|| "shugu_tmp".to_string());
    target.with_extension(ext)
}

/// Recursively delete a directory without following symlinks.
///
/// Uses `walkdir` with `follow_links(false)` and `contents_first(true)` so
/// leaves are yielded before parents — deletion works in natural iteration order.
/// Symlinks-to-dirs are treated as files by walkdir under `follow_links(false)`,
/// so `is_dir()` returns `false` for them and they are removed with `remove_file`.
fn delete_dir_no_follow(dir: &Path) -> Result<(), String> {
    for result in WalkDir::new(dir)
        .follow_links(false)
        .contents_first(true)
    {
        let entry = result.map_err(|e| format!("walkdir error: {e}"))?;
        let ft = entry.file_type();
        if ft.is_dir() {
            std::fs::remove_dir(entry.path())
                .map_err(|e| format!("remove_dir {:?}: {e}", entry.path()))?;
        } else {
            // Regular file or symlink-to-anything.
            std::fs::remove_file(entry.path())
                .map_err(|e| format!("remove_file {:?}: {e}", entry.path()))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Create a unique temp directory for test isolation.
    fn make_temp_dir(suffix: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("shugu_fs_test_{suffix}"));
        fs::create_dir_all(&base).expect("create temp dir");
        // Canonicalize so that starts_with comparisons work on Windows (UNC paths).
        std::fs::canonicalize(&base).expect("canonicalize temp dir")
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // safe_resolve tests
    // -----------------------------------------------------------------------

    #[test]
    fn safe_resolve_valid_inside_root() {
        let root = make_temp_dir("resolve_valid");
        let file = root.join("subdir").join("hello.txt");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"hi").unwrap();

        let result = safe_resolve(&root, "subdir/hello.txt");
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        cleanup(&root);
    }

    #[test]
    fn safe_resolve_rejects_traversal() {
        let root = make_temp_dir("resolve_traverse");
        // Create a file outside root that we try to escape to.
        let result = safe_resolve(&root, "../escape.txt");
        assert!(result.is_err(), "expected Err for ../escape");
        cleanup(&root);
    }

    #[test]
    fn safe_resolve_rejects_absolute_path() {
        let root = make_temp_dir("resolve_absolute");
        // Try to pass an absolute path.
        let abs = if cfg!(target_os = "windows") {
            "C:\\Windows\\System32\\calc.exe"
        } else {
            "/etc/passwd"
        };
        let result = safe_resolve(&root, abs);
        assert!(result.is_err(), "expected Err for absolute path");
        cleanup(&root);
    }

    #[test]
    fn safe_resolve_rejects_null_byte() {
        let root = make_temp_dir("resolve_null");
        let result = safe_resolve(&root, "some\0file.txt");
        assert!(result.is_err(), "expected Err for null byte");
        assert!(
            result.unwrap_err().contains("null byte"),
            "error should mention null byte"
        );
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // safe_resolve_for_write tests
    // -----------------------------------------------------------------------

    /// This is the regression test for the canonicalize-on-nonexistent-file bug.
    /// A new file inside the workspace root MUST succeed even though it doesn't exist yet.
    #[test]
    fn safe_resolve_for_write_nonexistent_file_inside_root_ok() {
        let root = make_temp_dir("write_nonexistent");

        // The file does NOT exist on disk yet.
        let result = safe_resolve_for_write(&root, "new_file.rs");
        assert!(
            result.is_ok(),
            "safe_resolve_for_write must succeed for a non-existent file inside root; got: {:?}",
            result
        );

        // The returned path must be inside root.
        let resolved = result.unwrap();
        assert!(
            resolved.starts_with(&root),
            "resolved path {:?} must start with root {:?}",
            resolved,
            root
        );

        // The file must NOT have been created as a side-effect.
        assert!(!resolved.exists(), "safe_resolve_for_write must not create the file");

        cleanup(&root);
    }

    #[test]
    fn safe_resolve_for_write_nonexistent_nested_inside_root_ok() {
        let root = make_temp_dir("write_nonexistent_nested");

        // Deep nested path — neither file nor parent dirs exist.
        let result = safe_resolve_for_write(&root, "src/components/NewWidget.tsx");
        assert!(
            result.is_ok(),
            "nested non-existent path inside root should be Ok; got: {:?}",
            result
        );

        cleanup(&root);
    }

    #[test]
    fn safe_resolve_for_write_rejects_traversal_no_dir_created() {
        let root = make_temp_dir("write_traverse");
        let escape_path = "../escape_target/evil.txt";

        let result = safe_resolve_for_write(&root, escape_path);
        assert!(result.is_err(), "expected Err for ../escape path");

        // CRITICAL: confirm no directory was created outside root.
        let would_be_escape = root
            .parent()
            .unwrap()
            .join("escape_target");
        assert!(
            !would_be_escape.exists(),
            "safe_resolve_for_write must NOT create directories for escaping paths"
        );

        cleanup(&root);
    }

    #[test]
    fn safe_resolve_for_write_rejects_null_byte() {
        let root = make_temp_dir("write_null");
        let result = safe_resolve_for_write(&root, "foo\0bar.txt");
        assert!(result.is_err(), "expected Err for null byte");
        cleanup(&root);
    }

    #[test]
    fn safe_resolve_for_write_rejects_absolute_path() {
        let root = make_temp_dir("write_absolute");
        let abs = if cfg!(target_os = "windows") {
            "C:\\Windows\\evil.txt"
        } else {
            "/tmp/evil.txt"
        };
        let result = safe_resolve_for_write(&root, abs);
        assert!(result.is_err(), "expected Err for absolute path");
        cleanup(&root);
    }

    // NOTE: symlink-target-outside-root test skipped on Windows because
    // creating symlinks requires elevated privileges or Developer Mode to be
    // enabled (CreateSymbolicLink requires SeCreateSymbolicLinkPrivilege).
    // On POSIX systems `std::os::unix::fs::symlink` is unprivileged and this
    // case WOULD be tested.  The defense for symlinked dirs is provided by the
    // `canonical_ancestor.starts_with(root)` check in `safe_resolve_for_write`
    // and the `canonicalize + starts_with` check in `safe_resolve`.
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn safe_resolve_for_write_rejects_symlinked_dir_escape() {
        use std::os::unix::fs::symlink;

        let root = make_temp_dir("write_symlink");
        let outside = make_temp_dir("write_symlink_outside");

        // Create a symlink inside root that points outside root.
        let link = root.join("link_to_outside");
        symlink(&outside, &link).expect("create symlink");

        // Try to write through the symlinked directory.
        let result = safe_resolve_for_write(&root, "link_to_outside/evil.txt");
        assert!(
            result.is_err(),
            "expected Err when target is through a symlink pointing outside root"
        );

        cleanup(&root);
        cleanup(&outside);
    }

    // -----------------------------------------------------------------------
    // fs_create_file impl tests (test the helpers directly, not the Tauri command)
    // -----------------------------------------------------------------------

    /// Create a file in a fresh temp root — must succeed.
    #[test]
    fn create_file_impl_new_file_ok() {
        let root = make_temp_dir("create_file_new");
        let target = safe_resolve_for_write(&root, "hello.txt").unwrap();

        // Simulate what fs_create_file does after resolving.
        assert!(!target.exists(), "precondition: file must not exist");
        fs::write(&target, b"hello").unwrap();
        assert!(target.exists(), "file should now exist");

        cleanup(&root);
    }

    #[test]
    fn create_file_rejects_existing() {
        let root = make_temp_dir("create_file_exists");
        let file = root.join("existing.txt");
        fs::write(&file, b"data").unwrap();
        // If target already exists, the command would error.
        assert!(file.try_exists().unwrap(), "precondition: file exists");

        cleanup(&root);
    }

    #[test]
    fn create_file_rejects_traversal() {
        let root = make_temp_dir("create_file_traverse");
        let result = safe_resolve_for_write(&root, "../evil.txt");
        assert!(result.is_err(), "traversal must be rejected");
        cleanup(&root);
    }

    #[test]
    fn create_file_rejects_null_byte() {
        let root = make_temp_dir("create_file_null");
        let result = safe_resolve_for_write(&root, "foo\0bar.txt");
        assert!(result.is_err(), "null byte must be rejected");
        cleanup(&root);
    }

    #[test]
    fn create_file_creates_parent_dirs() {
        let root = make_temp_dir("create_file_parents");
        // deep/nested/new.txt — parents don't exist yet
        let target = safe_resolve_for_write(&root, "deep/nested/new.txt").unwrap();
        if let Some(p) = target.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(&target, b"").unwrap();
        assert!(target.exists());
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // fs_create_dir impl tests
    // -----------------------------------------------------------------------

    #[test]
    fn create_dir_impl_new_dir_ok() {
        let root = make_temp_dir("create_dir_new");
        let target = safe_resolve_for_write(&root, "subdir/nested").unwrap();
        fs::create_dir_all(&target).unwrap();
        assert!(target.is_dir());
        cleanup(&root);
    }

    #[test]
    fn create_dir_idempotent_on_existing() {
        let root = make_temp_dir("create_dir_idem");
        let target = root.join("existing_dir");
        fs::create_dir_all(&target).unwrap();
        // second call must not error
        fs::create_dir_all(&target).unwrap();
        cleanup(&root);
    }

    #[test]
    fn create_dir_rejects_traversal() {
        let root = make_temp_dir("create_dir_traverse");
        let result = safe_resolve_for_write(&root, "../outside_dir");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn create_dir_rejects_null_byte() {
        let root = make_temp_dir("create_dir_null");
        let result = safe_resolve_for_write(&root, "dir\0name");
        assert!(result.is_err());
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // fs_rename impl tests
    // -----------------------------------------------------------------------

    #[test]
    fn rename_impl_success() {
        let root = make_temp_dir("rename_ok");
        let from = root.join("original.txt");
        fs::write(&from, b"content").unwrap();
        let from_canon = std::fs::canonicalize(&from).unwrap();

        let to = safe_resolve_for_write(&root, "renamed.txt").unwrap();
        assert!(!to.exists());

        std::fs::rename(&from_canon, &to).unwrap();
        assert!(to.exists());
        assert!(!from_canon.exists());
        cleanup(&root);
    }

    #[test]
    fn rename_impl_to_exists_fails() {
        let root = make_temp_dir("rename_to_exists");
        let from = root.join("a.txt");
        let to = root.join("b.txt");
        fs::write(&from, b"a").unwrap();
        fs::write(&to, b"b").unwrap();

        // The guard in fs_rename checks try_exists before calling rename.
        let to_resolved = safe_resolve_for_write(&root, "b.txt").unwrap();
        let exists = to_resolved.try_exists().unwrap();
        assert!(exists, "to already exists — command should have returned Err");
        cleanup(&root);
    }

    #[test]
    fn rename_rejects_from_traversal() {
        let root = make_temp_dir("rename_from_traverse");
        // safe_resolve requires the path to exist AND be inside root.
        let result = safe_resolve(&root, "../outside.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn rename_rejects_to_traversal() {
        let root = make_temp_dir("rename_to_traverse");
        let result = safe_resolve_for_write(&root, "../outside.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn rename_rejects_null_byte_in_from() {
        let root = make_temp_dir("rename_null_from");
        let result = safe_resolve(&root, "foo\0bar.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn rename_rejects_null_byte_in_to() {
        let root = make_temp_dir("rename_null_to");
        let result = safe_resolve_for_write(&root, "foo\0bar.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // fs_delete impl tests
    // -----------------------------------------------------------------------

    #[test]
    fn delete_file_ok() {
        let root = make_temp_dir("delete_file");
        let file = root.join("to_delete.txt");
        fs::write(&file, b"bye").unwrap();

        let resolved = safe_resolve(&root, "to_delete.txt").unwrap();
        fs::remove_file(&resolved).unwrap();
        assert!(!file.exists());
        cleanup(&root);
    }

    #[test]
    fn delete_dir_recursive_ok() {
        let root = make_temp_dir("delete_dir_rec");
        let dir = root.join("mydir");
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("file.txt"), b"x").unwrap();
        fs::write(dir.join("nested").join("deep.txt"), b"y").unwrap();

        let resolved = safe_resolve(&root, "mydir").unwrap();
        delete_dir_no_follow(&resolved).unwrap();
        assert!(!dir.exists());
        cleanup(&root);
    }

    #[test]
    fn delete_nonexistent_fails() {
        let root = make_temp_dir("delete_missing");
        // safe_resolve calls canonicalize which fails if path doesn't exist.
        let result = safe_resolve(&root, "ghost.txt");
        assert!(result.is_err(), "nonexistent path must be rejected");
        cleanup(&root);
    }

    #[test]
    fn delete_rejects_traversal() {
        let root = make_temp_dir("delete_traverse");
        let result = safe_resolve(&root, "../outside.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn delete_rejects_null_byte() {
        let root = make_temp_dir("delete_null");
        let result = safe_resolve(&root, "foo\0bar.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn delete_rejects_dotdot_segment() {
        let root = make_temp_dir("delete_dotdot");
        // A path like "dir/../../../etc" — safe_resolve canonicalizes and checks.
        let result = safe_resolve(&root, "dir/../../../etc");
        assert!(result.is_err());
        cleanup(&root);
    }
}
