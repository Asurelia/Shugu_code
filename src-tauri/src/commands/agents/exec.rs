//! Direct command execution — the "environment" half of the agent's domain.
//!
//! The agent needs REAL feedback: does the code it wrote actually run / pass
//! its tests? — not a static opinion. Commands run DIRECTLY on the user's
//! machine, in the agent's workspace, with the machine's real toolchain
//! (node, pnpm, cargo, git…) and network access — exactly like Claude Code or
//! Codex CLI. The safety net is git: the user follows the agent's changes in
//! the Git panel and can discard them there (pivot décision utilisateur
//! 2026-06-10 — l'ancien sandbox Docker + miroir jetable a été retiré comme
//! sur-ingénierie pour un outil local mono-utilisateur).
//!
//! Two guards remain, both about FEEDBACK quality, not containment:
//!   * a wall-clock timeout per command (a hung dev server can't wedge the
//!     agent loop forever),
//!   * an output cap per stream (a runaway test that prints megabytes can't
//!     blow the LLM context budget).
//!
//! `check_git_safety` is the preflight half: it reports whether the git
//! safety net is actually in place (repo present, tree committed) so the UI
//! can show a NON-BLOCKING warning before an agent run. It never refuses.

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Hard ceiling on captured output per stream, to protect the LLM context
/// budget (and the event log) from a runaway test that prints megabytes.
const OUTPUT_CAP: usize = 8 * 1024;

pub(super) struct ExecResult {
    pub(super) exit_code: i32,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) timed_out: bool,
}

/// Strip the `\\?\` verbatim prefix `canonicalize` adds on Windows — cmd.exe
/// and many node tools mis-handle it when it leaks into `cwd`/argv (recurring
/// Windows bug, cf. terminal.rs `normalize_cwd_for_shell`).
fn strip_verbatim(p: &Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(stripped) => std::path::PathBuf::from(stripped),
        None => p.to_path_buf(),
    }
}

/// Run `command` through the platform shell, cwd = the agent's workspace.
/// BLOCKS (call under `spawn_blocking`). Never panics: a spawn failure is
/// returned as a non-zero result with the reason in `stderr`, so the agent
/// sees a clean "exec failed" message instead of the run crashing.
///
/// Windows: `cmd /d /s /c` — `/d` SKIPS the user's cmd.exe AutoRun (this
/// machine has one that launches a vault + CLI; spawning it from a background
/// agent would be both slow and wrong), `/s` keeps quote handling sane.
/// Unix: `sh -c`.
pub(super) fn run_command_direct(ws: &Path, command: &str, timeout_secs: u64) -> ExecResult {
    let cwd = strip_verbatim(ws);

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/d", "/s", "/c", command]);
        // CREATE_NO_WINDOW — no console flash from a GUI app.
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };

    let child = cmd
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            return ExecResult {
                exit_code: -1,
                stdout: String::new(),
                stderr: format!("exécution impossible : {e}"),
                timed_out: false,
            };
        }
    };

    // Drain stdout/stderr on dedicated threads so a chatty child can't fill
    // the pipe buffer and deadlock against our try_wait polling loop.
    let stdout_handle = child.stdout.take().map(spawn_reader);
    let stderr_handle = child.stderr.take().map(spawn_reader);

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break 124; // same convention as coreutils `timeout`
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return ExecResult {
                    exit_code: -1,
                    stdout: join_reader(stdout_handle),
                    stderr: format!("wait failed: {e}"),
                    timed_out: false,
                };
            }
        }
    };

    ExecResult {
        exit_code,
        stdout: join_reader(stdout_handle),
        stderr: join_reader(stderr_handle),
        timed_out,
    }
}

/// Collect a child stream into a string on its own thread (cap applied at
/// join time — we still read everything so the child never blocks on a full
/// pipe, we just don't FORWARD more than the cap).
fn spawn_reader<R: Read + Send + 'static>(mut stream: R) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stream.read_to_end(&mut buf);
        buf
    })
}

fn join_reader(handle: Option<std::thread::JoinHandle<Vec<u8>>>) -> String {
    let Some(h) = handle else {
        return String::new();
    };
    match h.join() {
        Ok(bytes) => truncate(&String::from_utf8_lossy(&bytes)),
        Err(_) => String::new(),
    }
}

fn truncate(s: &str) -> String {
    if s.len() <= OUTPUT_CAP {
        return s.to_string();
    }
    let mut end = OUTPUT_CAP;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[... tronqué à {OUTPUT_CAP} octets ...]", &s[..end])
}

