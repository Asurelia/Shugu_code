//! Turn snapshots — autonomous module.
//!
//! Before an agent performs a mutating action, Shugu takes a lightweight
//! *checkpoint*: it captures the current working-tree state (tracked +
//! untracked files) as a commit on a phantom ref `refs/shugu/turn/<id>`,
//! parented on `HEAD`, **without touching the user's index, `HEAD`, or any
//! branch**. If the action goes wrong, `revert` restores the working tree to
//! that checkpoint.
//!
//! This is implemented with git plumbing and a throw-away index file so the
//! real index is never disturbed:
//!
//! 1. `GIT_INDEX_FILE=<tmp>` + `git add -A`  → stage a full snapshot in a temp
//!    index.
//! 2. `git write-tree`                       → tree OID for that snapshot.
//! 3. `git commit-tree <tree> -p <HEAD>`     → lightweight commit OID.
//! 4. `git update-ref refs/shugu/turn/<id>`  → publish the phantom ref.
//!
//! Revert restores tracked files to the snapshot via
//! `git restore --source=<ref> --worktree --staged -- :/` and re-creates any
//! files that the snapshot's tree carries.
//!
//! Self-contained: shells out to the `git` CLI, no dependency on `git.rs` or
//! `runner.rs`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Manager};
use tokio::process::Command as TokioCommand;

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/// A turn checkpoint stored at `refs/shugu/turn/<id>`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Turn identifier — the leaf of `refs/shugu/turn/<id>`.
    pub turn_id: String,
    /// Full ref name (`refs/shugu/turn/<id>`).
    pub ref_name: String,
    /// Commit OID the ref points at.
    pub oid: String,
    /// Tree OID captured (working-tree snapshot).
    pub tree: String,
    /// Parent commit (the `HEAD` at checkpoint time), if any.
    pub parent: Option<String>,
    /// Checkpoint time, unix seconds (UTC).
    pub created_at: i64,
}

const REF_PREFIX: &str = "refs/shugu/turn/";

// ---------------------------------------------------------------------------
// Workspace / helpers (local — no dependency on git.rs)
// ---------------------------------------------------------------------------

fn workspace_root_required(app: &AppHandle) -> Result<PathBuf, String> {
    let ws_state = app.state::<std::sync::Mutex<Option<PathBuf>>>();
    let guard = ws_state
        .lock()
        .map_err(|e| format!("workspace lock: {e}"))?;
    guard.clone().ok_or_else(|| "no workspace open".to_string())
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Validate a turn id is safe to embed in a ref name. Git ref components forbid
/// a number of characters and patterns; we accept a conservative subset.
fn validate_turn_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("turn id is empty".to_string());
    }
    if id.len() > 200 {
        return Err("turn id too long".to_string());
    }
    let ok = id.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
    });
    if !ok {
        return Err(
            "turn id must be alphanumeric with '-', '_' or '.' only".to_string(),
        );
    }
    if id.starts_with('.') || id.ends_with('.') || id.contains("..") {
        return Err("turn id has invalid dot placement".to_string());
    }
    Ok(())
}

fn ref_for(id: &str) -> String {
    format!("{REF_PREFIX}{id}")
}

// ---------------------------------------------------------------------------
// git CLI
// ---------------------------------------------------------------------------

