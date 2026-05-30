//! Sandboxed command execution — the "environment" half of the agent's domain.
//!
//! The agent needs REAL feedback: does the code it wrote actually run / pass its
//! tests? — not a static opinion. But executing agent-written code is the ONE
//! action a workspace path-guard can't contain (a command can `rm`, hit the
//! network, fork-bomb). So every execution runs inside a THROWAWAY Docker
//! container:
//!
//! ```text
//! docker run --rm --network none --cpus 2 --memory 2g --shm-size 1g \
//!   --pids-limit 512 -v <ws>:/work -w /work shugu-playwright:1.60 \
//!   sh -c "timeout <N> <command>"
//! ```
//!
//! Network off (no exfiltration, no install), resource + wall-clock limits,
//! `--rm` (ephemeral), and ONLY the disposable Atelier copy mounted → the
//! container cannot touch the host beyond that copy. This is the "execution"
//! half of safety axis 1 (containment). It runs ONLY against the Atelier's
//! throwaway mirror (`allow_exec` gate), never the user's real project.

use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Custom Atelier image: the official Playwright image (Chromium + browsers + OS
/// deps baked in, version-pinned) PLUS the Playwright npm library at a fixed
/// `NODE_PATH`, so an agent-written `node` script can drive a REAL browser with
/// the container OFFLINE (`--network none`). Built ONCE:
///   docker build -t shugu-playwright:1.60 -f docker/playwright.Dockerfile docker
const SANDBOX_IMAGE: &str = "shugu-playwright:1.60";

/// Hard ceiling on captured output per stream, to protect the LLM context budget
/// (and the event log) from a runaway test that prints megabytes.
const OUTPUT_CAP: usize = 8 * 1024;

pub(super) struct SandboxResult {
    pub(super) exit_code: i32,
    pub(super) stdout: String,
    pub(super) stderr: String,
    pub(super) timed_out: bool,
}

/// Normalise a Windows host path for a Docker `-v` mount: strip the `\\?\`
/// verbatim prefix that `canonicalize` adds (Docker Desktop rejects it) and turn
/// backslashes into forward slashes.
fn docker_host_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).replace('\\', "/")
}

/// Run `command` inside a throwaway, network-isolated container with the sandbox
/// workspace mounted at `/work`. BLOCKS (call under `spawn_blocking`). Never
/// panics: a docker-level failure (binary missing, daemon down, image absent) is
/// returned as a non-zero result with the reason in `stderr`, so a bench run
/// degrades to a clean "exec unavailable" verdict instead of crashing.
///
/// `extra_ro_mounts` are `(host_path, container_path)` pairs mounted read-only —
/// Grounded Run uses this to expose the live project's `node_modules` at
/// `/work/node_modules` so `pnpm`/`tsc` resolve OFFLINE (verified: pnpm's
/// relative symlinks stay valid when the whole dir is mounted as a unit). The
/// mounts are READ-ONLY, so the agent's exec can never mutate the real deps.
/// Atelier passes `&[]` (unchanged behaviour).
pub(super) fn run_in_sandbox(
    ws: &Path,
    command: &str,
    timeout_secs: u64,
    extra_ro_mounts: &[(String, String)],
) -> SandboxResult {
    let mount = docker_host_path(ws);

    // `timeout SECS CMD` (GNU coreutils, present in the jammy base) caps
    // wall-clock INSIDE the container; it exits 124 when it kills the command.
    let inner = format!("timeout {timeout_secs} {command}");

    let mut args: Vec<String> = vec![
        "run".into(),
        "--rm".into(),
        "--network".into(),
        "none".into(),
        "--cpus".into(),
        "2".into(),
        "--memory".into(),
        "2g".into(),
        "--shm-size".into(),
        "1g".into(),
        "--pids-limit".into(),
        "512".into(),
        "-v".into(),
        format!("{mount}:/work"),
    ];
    for (host, container) in extra_ro_mounts {
        // host is already a canonicalized path from the caller; normalise the
        // `\\?\` prefix + slashes exactly like the workspace mount above.
        let host_norm = docker_host_path(Path::new(host));
        args.push("-v".into());
        args.push(format!("{host_norm}:{container}:ro"));
    }
    args.push("-w".into());
    args.push("/work".into());
    args.push(SANDBOX_IMAGE.into());
    args.push("sh".into());
    args.push("-c".into());
    args.push(inner);

    let output = Command::new("docker").args(&args).output();

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
                "exécution sandbox impossible : {e}. Docker Desktop est-il démarré, \
                 et l'image construite ? (attendue : {SANDBOX_IMAGE} — voir \
                 docker/playwright.Dockerfile)"
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

// ────────────────────────────────────────────────────────────────────────
// Preflight — is the exec sandbox usable RIGHT NOW? The frontend calls this
// to enable/disable the "Grounded Run" button and show an ACTIONABLE reason
// when it can't. Three distinct failure states, each with its own remedy:
//   1. docker binary missing  → spawn fails (NotFound)
//   2. daemon down            → spawns, `docker info` exits non-zero
//   3. image absent           → daemon up, `docker image inspect` exits non-zero
// Web mode (no Tauri) never reaches here — the command simply isn't invokable.
// ────────────────────────────────────────────────────────────────────────

/// Capability report for the exec sandbox. Serialized camelCase to the
/// frontend (`{ dockerAvailable, imagePresent, reason }`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecCapability {
    pub docker_available: bool,
    pub image_present: bool,
    /// Actionable, human-readable reason when exec is unusable; `None` when
    /// everything is ready. Shown verbatim in the disabled-button tooltip.
    pub reason: Option<String>,
}

