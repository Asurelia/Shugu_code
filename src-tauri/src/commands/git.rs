//! Git commands — thin IPC bridge over `git` CLI.
//!
//! ## Commands
//!
//! | Command          | Purpose                                                     |
//! |------------------|-------------------------------------------------------------|
//! | `git_is_repo`    | Returns true if the workspace root is inside a git repo.   |
//! | `git_show_head`  | Returns HEAD content for a workspace-relative path, or     |
//! |                  | None when the file is untracked or the repo has no commits. |
//!
//! ## CRLF normalization (critical — Windows)
//!
//! On Windows with `core.autocrlf=true` (the default), git stores LF in
//! the object store but checks out files as CRLF. When the editor buffers
//! a freshly-opened file it holds CRLF. `git show HEAD:<path>` therefore
//! returns LF while the editor content is CRLF — every line appears
//! "modified" even when nothing has changed.
//!
//! Fix: normalize `\r\n` → `\n` on the `git show` output **before**
//! returning to the frontend, so both sides are compared in LF form.
//!
//! ## 3-tier stderr handling
//!
//! git exits non-zero for many distinct reasons. We classify them:
//!
//! 1. **Untracked / new file** — stderr contains "exists on disk, but not
//!    in" → return `Ok(None)`. Not an error; no diff decoration needed.
//! 2. **No commits yet / not a repo** — stderr contains "ambiguous argument
//!    'HEAD'", "does not exist in 'HEAD'", "does not exist in", or
//!    "not a git repository" → return `Ok(None)`. Fresh repo or plain
//!    folder with no git history; nothing to compare against.
//! 3. **Other error** — return `Err(String)` so the frontend can surface
//!    a diagnostic.
//!
//! ## Caching
//!
//! `git_is_repo` results are cached per-workspace-root in a global
//! `OnceLock<RwLock<HashMap>>`. The check is cheap, but it's called on
//! every file open (to decide whether to start decorating), so we avoid
//! spawning a subprocess on every keystroke.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{OnceLock, RwLock};

use tauri::{command, AppHandle, Manager};
use tokio::process::Command;

// ---------------------------------------------------------------------------
// Repo-presence cache
// ---------------------------------------------------------------------------

/// Per-workspace-root cache for `is_git_repo` results.
static REPO_CACHE: OnceLock<RwLock<HashMap<PathBuf, bool>>> = OnceLock::new();

fn repo_cache() -> &'static RwLock<HashMap<PathBuf, bool>> {
    REPO_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Internal helper (not a Tauri command — keeps state extraction DRY)
// ---------------------------------------------------------------------------

/// Resolve the workspace root from AppHandle state.
/// Falls back to temp dir when no workspace is open (scratch buffers).
fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    let ws_state = app.state::<std::sync::Mutex<Option<PathBuf>>>();
    let guard = ws_state
        .lock()
        .map_err(|e| format!("workspace lock: {e}"))?;
    Ok(guard.clone().unwrap_or_else(|| std::env::temp_dir()))
}

/// Checks whether `root` is inside a git repository by running
/// `git rev-parse --is-inside-work-tree`. Does NOT use the REPO_CACHE —
/// caching is handled by the public command wrapper.
async fn is_git_repo_internal(root: &Path) -> bool {
    let Ok(output) = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
    else {
        return false;
    };

    output.status.success()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Returns true if the current workspace is inside a git repository.
///
/// Result is cached per-workspace-root. Cache is never invalidated
/// (workspace roots don't flip between repo/non-repo at runtime).
#[command]
pub async fn git_is_repo(app: AppHandle) -> Result<bool, String> {
    let root = workspace_root(&app)?;

    // Fast path: check cache.
    {
        let cache = repo_cache()
            .read()
            .map_err(|e| format!("repo cache read lock: {e}"))?;
        if let Some(&cached) = cache.get(&root) {
            return Ok(cached);
        }
    }

    // Slow path: spawn subprocess then update cache.
    let result = is_git_repo_internal(&root).await;
    {
        let mut cache = repo_cache()
            .write()
            .map_err(|e| format!("repo cache write lock: {e}"))?;
        cache.insert(root, result);
    }

    Ok(result)
}

/// Returns the HEAD content of a workspace-relative `path`, or `None` when
/// the file is untracked or the repository has no commits yet.
///
/// CRLF is normalized to LF before returning (see module-level doc).
///
/// Errors:
/// - `"git not found"` — git binary not in PATH
/// - `"git error: <stderr>"` — unexpected git failure
#[command]
pub async fn git_show_head(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let root = workspace_root(&app)?;

    // Quick guard: don't bother if not a repo.
    // We reuse the cache-aware check without going through the Tauri dispatcher.
    {
        let cache = repo_cache()
            .read()
            .map_err(|e| format!("repo cache read lock: {e}"))?;
        if let Some(&false) = cache.get(&root) {
            return Ok(None);
        }
    }

    // Normalize path separator to forward-slash for git (required on Windows).
    let git_path = path.replace('\\', "/");

    let output = Command::new("git")
        .args(["show", &format!("HEAD:{git_path}")])
        .current_dir(&root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "git not found".to_string()
            } else {
                format!("git spawn: {e}")
            }
        })?;

    if output.status.success() {
        let raw = String::from_utf8(output.stdout)
            .map_err(|e| format!("git show utf8: {e}"))?;
        // CRLF normalization — see module-level doc.
        let normalized = raw.replace("\r\n", "\n");
        return Ok(Some(normalized));
    }

    // Non-zero exit: classify the stderr.
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Tier 1 — file exists on disk but is not tracked (new/untracked).
    if stderr.contains("exists on disk, but not in") {
        return Ok(None);
    }
    // Tier 2 — repo has no commits yet, path not in HEAD, or plain folder
    // (not a git workspace at all). All of these are non-error "no data"
    // conditions from the frontend's perspective.
    if stderr.contains("ambiguous argument 'HEAD'")
        || stderr.contains("does not exist in 'HEAD'")
        || stderr.contains("does not exist in")
        || stderr.contains("not a git repository")
    {
        return Ok(None);
    }

    // Tier 3 — real error.
    let first_lines: String = stderr
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("\n");

    Err(format!("git error: {first_lines}"))
}
