//! Shugu agent worktree lifecycle — autonomous module.
//!
//! Manages the per-run / per-agent isolated git worktrees that Shugu spins up
//! so an agent can mutate files without disturbing the user's main working
//! tree. Worktrees live under `<workspace>/.shugu/worktrees/<id>` and are
//! tracked in a JSON model file `<workspace>/.shugu/git-worktrees.json`.
//!
//! This module is intentionally self-contained: it shells out to the `git`
//! CLI via `tokio::process::Command` and does NOT depend on `git.rs` or
//! `runner.rs`. Everything it needs (workspace resolution, path normalization,
//! CLI invocation, error formatting) is reimplemented locally so the two
//! modules can evolve independently.
//!
//! ## Commands
//!
//! - `shugu_worktree_create` — create a new isolated worktree on a fresh
//!   branch derived from `HEAD` (or a caller-supplied base ref).
//! - `shugu_worktree_list` — list tracked worktrees with on-disk + git
//!   reconciliation, flagging orphans.
//! - `shugu_worktree_cleanup` — remove a tracked worktree (git + disk + model)
//!   and optionally delete its branch; with `prune_orphans` it also sweeps
//!   orphaned entries.
//! - `shugu_worktree_size` — recursive byte size of a worktree's working dir.
//!
//! ## Orphan detection
//!
//! An entry is an **orphan** when it is recorded in the model but either its
//! directory no longer exists on disk, or `git worktree list` no longer knows
//! about it (the two go out of sync when a worktree is removed behind Shugu's
//! back, e.g. `git worktree prune` or a manual `rm -rf`).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Manager};
use tokio::process::Command as TokioCommand;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/// One tracked agent worktree. Persisted in `git-worktrees.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    /// Stable identifier (uuid v4) — also the directory name under
    /// `.shugu/worktrees/`.
    pub id: String,
    /// Absolute working-directory path, forward-slashed, no `\\?\` prefix.
    pub path: String,
    /// Branch checked out in this worktree (always created fresh by us).
    pub branch: String,
    /// Base ref this worktree was forked from (branch name or OID).
    pub base: String,
    /// Free-form label set by the caller (e.g. the agent / turn name).
    pub label: Option<String>,
    /// Creation time, unix seconds (UTC).
    pub created_at: i64,
}

/// A worktree entry decorated with live reconciliation state. Returned by
/// `shugu_worktree_list` — never persisted (the extra flags are computed).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    #[serde(flatten)]
    pub entry: WorktreeEntry,
    /// Working directory currently exists on disk.
    pub exists_on_disk: bool,
    /// `git worktree list` still knows about this path.
    pub registered_in_git: bool,
    /// True when the entry is recorded in the model but is no longer backed by
    /// both a real directory and a git registration.
    pub is_orphan: bool,
}

/// On-disk shape of `git-worktrees.json`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct WorktreeModel {
    /// Schema version — bumped if the layout ever changes.
    version: u32,
    entries: Vec<WorktreeEntry>,
}

const MODEL_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Workspace / path helpers (local — no dependency on git.rs)
// ---------------------------------------------------------------------------

fn workspace_root_required(app: &AppHandle) -> Result<PathBuf, String> {
    let ws_state = app.state::<std::sync::Mutex<Option<PathBuf>>>();
    let guard = ws_state
        .lock()
        .map_err(|e| format!("workspace lock: {e}"))?;
    guard.clone().ok_or_else(|| "no workspace open".to_string())
}

/// Strip Windows extended-length prefix (`\\?\`) so paths cross IPC clean.
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

fn normalize_path_str(s: &str) -> String {
    s.replace('\\', "/")
}

fn normalize_path(p: &Path) -> String {
    normalize_path_str(&strip_extended_prefix(p.to_path_buf()).to_string_lossy())
}

/// Directory where Shugu keeps its state: `<workspace>/.shugu`.
fn shugu_dir(root: &Path) -> PathBuf {
    root.join(".shugu")
}

/// Directory holding all agent worktrees: `<workspace>/.shugu/worktrees`.
fn worktrees_dir(root: &Path) -> PathBuf {
    shugu_dir(root).join("worktrees")
}

/// Path of the JSON model file.
fn model_path(root: &Path) -> PathBuf {
    shugu_dir(root).join("git-worktrees.json")
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// git CLI
// ---------------------------------------------------------------------------

/// Run `git <args>` in `cwd`, returning stdout (CRLF-normalized) on success.
pub(crate) async fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = TokioCommand::new("git")
        .args(args)
        .current_dir(cwd)
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

    let raw = String::from_utf8(output.stdout).map_err(|e| format!("git stdout utf8: {e}"))?;
    Ok(raw.replace("\r\n", "\n"))
}

