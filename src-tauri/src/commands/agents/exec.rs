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
//!
//! ## Process-tree kill (P0-a)
//!
//! The wall-clock timeout used to call `child.kill()`, which on Windows only
//! terminates the *direct* child (`cmd.exe`). Its descendants — the `cargo`
//! that `cmd` launched, the `rustc`/`node`/dev-server that `cargo` launched —
//! survived, kept holding file locks and ports, and could wedge the next run.
//! We now assign the child to a Windows **Job Object** with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: `TerminateJobObject` (on timeout) and
//! dropping the job handle (on normal exit) both tear down the ENTIRE tree
//! atomically. On non-Windows the existing `child.kill()` is kept (a true
//! POSIX process-group kill is a separate, larger change and Shugu's target is
//! Windows-first).

use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::policy::{classify_with_rules, CommandRisk, CommandRule, ExecutionPolicy};

/// Hard ceiling on captured output per stream, to protect the LLM context
/// budget (and the event log) from a runaway test that prints megabytes.
const OUTPUT_CAP: usize = 8 * 1024;

pub(super) struct ExecResult {
    pub(super) exit_code: i32,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) timed_out: bool,
    /// Risk verdict the classifier returned for this command (P0-a). Carried on
    /// the result so the dispatcher can surface it to the model + the UI without
    /// re-classifying. `Safe` for the overwhelming majority of commands.
    pub(super) risk: CommandRisk,
}

// ────────────────────────────────────────────────────────────────────────
// Windows Job Object — process-tree containment for the timeout kill.
// ────────────────────────────────────────────────────────────────────────

/// RAII wrapper over a Windows Job Object configured to kill every assigned
/// process (and their descendants) when the handle closes. Created BEFORE the
/// child is spawned, the child is assigned to it immediately after spawn, and
/// the wrapper is held for the lifetime of the run.
///
/// Two teardown paths, both tree-wide:
///   * timeout → [`ProcessTree::terminate`] calls `TerminateJobObject`,
///   * normal exit / error → `Drop` closes the handle; with
///     `KILL_ON_JOB_CLOSE` set, Windows reaps any stragglers.
#[cfg(windows)]
struct ProcessTree {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl ProcessTree {
    /// Create a job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Returns
    /// `None` on any FFI failure — the caller degrades to a plain `child.kill()`
    /// rather than refusing to run (containment is best-effort hardening, never
    /// a precondition for execution).
    fn create() -> Option<Self> {
        use std::ptr;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: CreateJobObjectW with null security attrs + null name returns
        // a new unnamed job handle, or null on failure (which we check).
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return None;
        }

        // Configure: when the LAST handle to the job closes, kill every process
        // still assigned to it (and, transitively, the descendants they spawned
        // — children inherit the job assignment unless they opt out, which the
        // standard toolchain never does).
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: `info` is a valid, fully-initialized struct of the size we
        // pass; the class matches the struct type.
        let ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            // SAFETY: `job` is a valid handle we just created.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return None;
        }