// ────────────────────────────────────────────────────────────────────────
// Preflight — is the GIT SAFETY NET in place? Execution itself is always
// available (direct exec); what the user needs to know before letting an
// agent loose on the real project is whether the changes will be reversible.
// NON-BLOCKING by design: the UI shows the warning, the user decides.
// ────────────────────────────────────────────────────────────────────────

/// Git-safety-net report for the workspace. Serialized camelCase to the
/// frontend (`{ ready, gitRepo, hasUncommitted, warning }`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecCapability {
    /// Execution is possible (a workspace is open). Direct exec has no other
    /// prerequisite — no Docker, no image.
    pub ready: bool,
    /// The workspace is a git repository (the safety net exists).
    pub git_repo: bool,
    /// Uncommitted changes present — the net only protects what's committed.
    pub has_uncommitted: bool,
    /// Human-readable, NON-blocking warning; `None` when the net is solid.
    pub warning: Option<String>,
}

/// Probe the git safety net for `root`. BLOCKS (one `git status` subprocess,
/// call under `spawn_blocking`). Pure subprocess (no shell) so the user's
/// cmd.exe AutoRun is never invoked.
pub(super) fn check_git_safety(root: Option<std::path::PathBuf>) -> ExecCapability {
    let Some(root) = root else {
        return ExecCapability {
            ready: false,
            git_repo: false,
            has_uncommitted: false,
            warning: Some(
                "Aucun projet ouvert : ouvre un dossier avant de lancer un agent.".to_string(),
            ),
        };
    };

    let git_repo = root.join(".git").exists();
    if !git_repo {
        return ExecCapability {
            ready: true,
            git_repo: false,
            has_uncommitted: false,
            warning: Some(
                "Pas de filet git : ce dossier n'est pas un dépôt. Les modifications de \
                 l'agent ne seront pas annulables — fais un commit de départ (onglet Git) \
                 ou continue à tes risques."
                    .to_string(),
            ),
        };
    }

    // `git status --porcelain` : any output line = uncommitted change. A git
    // failure (binary missing, corrupt repo) degrades to "unknown" — we report
    // the net as present but flag nothing rather than blocking the run.
    let has_uncommitted = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&root)
        .stdin(Stdio::null())
        .output()
        .map(|out| out.status.success() && !out.stdout.is_empty())
        .unwrap_or(false);

    ExecCapability {
        ready: true,
        git_repo: true,
        has_uncommitted,
        warning: if has_uncommitted {
            Some(
                "Changements non commités : le filet git ne protège que ce qui est commité. \
                 Commite d'abord (onglet Git) pour pouvoir tout annuler proprement."
                    .to_string(),
            )
        } else {
            None
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_caps_long_output() {
        let s = "x".repeat(OUTPUT_CAP + 100);
        let t = truncate(&s);
        assert!(t.len() < s.len());
        assert!(t.contains("tronqué"));
    }

    #[test]
    fn truncate_short_passthrough() {
        assert_eq!(truncate("ok"), "ok");
    }

    #[test]
    fn strip_verbatim_removes_prefix() {
        #[cfg(windows)]
        {
            let p = Path::new(r"\\?\C:\Users\test");
            assert_eq!(strip_verbatim(p), std::path::PathBuf::from(r"C:\Users\test"));
        }
        let plain = Path::new("relative/path");
        assert_eq!(strip_verbatim(plain), std::path::PathBuf::from("relative/path"));
    }

    #[test]
    fn run_echo_captures_stdout() {
        let tmp = std::env::temp_dir();
        let res = run_command_direct(&tmp, "echo hello-exec", 30);
        assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
        assert!(res.stdout.contains("hello-exec"));
        assert!(!res.timed_out);
    }

    #[test]
    fn run_nonzero_exit_reported() {
        let tmp = std::env::temp_dir();
        let res = run_command_direct(&tmp, "exit 3", 30);
        assert_eq!(res.exit_code, 3);
        assert!(!res.timed_out);
    }

    #[test]
    fn check_git_safety_no_workspace() {
        let cap = check_git_safety(None);
        assert!(!cap.ready);
        assert!(cap.warning.is_some());
    }

    #[test]
    fn check_git_safety_non_repo_dir() {
        let dir = std::env::temp_dir().join("shugu-exec-test-nonrepo");
        let _ = std::fs::create_dir_all(&dir);
        let cap = check_git_safety(Some(dir.clone()));
        assert!(cap.ready);
        assert!(!cap.git_repo);
        assert!(cap.warning.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
