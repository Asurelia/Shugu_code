//! Disposable project mirror — the "grounded" half of the agent's domain.
//!
//! Atelier builds in an EMPTY temp dir. Grounded Run generalises that to "work
//! on a throwaway COPY of the user's real project": the agent reads / writes /
//! runs tests on the mirror, never the live tree. The live project is touched
//! ONLY by the explicit auto-apply of the resulting patch (and the user can
//! reverse it with one click).
//!
//! Why a `git init` baseline inside the mirror (`prepare_project_mirror`):
//!   - The mirror is seeded from the EXACT current working tree (tracked +
//!     untracked-non-ignored). Committing a `baseline` lets `compute_mirror_patch`
//!     produce a unified diff of *only the agent's changes* relative to what the
//!     user has RIGHT NOW — so it applies cleanly back onto the live tree.
//!   - `core.autocrlf=false` (mirror-local) defuses the classic Windows CRLF
//!     round-trip that makes `git apply` reject the patch downstream.
//!   - These config writes are LOCAL to the disposable mirror; the user's own
//!     git config is never touched.
//!
//! Mirror lives under `temp_dir()` (inside Docker Desktop's file-sharing scope,
//! same proven path as Atelier) and is removed once the patch is extracted —
//! the patch is the durable artifact, the source-tree copy is not.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Skip files larger than this in the NON-git recursive walk (random build
/// artifacts / binaries). Git-tracked files are copied regardless — they're
/// version-controlled, hence intentional.
const MIRROR_FILE_CAP: u64 = 5 * 1024 * 1024; // 5 MiB

/// Directory names never copied into the mirror (the non-git fallback path).
/// In git mode these are excluded for free by `.gitignore` via `ls-files`.
const EXCLUDE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    ".cache",
    ".shugu-forge",
];