/// Run `git <args>` in `cwd` with optional extra env, returning trimmed stdout.
async fn run_git_env(
    cwd: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<String, String> {
    let mut cmd = TokioCommand::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    let output = cmd.output().await.map_err(|e| {
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
    Ok(raw.replace("\r\n", "\n").trim_end().to_string())
}

async fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git_env(cwd, args, &[]).await
}

/// Resolve `HEAD` to a commit OID, or `None` when the repo has no commit yet.
async fn head_oid(root: &Path) -> Option<String> {
    run_git(root, &["rev-parse", "--verify", "HEAD"])
        .await
        .ok()
        .filter(|s| !s.is_empty())
}

/// Path of the `.git` directory (resolves worktrees too).
async fn git_dir(root: &Path) -> Result<PathBuf, String> {
    let out = run_git(root, &["rev-parse", "--absolute-git-dir"]).await?;
    Ok(PathBuf::from(out))
}

// ---------------------------------------------------------------------------
// Internal checkpoint / revert (testable, no AppHandle)
// ---------------------------------------------------------------------------

pub(crate) async fn checkpoint_inner(root: &Path, turn_id: &str) -> Result<Snapshot, String> {
    validate_turn_id(turn_id)?;

    // Confirm we are in a repo.
    run_git(root, &["rev-parse", "--is-inside-work-tree"]).await?;

    let parent = head_oid(root).await;

    // Throw-away index file so the user's real index is untouched. We seed it
    // from HEAD (if any) so `git add -A` produces a delta against HEAD and the
    // resulting tree is the full working-tree state.
    let git_dir = git_dir(root).await?;
    let tmp_index = git_dir.join(format!("shugu-snapshot-index-{turn_id}.tmp"));
    // Defensive: remove a stale temp index from a crashed run.
    let _ = std::fs::remove_file(&tmp_index);
    let tmp_index_str = tmp_index.to_string_lossy().to_string();
    let env = [("GIT_INDEX_FILE", tmp_index_str.as_str())];

    let result = async {
        // Seed the temp index from HEAD's tree when a commit exists.
        if let Some(ref p) = parent {
            run_git_env(root, &["read-tree", p], &env).await?;
        } else {
            // No commit yet → start from an empty index.
            run_git_env(root, &["read-tree", "--empty"], &env).await?;
        }

        // Stage everything (tracked modifications, additions, deletions, and
        // untracked files) into the temp index.
        run_git_env(root, &["add", "-A"], &env).await?;

        // Write the snapshot tree.
        let tree = run_git_env(root, &["write-tree"], &env).await?;
        if tree.is_empty() {
            return Err("write-tree produced empty oid".to_string());
        }

        // Build a lightweight commit. Provide deterministic identity/env so the
        // commit succeeds even on a machine with no user.name/user.email set.
        let msg = format!("shugu snapshot: turn {turn_id}");
        let mut args: Vec<&str> = vec!["commit-tree", &tree, "-m", &msg];
        if let Some(ref p) = parent {
            args.push("-p");
            args.push(p);
        }
        let ident_env = [
            ("GIT_AUTHOR_NAME", "shugu"),
            ("GIT_AUTHOR_EMAIL", "shugu@localhost"),
            ("GIT_COMMITTER_NAME", "shugu"),
            ("GIT_COMMITTER_EMAIL", "shugu@localhost"),
        ];
        let oid = run_git_env(root, &args, &ident_env).await?;
        if oid.is_empty() {
            return Err("commit-tree produced empty oid".to_string());
        }

        // Publish the phantom ref.
        let ref_name = ref_for(turn_id);
        run_git(root, &["update-ref", &ref_name, &oid]).await?;

        Ok(Snapshot {
            turn_id: turn_id.to_string(),
            ref_name,
            oid,
            tree,
            parent: parent.clone(),
            created_at: now_unix(),
        })
    }
    .await;

    // Always clean the temp index.
    let _ = std::fs::remove_file(&tmp_index);
    result
}

async fn list_inner(root: &Path) -> Result<Vec<Snapshot>, String> {
    // `for-each-ref` prints one line per matching ref. %(refname) %(objectname)
    // and the commit's tree/parent via dereference.
    let fmt = "%(refname)\t%(objectname)\t%(creatordate:unix)";
    let out = run_git(
        root,
        &["for-each-ref", "--format", fmt, "refs/shugu/turn/"],
    )
    .await?;

    let mut snaps = Vec::new();
    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\t');
        let ref_name = parts.next().unwrap_or("").to_string();
        let oid = parts.next().unwrap_or("").to_string();
        let created_at = parts
            .next()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0);
        if ref_name.is_empty() || oid.is_empty() {
            continue;
        }
        let turn_id = ref_name
            .strip_prefix(REF_PREFIX)
            .unwrap_or(&ref_name)
            .to_string();

        // Resolve tree + parent for the commit.
        let tree = run_git(root, &["rev-parse", &format!("{oid}^{{tree}}")])
            .await
            .unwrap_or_default();
        let parent = run_git(root, &["rev-parse", "--verify", &format!("{oid}^")])
            .await
            .ok()
            .filter(|s| !s.is_empty());

        snaps.push(Snapshot {
            turn_id,
            ref_name,
            oid,
            tree,
            parent,
            created_at,
        });
    }
    Ok(snaps)
}