/// Outcome of one bounded docker subprocess probe. We only ever surface canned,
/// actionable messages to the user, so the variants carry no captured output.
enum Probe {
    /// Process exited 0.
    Ok,
    /// Process exited non-zero (daemon down / image absent).
    NonZero,
    /// `docker` binary not found / not spawnable.
    NotSpawnable,
    /// Process didn't finish within the deadline (hung daemon).
    TimedOut,
}

/// Run `docker <args>` with a hard wall-clock deadline. BLOCKS — call under
/// `spawn_blocking`. Never hangs the UI: a stuck daemon is killed and reported
/// as `TimedOut` rather than blocking forever. Output is discarded — we only
/// read the exit status.
fn probe_docker(args: &[&str], timeout: Duration) -> Probe {
    let mut child = match Command::new("docker")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return Probe::NotSpawnable,
    };

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Probe::Ok
                } else {
                    Probe::NonZero
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Probe::TimedOut;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Probe::NotSpawnable,
        }
    }
}

/// Probe Docker availability + the sandbox image presence. BLOCKS — call under
/// `spawn_blocking`. ~8 s worst-case (two 4 s-capped probes).
pub(super) fn check_docker() -> ExecCapability {
    const BUILD_HINT: &str =
        "docker build -t shugu-playwright:1.60 -f docker/playwright.Dockerfile docker";

    // 1. Daemon reachable? `docker info --format {{.ServerVersion}}` is light:
    //    prints the version when the daemon is up, errors when it's down.
    match probe_docker(&["info", "--format", "{{.ServerVersion}}"], Duration::from_secs(4)) {
        Probe::NotSpawnable => {
            return ExecCapability {
                docker_available: false,
                image_present: false,
                reason: Some(format!(
                    "Docker introuvable. Installe Docker Desktop, puis construis l'image sandbox :\n{BUILD_HINT}"
                )),
            };
        }
        Probe::TimedOut => {
            return ExecCapability {
                docker_available: false,
                image_present: false,
                reason: Some(
                    "Docker ne répond pas (daemon en cours de démarrage ?). Réessaie dans un instant."
                        .to_string(),
                ),
            };
        }
        Probe::NonZero => {
            return ExecCapability {
                docker_available: false,
                image_present: false,
                reason: Some(
                    "Docker Desktop n'est pas démarré. Lance-le, puis réessaie.".to_string(),
                ),
            };
        }
        Probe::Ok => {}
    }

    // 2. Daemon is up — is the sandbox image built?
    match probe_docker(&["image", "inspect", SANDBOX_IMAGE], Duration::from_secs(4)) {
        Probe::Ok => ExecCapability {
            docker_available: true,
            image_present: true,
            reason: None,
        },
        _ => ExecCapability {
            docker_available: true,
            image_present: false,
            reason: Some(format!(
                "Image sandbox « {SANDBOX_IMAGE} » absente. Construis-la une fois :\n{BUILD_HINT}"
            )),
        },
    }
}