/// Run `git <args>` in `cwd`, returning stdout on success. Pure subprocess
/// (no shell) so the user's cmd.exe AutoRun is never invoked.
fn git_capture(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git {} (cwd={}): {e}", args.join(" "), cwd.display()))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Tracked ∪ untracked-non-ignored paths, NUL-separated so spaces / unicode in
/// paths never corrupt the split.
fn collect_git_files(real_root: &Path) -> Result<Vec<String>, String> {
    let tracked = git_capture(real_root, &["ls-files", "-z"])?;
    let untracked = git_capture(real_root, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    let mut files = Vec::new();
    for chunk in tracked.split('\0').chain(untracked.split('\0')) {
        let p = chunk.trim();
        if !p.is_empty() {
            files.push(p.to_string());
        }
    }
    Ok(files)
}

/// Recursive copy with directory exclusions + a per-file size cap. Symlinks are
/// skipped (they could escape the tree or dangle inside the container).
fn copy_tree_excluding(src: &Path, dst: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(src).map_err(|e| format!("read_dir {}: {e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if EXCLUDE_DIRS.iter().any(|d| name_str == *d) {
                continue;
            }
            let sub_dst = dst.join(&name);
            std::fs::create_dir_all(&sub_dst).map_err(|e| e.to_string())?;
            copy_tree_excluding(&entry.path(), &sub_dst)?;
        } else if ft.is_file() {
            let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if len > MIRROR_FILE_CAP {
                continue;
            }
            std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
            std::fs::copy(entry.path(), dst.join(&name)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Build a disposable mirror of `real_root` under the OS temp dir and stamp a
/// `baseline` commit. Returns the canonicalized mirror path (the path-guard's
/// pre-canonicalized-root contract; the `\\?\` prefix is handled downstream by
/// the sandbox + path-guard exactly as for Atelier).
pub(super) fn prepare_project_mirror(real_root: &Path, agent_id: &str) -> Result<PathBuf, String> {
    let dst = std::env::temp_dir().join(format!("shugu-grounded-{agent_id}"));
    if dst.exists() {
        let _ = std::fs::remove_dir_all(&dst);
    }
    std::fs::create_dir_all(&dst).map_err(|e| format!("create mirror dir: {e}"))?;

    let is_git = real_root.join(".git").exists();
    if is_git {
        let files = collect_git_files(real_root)?;
        if files.is_empty() {
            // Repo with nothing tracked/untracked yet — fall back to a copy.
            copy_tree_excluding(real_root, &dst)?;
        } else {
            for rel in files {
                let src = real_root.join(&rel);
                if !src.is_file() {
                    continue; // staged-but-deleted, or a gitlink/submodule
                }
                let dst_path = dst.join(&rel);
                if let Some(parent) = dst_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::copy(&src, &dst_path).map_err(|e| format!("copy {rel}: {e}"))?;
            }
        }
    } else {
        copy_tree_excluding(real_root, &dst)?;
    }

    // Baseline commit (mirror-local config; never touches the user's git config).
    git_capture(&dst, &["init", "-q"])?;
    git_capture(&dst, &["config", "core.autocrlf", "false"])?;
    git_capture(&dst, &["config", "commit.gpgsign", "false"])?;
    git_capture(&dst, &["config", "user.email", "grounded@shugu.local"])?;
    git_capture(&dst, &["config", "user.name", "Shugu Grounded"])?;
    git_capture(&dst, &["add", "-A"])?;
    git_capture(
        &dst,
        &["commit", "-q", "-m", "baseline", "--allow-empty", "--no-gpg-sign"],
    )?;

    std::fs::canonicalize(&dst).map_err(|e| format!("canonicalize mirror: {e}"))
}

/// Unified diff of the agent's changes vs the `baseline` commit. Empty string
/// when the agent changed nothing.
pub(super) fn compute_mirror_patch(mirror: &Path) -> Result<String, String> {
    git_capture(mirror, &["add", "-A"])?;
    git_capture(mirror, &["diff", "--cached"])
}

/// Feed `patch` to `git <args>` on stdin in `cwd`. Used for apply / reverse.
fn git_apply_stdin(cwd: &Path, args: &[&str], patch: &str) -> Result<(), String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "git stdin unavailable".to_string())?
        .write_all(patch.as_bytes())
        .map_err(|e| format!("write patch to git: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Auto-apply `patch` to the LIVE project working tree. `git apply --check`
/// runs first (CRLF / whitespace guard) so a non-appliable patch is reported
/// cleanly instead of leaving the tree half-written.
pub(super) fn apply_patch(real_root: &Path, patch: &str) -> Result<(), String> {
    git_apply_stdin(real_root, &["apply", "--check"], patch)
        .map_err(|e| format!("le patch ne s'applique pas proprement : {e}"))?;
    git_apply_stdin(real_root, &["apply"], patch)
}

/// Reverse a previously auto-applied patch (the "Annuler ce run" button).
/// `--check` first so a stale patch (the tree changed since) fails loudly.
pub(super) fn reverse_patch(real_root: &Path, patch: &str) -> Result<(), String> {
    git_apply_stdin(real_root, &["apply", "--reverse", "--check"], patch)
        .map_err(|e| format!("annulation impossible (le projet a-t-il changé depuis ?) : {e}"))?;
    git_apply_stdin(real_root, &["apply", "--reverse"], patch)
}

/// Best-effort removal of the disposable mirror (grounded mirrors are full
/// source-tree copies per run; temp would bloat otherwise). On Windows, git's
/// packed objects are read-only and block `remove_dir_all`, so we clear the
/// read-only flag and retry once.
pub(super) fn cleanup_mirror(mirror: &Path) {
    if !mirror.exists() {
        return;
    }
    if std::fs::remove_dir_all(mirror).is_ok() {
        return;
    }
    clear_readonly_recursive(mirror);
    let _ = std::fs::remove_dir_all(mirror);
}

fn clear_readonly_recursive(path: &Path) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(meta) = std::fs::symlink_metadata(&p) {
            let mut perms = meta.permissions();
            if perms.readonly() {
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(&p, perms);
            }
            if meta.is_dir() {
                clear_readonly_recursive(&p);
            }
        }
    }
}