/// Set of absolute worktree paths currently registered with git (normalized,
/// forward-slashed). Used to detect orphans.
async fn git_registered_worktree_paths(root: &Path) -> Result<Vec<String>, String> {
    let out = run_git(root, &["worktree", "list", "--porcelain"]).await?;
    let mut paths = Vec::new();
    for line in out.lines() {
        if let Some(p) = line.trim_end().strip_prefix("worktree ") {
            paths.push(normalize_path_str(p));
        }
    }
    Ok(paths)
}

// ---------------------------------------------------------------------------
// Model persistence
// ---------------------------------------------------------------------------

fn load_model(root: &Path) -> Result<WorktreeModel, String> {
    let path = model_path(root);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let model: WorktreeModel = serde_json::from_slice(&bytes)
                .map_err(|e| format!("git-worktrees.json parse: {e}"))?;
            Ok(model)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(WorktreeModel {
            version: MODEL_VERSION,
            entries: Vec::new(),
        }),
        Err(e) => Err(format!("git-worktrees.json read: {e}")),
    }
}

fn save_model(root: &Path, model: &WorktreeModel) -> Result<(), String> {
    let dir = shugu_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| format!(".shugu mkdir: {e}"))?;
    let json =
        serde_json::to_string_pretty(model).map_err(|e| format!("git-worktrees.json encode: {e}"))?;
    let tmp = model_path(root).with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("git-worktrees.json write: {e}"))?;
    std::fs::rename(&tmp, model_path(root))
        .map_err(|e| format!("git-worktrees.json commit: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Size computation
// ---------------------------------------------------------------------------

/// Recursive byte size of `dir`. Symlinks are not followed; unreadable entries
/// are skipped silently so a transient permission glitch never fails the call.
fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total: u64 = 0;
    for entry in walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

// ---------------------------------------------------------------------------
// Internal create / cleanup (testable, no AppHandle)
// ---------------------------------------------------------------------------

/// A short, filesystem-safe branch name derived from a worktree id.
fn branch_for(id: &str, label: Option<&str>) -> String {
    match label {
        Some(l) if !l.trim().is_empty() => {
            let slug: String = l
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect();
            let slug = slug.trim_matches('-');
            if slug.is_empty() {
                format!("shugu/wt/{id}")
            } else {
                format!("shugu/wt/{slug}-{id}")
            }
        }
        _ => format!("shugu/wt/{id}"),
    }
}

pub(crate) async fn create_inner(
    root: &Path,
    base: Option<&str>,
    label: Option<&str>,
) -> Result<WorktreeEntry, String> {
    // Resolve the base ref to a concrete OID so the branch is reproducible even
    // if HEAD moves later.
    let base_ref = base.unwrap_or("HEAD");
    let base_oid = run_git(root, &["rev-parse", base_ref])
        .await?
        .trim()
        .to_string();
    if base_oid.is_empty() {
        return Err(format!("cannot resolve base ref: {base_ref}"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let branch = branch_for(&id, label);
    let wt_path = worktrees_dir(root).join(&id);

    std::fs::create_dir_all(worktrees_dir(root)).map_err(|e| format!("worktrees mkdir: {e}"))?;

    let wt_path_str = wt_path.to_string_lossy().to_string();
    // `git worktree add -b <branch> <path> <base_oid>` creates the branch at the
    // base commit and checks it out in the new worktree.
    run_git(
        root,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &wt_path_str,
            &base_oid,
        ],
    )
    .await?;

    let entry = WorktreeEntry {
        id,
        path: normalize_path(&wt_path),
        branch,
        base: base_oid,
        label: label.map(|s| s.to_string()),
        created_at: now_unix(),
    };

    let mut model = load_model(root)?;
    model.version = MODEL_VERSION;
    model.entries.push(entry.clone());
    save_model(root, &model)?;

    Ok(entry)
}

async fn list_inner(root: &Path) -> Result<Vec<WorktreeStatus>, String> {
    let model = load_model(root)?;
    let registered = git_registered_worktree_paths(root)
        .await
        .unwrap_or_default();

    let mut out = Vec::with_capacity(model.entries.len());
    for entry in model.entries {
        let exists_on_disk = Path::new(&entry.path).is_dir();
        // Compare against the normalized git-registered paths. We also normalize
        // the entry path defensively in case of casing/slash drift.
        let entry_norm = normalize_path_str(&entry.path);
        let registered_in_git = registered
            .iter()
            .any(|p| paths_equal(p, &entry_norm));
        let is_orphan = !(exists_on_disk && registered_in_git);
        out.push(WorktreeStatus {
            entry,
            exists_on_disk,
            registered_in_git,
            is_orphan,
        });
    }
    Ok(out)
}

/// Case-insensitive path comparison on Windows, exact elsewhere.
fn paths_equal(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Remove a single worktree: git unregister → disk removal → branch delete.
/// Best-effort per step so a partially-broken worktree still gets cleaned.
pub(crate) async fn remove_one(
    root: &Path,
    entry: &WorktreeEntry,
    delete_branch: bool,
) -> Result<(), String> {
    // 1. Ask git to remove the worktree (handles its admin files under
    //    `.git/worktrees/<id>`). `--force` because the working tree may contain
    //    uncommitted agent edits we intend to drop.
    let _ = run_git(root, &["worktree", "remove", "--force", &entry.path]).await;

    // 2. Remove the directory if git left it behind (it can, on partial state).
    if Path::new(&entry.path).exists() {
        let _ = std::fs::remove_dir_all(&entry.path);
    }

    // 3. Prune stale admin entries so git's bookkeeping matches reality.
    let _ = run_git(root, &["worktree", "prune"]).await;

    // 4. Optionally delete the branch we created for this worktree.
    if delete_branch {
        let _ = run_git(root, &["branch", "-D", &entry.branch]).await;
    }

    Ok(())
}

pub(crate) async fn cleanup_inner(
    root: &Path,
    id: Option<&str>,
    delete_branch: bool,
    prune_orphans: bool,
) -> Result<Vec<String>, String> {
    let mut model = load_model(root)?;
    let registered = git_registered_worktree_paths(root)
        .await
        .unwrap_or_default();

    let mut removed_ids: Vec<String> = Vec::new();
    let mut keep: Vec<WorktreeEntry> = Vec::new();

    for entry in std::mem::take(&mut model.entries) {
        let entry_norm = normalize_path_str(&entry.path);
        let exists_on_disk = Path::new(&entry.path).is_dir();
        let registered_in_git = registered.iter().any(|p| paths_equal(p, &entry_norm));
        let is_orphan = !(exists_on_disk && registered_in_git);

        let target_by_id = id.map(|want| want == entry.id).unwrap_or(false);
        let target_by_orphan = prune_orphans && is_orphan;

        if target_by_id || target_by_orphan {
            remove_one(root, &entry, delete_branch).await?;
            removed_ids.push(entry.id);
        } else {
            keep.push(entry);
        }
    }

    if id.is_some() && removed_ids.is_empty() {
        return Err(format!("worktree not found: {}", id.unwrap_or("")));
    }

    model.version = MODEL_VERSION;
    model.entries = keep;
    save_model(root, &model)?;

    Ok(removed_ids)
}

// ---------------------------------------------------------------------------
// Merge-back machinery (Phase 3 — worktree-per-agent isolation)
//
// After an isolated agent finishes, its edits live on a fresh branch inside the
// worktree. To land them in the user's tree we (1) commit them inside the
// worktree, then (2) merge that branch back into whatever branch the main root
// has checked out — but ONLY when the merge is clean and non-destructive. A
// conflict or a dirty overlapping target leaves the user's tree untouched and
// keeps the worktree around for manual review. None of this runs unless a
// caller explicitly opts into isolation (`isolate=true`); the default path
// never touches a worktree.
// ---------------------------------------------------------------------------

/// Serializes the merge-back step of concurrent isolated agents into the user's
/// working tree. Up to `MAX_CONCURRENT_AGENTS` isolated agents can finish at
/// once; each acquires this lock around its `merge_back` call so two agents
/// never run `git merge` into the same root simultaneously (which would corrupt
/// the index / leave a half-applied merge). Managed once in `lib.rs` setup().
pub struct MergeLock(pub tokio::sync::Mutex<()>);

/// Outcome of a `merge_back` attempt. Serialized camelCase so the runner can
/// reflect it into an `AgentEvent::WorktreeFinalized`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub(crate) enum MergeOutcome {
    /// The branch was merged cleanly; `commit` is the merge commit OID.
    Merged { commit: String },
    /// The branch had no commits to merge (worktree produced nothing).
    NoChanges,
    /// The merge hit conflicts; we ran `merge --abort` so the target is clean
    /// again. `files` are the conflicting paths (best-effort).
    Conflict { files: Vec<String> },
    /// The target working tree has uncommitted edits on paths this branch also
    /// touched — merging would risk clobbering the user's in-flight work, so we
    /// declined and left everything untouched.
    DirtyTarget,
}

/// Commit every change in a worktree's working tree onto its branch.
///
/// `git add -A` then a NON-interactive, NON-signed commit authored as a neutral
/// `shugu` identity (so it works even if the repo has no committer configured
/// and never trips the user's gpg-signing hook). Returns `Ok(None)` when there
/// was nothing to commit, or `Ok(Some(oid))` with the new commit's OID.
pub(crate) async fn commit_worktree(
    wt_path: &Path,
    message: &str,
) -> Result<Option<String>, String> {
    run_git(wt_path, &["add", "-A"]).await?;

    // `diff --cached --quiet` exits 0 when the index matches HEAD (nothing to
    // commit) and 1 when there are staged changes. We can't use `run_git` (it
    // treats non-zero as an error), so probe the status code directly.
    let staged_changes = {
        let status = TokioCommand::new("git")
            .args(["diff", "--cached", "--quiet"])
            .current_dir(wt_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "git not found".to_string()
                } else {
                    format!("git spawn: {e}")
                }
            })?;
        // exit 0 → no staged changes; exit 1 → staged changes present.
        !status.success()
    };

    if !staged_changes {
        return Ok(None);
    }

    run_git(
        wt_path,
        &[
            "-c",
            "user.name=shugu",
            "-c",
            "user.email=shugu@localhost",
            "commit",
            "-m",
            message,
            "--no-gpg-sign",
        ],
    )
    .await?;

    let oid = run_git(wt_path, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();
    Ok(Some(oid))
}

/// Paths reported as changed by `git status --porcelain` in `root` (working
/// tree + index). Each porcelain line is `XY <path>` — we take everything after
/// the first 3 chars and normalize. Rename lines (`R  old -> new`) keep both.
async fn dirty_paths(root: &Path) -> Result<Vec<String>, String> {
    let out = run_git(root, &["status", "--porcelain"]).await?;
    let mut paths = Vec::new();
    for line in out.lines() {
        if line.len() < 4 {
            continue;
        }
        let rest = &line[3..];
        if let Some((old, new)) = rest.split_once(" -> ") {
            paths.push(normalize_path_str(old.trim()));
            paths.push(normalize_path_str(new.trim()));
        } else {
            paths.push(normalize_path_str(rest.trim()));
        }
    }
    Ok(paths)
}

/// Paths a branch changed relative to a base ref (`git diff --name-only base..branch`).
async fn branch_changed_paths(root: &Path, base: &str, branch: &str) -> Result<Vec<String>, String> {
    let range = format!("{base}..{branch}");
    let out = run_git(root, &["diff", "--name-only", &range]).await?;
    Ok(out
        .lines()
        .map(|l| normalize_path_str(l.trim()))
        .filter(|l| !l.is_empty())
        .collect())
}

/// Merge an isolated agent's branch back into the main root's current branch.
///
/// Safe by construction:
///   * If the target working tree is dirty on any path the branch also touched,
///     we return `DirtyTarget` WITHOUT merging (never clobber in-flight work).
///   * On a clean merge we return `Merged { commit }`.
///   * On a conflicting merge we run `merge --abort` (so the target is restored)
///     and return `Conflict { files }`.
///
/// `branch` is the worktree's branch name (e.g. `shugu/wt/coder-<id>`).
pub(crate) async fn merge_back(root: &Path, branch: &str) -> Result<MergeOutcome, String> {
    // Resolve the root's currently checked-out branch — that's our merge target.
    let target = run_git(root, &["symbolic-ref", "--short", "HEAD"])
        .await?
        .trim()
        .to_string();
    if target.is_empty() {
        return Err("root HEAD is detached — refusing to merge".to_string());
    }

    // Merge base between the target and the branch — the fork point. Used both
    // to enumerate what the branch changed and to short-circuit empty merges.
    let merge_base = run_git(root, &["merge-base", &target, branch])
        .await?
        .trim()
        .to_string();
    let branch_tip = run_git(root, &["rev-parse", branch])
        .await?
        .trim()
        .to_string();
    if merge_base == branch_tip {
        // The branch is an ancestor of the target — nothing to merge.
        return Ok(MergeOutcome::NoChanges);
    }

    // Dirty-target guard: if the user has uncommitted edits that overlap with
    // the branch's changed paths, decline rather than risk a clobbering merge.
    let dirty = dirty_paths(root).await.unwrap_or_default();
    if !dirty.is_empty() {
        let changed = branch_changed_paths(root, &merge_base, branch)
            .await
            .unwrap_or_default();
        let overlap = dirty.iter().any(|d| changed.iter().any(|c| paths_equal(c, d)));
        if overlap {
            return Ok(MergeOutcome::DirtyTarget);
        }
    }

    // Attempt the merge. We can't use `run_git` here because we need to inspect
    // the failure (conflict) rather than bubble it as an opaque error.
    let merge_status = TokioCommand::new("git")
        .args(["merge", "--no-ff", "--no-edit", branch])
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "git not found".to_string()
            } else {
                format!("git spawn: {e}")
            }
        })?;

    if merge_status.success() {
        let commit = run_git(root, &["rev-parse", "HEAD"])
            .await?
            .trim()
            .to_string();
        return Ok(MergeOutcome::Merged { commit });
    }

    // Conflict: enumerate the unmerged paths, then abort so the target tree is
    // returned to its pre-merge state.
    let conflict_files: Vec<String> = run_git(root, &["diff", "--name-only", "--diff-filter=U"])
        .await
        .unwrap_or_default()
        .lines()
        .map(|l| normalize_path_str(l.trim()))
        .filter(|l| !l.is_empty())
        .collect();
    let _ = run_git(root, &["merge", "--abort"]).await;
    Ok(MergeOutcome::Conflict {
        files: conflict_files,
    })
}