        Some(ProcessTree { job })
    }

    /// Assign a freshly-spawned child to the job. Best-effort: a failure here
    /// just means the timeout kill falls back to killing the direct child only.
    fn assign(&self, child: &Child) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        let proc_handle = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        // SAFETY: `self.job` is a valid job handle; `proc_handle` is the live
        // process handle owned by `child` (valid until `child` is dropped).
        unsafe {
            AssignProcessToJobObject(self.job, proc_handle);
        }
    }

    /// Terminate every process in the job (the whole tree) with the given exit
    /// code. Used on the timeout path.
    fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: `self.job` is a valid job handle.
        unsafe {
            TerminateJobObject(self.job, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // Closing the last handle triggers KILL_ON_JOB_CLOSE → any survivors are
        // reaped. On the normal-exit path the child is already gone, so this is
        // just handle cleanup; on an error path it also catches stragglers.
        // SAFETY: `self.job` is a valid handle created in `create`, closed once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
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

/// Run `command` through the platform shell, cwd = the agent's workspace,
/// under execution `policy`. BLOCKS (call under `spawn_blocking`). Never
/// panics: a spawn failure is returned as a non-zero result with the reason in
/// `stderr`, so the agent sees a clean "exec failed" message instead of the
/// run crashing.
///
/// Windows: `cmd /d /s /c` — `/d` SKIPS the user's cmd.exe AutoRun (this
/// machine has one that launches a vault + CLI; spawning it from a background
/// agent would be both slow and wrong), `/s` keeps quote handling sane. The
/// child is assigned to a Job Object so the timeout kill takes the whole
/// process tree (see module docs). Unix: `sh -c`.
///
/// The command is classified ([`CommandRisk`]) and a structured line is logged
/// (`{cmd, cwd, policy, risk, exit, timedOut}`); the risk verdict rides back on
/// the result so the dispatcher can flag it to the model + UI. Classification
/// is ADVISORY — a `Danger` verdict is logged and surfaced, never a refusal
/// (the loop stays fluid; the safety net is git + the process-tree kill).
pub(super) fn run_command_direct(
    ws: &Path,
    command: &str,
    timeout_secs: u64,
    policy: ExecutionPolicy,
    rules: &[CommandRule],
) -> ExecResult {
    let cwd = strip_verbatim(ws);
    // Phase 2 — les règles apprises de l'utilisateur OVERRIDENT le classifieur
    // statique (allow → Safe, deny → Danger) ; sinon on retombe sur les
    // détecteurs. `rules` est vide quand aucune règle / DB indisponible.
    let risk = classify_with_rules(command, policy, rules);

    // Real process sandbox (ALWAYS ON — Claude-Code model). The command runs in
    // a write-confined / reads-open low-integrity child: it can read anywhere
    // (so node/pnpm/cargo/git work) but can only WRITE the workspace + temp +
    // package caches. Network stays active. The ONLY opt-out is the emergency
    // env `SHUGU_SANDBOX_DISABLE=1`. `run_confined` returns `Some(outcome)` when
    // it actually ran the command confined; it returns `None` when the sandbox
    // declined or could not arm (disabled, non-Windows, or any FFI failure) — in
    // which case we fall through to the proven direct spawn below so the dev loop
    // is never blocked. See sandbox.rs for the mechanism + honest limits.
    if let Some(out) = super::sandbox::run_confined(&cwd, command, timeout_secs, OUTPUT_CAP) {
        log_exec(command, &cwd, policy, &risk, out.exit_code, out.timed_out);
        return ExecResult {
            exit_code: out.exit_code,
            stdout: out.stdout,
            stderr: out.stderr,
            timed_out: out.timed_out,
            risk,
        };
    }

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

    // Create the job object BEFORE spawn so we can assign the child the instant
    // it exists, before it has a chance to fork descendants. Best-effort: a
    // None here just degrades the timeout kill to the direct child.
    #[cfg(windows)]
    let process_tree = ProcessTree::create();

    let child = cmd
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            log_exec(command, &cwd, policy, &risk, -1, false);
            return ExecResult {
                exit_code: -1,
                stdout: String::new(),
                stderr: format!("exécution impossible : {e}"),
                timed_out: false,
                risk,
            };
        }
    };

    // Assign the child (and thus its future descendants) to the job.
    #[cfg(windows)]
    if let Some(ref tree) = process_tree {
        tree.assign(&child);
    }

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
                    kill_tree(&mut child);
                    #[cfg(windows)]
                    if let Some(ref tree) = process_tree {
                        // Terminate the WHOLE tree, not just `cmd.exe`: the
                        // hung process is usually a descendant (dev server,
                        // rustc) that `child.kill()` alone would orphan.
                        tree.terminate();
                    }
                    break 124; // same convention as coreutils `timeout`
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                kill_tree(&mut child);
                #[cfg(windows)]
                if let Some(ref tree) = process_tree {
                    tree.terminate();
                }
                log_exec(command, &cwd, policy, &risk, -1, false);
                return ExecResult {
                    exit_code: -1,
                    stdout: join_reader(stdout_handle),
                    stderr: format!("wait failed: {e}"),
                    timed_out: false,
                    risk,
                };
            }
        }
    };

    log_exec(command, &cwd, policy, &risk, exit_code, timed_out);

    ExecResult {
        exit_code,
        stdout: join_reader(stdout_handle),
        stderr: join_reader(stderr_handle),
        timed_out,
        risk,
    }
}

