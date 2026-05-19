//! Git commands — hybrid IPC bridge over `git2` (libgit2 read-side) and
//! the `git` CLI (write-side, network, hooks-respecting).
//!
//! ## Backend choice per command
//!
//! Read-only / cheap → git2 in-process:
//!   `git_status`, `git_diff_file`, `git_log`, `git_branches`, `git_blame`,
//!   `git_stash_list`, `git_remotes`, `git_show_head` (existant CLI), `git_is_repo`.
//!
//! Mutating / network / hooks → `git` CLI subprocess:
//!   `git_stage`, `git_unstage`, `git_discard`, `git_stage_hunk`,
//!   `git_unstage_hunk`, `git_commit`, `git_checkout`, `git_push`, `git_pull`,
//!   `git_fetch`, `git_stash_save`, `git_stash_apply`, `git_remote_add`,
//!   `git_remote_remove`.
//!
//! ## CRLF normalization (critical — Windows)
//!
//! On Windows with `core.autocrlf=true` (the default), git stores LF in
//! the object store but checks out files as CRLF. Every textual output
//! that flows back to the frontend is normalized `\r\n` → `\n` so the
//! frontend never sees mixed line endings.
//!
//! ## Windows path prefix
//!
//! `git2::Repository::workdir()` returns canonicalized paths which on
//! Windows are prefixed with `\\?\`. We strip that prefix from any path
//! that crosses the IPC boundary (cf. project memory
//! `feedback_windows_extended_path_prefix`).
//!
//! ## Threading / async
//!
//! `git2::Repository` holds raw libgit2 pointers and is `!Send`. Commands
//! that use git2 are plain sync `fn`. Commands that shell out use `async fn`
//! with `tokio::process::Command`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{OnceLock, RwLock};

use git2::{
    BlameOptions, BranchType, DiffFormat, DiffOptions, Repository, Sort, StatusOptions,
};
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command as TokioCommand;

// ---------------------------------------------------------------------------
// Repo-presence cache
// ---------------------------------------------------------------------------

static REPO_CACHE: OnceLock<RwLock<HashMap<PathBuf, bool>>> = OnceLock::new();

fn repo_cache() -> &'static RwLock<HashMap<PathBuf, bool>> {
    REPO_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    let ws_state = app.state::<std::sync::Mutex<Option<PathBuf>>>();
    let guard = ws_state
        .lock()
        .map_err(|e| format!("workspace lock: {e}"))?;
    Ok(guard.clone().unwrap_or_else(std::env::temp_dir))
}

fn workspace_root_required(app: &AppHandle) -> Result<PathBuf, String> {
    let ws_state = app.state::<std::sync::Mutex<Option<PathBuf>>>();
    let guard = ws_state
        .lock()
        .map_err(|e| format!("workspace lock: {e}"))?;
    guard.clone().ok_or_else(|| "no workspace open".to_string())
}

/// Strip Windows extended-length prefix (`\\?\`) from a path. On non-Windows
/// targets the input is returned unchanged. The frontend never sees the
/// prefix — paths cross the IPC boundary as plain absolute paths.
fn strip_extended_prefix(p: PathBuf) -> PathBuf {
    if cfg!(windows) {
        let s = p.to_string_lossy();
        let stripped = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            return p;
        };
        PathBuf::from(stripped)
    } else {
        p
    }
}

fn open_repo_at(root: &Path) -> Result<Repository, String> {
    Repository::discover(root).map_err(|_| "not a git repository".to_string())
}

fn libgit2_err(e: git2::Error) -> String {
    format!("libgit2: {}", e.message())
}

fn normalize_path(s: &str) -> String {
    s.replace('\\', "/")
}

fn workdir(repo: &Repository) -> Result<PathBuf, String> {
    repo.workdir()
        .map(|p| strip_extended_prefix(p.to_path_buf()))
        .ok_or_else(|| "bare repository".to_string())
}

/// Run `git <args>` and return stdout (CRLF-normalized) on success.
async fn run_git_cli(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = TokioCommand::new("git")
        .args(args)
        .current_dir(root)
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

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first_lines: String = stderr
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(3)
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("git error: {first_lines}"));
    }

    let raw =
        String::from_utf8(output.stdout).map_err(|e| format!("git stdout utf8: {e}"))?;
    Ok(raw.replace("\r\n", "\n"))
}