/// Human-readable `git diff --stat <base>..<branch>` summary, run in `root`.
/// Used to show the user what an UNMERGED (conflicting / declined) worktree
/// contains so they can review it manually. Empty string when there is no diff.
pub(crate) async fn diff_summary(root: &Path, branch: &str, base: &str) -> Result<String, String> {
    let range = format!("{base}..{branch}");
    run_git(root, &["diff", "--stat", &range]).await
}

/// Look up a tracked worktree entry by id from the persisted model.
///
/// Reserved for the future fan-out / review UI that needs to resolve a KEPT
/// (unmerged) worktree by id after a `WorktreeFinalized { outcome: "diff" }`
/// event — e.g. to open it, re-diff it, or clean it up on the user's command.
/// Covered by `entry_for_id_round_trips`; not yet called in production (Phase 3
/// ships the merge-back mechanism dormant), hence the explicit allow.
#[allow(dead_code)]
pub(crate) fn entry_for_id(root: &Path, id: &str) -> Option<WorktreeEntry> {
    let model = load_model(root).ok()?;
    model.entries.into_iter().find(|e| e.id == id)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Create a new isolated agent worktree on a fresh branch.
///
/// `base` defaults to `HEAD`. `label` is an optional human tag woven into the
/// branch name. Returns the persisted entry.
#[command(rename_all = "camelCase")]
pub async fn shugu_worktree_create(
    app: AppHandle,
    base: Option<String>,
    label: Option<String>,
) -> Result<WorktreeEntry, String> {
    let root = workspace_root_required(&app)?;
    create_inner(&root, base.as_deref(), label.as_deref()).await
}

/// List tracked worktrees decorated with live orphan-detection state.
#[command(rename_all = "camelCase")]
pub async fn shugu_worktree_list(app: AppHandle) -> Result<Vec<WorktreeStatus>, String> {
    let root = workspace_root_required(&app)?;
    list_inner(&root).await
}

/// Remove a worktree by `id`, and/or sweep orphaned entries.
///
/// - `id`: when set, the matching worktree is removed; an unknown id is an
///   error. When `None`, no id-targeted removal happens (use `pruneOrphans`).
/// - `deleteBranch`: also delete the branch created for the worktree.
/// - `pruneOrphans`: additionally remove every entry whose directory or git
///   registration has gone missing.
///
/// Returns the ids actually removed.
#[command(rename_all = "camelCase")]
pub async fn shugu_worktree_cleanup(
    app: AppHandle,
    id: Option<String>,
    delete_branch: bool,
    prune_orphans: bool,
) -> Result<Vec<String>, String> {
    let root = workspace_root_required(&app)?;
    cleanup_inner(&root, id.as_deref(), delete_branch, prune_orphans).await
}

/// Recursive byte size of a tracked worktree's working directory.
#[command(rename_all = "camelCase")]
pub async fn shugu_worktree_size(app: AppHandle, id: String) -> Result<u64, String> {
    let root = workspace_root_required(&app)?;
    let model = load_model(&root)?;
    let entry = model
        .entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("worktree not found: {id}"))?;
    let dir = PathBuf::from(&entry.path);
    if !dir.is_dir() {
        return Err(format!("worktree directory missing: {}", entry.path));
    }
    Ok(dir_size_bytes(&dir))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn make_temp_dir(suffix: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "shugu_wt_test_{suffix}_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).expect("create temp dir");
        // Canonicalize for stable comparisons, then strip the Windows
        // extended-length prefix (`\\?\`) — `git worktree add` refuses to
        // create a worktree `.git` under such a path. Production never sees the
        // prefix because `workspace_root` is already stripped.
        let canon = std::fs::canonicalize(&base).expect("canonicalize temp dir");
        strip_extended_prefix(canon)
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Initialize a git repo with one commit so HEAD resolves.
    fn init_repo(root: &Path) {
        run(root, &["init", "-q"]);
        run(root, &["config", "user.email", "t@t.t"]);
        run(root, &["config", "user.name", "t"]);
        run(root, &["config", "commit.gpgsign", "false"]);
        run(root, &["config", "core.autocrlf", "false"]);
        // Production gitignores `.shugu/` (where worktrees live). Mirror that here
        // so `git status` in these tests reflects only real working-tree state and
        // never the internal worktree scaffolding under `.shugu/worktrees/`.
        std::fs::write(root.join(".gitignore"), b".shugu/\n").unwrap();
        std::fs::write(root.join("seed.txt"), b"seed").unwrap();
        run(root, &["add", "-A"]);
        run(root, &["commit", "-q", "-m", "seed"]);
    }

    fn run(root: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .expect("git spawn");
        assert!(status.success(), "git {:?} failed", args);
    }

    #[test]
    fn branch_for_slugifies_label() {
        let b = branch_for("abcd", Some("My Cool Turn!"));
        assert!(b.starts_with("shugu/wt/My-Cool-Turn-abcd"), "got {b}");
        let b2 = branch_for("abcd", None);
        assert_eq!(b2, "shugu/wt/abcd");
        let b3 = branch_for("abcd", Some("   "));
        assert_eq!(b3, "shugu/wt/abcd");
    }

    #[test]
    fn paths_equal_handles_platform() {
        if cfg!(windows) {
            assert!(paths_equal("C:/Foo/Bar", "c:/foo/bar"));
        } else {
            assert!(!paths_equal("C:/Foo/Bar", "c:/foo/bar"));
        }
        assert!(paths_equal("/a/b", "/a/b"));
    }

    #[test]
    fn model_roundtrip() {
        let root = make_temp_dir("model_roundtrip");
        let mut model = WorktreeModel {
            version: MODEL_VERSION,
            entries: vec![WorktreeEntry {
                id: "id1".into(),
                path: "/tmp/wt".into(),
                branch: "shugu/wt/id1".into(),
                base: "deadbeef".into(),
                label: Some("turn-1".into()),
                created_at: 1234,
            }],
        };
        save_model(&root, &model).unwrap();
        let loaded = load_model(&root).unwrap();
        assert_eq!(loaded.entries, model.entries);
        // Missing file → empty model.
        model.entries.clear();
        let fresh = load_model(&make_temp_dir("model_empty")).unwrap();
        assert!(fresh.entries.is_empty());
        cleanup(&root);
    }

    #[tokio::test]
    async fn create_list_size_cleanup_lifecycle() {
        if which_git().is_none() {
            eprintln!("git not on PATH — skipping lifecycle test");
            return;
        }
        let root = make_temp_dir("lifecycle");
        init_repo(&root);

        // Create.
        let entry = create_inner(&root, None, Some("turn one"))
            .await
            .expect("create");
        assert!(Path::new(&entry.path).is_dir(), "worktree dir exists");
        assert!(entry.branch.starts_with("shugu/wt/"));

        // List → present, not orphan.
        let listed = list_inner(&root).await.expect("list");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].exists_on_disk);
        assert!(listed[0].registered_in_git);
        assert!(!listed[0].is_orphan);

        // Size → non-zero (working tree has seed.txt + .git file).
        let dir = PathBuf::from(&entry.path);
        let size = dir_size_bytes(&dir);
        assert!(size > 0, "expected non-zero size, got {size}");

        // Cleanup by id, delete branch.
        let removed = cleanup_inner(&root, Some(&entry.id), true, false)
            .await
            .expect("cleanup");
        assert_eq!(removed, vec![entry.id.clone()]);
        assert!(!Path::new(&entry.path).exists(), "dir removed");
        // Model now empty.
        assert!(list_inner(&root).await.unwrap().is_empty());

        cleanup(&root);
    }

    #[tokio::test]
    async fn orphan_detection_and_prune() {
        if which_git().is_none() {
            eprintln!("git not on PATH — skipping orphan test");
            return;
        }
        let root = make_temp_dir("orphan");
        init_repo(&root);

        let entry = create_inner(&root, None, None).await.expect("create");
        // Simulate an out-of-band removal: nuke the dir AND git registration.
        std::fs::remove_dir_all(&entry.path).unwrap();
        run(&root, &["worktree", "prune"]);

        let listed = list_inner(&root).await.expect("list");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].is_orphan, "should be flagged orphan");
        assert!(!listed[0].exists_on_disk);

        // Prune orphans (no id target).
        let removed = cleanup_inner(&root, None, true, true)
            .await
            .expect("prune");
        assert_eq!(removed, vec![entry.id]);
        assert!(list_inner(&root).await.unwrap().is_empty());

        cleanup(&root);
    }

    #[tokio::test]
    async fn cleanup_unknown_id_errors() {
        if which_git().is_none() {
            return;
        }
        let root = make_temp_dir("unknown_id");
        init_repo(&root);
        let err = cleanup_inner(&root, Some("nope"), false, false)
            .await
            .unwrap_err();
        assert!(err.contains("not found"), "got {err}");
        cleanup(&root);
    }

    fn which_git() -> Option<()> {
        StdCommand::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()
            .filter(|s| s.success())
            .map(|_| ())
    }

    /// Read a file under `root`, returning None if missing.
    fn read_file(root: &Path, rel: &str) -> Option<String> {
        std::fs::read_to_string(root.join(rel)).ok()
    }

    // ── Merge-back machinery (Phase 3) ──────────────────────────────────

    #[tokio::test]
    async fn commit_and_merge_back_lands_changes() {
        if which_git().is_none() {
            eprintln!("git not on PATH — skipping merge-back test");
            return;
        }
        let root = make_temp_dir("merge_ok");
        init_repo(&root);

        let entry = create_inner(&root, None, Some("coder"))
            .await
            .expect("create");
        let wt = PathBuf::from(&entry.path);

        // Agent writes a NEW file in the worktree.
        std::fs::write(wt.join("feature.txt"), b"hello from agent").unwrap();

        // Commit inside the worktree → Some(oid).
        let committed = commit_worktree(&wt, "agent work")
            .await
            .expect("commit_worktree");
        assert!(committed.is_some(), "expected a commit oid, got None");

        // Merge back → Merged, and the file is now present in main.
        let outcome = merge_back(&root, &entry.branch).await.expect("merge_back");
        match outcome {
            MergeOutcome::Merged { commit } => assert!(!commit.is_empty()),
            other => panic!("expected Merged, got {other:?}"),
        }
        assert_eq!(
            read_file(&root, "feature.txt").as_deref(),
            Some("hello from agent"),
            "merged file should be present in main working tree"
        );

        // Cleanup with delete_branch=true removes the worktree dir + branch.
        cleanup_inner(&root, Some(&entry.id), true, false)
            .await
            .expect("cleanup");
        assert!(!Path::new(&entry.path).exists(), "worktree dir removed");
        // Branch gone.
        let branches = run_git(&root, &["branch", "--list", &entry.branch])
            .await
            .unwrap();
        assert!(branches.trim().is_empty(), "branch should be deleted");

        cleanup(&root);
    }

    #[tokio::test]
    async fn commit_worktree_no_changes_is_none() {
        if which_git().is_none() {
            return;
        }
        let root = make_temp_dir("commit_none");
        init_repo(&root);
        let entry = create_inner(&root, None, None).await.expect("create");
        let wt = PathBuf::from(&entry.path);

        // No edits → nothing to commit.
        let committed = commit_worktree(&wt, "no-op").await.expect("commit_worktree");
        assert!(committed.is_none(), "expected None for an unchanged worktree");

        cleanup(&root);
    }

    #[tokio::test]
    async fn merge_back_conflict_aborts_and_keeps_worktree() {
        if which_git().is_none() {
            return;
        }
        let root = make_temp_dir("merge_conflict");
        init_repo(&root); // seeds seed.txt = "seed", committed.

        // Worktree forks from the committed HEAD, then edits seed.txt.
        let entry = create_inner(&root, None, Some("coder"))
            .await
            .expect("create");
        let wt = PathBuf::from(&entry.path);
        std::fs::write(wt.join("seed.txt"), b"branch edit").unwrap();
        commit_worktree(&wt, "branch edits seed")
            .await
            .expect("commit branch");

        // Main ALSO edits seed.txt and COMMITS — divergent → conflict on merge.
        // Stage ONLY seed.txt (not `-A`) so we don't accidentally add the nested
        // worktree dir under .shugu/worktrees/ to the index (a test-sandbox-only
        // artifact; production gitignores .shugu/).
        std::fs::write(root.join("seed.txt"), b"main edit").unwrap();
        run(&root, &["add", "seed.txt"]);
        run(&root, &["commit", "-q", "-m", "main edits seed"]);

        let outcome = merge_back(&root, &entry.branch).await.expect("merge_back");
        match outcome {
            MergeOutcome::Conflict { files } => {
                assert_eq!(files, vec!["seed.txt".to_string()], "got {files:?}");
            }
            other => panic!("expected Conflict, got {other:?}"),
        }

        // merge --abort ran → main tree restored to its own commit, clean.
        assert_eq!(
            read_file(&root, "seed.txt").as_deref(),
            Some("main edit"),
            "main working tree should be restored to its own edit"
        );
        let status = run_git(&root, &["status", "--porcelain"]).await.unwrap();
        assert!(
            status.trim().is_empty(),
            "main tree should be clean after abort, got: {status:?}"
        );

        // Worktree is KEPT (not cleaned) so the user can review it manually.
        assert!(
            Path::new(&entry.path).exists(),
            "worktree dir should be kept on conflict"
        );
        let branches = run_git(&root, &["branch", "--list", &entry.branch])
            .await
            .unwrap();
        assert!(
            !branches.trim().is_empty(),
            "branch should be kept on conflict"
        );

        // Manual cleanup for the test sandbox.
        let _ = cleanup_inner(&root, Some(&entry.id), true, false).await;
        cleanup(&root);
    }

    #[tokio::test]
    async fn merge_back_into_dirty_target_declines() {
        if which_git().is_none() {
            return;
        }
        let root = make_temp_dir("merge_dirty");
        init_repo(&root); // seed.txt = "seed", committed.

        let entry = create_inner(&root, None, Some("coder"))
            .await
            .expect("create");
        let wt = PathBuf::from(&entry.path);
        // Branch edits seed.txt and commits.
        std::fs::write(wt.join("seed.txt"), b"branch edit").unwrap();
        commit_worktree(&wt, "branch edits seed")
            .await
            .expect("commit branch");

        // Main has an UNCOMMITTED edit on the SAME path → dirty overlap.
        std::fs::write(root.join("seed.txt"), b"uncommitted main edit").unwrap();

        let outcome = merge_back(&root, &entry.branch).await.expect("merge_back");
        assert_eq!(
            outcome,
            MergeOutcome::DirtyTarget,
            "should decline merging into a dirty overlapping target"
        );

        // Main working tree is UNMUTATED — the uncommitted edit is intact and no
        // merge commit was created.
        assert_eq!(
            read_file(&root, "seed.txt").as_deref(),
            Some("uncommitted main edit"),
            "main working tree must be left untouched"
        );

        let _ = cleanup_inner(&root, Some(&entry.id), true, false).await;
        cleanup(&root);
    }

    #[tokio::test]
    async fn diff_summary_reports_branch_changes() {
        if which_git().is_none() {
            return;
        }
        let root = make_temp_dir("diff_summary");
        init_repo(&root);
        let entry = create_inner(&root, None, None).await.expect("create");
        let wt = PathBuf::from(&entry.path);
        std::fs::write(wt.join("new.txt"), b"a\nb\nc\n").unwrap();
        commit_worktree(&wt, "add new.txt").await.expect("commit");

        let summary = diff_summary(&root, &entry.branch, &entry.base)
            .await
            .expect("diff_summary");
        assert!(summary.contains("new.txt"), "got summary: {summary:?}");

        let _ = cleanup_inner(&root, Some(&entry.id), true, false).await;
        cleanup(&root);
    }

    #[tokio::test]
    async fn entry_for_id_round_trips() {
        if which_git().is_none() {
            return;
        }
        let root = make_temp_dir("entry_for_id");
        init_repo(&root);
        let entry = create_inner(&root, None, Some("lookup"))
            .await
            .expect("create");
        let found = entry_for_id(&root, &entry.id).expect("entry_for_id");
        assert_eq!(found.id, entry.id);
        assert_eq!(found.branch, entry.branch);
        assert!(entry_for_id(&root, "does-not-exist").is_none());

        let _ = cleanup_inner(&root, Some(&entry.id), true, false).await;
        cleanup(&root);
    }
}