async fn revert_inner(root: &Path, turn_id: &str) -> Result<Snapshot, String> {
    validate_turn_id(turn_id)?;
    let ref_name = ref_for(turn_id);

    // Resolve the snapshot — error clearly if it does not exist.
    let oid = run_git(root, &["rev-parse", "--verify", &format!("{ref_name}^{{commit}}")])
        .await
        .map_err(|_| format!("snapshot not found: {turn_id}"))?;
    let tree = run_git(root, &["rev-parse", &format!("{oid}^{{tree}}")]).await?;
    let parent = run_git(root, &["rev-parse", "--verify", &format!("{oid}^")])
        .await
        .ok()
        .filter(|s| !s.is_empty());

    // Restore tracked content to exactly the snapshot tree, in both the index
    // and the working tree. `:/` targets the whole repo from its root.
    run_git(
        root,
        &[
            "restore",
            "--source",
            &oid,
            "--staged",
            "--worktree",
            "--",
            ":/",
        ],
    )
    .await?;

    // `git restore` does not delete files that exist in the working tree but
    // are absent from the snapshot tree (i.e. files created after the
    // checkpoint). Remove those so the working tree matches the snapshot
    // exactly. We diff the snapshot tree against the current index (which we
    // just set to the snapshot) — anything still "added" in the worktree is
    // surfaced by `clean`-style detection below.
    //
    // Build the set of paths present in the snapshot tree, then delete any
    // tracked-or-untracked file under the repo root that is NOT in it. We use
    // `git ls-files --others --exclude-standard` to find untracked leftovers
    // (files created since the checkpoint that the snapshot never had).
    let leftovers = run_git(
        root,
        &["ls-files", "--others", "--exclude-standard"],
    )
    .await?;
    for rel in leftovers.lines() {
        let rel = rel.trim();
        if rel.is_empty() {
            continue;
        }
        let p = root.join(rel);
        let _ = std::fs::remove_file(&p);
    }

    let created_at = run_git(
        root,
        &["log", "-1", "--format=%ct", &oid],
    )
    .await
    .ok()
    .and_then(|s| s.trim().parse::<i64>().ok())
    .unwrap_or_else(now_unix);

    Ok(Snapshot {
        turn_id: turn_id.to_string(),
        ref_name,
        oid,
        tree,
        parent,
        created_at,
    })
}