/// Kill the direct child and reap it. On Windows the tree-wide kill is handled
/// separately by the Job Object (`TerminateJobObject`); this still kills the
/// `cmd.exe` itself. On non-Windows this is the only kill (POSIX process-group
/// containment is out of scope for this Windows-first lane).
fn kill_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Structured one-line log of an exec, JSON so it's grep-able and machine-
/// parseable in the dev log. Fields: `cmd` (capped), `cwd`, `policy`, `risk`
/// (+ reason when danger), `exit`, `timedOut`. Emitted to stderr (the app's
/// dev-log sink). Cheap — only formats a short object per command.
fn log_exec(
    command: &str,
    cwd: &Path,
    policy: ExecutionPolicy,
    risk: &CommandRisk,
    exit_code: i32,
    timed_out: bool,
) {
    // Cap the logged command so a giant heredoc can't blow the log line.
    const CMD_LOG_CAP: usize = 200;
    let cmd_short: String = command.chars().take(CMD_LOG_CAP).collect();
    let truncated = command.chars().count() > CMD_LOG_CAP;
    let payload = serde_json::json!({
        "cmd": if truncated { format!("{cmd_short}…") } else { cmd_short },
        "cwd": cwd.to_string_lossy(),
        "policy": policy.as_str(),
        "risk": risk.level.as_str(),
        "riskReason": risk.reason,
        "exit": exit_code,
        "timedOut": timed_out,
    });
    eprintln!("[agent:exec] {payload}");
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
        let res = run_command_direct(
            &tmp,
            "echo hello-exec",
            30,
            ExecutionPolicy::WorkspaceWrite,
            &[],
        );
        assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
        assert!(res.stdout.contains("hello-exec"));
        assert!(!res.timed_out);
        // A plain echo must classify as safe.
        assert!(!res.risk.is_danger());
    }

    #[test]
    fn run_nonzero_exit_reported() {
        let tmp = std::env::temp_dir();
        let res = run_command_direct(&tmp, "exit 3", 30, ExecutionPolicy::WorkspaceWrite, &[]);
        assert_eq!(res.exit_code, 3);
        assert!(!res.timed_out);
    }

    #[test]
    fn run_carries_risk_verdict() {
        // run_command_direct RUNS the command regardless of risk (non-blocking)
        // but the verdict must ride back on the result for the UI/log.
        let tmp = std::env::temp_dir();
        let res = run_command_direct(
            &tmp,
            "git push --force",
            30,
            ExecutionPolicy::WorkspaceWrite,
            &[],
        );
        // (git may or may not be a repo here — we only assert the classifier ran.)
        assert!(res.risk.is_danger());
        assert_eq!(res.risk.reason, Some("forcePush"));
    }

    #[test]
    fn run_timeout_kills_within_grace() {
        // A command that sleeps far past the 1s timeout must come back as
        // timed_out=124 promptly (the Job-Object/kill path), not hang the test.
        let tmp = std::env::temp_dir();
        #[cfg(windows)]
        // `ping -n 10 127.0.0.1` runs ~9s; with a 1s timeout it must be killed.
        let cmd = "ping -n 10 127.0.0.1";
        #[cfg(not(windows))]
        let cmd = "sleep 10";
        let start = Instant::now();
        let res = run_command_direct(&tmp, cmd, 1, ExecutionPolicy::WorkspaceWrite, &[]);
        let elapsed = start.elapsed();
        assert!(res.timed_out, "expected timeout, got exit {}", res.exit_code);
        assert_eq!(res.exit_code, 124);
        // Generous upper bound: 1s timeout + polling slack + kill, well under 8s.
        assert!(
            elapsed < Duration::from_secs(8),
            "timeout kill took too long: {elapsed:?}"
        );
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