/// Run `git <args>` piping `stdin_data` into stdin. Returns stdout on success.
async fn run_git_cli_stdin(
    root: &Path,
    args: &[&str],
    stdin_data: &str,
) -> Result<String, String> {
    let mut child = TokioCommand::new("git")
        .args(args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "git not found".to_string()
            } else {
                format!("git spawn: {e}")
            }
        })?;

    {
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let mut stdin = tokio::io::BufWriter::new(stdin);
        stdin
            .write_all(stdin_data.as_bytes())
            .await
            .map_err(|e| format!("stdin write: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("stdin flush: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("git wait: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first_lines: String = stderr
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(3)
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("git error: {first_lines}"));
    }

    let raw =
        String::from_utf8(output.stdout).map_err(|e| format!("git stdout utf8: {e}"))?;
    Ok(raw.replace("\r\n", "\n"))
}

async fn is_git_repo_internal(root: &Path) -> bool {
    let Ok(output) = TokioCommand::new("git")
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
// Types (serde camelCase)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub index_status: char,
    pub worktree_status: char,
    pub is_conflicted: bool,
    pub is_staged: bool,
    pub is_untracked: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub last_commit_oid: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchList {
    pub current: Option<String>,
    pub local: Vec<GitBranch>,
    pub remote: Vec<GitBranch>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    pub line_number: u32,
    pub oid: String,
    pub short_oid: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub summary: String,
    pub is_uncommitted: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    pub index: u32,
    pub oid: String,
    pub message: String,
    pub timestamp: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,
    pub url: String,
    pub push_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Status char translation
// ---------------------------------------------------------------------------

fn status_char_index(s: git2::Status) -> char {
    if s.contains(git2::Status::INDEX_NEW) {
        'A'
    } else if s.contains(git2::Status::INDEX_MODIFIED) {
        'M'
    } else if s.contains(git2::Status::INDEX_DELETED) {
        'D'
    } else if s.contains(git2::Status::INDEX_RENAMED) {
        'R'
    } else if s.contains(git2::Status::INDEX_TYPECHANGE) {
        'T'
    } else if s.contains(git2::Status::WT_NEW) && !s.intersects(any_index_change()) {
        '?'
    } else {
        ' '
    }
}

fn status_char_worktree(s: git2::Status) -> char {
    if s.contains(git2::Status::CONFLICTED) {
        'U'
    } else if s.contains(git2::Status::WT_MODIFIED) {
        'M'
    } else if s.contains(git2::Status::WT_DELETED) {
        'D'
    } else if s.contains(git2::Status::WT_RENAMED) {
        'R'
    } else if s.contains(git2::Status::WT_TYPECHANGE) {
        'T'
    } else if s.contains(git2::Status::WT_NEW) && !s.intersects(any_index_change()) {
        '?'
    } else {
        ' '
    }
}

fn any_index_change() -> git2::Status {
    git2::Status::INDEX_NEW
        | git2::Status::INDEX_MODIFIED
        | git2::Status::INDEX_DELETED
        | git2::Status::INDEX_RENAMED
        | git2::Status::INDEX_TYPECHANGE
}

// ---------------------------------------------------------------------------
// Existing commands — KEEP
// ---------------------------------------------------------------------------

#[command]
pub async fn git_is_repo(app: AppHandle) -> Result<bool, String> {
    let root = workspace_root(&app)?;

    {
        let cache = repo_cache()
            .read()
            .map_err(|e| format!("repo cache read lock: {e}"))?;
        if let Some(&cached) = cache.get(&root) {
            return Ok(cached);
        }
    }

    let result = is_git_repo_internal(&root).await;
    {
        let mut cache = repo_cache()
            .write()
            .map_err(|e| format!("repo cache write lock: {e}"))?;
        cache.insert(root, result);
    }

    Ok(result)
}

#[command]
pub async fn git_show_head(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let root = workspace_root(&app)?;

    {
        let cache = repo_cache()
            .read()
            .map_err(|e| format!("repo cache read lock: {e}"))?;
        if let Some(&false) = cache.get(&root) {
            return Ok(None);
        }
    }

    let git_path = normalize_path(&path);

    let output = TokioCommand::new("git")
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
        let normalized = raw.replace("\r\n", "\n");
        return Ok(Some(normalized));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);

    if stderr.contains("exists on disk, but not in") {
        return Ok(None);
    }
    if stderr.contains("ambiguous argument 'HEAD'")
        || stderr.contains("does not exist in 'HEAD'")
        || stderr.contains("does not exist in")
        || stderr.contains("not a git repository")
    {
        return Ok(None);
    }

    let first_lines: String = stderr
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("\n");

    Err(format!("git error: {first_lines}"))
}

// ---------------------------------------------------------------------------
// git_status (git2)
// ---------------------------------------------------------------------------

fn git_status_inner(root: &Path) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo_at(root)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(libgit2_err)?;

    let mut out = Vec::with_capacity(statuses.len());
    for entry in statuses.iter() {
        let Some(raw_path) = entry.path() else {
            continue;
        };
        let s = entry.status();

        if s == git2::Status::CURRENT || s.contains(git2::Status::IGNORED) {
            continue;
        }

        let index_status = status_char_index(s);
        let worktree_status = status_char_worktree(s);
        let is_conflicted = s.contains(git2::Status::CONFLICTED);
        let is_untracked = s.contains(git2::Status::WT_NEW) && !s.intersects(any_index_change());
        let is_staged = index_status != ' ' && index_status != '?';

        out.push(GitFileStatus {
            path: normalize_path(raw_path),
            index_status,
            worktree_status,
            is_conflicted,
            is_staged,
            is_untracked,
        });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

#[command]
pub fn git_status(app: AppHandle) -> Result<Vec<GitFileStatus>, String> {
    let root = workspace_root_required(&app)?;
    git_status_inner(&root)
}

// ---------------------------------------------------------------------------
// git_diff_file (git2)
// ---------------------------------------------------------------------------

fn git_diff_file_inner(root: &Path, path: &str, vs: &str) -> Result<String, String> {
    let repo = open_repo_at(root)?;
    let git_path = normalize_path(path);

    let mut opts = DiffOptions::new();
    opts.pathspec(&git_path)
        .context_lines(3)
        .include_untracked(true)
        .recurse_untracked_dirs(true);

    let diff = match vs {
        "head" => {
            let head_tree = match repo.head() {
                Ok(h) => Some(h.peel_to_tree().map_err(libgit2_err)?),
                Err(_) => None,
            };
            repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
                .map_err(libgit2_err)?
        }
        "index" => {
            let head_tree = match repo.head() {
                Ok(h) => Some(h.peel_to_tree().map_err(libgit2_err)?),
                Err(_) => None,
            };
            repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
                .map_err(libgit2_err)?
        }
        "worktree" => repo
            .diff_index_to_workdir(None, Some(&mut opts))
            .map_err(libgit2_err)?,
        _ => return Err(format!("invalid diff source: {vs}")),
    };

    let mut buf = String::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if origin == 'F' || origin == 'H' {
            buf.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        } else {
            if matches!(origin, '+' | '-' | ' ') {
                buf.push(origin);
            }
            buf.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
        }
        true
    })
    .map_err(libgit2_err)?;

    Ok(buf.replace("\r\n", "\n"))
}

#[command]
pub fn git_diff_file(app: AppHandle, path: String, vs: String) -> Result<String, String> {
    let root = workspace_root_required(&app)?;
    git_diff_file_inner(&root, &path, &vs)
}

// ---------------------------------------------------------------------------
// CLI mutators
// ---------------------------------------------------------------------------

async fn git_stage_inner(root: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let normalized: Vec<String> = paths.iter().map(|p| normalize_path(p)).collect();
    let mut args: Vec<&str> = vec!["add", "--"];
    for p in &normalized {
        args.push(p);
    }
    run_git_cli(root, &args).await?;
    Ok(())
}

#[command]
pub async fn git_stage(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let root = workspace_root_required(&app)?;
    git_stage_inner(&root, &paths).await
}

async fn git_unstage_inner(root: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let normalized: Vec<String> = paths.iter().map(|p| normalize_path(p)).collect();
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    for p in &normalized {
        args.push(p);
    }
    run_git_cli(root, &args).await?;
    Ok(())
}

#[command]
pub async fn git_unstage(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let root = workspace_root_required(&app)?;
    git_unstage_inner(&root, &paths).await
}

async fn git_discard_inner(root: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let normalized: Vec<String> = paths.iter().map(|p| normalize_path(p)).collect();
    let mut args: Vec<&str> = vec!["checkout", "--"];
    for p in &normalized {
        args.push(p);
    }
    run_git_cli(root, &args).await?;
    Ok(())
}

#[command]
pub async fn git_discard(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    let root = workspace_root_required(&app)?;
    git_discard_inner(&root, &paths).await
}

async fn git_stage_hunk_inner(root: &Path, hunk_patch: &str) -> Result<(), String> {
    run_git_cli_stdin(
        root,
        &["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "-"],
        hunk_patch,
    )
    .await?;
    Ok(())
}

#[command(rename_all = "camelCase")]
pub async fn git_stage_hunk(
    app: AppHandle,
    path: String,
    hunk_patch: String,
) -> Result<(), String> {
    let _ = path;
    let root = workspace_root_required(&app)?;
    git_stage_hunk_inner(&root, &hunk_patch).await
}

async fn git_unstage_hunk_inner(root: &Path, hunk_patch: &str) -> Result<(), String> {
    run_git_cli_stdin(
        root,
        &[
            "apply",
            "--cached",
            "--reverse",
            "--unidiff-zero",
            "--whitespace=nowarn",
            "-",
        ],
        hunk_patch,
    )
    .await?;
    Ok(())
}

#[command(rename_all = "camelCase")]
pub async fn git_unstage_hunk(
    app: AppHandle,
    path: String,
    hunk_patch: String,
) -> Result<(), String> {
    let _ = path;
    let root = workspace_root_required(&app)?;
    git_unstage_hunk_inner(&root, &hunk_patch).await
}

async fn git_commit_inner(root: &Path, message: &str, amend: bool) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    run_git_cli(root, &args).await?;
    let oid = run_git_cli(root, &["rev-parse", "HEAD"]).await?;
    Ok(oid.trim().to_string())
}

#[command]
pub async fn git_commit(app: AppHandle, message: String, amend: bool) -> Result<String, String> {
    let root = workspace_root_required(&app)?;
    git_commit_inner(&root, &message, amend).await
}

async fn git_checkout_inner(root: &Path, branch: &str, create: bool) -> Result<(), String> {
    if create {
        run_git_cli(root, &["checkout", "-b", branch]).await?;
    } else {
        run_git_cli(root, &["checkout", branch]).await?;
    }
    Ok(())
}

#[command(rename_all = "camelCase")]
pub async fn git_checkout(app: AppHandle, branch: String, create: bool) -> Result<(), String> {
    let root = workspace_root_required(&app)?;
    git_checkout_inner(&root, &branch, create).await
}

// Network commands (push/pull/fetch) are not unit-tested — they require a
// reachable remote and live network. Manual smoke verification only.
#[command]
pub async fn git_push(app: AppHandle, remote: String, branch: String) -> Result<String, String> {
    let root = workspace_root_required(&app)?;
    run_git_cli(&root, &["push", &remote, &branch]).await
}

#[command]
pub async fn git_pull(app: AppHandle, remote: String, branch: String) -> Result<String, String> {
    let root = workspace_root_required(&app)?;
    run_git_cli(&root, &["pull", &remote, &branch]).await
}

#[command]
pub async fn git_fetch(app: AppHandle, remote: Option<String>) -> Result<String, String> {
    let root = workspace_root_required(&app)?;
    if let Some(r) = remote {
        run_git_cli(&root, &["fetch", &r]).await
    } else {
        run_git_cli(&root, &["fetch", "--all"]).await
    }
}

async fn git_stash_save_inner(root: &Path, message: Option<&str>) -> Result<(), String> {
    match message {
        Some(m) => {
            run_git_cli(root, &["stash", "push", "-m", m]).await?;
        }
        None => {
            run_git_cli(root, &["stash", "push"]).await?;
        }
    }
    Ok(())
}

#[command]
pub async fn git_stash_save(app: AppHandle, message: Option<String>) -> Result<(), String> {
    let root = workspace_root_required(&app)?;
    git_stash_save_inner(&root, message.as_deref()).await
}

async fn git_stash_apply_inner(root: &Path, index: u32, pop: bool) -> Result<(), String> {
    let stash_ref = format!("stash@{{{index}}}");
    let sub = if pop { "pop" } else { "apply" };
    run_git_cli(root, &["stash", sub, &stash_ref]).await?;
    Ok(())
}

#[command]
pub async fn git_stash_apply(app: AppHandle, index: u32, pop: bool) -> Result<(), String> {
    let root = workspace_root_required(&app)?;
    git_stash_apply_inner(&root, index, pop).await
}

async fn git_remote_add_inner(root: &Path, name: &str, url: &str) -> Result<(), String> {
    run_git_cli(root, &["remote", "add", name, url]).await?;
    Ok(())
}

#[command]
pub async fn git_remote_add(app: AppHandle, name: String, url: String) -> Result<(), String> {
    let root = workspace_root_required(&app)?;
    git_remote_add_inner(&root, &name, &url).await
}

async fn git_remote_remove_inner(root: &Path, name: &str) -> Result<(), String> {
    run_git_cli(root, &["remote", "remove", name]).await?;
    Ok(())
}

#[command]
pub async fn git_remote_remove(app: AppHandle, name: String) -> Result<(), String> {
    let root = workspace_root_required(&app)?;
    git_remote_remove_inner(&root, &name).await
}

// ---------------------------------------------------------------------------
// git_log (git2)
// ---------------------------------------------------------------------------

fn git_log_inner(
    root: &Path,
    max_count: u32,
    branch: Option<&str>,
) -> Result<Vec<GitLogEntry>, String> {
    let repo = open_repo_at(root)?;

    let mut revwalk = repo.revwalk().map_err(libgit2_err)?;
    revwalk
        .set_sorting(Sort::TIME)
        .map_err(libgit2_err)?;

    match branch {
        Some(b) => {
            // Try local first, then remote.
            let local = repo.find_branch(b, BranchType::Local).ok();
            let target_oid = if let Some(br) = local {
                br.get().target().ok_or_else(|| "branch has no target".to_string())?
            } else if let Ok(br) = repo.find_branch(b, BranchType::Remote) {
                br.get().target().ok_or_else(|| "branch has no target".to_string())?
            } else if let Ok(r) = repo.revparse_single(b) {
                r.id()
            } else {
                return Err(format!("branch not found: {b}"));
            };
            revwalk.push(target_oid).map_err(libgit2_err)?;
        }
        None => {
            if repo.head().is_err() {
                return Ok(Vec::new());
            }
            revwalk.push_head().map_err(libgit2_err)?;
        }
    }

    let mut out: Vec<GitLogEntry> = Vec::new();
    let cap = if max_count == 0 { u32::MAX } else { max_count };
    for (count, oid_result) in revwalk.enumerate() {
        if count as u32 >= cap {
            break;
        }
        let oid = oid_result.map_err(libgit2_err)?;
        let commit = repo.find_commit(oid).map_err(libgit2_err)?;
        let summary = commit.summary().unwrap_or("").to_string();
        let message = commit.message().unwrap_or("").to_string();
        let author = commit.author();
        let oid_str = oid.to_string();
        let short = oid_str.chars().take(7).collect::<String>();
        let parents: Vec<String> =
            commit.parent_ids().map(|p| p.to_string()).collect();

        out.push(GitLogEntry {
            oid: oid_str,
            short_oid: short,
            summary,
            message: message.replace("\r\n", "\n"),
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            timestamp: author.when().seconds(),
            parents,
        });
    }

    Ok(out)
}

#[command(rename_all = "camelCase")]
pub fn git_log(
    app: AppHandle,
    max_count: u32,
    branch: Option<String>,
) -> Result<Vec<GitLogEntry>, String> {
    let root = workspace_root_required(&app)?;
    git_log_inner(&root, max_count, branch.as_deref())
}

// ---------------------------------------------------------------------------
// git_branches (git2)
// ---------------------------------------------------------------------------

fn git_branches_inner(root: &Path) -> Result<GitBranchList, String> {
    let repo = open_repo_at(root)?;

    let mut local: Vec<GitBranch> = Vec::new();
    let mut remote: Vec<GitBranch> = Vec::new();
    let mut current: Option<String> = None;

    if let Ok(head) = repo.head() {
        if head.is_branch() {
            if let Some(name) = head.shorthand() {
                current = Some(name.to_string());
            }
        }
    }

    let branches = repo.branches(None).map_err(libgit2_err)?;
    for b in branches {
        let (br, ty) = b.map_err(libgit2_err)?;
        let name = match br.name() {
            Ok(Some(n)) => n.to_string(),
            _ => continue,
        };
        let oid = match br.get().target() {
            Some(o) => o.to_string(),
            None => continue,
        };

        let (upstream, ahead, behind) = match ty {
            BranchType::Local => {
                let upstream_name = br
                    .upstream()
                    .ok()
                    .and_then(|u| u.name().ok().flatten().map(|s| s.to_string()));
                let (ahead, behind) = if let Some(up) = br
                    .upstream()
                    .ok()
                    .and_then(|u| u.get().target())
                {
                    let local_oid =
                        br.get().target().ok_or_else(|| "no target".to_string())?;
                    repo.graph_ahead_behind(local_oid, up)
                        .map(|(a, b)| (a as u32, b as u32))
                        .unwrap_or((0, 0))
                } else {
                    (0, 0)
                };
                (upstream_name, ahead, behind)
            }
            BranchType::Remote => (None, 0u32, 0u32),
        };

        let entry = GitBranch {
            name,
            upstream,
            ahead,
            behind,
            last_commit_oid: oid,
        };

        match ty {
            BranchType::Local => local.push(entry),
            BranchType::Remote => remote.push(entry),
        }
    }

    local.sort_by(|a, b| a.name.cmp(&b.name));
    remote.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(GitBranchList {
        current,
        local,
        remote,
    })
}

#[command]
pub fn git_branches(app: AppHandle) -> Result<GitBranchList, String> {
    let root = workspace_root_required(&app)?;
    git_branches_inner(&root)
}

// ---------------------------------------------------------------------------
// git_blame (git2)
// ---------------------------------------------------------------------------

fn git_blame_inner(root: &Path, path: &str) -> Result<Vec<GitBlameLine>, String> {
    let repo = open_repo_at(root)?;
    let git_path = normalize_path(path);
    let rel_path = Path::new(&git_path);

    let mut opts = BlameOptions::new();
    opts.track_copies_same_file(false);

    let blame = repo
        .blame_file(rel_path, Some(&mut opts))
        .map_err(libgit2_err)?;

    // Load the worktree file contents to count lines and detect uncommitted.
    let wd = workdir(&repo)?;
    let full = wd.join(rel_path);
    let contents = std::fs::read_to_string(&full)
        .map_err(|e| format!("read file: {e}"))?;
    let total_lines: u32 = contents.lines().count().max(1) as u32;

    // Apply blame to the buffer to capture uncommitted lines correctly.
    let buffer_blame = blame
        .blame_buffer(contents.as_bytes())
        .map_err(libgit2_err)?;

    let mut out: Vec<GitBlameLine> = Vec::with_capacity(total_lines as usize);
    let zero_oid = git2::Oid::zero();

    for line_idx in 0..total_lines {
        let line_no = line_idx + 1;
        let hunk = match buffer_blame.get_line(line_no as usize) {
            Some(h) => h,
            None => continue,
        };
        let oid = hunk.final_commit_id();
        let is_uncommitted = oid == zero_oid;

        if is_uncommitted {
            out.push(GitBlameLine {
                line_number: line_no,
                oid: "0000000000000000000000000000000000000000".to_string(),
                short_oid: "0000000".to_string(),
                author_name: String::new(),
                author_email: String::new(),
                timestamp: 0,
                summary: String::new(),
                is_uncommitted: true,
            });
            continue;
        }

        let oid_str = oid.to_string();
        let short = oid_str.chars().take(7).collect::<String>();

        let (author_name, author_email, timestamp, summary) =
            match repo.find_commit(oid) {
                Ok(c) => {
                    let a = c.author();
                    (
                        a.name().unwrap_or("").to_string(),
                        a.email().unwrap_or("").to_string(),
                        a.when().seconds(),
                        c.summary().unwrap_or("").to_string(),
                    )
                }
                Err(_) => (String::new(), String::new(), 0, String::new()),
            };

        out.push(GitBlameLine {
            line_number: line_no,
            oid: oid_str,
            short_oid: short,
            author_name,
            author_email,
            timestamp,
            summary,
            is_uncommitted: false,
        });
    }

    Ok(out)
}

#[command]
pub fn git_blame(app: AppHandle, path: String) -> Result<Vec<GitBlameLine>, String> {
    let root = workspace_root_required(&app)?;
    git_blame_inner(&root, &path)
}

// ---------------------------------------------------------------------------
// git_stash_list (git2)
// ---------------------------------------------------------------------------

fn git_stash_list_inner(root: &Path) -> Result<Vec<GitStash>, String> {
    let mut repo = open_repo_at(root)?;

    // First pass: collect (index, message, oid) tuples without touching repo.
    let mut raw: Vec<(usize, String, git2::Oid)> = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        raw.push((index, message.to_string(), *oid));
        true
    })
    .map_err(libgit2_err)?;

    // Second pass: look up timestamps now that the mutable borrow is gone.
    let mut out: Vec<GitStash> = Vec::with_capacity(raw.len());
    for (index, message, oid) in raw {
        let timestamp = repo
            .find_commit(oid)
            .map(|c| c.time().seconds())
            .unwrap_or(0);
        out.push(GitStash {
            index: index as u32,
            oid: oid.to_string(),
            message,
            timestamp,
        });
    }

    Ok(out)
}

