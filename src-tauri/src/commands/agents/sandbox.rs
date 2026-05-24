//! Sandboxed command execution — the "environment" half of the agent's domain.
//!
//! The agent needs REAL feedback: does the code it wrote actually run / pass its
//! tests? — not a static opinion. But executing agent-written code is the ONE
//! action a workspace path-guard can't contain (a command can `rm`, hit the
//! network, fork-bomb). So every execution runs inside a THROWAWAY Docker
//! container:
//!
//! ```text
//! docker run --rm --network none --cpus 1 --memory 512m --pids-limit 256 \
//!   -v <ws>:/work -w /work node:22-alpine sh -c "timeout <N> <command>"
//! ```
//!
//! Network off (no exfiltration, no install), resource + wall-clock limits,
//! `--rm` (ephemeral), and ONLY the disposable sandbox copy mounted → the
//! container cannot touch the host beyond that copy. This is the "execution"
//! half of safety axis 1 (containment). v1 runs ONLY against the bench's copied
//! fixtures (`allow_exec` gate), never the user's real project.

use std::path::Path;
use std::process::Command;

/// Image with a Node runtime (`node --test` is built in) — small (~150 MB).
/// Must be pulled once (`docker pull node:22-alpine`); runs are `--network none`.
const SANDBOX_IMAGE: &str = "node:22-alpine";

/// Hard ceiling on captured output per stream, to protect the LLM context budget
/// (and the event log) from a runaway test that prints megabytes.
const OUTPUT_CAP: usize = 8 * 1024;

pub(super) struct SandboxResult {
    pub(super) exit_code: i32,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) timed_out: bool,
}

/// Run `command` inside a throwaway, network-isolated container with the sandbox
/// workspace mounted at `/work`. BLOCKS (call under `spawn_blocking`). Never
/// panics: a docker-level failure (binary missing, daemon down, image absent) is
/// returned as a non-zero result with the reason in `stderr`, so a bench run
/// degrades to a clean "exec unavailable" verdict instead of crashing.
pub(super) fn run_in_sandbox(ws: &Path, command: &str, timeout_secs: u64) -> SandboxResult {
    // Docker Desktop wants a forward-slash host path and rejects the Windows
    // `\\?\` verbatim prefix that `canonicalize` adds. Strip it, normalise slashes.
    let ws_str = ws.to_string_lossy();
    let mount = ws_str
        .strip_prefix(r"\\?\")
        .unwrap_or(&ws_str)
        .replace('\\', "/");

    // `timeout SECS CMD` (BusyBox coreutils, present in alpine) caps wall-clock
    // INSIDE the container; it exits 124 when it kills the command.
    let inner = format!("timeout {timeout_secs} {command}");

    let output = Command::new("docker")
        .args([
            "run",
            "--rm",
            "--network",
            "none",
            "--cpus",
            "1",
            "--memory",
            "512m",
            "--pids-limit",
            "256",
            "-v",
            &format!("{mount}:/work"),
            "-w",
            "/work",
            SANDBOX_IMAGE,
            "sh",
            "-c",
            &inner,
        ])
        .output();

    match output {
        Ok(out) => {
            let exit_code = out.status.code().unwrap_or(-1);
            SandboxResult {
                exit_code,
                stdout: truncate(&String::from_utf8_lossy(&out.stdout)),
                stderr: truncate(&String::from_utf8_lossy(&out.stderr)),
                timed_out: exit_code == 124,
            }
        }
        Err(e) => SandboxResult {
            exit_code: -1,
            stdout: String::new(),
            stderr: format!(
                "exécution sandbox impossible : {e}. Docker Desktop est-il démarré ? \
                 (image attendue : {SANDBOX_IMAGE})"
            ),
            timed_out: false,
        },
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