async fn delete_inner(root: &Path, turn_id: &str) -> Result<(), String> {
    validate_turn_id(turn_id)?;
    let ref_name = ref_for(turn_id);
    // `update-ref -d` is a no-op-error if the ref is missing; tolerate that.
    match run_git(root, &["update-ref", "-d", &ref_name]).await {
        Ok(_) => Ok(()),
        Err(e) if e.contains("not exist") || e.contains("No such ref") => Ok(()),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Capture the current working tree as a checkpoint on `refs/shugu/turn/<id>`.
/// Does not modify the user's index, `HEAD`, or any branch. Idempotent for a
/// given `turnId` in the sense that re-running overwrites the ref with a fresh
/// snapshot of the current state.
#[command(rename_all = "camelCase")]
pub async fn shugu_snapshot_checkpoint(
    app: AppHandle,
    turn_id: String,
) -> Result<Snapshot, String> {
    let root = workspace_root_required(&app)?;
    checkpoint_inner(&root, &turn_id).await
}

/// Restore the working tree to the checkpoint stored for `turnId`.
#[command(rename_all = "camelCase")]
pub async fn shugu_snapshot_revert(
    app: AppHandle,
    turn_id: String,
) -> Result<Snapshot, String> {
    let root = workspace_root_required(&app)?;
    revert_inner(&root, &turn_id).await
}

/// List all turn snapshots currently held under `refs/shugu/turn/`.
#[command(rename_all = "camelCase")]
pub async fn shugu_snapshot_list(app: AppHandle) -> Result<Vec<Snapshot>, String> {
    let root = workspace_root_required(&app)?;
    list_inner(&root).await
}

/// Delete the checkpoint ref for `turnId`. Missing ref is treated as success.
#[command(rename_all = "camelCase")]
pub async fn shugu_snapshot_delete(app: AppHandle, turn_id: String) -> Result<(), String> {
    let root = workspace_root_required(&app)?;
    delete_inner(&root, &turn_id).await
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
            "shugu_snap_test_{suffix}_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).expect("create temp dir");
        let canon = std::fs::canonicalize(&base).expect("canonicalize temp dir");
        strip_extended_prefix(canon)
    }

    /// Strip Windows extended-length prefix so git CLI accepts the test paths.
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

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn run(root: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .expect("git spawn");
        assert!(status.success(), "git {:?} failed", args);
    }

    fn init_repo(root: &Path) {
        run(root, &["init", "-q"]);
        run(root, &["config", "user.email", "t@t.t"]);
        run(root, &["config", "user.name", "t"]);
        run(root, &["config", "commit.gpgsign", "false"]);
        // Keep bytes verbatim so assertions on exact file contents are not
        // perturbed by the platform's autocrlf default (CRLF on checkout).
        run(root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("seed.txt"), b"seed\n").unwrap();
        run(root, &["add", "-A"]);
        run(root, &["commit", "-q", "-m", "seed"]);
    }

    fn which_git() -> bool {
        StdCommand::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    #[test]
    fn validate_turn_id_rules() {
        assert!(validate_turn_id("abc-123_x.y").is_ok());
        assert!(validate_turn_id("").is_err());
        assert!(validate_turn_id("has space").is_err());
        assert!(validate_turn_id("..").is_err());
        assert!(validate_turn_id(".lead").is_err());
        assert!(validate_turn_id("trail.").is_err());
        assert!(validate_turn_id("a/b").is_err());
        assert!(validate_turn_id("a..b").is_err());
    }

    #[test]
    fn ref_for_builds_path() {
        assert_eq!(ref_for("t1"), "refs/shugu/turn/t1");
    }

    #[tokio::test]
    async fn checkpoint_does_not_touch_index_or_head() {
        if !which_git() {
            eprintln!("git missing — skipping");
            return;
        }
        let root = make_temp_dir("notouch");
        init_repo(&root);

        let head_before = head_oid(&root).await.unwrap();
        // Stage something into the REAL index so we can verify it is preserved.
        std::fs::write(root.join("staged.txt"), b"in-index\n").unwrap();
        run(&root, &["add", "staged.txt"]);
        // Also make an unstaged change.
        std::fs::write(root.join("seed.txt"), b"changed\n").unwrap();

        let snap = checkpoint_inner(&root, "turn1").await.expect("checkpoint");
        assert_eq!(snap.ref_name, "refs/shugu/turn/turn1");
        assert_eq!(snap.parent.as_deref(), Some(head_before.as_str()));

        // HEAD unchanged.
        assert_eq!(head_oid(&root).await.unwrap(), head_before);
        // Real index still has staged.txt staged.
        let staged = run_git(&root, &["diff", "--cached", "--name-only"])
            .await
            .unwrap();
        assert!(staged.contains("staged.txt"), "index preserved: {staged}");

        // The snapshot tree must include the working-tree change to seed.txt.
        let show = run_git(&root, &["show", &format!("{}:seed.txt", snap.oid)])
            .await
            .unwrap();
        assert_eq!(show.trim(), "changed");

        cleanup(&root);
    }

    #[tokio::test]
    async fn revert_restores_working_tree() {
        if !which_git() {
            return;
        }
        let root = make_temp_dir("revert");
        init_repo(&root);

        // Checkpoint the clean state.
        checkpoint_inner(&root, "t").await.expect("checkpoint");

        // Agent mutates: edit seed.txt, add new.txt, delete nothing.
        std::fs::write(root.join("seed.txt"), b"agent-edit\n").unwrap();
        std::fs::write(root.join("new.txt"), b"created by agent\n").unwrap();

        // Revert.
        let snap = revert_inner(&root, "t").await.expect("revert");
        assert_eq!(snap.turn_id, "t");

        // seed.txt restored.
        let seed = std::fs::read_to_string(root.join("seed.txt")).unwrap();
        assert_eq!(seed, "seed\n", "seed.txt restored to snapshot");
        // new.txt removed (it did not exist at checkpoint).
        assert!(
            !root.join("new.txt").exists(),
            "post-checkpoint file removed on revert"
        );

        cleanup(&root);
    }

    #[tokio::test]
    async fn list_and_delete() {
        if !which_git() {
            return;
        }
        let root = make_temp_dir("listdel");
        init_repo(&root);

        checkpoint_inner(&root, "alpha").await.expect("cp a");
        checkpoint_inner(&root, "beta").await.expect("cp b");

        let mut listed = list_inner(&root).await.expect("list");
        listed.sort_by(|a, b| a.turn_id.cmp(&b.turn_id));
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].turn_id, "alpha");
        assert_eq!(listed[1].turn_id, "beta");
        assert!(listed[0].ref_name.ends_with("alpha"));
        assert!(!listed[0].oid.is_empty());
        assert!(!listed[0].tree.is_empty());

        delete_inner(&root, "alpha").await.expect("delete");
        let after = list_inner(&root).await.expect("list2");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].turn_id, "beta");

        // Deleting a missing ref is a no-op success.
        delete_inner(&root, "ghost").await.expect("delete ghost ok");

        cleanup(&root);
    }

    #[tokio::test]
    async fn revert_missing_snapshot_errors() {
        if !which_git() {
            return;
        }
        let root = make_temp_dir("revmiss");
        init_repo(&root);
        let err = revert_inner(&root, "nope").await.unwrap_err();
        assert!(err.contains("not found"), "got {err}");
        cleanup(&root);
    }
}