#[command]
pub fn git_stash_list(app: AppHandle) -> Result<Vec<GitStash>, String> {
    let root = workspace_root_required(&app)?;
    git_stash_list_inner(&root)
}

// ---------------------------------------------------------------------------
// git_remotes (git2)
// ---------------------------------------------------------------------------

fn git_remotes_inner(root: &Path) -> Result<Vec<GitRemote>, String> {
    let repo = open_repo_at(root)?;
    let names = repo.remotes().map_err(libgit2_err)?;
    let mut out: Vec<GitRemote> = Vec::new();
    for name in names.iter().flatten() {
        let remote = match repo.find_remote(name) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let url = remote.url().unwrap_or("").to_string();
        let push_url = remote.pushurl().map(|s| s.to_string());
        let push_url = match push_url {
            Some(p) if p != url => Some(p),
            _ => None,
        };
        out.push(GitRemote {
            name: name.to_string(),
            url,
            push_url,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[command]
pub fn git_remotes(app: AppHandle) -> Result<Vec<GitRemote>, String> {
    let root = workspace_root_required(&app)?;
    git_remotes_inner(&root)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command as StdCommand;

    fn run_git(dir: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {:?} failed in {:?}", args, dir);
    }

    fn make_temp_repo(suffix: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("shugu_git_test_{suffix}_{}", std::process::id()));
        if base.exists() {
            let _ = fs::remove_dir_all(&base);
        }
        fs::create_dir_all(&base).expect("create temp dir");
        let canonical = fs::canonicalize(&base).expect("canonicalize");
        run_git(&canonical, &["init", "-q", "-b", "main"]);
        run_git(&canonical, &["config", "user.email", "test@example.com"]);
        run_git(&canonical, &["config", "user.name", "Test"]);
        run_git(&canonical, &["config", "commit.gpgsign", "false"]);
        canonical
    }

    fn commit_file(root: &Path, rel: &str, contents: &str) {
        let target = root.join(rel);
        if let Some(p) = target.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(&target, contents).unwrap();
        run_git(root, &["add", rel]);
        run_git(root, &["commit", "-q", "-m", &format!("add {rel}")]);
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn strip_prefix_noop_on_non_extended() {
        let p = PathBuf::from(if cfg!(windows) { r"C:\foo\bar" } else { "/foo/bar" });
        let stripped = strip_extended_prefix(p.clone());
        assert_eq!(stripped, p);
    }

    #[cfg(windows)]
    #[test]
    fn strip_prefix_handles_drive() {
        let p = PathBuf::from(r"\\?\C:\foo\bar");
        let stripped = strip_extended_prefix(p);
        assert_eq!(stripped, PathBuf::from(r"C:\foo\bar"));
    }

    #[cfg(windows)]
    #[test]
    fn strip_prefix_handles_unc() {
        let p = PathBuf::from(r"\\?\UNC\server\share\foo");
        let stripped = strip_extended_prefix(p);
        assert_eq!(stripped, PathBuf::from(r"\\server\share\foo"));
    }

    #[test]
    fn status_clean_repo_empty() {
        let root = make_temp_repo("status_clean");
        commit_file(&root, "a.txt", "alpha\n");
        let result = git_status_inner(&root).unwrap();
        assert!(result.is_empty(), "expected clean tree, got {:?}", result.iter().map(|s| &s.path).collect::<Vec<_>>());
        cleanup(&root);
    }

    #[test]
    fn status_detects_modified() {
        let root = make_temp_repo("status_modified");
        commit_file(&root, "file.txt", "hello\n");
        fs::write(root.join("file.txt"), "hello world\n").unwrap();
        let result = git_status_inner(&root).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "file.txt");
        assert_eq!(result[0].worktree_status, 'M');
        cleanup(&root);
    }

    #[test]
    fn status_detects_untracked() {
        let root = make_temp_repo("status_untracked");
        commit_file(&root, "a.txt", "a\n");
        fs::write(root.join("new.txt"), "n\n").unwrap();
        let result = git_status_inner(&root).unwrap();
        assert!(result.iter().any(|s| s.path == "new.txt" && s.is_untracked));
        cleanup(&root);
    }

    #[test]
    fn diff_file_modified_against_head() {
        let root = make_temp_repo("diff_head");
        commit_file(&root, "code.txt", "alpha\nbeta\n");
        fs::write(root.join("code.txt"), "alpha\nbeta-changed\n").unwrap();
        let diff = git_diff_file_inner(&root, "code.txt", "head").unwrap();
        assert!(diff.contains("beta-changed"), "diff was: {diff}");
        assert!(diff.contains("-beta"));
        cleanup(&root);
    }

    #[test]
    fn diff_file_invalid_source_errors() {
        let root = make_temp_repo("diff_invalid");
        commit_file(&root, "code.txt", "alpha\n");
        let err = git_diff_file_inner(&root, "code.txt", "bogus").unwrap_err();
        assert!(err.contains("invalid"));
        cleanup(&root);
    }

    #[test]
    fn log_returns_commits() {
        let root = make_temp_repo("log_basic");
        commit_file(&root, "a.txt", "1\n");
        commit_file(&root, "b.txt", "2\n");
        let entries = git_log_inner(&root, 10, None).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].summary.starts_with("add b"));
        assert!(entries[1].summary.starts_with("add a"));
        assert_eq!(entries[0].oid.len(), 40);
        assert_eq!(entries[0].short_oid.len(), 7);
        cleanup(&root);
    }

    #[test]
    fn log_respects_max_count() {
        let root = make_temp_repo("log_cap");
        for i in 0..5 {
            commit_file(&root, &format!("f{i}.txt"), &format!("{i}\n"));
        }
        let entries = git_log_inner(&root, 3, None).unwrap();
        assert_eq!(entries.len(), 3);
        cleanup(&root);
    }

    #[test]
    fn log_no_head_returns_empty() {
        let root = make_temp_repo("log_nohead");
        let entries = git_log_inner(&root, 10, None).unwrap();
        assert!(entries.is_empty());
        cleanup(&root);
    }

    #[test]
    fn branches_lists_current() {
        let root = make_temp_repo("branches_current");
        commit_file(&root, "a.txt", "1\n");
        let list = git_branches_inner(&root).unwrap();
        assert_eq!(list.current.as_deref(), Some("main"));
        assert!(list.local.iter().any(|b| b.name == "main"));
        cleanup(&root);
    }

    #[test]
    fn branches_local_and_remote() {
        let root = make_temp_repo("branches_dev");
        commit_file(&root, "a.txt", "1\n");
        run_git(&root, &["checkout", "-q", "-b", "dev"]);
        let list = git_branches_inner(&root).unwrap();
        assert_eq!(list.current.as_deref(), Some("dev"));
        assert!(list.local.iter().any(|b| b.name == "dev"));
        cleanup(&root);
    }

    #[test]
    fn blame_returns_lines() {
        let root = make_temp_repo("blame_basic");
        commit_file(&root, "code.txt", "alpha\nbeta\ngamma\n");
        let lines = git_blame_inner(&root, "code.txt").unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].line_number, 1);
        assert_eq!(lines[1].line_number, 2);
        assert_eq!(lines[2].line_number, 3);
        assert!(lines.iter().all(|l| !l.is_uncommitted));
        cleanup(&root);
    }

    #[test]
    fn blame_detects_uncommitted_line() {
        let root = make_temp_repo("blame_uncommitted");
        commit_file(&root, "code.txt", "alpha\nbeta\n");
        fs::write(root.join("code.txt"), "alpha\nbeta\nfresh\n").unwrap();
        let lines = git_blame_inner(&root, "code.txt").unwrap();
        assert_eq!(lines.len(), 3);
        assert!(lines[2].is_uncommitted, "third line should be uncommitted");
        cleanup(&root);
    }

    #[test]
    fn stash_list_empty() {
        let root = make_temp_repo("stash_empty");
        commit_file(&root, "a.txt", "x\n");
        let stashes = git_stash_list_inner(&root).unwrap();
        assert!(stashes.is_empty());
        cleanup(&root);
    }

    #[test]
    fn stash_list_after_stash() {
        let root = make_temp_repo("stash_one");
        commit_file(&root, "a.txt", "x\n");
        fs::write(root.join("a.txt"), "modified\n").unwrap();
        run_git(&root, &["stash", "push", "-m", "wip"]);
        let stashes = git_stash_list_inner(&root).unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].message.contains("wip"));
        cleanup(&root);
    }

    #[test]
    fn remotes_lists_added_remote() {
        let root = make_temp_repo("remotes_basic");
        commit_file(&root, "a.txt", "1\n");
        run_git(&root, &["remote", "add", "origin", "https://example.invalid/r.git"]);
        let remotes = git_remotes_inner(&root).unwrap();
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].url, "https://example.invalid/r.git");
        assert!(remotes[0].push_url.is_none());
        cleanup(&root);
    }

    #[test]
    fn remotes_empty_when_none() {
        let root = make_temp_repo("remotes_empty");
        commit_file(&root, "a.txt", "1\n");
        let remotes = git_remotes_inner(&root).unwrap();
        assert!(remotes.is_empty());
        cleanup(&root);
    }

    #[test]
    fn open_repo_not_a_repo_errors() {
        let base = std::env::temp_dir().join(format!("shugu_git_no_repo_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let canonical = fs::canonicalize(&base).unwrap();
        let result = open_repo_at(&canonical);
        match result {
            Err(e) => assert_eq!(e, "not a git repository"),
            Ok(_) => panic!("expected Err"),
        }
        let _ = fs::remove_dir_all(&canonical);
    }

    #[test]
    fn status_char_translation_basic() {
        let s = git2::Status::INDEX_NEW;
        assert_eq!(status_char_index(s), 'A');
        let s = git2::Status::INDEX_MODIFIED;
        assert_eq!(status_char_index(s), 'M');
        let s = git2::Status::WT_MODIFIED;
        assert_eq!(status_char_worktree(s), 'M');
        let s = git2::Status::WT_NEW;
        assert_eq!(status_char_worktree(s), '?');
    }

    #[tokio::test]
    async fn stage_file_modifies_index() {
        let root = make_temp_repo("stage_basic");
        commit_file(&root, "a.txt", "alpha\n");
        fs::write(root.join("a.txt"), "alpha2\n").unwrap();

        let out = TokioCommand::new("git")
            .args(["add", "--", "a.txt"])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(out.status.success());

        let status = git_status_inner(&root).unwrap();
        assert!(status.iter().any(|s| s.path == "a.txt" && s.is_staged));
        cleanup(&root);
    }

    #[tokio::test]
    async fn commit_via_cli_then_log_sees_it() {
        let root = make_temp_repo("commit_log");
        fs::write(root.join("x.txt"), "x\n").unwrap();

        let out = TokioCommand::new("git")
            .args(["add", "--", "x.txt"])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(out.status.success());

        let out = TokioCommand::new("git")
            .args(["commit", "-m", "first"])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(out.status.success(), "commit stderr: {}", String::from_utf8_lossy(&out.stderr));

        let entries = git_log_inner(&root, 10, None).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].summary, "first");
        cleanup(&root);
    }

    #[tokio::test]
    async fn run_git_cli_returns_stdout_normalized() {
        let root = make_temp_repo("cli_basic");
        commit_file(&root, "a.txt", "x\n");
        let out = run_git_cli(&root, &["log", "-1", "--pretty=%s"]).await.unwrap();
        assert!(out.contains("add a.txt"));
        assert!(!out.contains("\r\n"));
        cleanup(&root);
    }

    #[tokio::test]
    async fn run_git_cli_propagates_error() {
        let root = make_temp_repo("cli_err");
        let err = run_git_cli(&root, &["nonexistent-subcommand"]).await.unwrap_err();
        assert!(err.starts_with("git error:"));
        cleanup(&root);
    }

    #[tokio::test]
    async fn stage_inner_stages_path() {
        let root = make_temp_repo("inner_stage");
        commit_file(&root, "a.txt", "alpha\n");
        fs::write(root.join("a.txt"), "alpha2\n").unwrap();

        git_stage_inner(&root, &["a.txt".to_string()]).await.unwrap();

        let status = git_status_inner(&root).unwrap();
        assert!(
            status.iter().any(|s| s.path == "a.txt" && s.is_staged),
            "expected a.txt to be staged, got {:?}",
            status.iter().map(|s| (&s.path, s.is_staged)).collect::<Vec<_>>()
        );
        cleanup(&root);
    }

    #[tokio::test]
    async fn stage_inner_empty_paths_noop() {
        let root = make_temp_repo("inner_stage_empty");
        commit_file(&root, "a.txt", "x\n");
        // Empty list must succeed and not error.
        git_stage_inner(&root, &[]).await.unwrap();
        cleanup(&root);
    }

    #[tokio::test]
    async fn unstage_inner_removes_from_index() {
        let root = make_temp_repo("inner_unstage");
        commit_file(&root, "a.txt", "alpha\n");
        fs::write(root.join("a.txt"), "alpha2\n").unwrap();
        git_stage_inner(&root, &["a.txt".to_string()]).await.unwrap();

        git_unstage_inner(&root, &["a.txt".to_string()]).await.unwrap();

        let status = git_status_inner(&root).unwrap();
        // After unstage, the modification is still in the worktree but not in the index.
        let entry = status.iter().find(|s| s.path == "a.txt").expect("a.txt");
        assert_eq!(entry.worktree_status, 'M');
        assert!(!entry.is_staged);
        cleanup(&root);
    }

    #[tokio::test]
    async fn unstage_inner_empty_noop() {
        let root = make_temp_repo("inner_unstage_empty");
        commit_file(&root, "a.txt", "x\n");
        git_unstage_inner(&root, &[]).await.unwrap();
        cleanup(&root);
    }

    #[tokio::test]
    async fn discard_inner_restores_file() {
        let root = make_temp_repo("inner_discard");
        commit_file(&root, "a.txt", "original\n");
        fs::write(root.join("a.txt"), "modified\n").unwrap();

        git_discard_inner(&root, &["a.txt".to_string()]).await.unwrap();

        let contents = fs::read_to_string(root.join("a.txt")).unwrap();
        assert_eq!(contents.trim_end_matches(['\r', '\n']), "original");
        cleanup(&root);
    }

    #[tokio::test]
    async fn stage_hunk_inner_stages_partial_diff() {
        let root = make_temp_repo("hunk_stage_inner");
        commit_file(&root, "code.txt", "a\nb\nc\n");
        let patch = "\
diff --git a/code.txt b/code.txt
--- a/code.txt
+++ b/code.txt
@@ -1,3 +1,4 @@
 a
 b
+inserted
 c
";
        git_stage_hunk_inner(&root, patch).await.unwrap();

        let status = git_status_inner(&root).unwrap();
        assert!(status.iter().any(|s| s.path == "code.txt" && s.is_staged));
        cleanup(&root);
    }

    #[tokio::test]
    async fn unstage_hunk_inner_reverses_staged_diff() {
        let root = make_temp_repo("hunk_unstage_inner");
        commit_file(&root, "code.txt", "a\nb\nc\n");
        let patch = "\
diff --git a/code.txt b/code.txt
--- a/code.txt
+++ b/code.txt
@@ -1,3 +1,4 @@
 a
 b
+inserted
 c
";
        // Stage the hunk first.
        git_stage_hunk_inner(&root, patch).await.unwrap();
        let status = git_status_inner(&root).unwrap();
        assert!(status.iter().any(|s| s.path == "code.txt" && s.is_staged));

        // Now unstage the same hunk — should be clean again from index POV.
        git_unstage_hunk_inner(&root, patch).await.unwrap();
        let status = git_status_inner(&root).unwrap();
        // The index should match HEAD again (no staged change).
        assert!(!status.iter().any(|s| s.path == "code.txt" && s.is_staged));
        cleanup(&root);
    }

    #[tokio::test]
    async fn commit_inner_creates_commit_returns_oid() {
        let root = make_temp_repo("commit_inner");
        fs::write(root.join("x.txt"), "x\n").unwrap();
        git_stage_inner(&root, &["x.txt".to_string()]).await.unwrap();

        let oid = git_commit_inner(&root, "first commit", false).await.unwrap();

        assert_eq!(oid.len(), 40, "expected 40-char OID, got: {oid}");
        let log = git_log_inner(&root, 10, None).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].summary, "first commit");
        assert_eq!(log[0].oid, oid);
        cleanup(&root);
    }

    #[tokio::test]
    async fn commit_inner_amend_replaces_head() {
        let root = make_temp_repo("commit_amend");
        commit_file(&root, "a.txt", "1\n");
        let first_oid = git_log_inner(&root, 1, None).unwrap()[0].oid.clone();

        fs::write(root.join("b.txt"), "2\n").unwrap();
        git_stage_inner(&root, &["b.txt".to_string()]).await.unwrap();
        let amended_oid = git_commit_inner(&root, "amended", true).await.unwrap();

        assert_ne!(amended_oid, first_oid);
        let log = git_log_inner(&root, 10, None).unwrap();
        assert_eq!(log.len(), 1, "amend must not add a new commit");
        cleanup(&root);
    }

    #[tokio::test]
    async fn checkout_inner_switches_branch() {
        let root = make_temp_repo("checkout_inner");
        commit_file(&root, "a.txt", "x\n");

        git_checkout_inner(&root, "feature", true).await.unwrap();
        let branches = git_branches_inner(&root).unwrap();
        assert_eq!(branches.current.as_deref(), Some("feature"));

        git_checkout_inner(&root, "main", false).await.unwrap();
        let branches = git_branches_inner(&root).unwrap();
        assert_eq!(branches.current.as_deref(), Some("main"));
        cleanup(&root);
    }

    #[tokio::test]
    async fn stash_save_inner_creates_entry() {
        let root = make_temp_repo("stash_save_inner");
        commit_file(&root, "a.txt", "alpha\n");
        fs::write(root.join("a.txt"), "modified\n").unwrap();

        git_stash_save_inner(&root, Some("wip msg")).await.unwrap();

        let stashes = git_stash_list_inner(&root).unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].message.contains("wip msg"));
        // After stash, worktree should be clean again.
        let status = git_status_inner(&root).unwrap();
        assert!(status.is_empty());
        cleanup(&root);
    }

    #[tokio::test]
    async fn stash_save_inner_default_message() {
        let root = make_temp_repo("stash_save_default");
        commit_file(&root, "a.txt", "alpha\n");
        fs::write(root.join("a.txt"), "modified\n").unwrap();

        git_stash_save_inner(&root, None).await.unwrap();

        let stashes = git_stash_list_inner(&root).unwrap();
        assert_eq!(stashes.len(), 1);
        cleanup(&root);
    }

    #[tokio::test]
    async fn stash_apply_inner_restores_changes() {
        let root = make_temp_repo("stash_apply_inner");
        commit_file(&root, "a.txt", "alpha\n");
        fs::write(root.join("a.txt"), "modified\n").unwrap();
        git_stash_save_inner(&root, Some("test")).await.unwrap();

        git_stash_apply_inner(&root, 0, false).await.unwrap();

        let contents = fs::read_to_string(root.join("a.txt")).unwrap();
        assert!(contents.contains("modified"));
        // apply (not pop) keeps the stash entry.
        let stashes = git_stash_list_inner(&root).unwrap();
        assert_eq!(stashes.len(), 1);
        cleanup(&root);
    }

    #[tokio::test]
    async fn stash_apply_inner_pop_removes_entry() {
        let root = make_temp_repo("stash_pop_inner");
        commit_file(&root, "a.txt", "alpha\n");
        fs::write(root.join("a.txt"), "modified\n").unwrap();
        git_stash_save_inner(&root, Some("test")).await.unwrap();

        git_stash_apply_inner(&root, 0, true).await.unwrap();

        let stashes = git_stash_list_inner(&root).unwrap();
        assert!(stashes.is_empty(), "pop must remove the stash entry");
        cleanup(&root);
    }

    #[tokio::test]
    async fn remote_add_inner_creates_remote() {
        let root = make_temp_repo("remote_add_inner");
        commit_file(&root, "a.txt", "x\n");

        git_remote_add_inner(&root, "origin", "https://example.invalid/r.git")
            .await
            .unwrap();

        let remotes = git_remotes_inner(&root).unwrap();
        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].url, "https://example.invalid/r.git");
        cleanup(&root);
    }

    #[tokio::test]
    async fn remote_remove_inner_deletes_remote() {
        let root = make_temp_repo("remote_remove_inner");
        commit_file(&root, "a.txt", "x\n");
        git_remote_add_inner(&root, "origin", "https://example.invalid/r.git")
            .await
            .unwrap();

        git_remote_remove_inner(&root, "origin").await.unwrap();

        let remotes = git_remotes_inner(&root).unwrap();
        assert!(remotes.is_empty());
        cleanup(&root);
    }
}
