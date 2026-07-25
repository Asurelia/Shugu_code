//! Real process sandbox for agent `run_command` — write-confined, reads-open,
//! invisible, ALWAYS ON (Claude-Code / Codex-CLI model, ported to Windows).
//!
//! ## What this is (and what the previous version was NOT)
//!
//! `run_command_direct` (exec.rs) runs agent commands on the user's machine with
//! the full toolchain. A prior iteration tried to confine it with **deny-ACEs**
//! on a hand-picked list of secret files — a deny-LIST, not a jail. The user
//! rejected that: it protects only the files we thought to enumerate, and it
//! ducked the hard part (re-spawning the child under a confined token). This
//! module does the real thing:
//!
//!   * **Reads: OPEN.** The confined child can read anywhere — system dirs, the
//!     user profile, every toolchain (node / pnpm / cargo / git) — so the tools
//!     keep working.
//!   * **Writes: CONFINED** to the workspace plus dedicated runtime/cache
//!     directories under `<workspace>/.shugu/agent-runtime`. User-wide package
//!     caches are never relabeled. A write elsewhere remains blocked by MIC.
//!   * **Network: ACTIVE.** Untouched — cutting it would break `pnpm install` /
//!     `git fetch`.
//!
//! ## Mechanism — Mandatory Integrity Control, LOW integrity (chosen)
//!
//! Windows has no native "reads-open / writes-confined" primitive, so we lean on
//! **Mandatory Integrity Control (MIC)**, the same kernel feature that sandboxes
//! Protected-Mode IE / Chrome renderers:
//!
//!   1. Duplicate the current primary token and lower its integrity to **LOW**
//!      (`SetTokenInformation(TokenIntegrityLevel)`, SID `S-1-16-4096`). Lowering
//!      your OWN token needs no privilege (you can always drop integrity, never
//!      raise it). A LOW process obeys MIC's two rules:
//!        * **no-write-up** — it may NOT write to objects labeled at a HIGHER
//!          integrity than itself. Ordinary files/dirs are MEDIUM by default, so
//!          a LOW child cannot write them. ← this is the write-jail, for free.
//!        * **no `*-read-up` is the default** — MIC does NOT restrict reads by
//!          default (the read-up policy bit is off on normal objects), so the LOW
//!          child reads MEDIUM/HIGH objects fine. ← reads stay open, for free.
//!   2. Stamp each allowlist directory with a **LOW mandatory label** (a SACL
//!      `S:(ML;OICI;NW;;;LW)` — Low label, container+object inherit, no-write-up
//!      policy). An object's own integrity gates writes: once a dir is LOW, a LOW
//!      process MAY write it (equal integrity, no up-level). So the workspace /
//!      temp / caches become writable to the confined child while the rest of the
//!      disk (MEDIUM) stays read-only to it. The owner can set a label at or
//!      below its own level without privilege; we restore the prior label on Drop
//!      (RAII), so the change is transient and self-healing.
//!
//! ### Why MIC-low over AppContainer
//!
//! AppContainer is a true capability jail, but it confines **reads** too: by
//! default an AppContainer process can't read anything not granted
//! `ALL_APPLICATION_PACKAGES`, so every toolchain dir (node install, cargo
//! registry, the user's PATH targets, system DLLs the loader touches) would need
//! an explicit read-grant ACE — a large, fragile surface that breaks a tool the
//! moment we miss one path. MIC-low gives "reads open, writes confined" as the
//! NATIVE default, which is exactly the spec. We document AppContainer as the
//! stricter upgrade if a capability-true jail is ever needed.
//!
//! ### Honest limits of MIC-low
//!
//!   * **Granularity is the integrity label, not a path ACL.** Anything we label
//!     LOW is writable; everything else MEDIUM is not. A pre-existing LOW-labeled
//!     object elsewhere on the machine (rare) would also be writable. We don't
//!     scan for those — the allowlist is what we deliberately open.
//!   * **A tool that itself drops/raises integrity** could escape, but the agent
//!     runs as the user with no special privilege, and raising integrity needs
//!     one — so a LOW child cannot climb back to MEDIUM.
//!   * **Same-user concurrency window.** The LOW label on an allowlist dir is
//!     visible to other processes during the run; it only *grants* low-IL write
//!     (it never removes the existing DACL), so it does not reduce anyone's
//!     access. Restored on Drop; a hard crash leaves a recoverable state fixable
//!     with `icacls <dir> /setintegritylevel … ` or simply re-running.
//!   * **Delete semantics.** A LOW child can delete files *inside* a LOW dir
//!     (the workspace) — that's intended (git is the net there). It cannot delete
//!     MEDIUM files outside the allowlist (no-write-up covers delete).
//!
//! ## Always on — the invisibility contract
//!
//! There is **no toggle to enable** the sandbox and no UI: every agent
//! `run_command` goes through the confined spawn. The ONLY escape hatch is the
//! emergency env var **`SHUGU_SANDBOX_DISABLE=1`**, which forces the plain direct
//! spawn (to unblock the dev loop if confinement ever misbehaves on a machine).
//!
//! ## Fail-safe
//!
//! Setting up the token, labeling a dir, or the confined spawn can each fail for
//! environmental reasons. The public API reports that failure explicitly. Auto
//! mode must fail closed; only an explicit Full Access policy may run directly.
//!
//! ## Non-Windows
//!
//! A documented no-op: [`should_disable`] / the allowlist resolver still parse so
//! the policy is observable/testable, but there is no confined spawn (Shugu is
//! Windows-first; a POSIX lane — bubblewrap/Landlock — is a separate change).
//! `run_command_direct` simply uses its normal `std::process::Command` path.

use std::path::{Path, PathBuf};

// ────────────────────────────────────────────────────────────────────────
// Activation — ALWAYS ON; only env `SHUGU_SANDBOX_DISABLE=1` opts OUT.
// ────────────────────────────────────────────────────────────────────────

/// Emergency kill-switch env var. Set to `1` / `true` / `on` to run commands
/// WITHOUT confinement (plain direct spawn). Anything else (incl. unset) → the
/// sandbox is active. Documented in `docs/win-sandbox-validation.md`.
pub const DISABLE_ENV: &str = "SHUGU_SANDBOX_DISABLE";

/// Is the sandbox disabled by the emergency env var? `true` only for an explicit
/// truthy value — the default (unset / anything else) keeps the sandbox ON.
pub fn should_disable() -> bool {
    match std::env::var(DISABLE_ENV) {
        Ok(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "on" | "yes"
        ),
        Err(_) => false,
    }
}

// ────────────────────────────────────────────────────────────────────────
// Write-allowlist — the roots the confined child MAY write. Pure, OS-agnostic,
// unit-tested without any spawn or FFI.
// ────────────────────────────────────────────────────────────────────────

/// Resolve the user's home directory the way the rest of Shugu does
/// (`USERPROFILE` first on Windows, then `HOME`). `None` if neither is set, in
/// which case only the workspace + temp are allowlisted.
pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// The write-allowlist: workspace plus dedicated per-workspace runtime roots.
/// Global temp/package caches stay MEDIUM and are never weakened.
pub(crate) fn write_allowlist(ws: &Path, _home: Option<&Path>) -> Vec<PathBuf> {
    let runtime = ws.join(".shugu").join("agent-runtime");
    let mut allow: Vec<PathBuf> = vec![
        ws.to_path_buf(),
        runtime.join("temp"),
        runtime.join("cargo-home"),
        runtime.join("cargo-target"),
        runtime.join("npm-cache"),
        runtime.join("pnpm-store"),
        runtime.join("xdg-cache"),
        runtime.join("pip-cache"),
    ];

    // De-dup (env overrides can collide with the home-relative defaults).
    allow.sort();
    allow.dedup();
    allow
}

// ════════════════════════════════════════════════════════════════════════
// Public spawn surface. On Windows: the confined low-IL spawn. Elsewhere /
// when disabled: the caller uses its own direct path (this returns None to say
// "I did not run it").
// ════════════════════════════════════════════════════════════════════════

/// Outcome of a confined run, mirroring the fields `run_command_direct` needs.
pub struct ConfinedOutcome {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Proof of whether the command actually ran inside the sandbox. Callers must
/// never infer confinement from a best-effort attempt.
pub enum ConfinedRun {
    Executed(ConfinedOutcome),
    Unavailable { reason: &'static str },
}

/// Attempt to run `command` (via `cmd /d /s /c`) under the process sandbox, with
/// cwd = `ws`, a wall-clock `timeout_secs`, and stdout/stderr each capped at
/// `output_cap` bytes. BLOCKS (call under `spawn_blocking`).
///
/// Returns:
///   * `Some(outcome)` — the command ran CONFINED; the outcome is authoritative.
///   * `None` — the sandbox declined / could not arm (disabled by env, non-
///     Windows, or any FFI failure). The caller MUST fall back to its direct
///     spawn. A warning is logged on the failure path.
///
/// Never panics: every fallible FFI step degrades to `None` so the dev loop is
/// never blocked.
#[cfg(windows)]
#[cfg_attr(not(test), allow(dead_code))]
pub fn run_confined(ws: &Path, command: &str, timeout_secs: u64, output_cap: usize) -> ConfinedRun {
    run_confined_cancellable(ws, command, timeout_secs, output_cap, None)
}

#[cfg(windows)]
pub fn run_confined_cancellable(
    ws: &Path,
    command: &str,
    timeout_secs: u64,
    output_cap: usize,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> ConfinedRun {
    // MIC labels are process-global filesystem state. Serialize confined runs so
    // one command cannot restore a transient workspace label while another
    // command is still executing under LOW integrity.
    static RUN_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    let _run_guard = match RUN_LOCK.get_or_init(|| std::sync::Mutex::new(())).lock() {
        Ok(guard) => guard,
        Err(_) => {
            return ConfinedRun::Unavailable {
                reason: "sandboxLockPoisoned",
            }
        }
    };
    if cancelled.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst)) {
        return ConfinedRun::Executed(ConfinedOutcome {
            exit_code: 130,
            stdout: String::new(),
            stderr: "commande annulée avant démarrage".to_string(),
            timed_out: false,
        });
    }
    if should_disable() {
        eprintln!("[agent:sandbox] {DISABLE_ENV} set — confinement unavailable.");
        return ConfinedRun::Unavailable {
            reason: "disabledByEnvironment",
        };
    }
    match windows_impl::run_confined(ws, command, timeout_secs, output_cap, cancelled) {
        Some(outcome) => ConfinedRun::Executed(outcome),
        None => ConfinedRun::Unavailable {
            reason: "sandboxSetupFailed",
        },
    }
}

/// Non-Windows: no confined spawn lane. Always `None` → caller uses its direct
/// `std::process::Command` path. (A POSIX confinement lane is out of scope.)
#[cfg(not(windows))]
#[cfg_attr(not(test), allow(dead_code))]
pub fn run_confined(
    _ws: &Path,
    _command: &str,
    _timeout_secs: u64,
    _output_cap: usize,
) -> ConfinedRun {
    run_confined_cancellable(_ws, _command, _timeout_secs, _output_cap, None)
}

#[cfg(not(windows))]
pub fn run_confined_cancellable(
    _ws: &Path,
    _command: &str,
    _timeout_secs: u64,
    _output_cap: usize,
    _cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> ConfinedRun {
    ConfinedRun::Unavailable {
        reason: "unsupportedPlatform",
    }
}

// ════════════════════════════════════════════════════════════════════════
// P6.9 — surface publique des spawns persistants (sessions + background).
// Sur Windows : le chemin confiné LOW (windows_impl). Ailleurs : None →
// l'appelant utilise son chemin direct (Full Access) ou refuse (Auto,
// fail-closed comme run_command).
// ════════════════════════════════════════════════════════════════════════

/// Un shell spawné sans attente (session persistante ou processus détaché) :
/// pipes appartenant au parent + handle (terminate = kill de l'arbre).
#[cfg(windows)]
pub(super) struct SpawnedShell {
    pub pid: u32,
    pub stdin: std::fs::File,
    pub stdout: std::fs::File,
    pub stderr: std::fs::File,
    handle: windows_impl::ConfinedShellHandle,
}

#[cfg(windows)]
impl SpawnedShell {
    /// Consomme le shell : (pid, stdin, stdout, stderr, handle). Évite les
    /// moves partiels côté appelant (P6.9).
    pub fn into_parts(
        self,
    ) -> (
        u32,
        std::fs::File,
        std::fs::File,
        std::fs::File,
        windows_impl::ConfinedShellHandle,
    ) {
        (self.pid, self.stdin, self.stdout, self.stderr, self.handle)
    }
}

/// Session shell persistante confinée (LOW integrity), `cmd /d /q /k`.
/// `None` si le sandbox ne peut pas s'armer (Auto doit alors REFUSER —
/// fail-closed, jamais de repli direct silencieux).
#[cfg(windows)]
pub(super) fn spawn_confined_shell(ws: &Path) -> Option<SpawnedShell> {
    windows_impl::spawn_shell(ws).map(|sh| SpawnedShell {
        pid: sh.handle.pid(),
        stdin: sh.stdin,
        stdout: sh.stdout,
        stderr: sh.stderr,
        handle: sh.handle,
    })
}

/// Processus d'arrière-plan confiné (`cmd /d /s /c <command>`).
#[cfg(windows)]
pub(super) fn spawn_confined_detached(ws: &Path, command: &str) -> Option<SpawnedShell> {
    windows_impl::spawn_detached(ws, command).map(|sh| SpawnedShell {
        pid: sh.handle.pid(),
        stdin: sh.stdin,
        stdout: sh.stdout,
        stderr: sh.stderr,
        handle: sh.handle,
    })
}

#[cfg(not(windows))]
pub(super) struct SpawnedShell;

#[cfg(not(windows))]
pub(super) fn spawn_confined_shell(_ws: &Path) -> Option<SpawnedShell> {
    None
}

#[cfg(not(windows))]
pub(super) fn spawn_confined_detached(_ws: &Path, _command: &str) -> Option<SpawnedShell> {
    None
}

// ════════════════════════════════════════════════════════════════════════
// Windows implementation
// ════════════════════════════════════════════════════════════════════════

#[cfg(windows)]
pub(crate) mod windows_impl {
    use super::*;
    use std::io::Read;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::ptr;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, DuplicateTokenEx, GetFileSecurityW, GetLengthSid,
        SecurityImpersonation, SetFileSecurityW, SetTokenInformation, TokenIntegrityLevel,
        TokenPrimary, WinLowLabelSid, ACL, LABEL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES, TOKEN_ALL_ACCESS, TOKEN_MANDATORY_LABEL,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcessToken, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW,
        EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    use windows_sys::Win32::Security::{
        TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_QUERY,
    };

    // The integrity-label attribute that flags a SID as the token's integrity
    // level (SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED = 0x20 | 0x40).
    const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;
    const SE_GROUP_INTEGRITY_ENABLED: u32 = 0x0000_0040;

    /// Convert a path to a NUL-terminated UTF-16 buffer for the *W APIs.
    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// A NUL-terminated wide string from a &str (for SDDL / command line).
    fn wide_str(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // ── RAII wrappers ───────────────────────────────────────────────────

    /// Owns a Win32 HANDLE, closing it on Drop. Used for the token, the pipe
    /// ends we keep, the process/thread handles, and the Job.
    struct OwnedHandle(HANDLE);
    impl OwnedHandle {
        fn new(h: HANDLE) -> Option<Self> {
            if h.is_null() || h == INVALID_HANDLE_VALUE {
                None
            } else {
                Some(OwnedHandle(h))
            }
        }
        fn raw(&self) -> HANDLE {
            self.0
        }
    }
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: self.0 is a live handle we own, closed exactly once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// A transient LOW label we applied to ONE dir and will REMOVE on Drop
    /// (RAII). Only the **workspace** dir gets one of these — its label is the
    /// user's live project and must not linger. The cache/temp roots are
    /// provisioned-once (see `ensure_label_low`'s `transient=false` path) and
    /// intentionally NOT restored: a LOW label only GRANTS low-IL write, it
    /// removes no one's access, so leaving it is safe and lets the next command
    /// skip re-labeling (the slow part). `path_w` is the dir; the restore removes
    /// the SACL via the object-only `SetFileSecurityW` (NO recursive walk).
    struct LabelRestore {
        path_w: Vec<u16>,
    }
    fn clear_integrity_label(path_w: &[u16], warn: bool) {
        let empty = wide_str("S:");
        let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        let parsed = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                empty.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                ptr::null_mut(),
            )
        };
        if parsed != 0 && !sd.is_null() {
            let ok = unsafe { SetFileSecurityW(path_w.as_ptr(), LABEL_SECURITY_INFORMATION, sd) };
            if warn && ok == 0 {
                eprintln!(
                    "[agent:sandbox] WARN failed to restore integrity label (err {})",
                    std::io::Error::last_os_error()
                );
            }
            unsafe {
                LocalFree(sd as *mut _);
            }
        }
    }
    impl Drop for LabelRestore {
        fn drop(&mut self) {
            clear_integrity_label(&self.path_w, true);
        }
    }

    /// Transient recursive MIC grant for pre-existing workspace files. Merely
    /// labeling the root does not retrofit inherited labels onto existing
    /// children, so a LOW process otherwise cannot edit a real project. Paths
    /// that were already LOW are preserved; labels introduced by the command on
    /// newly-created files are cleaned up in the final walk.
    struct WorkspaceTreeLabels {
        root: PathBuf,
        preserve_low: std::collections::HashSet<PathBuf>,
        restores: Vec<LabelRestore>,
        include_node_modules: bool,
    }

    impl Drop for WorkspaceTreeLabels {
        fn drop(&mut self) {
            if let Ok(mut paths) = workspace_label_paths(&self.root, self.include_node_modules) {
                paths.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
                for path in paths {
                    if self.preserve_low.contains(&path) {
                        continue;
                    }
                    let path_w = wide(&path);
                    if dir_is_low_labeled(&path_w) {
                        clear_integrity_label(&path_w, false);
                    }
                }
            }
            // The explicit guards are retained as a crash-safe fallback during
            // the run. After the full cleanup walk, dropping them is idempotent.
            self.restores.clear();
        }
    }

    fn workspace_label_paths(
        root: &Path,
        include_node_modules: bool,
    ) -> Result<Vec<PathBuf>, String> {
        let mut out = vec![root.to_path_buf()];
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir)
                .map_err(|e| format!("sandbox read_dir {}: {e}", dir.display()))?;
            for entry in entries {
                let entry = entry.map_err(|e| format!("sandbox directory entry: {e}"))?;
                let path = entry.path();
                let ty = entry
                    .file_type()
                    .map_err(|e| format!("sandbox file_type {}: {e}", path.display()))?;
                if ty.is_symlink() {
                    continue;
                }
                if ty.is_dir() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name == ".git"
                        || name == ".shugu"
                        || (!include_node_modules && name == "node_modules")
                    {
                        continue;
                    }
                    stack.push(path.clone());
                }
                out.push(path);
                if out.len() > 150_000 {
                    return Err("workspace trop volumineux pour armer le sandbox Auto".into());
                }
            }
        }
        Ok(out)
    }

    fn command_needs_dependency_writes(command: &str) -> bool {
        let lower = command.to_ascii_lowercase();
        [
            "pnpm add",
            "pnpm install",
            "pnpm update",
            "pnpm remove",
            "npm install",
            "npm update",
            "npm uninstall",
            "yarn add",
            "yarn install",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
    }

    fn label_workspace_tree(ws: &Path, command: &str) -> Option<WorkspaceTreeLabels> {
        let include_node_modules = command_needs_dependency_writes(command);
        let paths = match workspace_label_paths(ws, include_node_modules) {
            Ok(paths) => paths,
            Err(e) => {
                eprintln!("[agent:sandbox] WARN {e}");
                return None;
            }
        };
        let mut preserve_low = std::collections::HashSet::new();
        let mut restores = Vec::with_capacity(paths.len());
        for path in paths {
            let path_w = wide(&path);
            if let Some(rid) = integrity_rid(&path_w) {
                if rid == 0x0000_1000 {
                    preserve_low.insert(path);
                    continue;
                }
                if rid > 0x0000_2000 {
                    eprintln!(
                        "[agent:sandbox] WARN refusing to lower protected integrity label on {}",
                        path.display()
                    );
                    return None;
                }
            }
            match ensure_label_low(&path, true) {
                LabelOutcome::Transient(restore) => restores.push(restore),
                LabelOutcome::Provisioned => {
                    preserve_low.insert(path);
                }
                LabelOutcome::Failed => {
                    eprintln!(
                        "[agent:sandbox] WARN could not label workspace entry {}",
                        path.display()
                    );
                    return None;
                }
            }
        }
        Some(WorkspaceTreeLabels {
            root: ws.to_path_buf(),
            preserve_low,
            restores,
            include_node_modules,
        })
    }

    fn prepare_runtime_dirs(ws: &Path) -> Option<Vec<PathBuf>> {
        let allow = write_allowlist(ws, home_dir().as_deref());
        for dir in allow.iter().filter(|dir| dir.as_path() != ws) {
            if let Err(e) = std::fs::create_dir_all(dir) {
                eprintln!(
                    "[agent:sandbox] WARN create runtime dir {} failed: {e}",
                    dir.display()
                );
                return None;
            }
        }
        // Preserve Cargo registry/auth configuration without ever relabeling the
        // user's real ~/.cargo tree. Downloads and indexes go to the dedicated
        // CARGO_HOME after this one-time small-file seed.
        if let Some(home) = home_dir() {
            let source = home.join(".cargo");
            let dest = ws.join(".shugu").join("agent-runtime").join("cargo-home");
            for name in ["config", "config.toml", "credentials", "credentials.toml"] {
                let from = source.join(name);
                let to = dest.join(name);
                if from.is_file() && !to.exists() {
                    let _ = std::fs::copy(from, to);
                }
            }
        }
        Some(allow)
    }

    fn environment_block(ws: &Path) -> Vec<u16> {
        let runtime = ws.join(".shugu").join("agent-runtime");
        let mut vars: std::collections::BTreeMap<String, (String, String)> =
            std::collections::BTreeMap::new();
        for (key, value) in std::env::vars_os() {
            let key = key.to_string_lossy().into_owned();
            let value = value.to_string_lossy().into_owned();
            vars.insert(key.to_ascii_uppercase(), (key, value));
        }
        for (key, value) in [
            ("TEMP", runtime.join("temp")),
            ("TMP", runtime.join("temp")),
            ("CARGO_HOME", runtime.join("cargo-home")),
            ("CARGO_TARGET_DIR", runtime.join("cargo-target")),
            ("npm_config_cache", runtime.join("npm-cache")),
            ("npm_config_store_dir", runtime.join("pnpm-store")),
            ("XDG_CACHE_HOME", runtime.join("xdg-cache")),
            ("PIP_CACHE_DIR", runtime.join("pip-cache")),
        ] {
            vars.insert(
                key.to_ascii_uppercase(),
                (key.to_string(), value.to_string_lossy().into_owned()),
            );
        }
        let mut block = Vec::new();
        for (_, (key, value)) in vars {
            block.extend(format!("{key}={value}").encode_utf16());
            block.push(0);
        }
        block.push(0);
        block
    }

    // ── Step 1: a LOW-integrity primary token duplicated from ours ──────

    /// Duplicate the current process token and lower its integrity to LOW.
    /// Returns the new primary token on success. `None` (logged) on any failure.
    ///
    /// Lowering one's own integrity needs no privilege; the kernel forbids
    /// RAISING it, which is exactly the property we rely on (the child can't
    /// climb back to MEDIUM).
    fn make_low_token() -> Option<OwnedHandle> {
        unsafe {
            // 1a. Open our own primary token with the rights DuplicateTokenEx +
            // the later SetTokenInformation need.
            let mut cur_token: HANDLE = ptr::null_mut();
            // SAFETY: GetCurrentProcess is a pseudo-handle (no close needed).
            if OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
                &mut cur_token,
            ) == 0
            {
                eprintln!("[agent:sandbox] WARN OpenProcessToken failed — running unconfined.");
                return None;
            }
            let _cur = OwnedHandle::new(cur_token)?;

            // 1b. Duplicate it as a PRIMARY token we can assign to a new process.
            let mut new_token: HANDLE = ptr::null_mut();
            // SAFETY: cur_token is valid; out-param receives a new token handle.
            let ok = DuplicateTokenEx(
                _cur.raw(),
                TOKEN_ALL_ACCESS,
                ptr::null(),
                SecurityImpersonation,
                TokenPrimary,
                &mut new_token,
            );
            if ok == 0 {
                eprintln!("[agent:sandbox] WARN DuplicateTokenEx failed — running unconfined.");
                return None;
            }
            let dup = OwnedHandle::new(new_token)?;

            // 1c. Build the LOW integrity SID (S-1-16-4096) via CreateWellKnownSid.
            let mut sid_len: u32 = 0;
            // First call sizes the buffer (returns 0 / ERROR_INSUFFICIENT_BUFFER).
            CreateWellKnownSid(
                WinLowLabelSid,
                ptr::null_mut(),
                ptr::null_mut(),
                &mut sid_len,
            );
            if sid_len == 0 {
                eprintln!("[agent:sandbox] WARN CreateWellKnownSid sizing failed — unconfined.");
                return None;
            }
            let mut sid_buf = vec![0u8; sid_len as usize];
            // SAFETY: sid_buf is sized exactly per the previous call.
            if CreateWellKnownSid(
                WinLowLabelSid,
                ptr::null_mut(),
                sid_buf.as_mut_ptr() as PSID,
                &mut sid_len,
            ) == 0
            {
                eprintln!("[agent:sandbox] WARN CreateWellKnownSid failed — unconfined.");
                return None;
            }

            // 1d. SetTokenInformation(TokenIntegrityLevel) to drop the dup token
            // to LOW. TOKEN_MANDATORY_LABEL points at our SID buffer (kept alive
            // for the duration of this call).
            let mut label = TOKEN_MANDATORY_LABEL {
                Label: SID_AND_ATTRIBUTES {
                    Sid: sid_buf.as_mut_ptr() as PSID,
                    Attributes: SE_GROUP_INTEGRITY | SE_GROUP_INTEGRITY_ENABLED,
                },
            };
            // SAFETY: label is a fully-initialized TOKEN_MANDATORY_LABEL; its
            // size is the struct size; dup is a valid primary token with
            // ADJUST_DEFAULT rights.
            if SetTokenInformation(
                dup.raw(),
                TokenIntegrityLevel,
                &mut label as *mut _ as *const core::ffi::c_void,
                std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32
                    + GetLengthSid(sid_buf.as_mut_ptr() as PSID),
            ) == 0
            {
                eprintln!(
                    "[agent:sandbox] WARN SetTokenInformation(IntegrityLevel=LOW) failed — \
                     running unconfined."
                );
                return None;
            }

            Some(dup)
        }
    }

    // ── Step 2: stamp a LOW mandatory label on each allowlist dir ───────

    /// Result of trying to make `dir` writable to the LOW child.
    enum LabelOutcome {
        /// We just applied a transient LOW label that must be removed on Drop
        /// (the workspace). Carries its restore guard.
        Transient(LabelRestore),
        /// The dir is already LOW (we skipped — fast path) OR we applied a
        /// persistent LOW label we intentionally leave in place (caches/temp).
        /// Nothing to restore.
        Provisioned,
        /// Could not label it (missing dir / ACL failure). The dir just won't be
        /// writable by the confined child; confinement is still correct.
        Failed,
    }

    /// Ensure `dir` carries a LOW mandatory label so the LOW child may write it.
    ///
    /// PERFORMANCE: uses the object-only `Get/SetFileSecurityW` (NOT
    /// `SetNamedSecurityInfoW`, which recursively re-stamps every existing child
    /// — that turned a `~\.cargo` + `~\.rustup` label into a multi-minute walk).
    /// The OICI (inherit) flag on the directory's own ACE is enough: files the
    /// LOW child CREATES inherit the label at creation time, so writes succeed
    /// without touching the tens of thousands of pre-existing cache files.
    ///
    /// IDEMPOTENT: if the dir is already LOW (carries our label from a prior
    /// command), we skip the apply entirely (`Provisioned`) — the common case
    /// after the first run, making per-command overhead ~one Get per dir.
    ///
    /// `transient` = true only for the workspace: its label is removed on Drop.
    /// Caches/temp are provisioned-once and left labeled (a LOW label only GRANTS
    /// low-IL write — it removes no access — so leaving it is safe and keeps the
    /// dev loop fast).
    fn ensure_label_low(dir: &Path, transient: bool) -> LabelOutcome {
        if !dir.exists() {
            return LabelOutcome::Failed;
        }
        let path_w = wide(dir);

        // 2a. Fast path: is it ALREADY low-labeled? Read the object's own SACL
        // (object-only, cheap) and check for a mandatory-label ACE at LOW.
        if dir_is_low_labeled(&path_w) {
            return LabelOutcome::Provisioned;
        }

        // 2b. Build the LOW-label SD from SDDL. `S:(ML;OICI;NW;;;LW)`:
        //   ML  = SYSTEM_MANDATORY_LABEL_ACE
        //   OICI= OBJECT_INHERIT | CONTAINER_INHERIT (new files + subdirs inherit)
        //   NW  = SYSTEM_MANDATORY_LABEL_NO_WRITE_UP (the policy)
        //   LW  = Low integrity level SID (S-1-16-4096)
        let sddl = wide_str("S:(ML;OICI;NW;;;LW)");
        let mut new_sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: sddl is a valid NUL-terminated SDDL; out-param gets a LocalAlloc'd SD.
        let parsed = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut new_sd,
                ptr::null_mut(),
            )
        };
        if parsed == 0 || new_sd.is_null() {
            eprintln!(
                "[agent:sandbox] WARN parsing LOW-label SDDL failed for {} — skipping.",
                dir.display()
            );
            return LabelOutcome::Failed;
        }

        // 2c. Apply to the OBJECT ONLY (no child walk).
        // SAFETY: path_w NUL-terminated; new_sd is a valid SD from the parser.
        let applied =
            unsafe { SetFileSecurityW(path_w.as_ptr(), LABEL_SECURITY_INFORMATION, new_sd) };
        // SAFETY: new_sd was LocalAlloc'd by the parser; freed once here (the
        // apply copied what it needs).
        unsafe {
            LocalFree(new_sd as *mut _);
        }
        if applied == 0 {
            eprintln!(
                "[agent:sandbox] WARN applying LOW label failed (err {}) for {} — skipping \
                 (that dir won't be writable by the confined child).",
                std::io::Error::last_os_error(),
                dir.display()
            );
            return LabelOutcome::Failed;
        }

        if transient {
            LabelOutcome::Transient(LabelRestore { path_w })
        } else {
            LabelOutcome::Provisioned
        }
    }

    /// Does `dir` already carry a mandatory label at LOW integrity? Reads the
    /// object's own label SACL via the object-only `GetFileSecurityW` and checks
    /// the first mandatory-label ACE's SID for the LOW RID (4096). On any read
    /// failure → `false` (we'll just (re)apply — correctness over a micro-opt).
    fn integrity_rid(path_w: &[u16]) -> Option<u32> {
        unsafe {
            // Size the buffer.
            let mut needed: u32 = 0;
            GetFileSecurityW(
                path_w.as_ptr(),
                LABEL_SECURITY_INFORMATION,
                ptr::null_mut(),
                0,
                &mut needed,
            );
            if needed == 0 {
                return None;
            }
            let mut buf = vec![0u8; needed as usize];
            if GetFileSecurityW(
                path_w.as_ptr(),
                LABEL_SECURITY_INFORMATION,
                buf.as_mut_ptr() as PSECURITY_DESCRIPTOR,
                needed,
                &mut needed,
            ) == 0
            {
                return None;
            }
            // Pull the SACL out of the (self-relative) SD.
            let mut present: i32 = 0;
            let mut defaulted: i32 = 0;
            let mut sacl: *mut ACL = ptr::null_mut();
            if windows_sys::Win32::Security::GetSecurityDescriptorSacl(
                buf.as_mut_ptr() as PSECURITY_DESCRIPTOR,
                &mut present,
                &mut sacl,
                &mut defaulted,
            ) == 0
                || present == 0
                || sacl.is_null()
            {
                return None;
            }
            // The mandatory-label ACE is the first (only) ACE; its SID's last
            // sub-authority is the integrity RID. LOW = 0x1000 (4096). We read
            // the ACE generically: an ACE header followed by an access mask then
            // the SID. Rather than model every ACE struct, use the documented
            // SYSTEM_MANDATORY_LABEL_ACE layout: { ACE_HEADER(4) , ACCESS_MASK(4) ,
            // SID }. The SID's sub-authority count + sub-authorities follow the
            // 8-byte revision/identifier-authority preamble.
            let acl = &*(sacl as *const ACL);
            if acl.AceCount == 0 {
                return None;
            }
            // First ACE sits immediately after the ACL header.
            let ace_ptr = (sacl as *const u8).add(std::mem::size_of::<ACL>());
            // SYSTEM_MANDATORY_LABEL_ACE: ACE_HEADER (4 bytes) + ACCESS_MASK (4) →
            // SID starts at offset 8.
            let sid_ptr = ace_ptr.add(8);
            // SID layout: Revision(1) SubAuthorityCount(1) IdentifierAuthority(6)
            // SubAuthority[count] (4 bytes each). Integrity RID is the last sub.
            let sub_count = *sid_ptr.add(1);
            if sub_count == 0 {
                return None;
            }
            let last_sub_off = 8 + (sub_count as usize - 1) * 4;
            let rid = (sid_ptr.add(last_sub_off) as *const u32).read_unaligned();
            Some(rid)
        }
    }

    fn dir_is_low_labeled(path_w: &[u16]) -> bool {
        integrity_rid(path_w) == Some(0x0000_1000)
    }

    // ── Job object (tree-kill on timeout / drop), mirrors exec.rs ───────

    fn create_job() -> Option<OwnedHandle> {
        // SAFETY: null attrs + null name → new unnamed job, or null on failure.
        let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        let job = OwnedHandle::new(job)?;
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: info is fully-initialized; class matches the struct.
        let ok = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return None;
        }
        Some(job)
    }

    // ── Step 3: the confined spawn (CreateProcessAsUserW + manual pipes) ─

    /// Run `command` confined. Returns `Some(outcome)` if it actually ran under
    /// the low-IL token, `None` to signal the caller to use its direct path.
    pub(super) fn run_confined(
        ws: &Path,
        command: &str,
        timeout_secs: u64,
        output_cap: usize,
        cancelled: Option<&std::sync::atomic::AtomicBool>,
    ) -> Option<ConfinedOutcome> {
        // 3a. Build the LOW token. If this fails, bail to the direct path.
        let token = make_low_token()?;

        // 3b. Label the write-allowlist dirs LOW. Hold the restores for the whole
        // run (Drop restores them). We label whatever exists; the workspace MUST
        // be writable, so if labeling the workspace itself fails we bail (the
        // command would fail spuriously otherwise — a worse outcome than the
        // unconfined direct path).
        let allow = prepare_runtime_dirs(ws)?;
        let mut restores: Vec<LabelRestore> = Vec::new();
        let workspace_labels = label_workspace_tree(ws, command)?;
        let workspace_labeled = true;
        for dir in &allow {
            if dir == ws {
                continue;
            }
            // The workspace label is TRANSIENT (removed on Drop — it's the user's
            // live project). Cache/temp roots are PROVISIONED (labeled once, left
            // in place; re-labeling is skipped on later commands → fast loop).
            let transient = dir == ws;
            match ensure_label_low(dir, transient) {
                LabelOutcome::Transient(r) => restores.push(r),
                LabelOutcome::Provisioned => {}
                LabelOutcome::Failed => {}
            }
        }
        if !workspace_labeled {
            eprintln!(
                "[agent:sandbox] WARN could not LOW-label the workspace {} — a confined child \
                 could not write its own project; falling back to direct spawn.",
                ws.display()
            );
            // `restores` Drop here restores any dirs we did label. Then bail.
            return None;
        }

        // 3c. Create the Job object up front (tree-kill).
        let job = create_job();

        // 3d. Inheritable pipes for stdout/stderr; stdin = null (we feed none).
        let mut sa: SECURITY_ATTRIBUTES = unsafe { std::mem::zeroed() };
        sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
        sa.bInheritHandle = 1; // pipe ends must be inheritable by the child

        let (out_read, out_write) = make_pipe(&sa)?;
        let (err_read, err_write) = make_pipe(&sa)?;

        // The READ ends must NOT be inherited by the child (only the parent
        // reads them); clear their inherit flag.
        clear_inherit(out_read.raw());
        clear_inherit(err_read.raw());

        // 3e. STARTUPINFOEX with std handles wired + (optionally) the Job in a
        // proc-thread attribute list so the child joins the job atomically at
        // creation (closes the assign race; falls back to post-spawn assign if
        // the attr list can't be built).
        let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        // stdin null → the child sees an empty/closed stdin (matches Stdio::null).
        si.StartupInfo.hStdInput = ptr::null_mut();
        si.StartupInfo.hStdOutput = out_write.raw();
        si.StartupInfo.hStdError = err_write.raw();

        // Build the proc-thread attribute list carrying the Job handle.
        let mut attr_buf: Vec<u8> = Vec::new();
        let mut job_handles: [HANDLE; 1] = [ptr::null_mut()];
        let mut have_attr_list = false;
        if let Some(ref j) = job {
            job_handles[0] = j.raw();
            if let Some(buf) = build_job_attr_list(&job_handles) {
                attr_buf = buf;
                si.lpAttributeList = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
                have_attr_list = true;
            }
        }

        // 3f. Command line: `cmd /d /s /c <command>`. CreateProcess* mutates the
        // command-line buffer in place, so it must be a writable Vec<u16>.
        // /d skips the user's cmd.exe AutoRun, /s keeps quote handling sane.
        let cmdline = format!("cmd /d /s /c {command}");
        let mut cmdline_w = wide_str(&cmdline);
        let cwd_w = wide(ws);
        let mut env_block = environment_block(ws);

        let creation_flags = CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | 0x0000_0400; // CREATE_UNICODE_ENVIRONMENT

        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

        // SAFETY: token is a valid primary token; cmdline_w is a writable,
        // NUL-terminated buffer; si is a valid STARTUPINFOEXW (size in cb);
        // bInheritHandles=TRUE so the child inherits the pipe write ends; cwd_w
        // NUL-terminated. On success pi.hProcess / pi.hThread are live handles.
        let spawned = unsafe {
            CreateProcessAsUserW(
                token.raw(),
                ptr::null(),
                cmdline_w.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1, // bInheritHandles
                creation_flags,
                env_block.as_mut_ptr() as *mut core::ffi::c_void,
                cwd_w.as_ptr(),
                &si.StartupInfo,
                &mut pi,
            )
        };

        // The attribute list is consumed by CreateProcess; clean it up now.
        if have_attr_list {
            // SAFETY: attr_buf was initialized by InitializeProcThreadAttributeList.
            unsafe {
                DeleteProcThreadAttributeList(attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST);
            }
        }

        if spawned == 0 {
            let err = std::io::Error::last_os_error();
            eprintln!(
                "[agent:sandbox] WARN CreateProcessAsUserW failed ({err}) — falling back to \
                 direct spawn."
            );
            // restores Drop → labels restored; pipes Drop → closed. Bail.
            return None;
        }

        let proc = OwnedHandle::new(pi.hProcess);
        let thread = OwnedHandle::new(pi.hThread);

        // If the attr-list job-join wasn't used, assign post-spawn (best-effort).
        if !have_attr_list {
            if let (Some(ref j), Some(ref p)) = (&job, &proc) {
                // SAFETY: both handles are live; assignment is idempotent.
                unsafe {
                    AssignProcessToJobObject(j.raw(), p.raw());
                }
            }
        }

        // 3g. Drop OUR copy of the child's stdio WRITE ends so the read ends see
        // EOF when the child exits (otherwise the drain threads block forever).
        drop(out_write);
        drop(err_write);

        // 3h. Drain stdout/stderr on threads (identical contract to exec.rs):
        // read everything so the child never blocks on a full pipe; cap at join.
        let out_file = unsafe { std::fs::File::from_raw_handle(out_read.raw() as *mut _) };
        let err_file = unsafe { std::fs::File::from_raw_handle(err_read.raw() as *mut _) };
        // from_raw_handle takes ownership of the handle; prevent the OwnedHandle
        // Drop from double-closing it.
        std::mem::forget(out_read);
        std::mem::forget(err_read);

        let out_handle = spawn_reader(out_file);
        let err_handle = spawn_reader(err_file);

        // 3i. Poll for exit with a wall-clock deadline; on timeout, kill the
        // whole tree (Job terminate) and the direct child as a fallback.
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        let mut timed_out = false;
        let exit_code: i32 = loop {
            let Some(ref p) = proc else {
                break -1;
            };
            // SAFETY: p.raw() is a live process handle; 0 ms = poll, no wait.
            let wait = unsafe { WaitForSingleObject(p.raw(), 0) };
            if wait == WAIT_OBJECT_0 {
                let mut code: u32 = 0;
                // SAFETY: live handle; out-param valid.
                unsafe {
                    GetExitCodeProcess(p.raw(), &mut code);
                }
                break code as i32;
            }
            if cancelled.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::SeqCst)) {
                if let Some(ref j) = job {
                    unsafe {
                        TerminateJobObject(j.raw(), 1);
                    }
                }
                unsafe {
                    TerminateProcess(p.raw(), 1);
                }
                break 130;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                if let Some(ref j) = job {
                    // SAFETY: live job handle — terminate the whole tree.
                    unsafe {
                        TerminateJobObject(j.raw(), 1);
                    }
                }
                // SAFETY: live process handle — belt-and-braces direct kill.
                unsafe {
                    TerminateProcess(p.raw(), 1);
                }
                break 124; // coreutils `timeout` convention
            }
            std::thread::sleep(Duration::from_millis(50));
        };

        let stdout = join_reader(out_handle, output_cap);
        let stderr = join_reader(err_handle, output_cap);

        // proc / thread / job / token / restores all Drop here:
        //   * dropping the Job handle (KILL_ON_JOB_CLOSE) reaps any straggler,
        //   * dropping `restores` puts the original integrity labels back,
        //   * dropping the token / handles closes them.
        drop(thread);
        drop(proc);
        drop(job);
        drop(workspace_labels);
        // restores + token dropped at scope end.
        let _ = restores;
        let _ = token;

        Some(ConfinedOutcome {
            exit_code,
            stdout,
            stderr,
            timed_out,
        })
    }

    /// Create an anonymous pipe (read, write). Both ends inheritable per `sa`.
    fn make_pipe(sa: &SECURITY_ATTRIBUTES) -> Option<(OwnedHandle, OwnedHandle)> {
        let mut read: HANDLE = ptr::null_mut();
        let mut write: HANDLE = ptr::null_mut();
        // SAFETY: out-params valid; sa is a valid SECURITY_ATTRIBUTES.
        let ok = unsafe { CreatePipe(&mut read, &mut write, sa, 0) };
        if ok == 0 {
            eprintln!("[agent:sandbox] WARN CreatePipe failed — falling back to direct spawn.");
            return None;
        }
        Some((OwnedHandle::new(read)?, OwnedHandle::new(write)?))
    }

    /// Clear the inherit flag on a handle (the parent-only read ends).
    fn clear_inherit(h: HANDLE) {
        use windows_sys::Win32::Foundation::SetHandleInformation;
        // SAFETY: h is a live handle; clearing HANDLE_FLAG_INHERIT is safe.
        unsafe {
            SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0);
        }
    }

    /// Build a PROC_THREAD_ATTRIBUTE_LIST carrying the Job handle(s) so the child
    /// joins the job at creation. Returns the backing buffer (kept alive by the
    /// caller until after CreateProcess). `None` on any failure → caller assigns
    /// the job post-spawn instead.

    // ── P6.9 — spawn confiné PERSISTANT (sessions shell + processus d'arrière-
    // plan). Même confinement que `run_confined` (token LOW, allowlist MIC,
    // Job Object), mais SANS attente : le parent garde stdin/stdout/stderr et
    // le handle. L'appelant (processes.rs) possède le cycle de vie.
    // ─────────────────────────────────────────────────────────────────────

    /// Handle d'un shell confiné : possède le Job, le processus et les labels
    /// MIC (nettoyés au drop). `terminate` tue tout l'arbre.
    pub(crate) struct ConfinedShellHandle {
        pid: u32,
        job: Option<OwnedHandle>,
        proc: Option<OwnedHandle>,
        /// Labels MIC transitoires du workspace — restaurés à la mort du shell.
        _workspace_labels: WorkspaceTreeLabels,
        /// Labels MIC des dossiers runtime (provisionnés/transitoires).
        _restores: Vec<LabelRestore>,
        _token: OwnedHandle,
    }

    impl ConfinedShellHandle {
        pub(crate) fn pid(&self) -> u32 {
            self.pid
        }
        pub(crate) fn terminate(&self) {
            use windows_sys::Win32::System::Threading::TerminateProcess;
            if let Some(ref j) = self.job {
                // SAFETY: live job handle — kill the whole tree.
                unsafe { TerminateJobObject(j.raw(), 1) };
            }
            if let Some(ref p) = self.proc {
                // SAFETY: live process handle — belt-and-braces.
                unsafe { TerminateProcess(p.raw(), 1) };
            }
        }
        pub(crate) fn exited(&self) -> Option<i32> {
            use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
            let p = self.proc.as_ref()?;
            // SAFETY: live process handle; 0 ms = poll.
            let wait = unsafe { WaitForSingleObject(p.raw(), 0) };
            if wait != WAIT_OBJECT_0 {
                return None;
            }
            let mut code: u32 = 0;
            // SAFETY: live handle; out-param valid.
            unsafe {
                GetExitCodeProcess(p.raw(), &mut code);
            }
            Some(code as i32)
        }
    }

    /// Un shell confiné fraîchement spawné (pipes détenues par le parent).
    pub(super) struct ConfinedShell {
        pub handle: ConfinedShellHandle,
        pub stdin: std::fs::File,
        pub stdout: std::fs::File,
        pub stderr: std::fs::File,
    }

    // Les HANDLEs Win32 sont des handles kernel valables process-wide : les
    // déplacer vers le thread propriétaire de la session est sûr (lecture des
    // pipes et TerminateJobObject/TerminateProcess sont thread-safe).
    unsafe impl Send for ConfinedShellHandle {}
    unsafe impl Sync for ConfinedShellHandle {}

    /// Spawn confiné sans attente. `cmdline` est la ligne complète
    /// (`cmd /d /q /k` pour une session, `cmd /d /s /c <command>` pour un
    /// détaché). Retourne `None` si le sandbox ne peut pas s'armer (l'appelant
    /// décide alors — fail-closed en Auto pour run_command, erreur propre
    /// pour les sessions/background).
    fn spawn_confined_noblock(ws: &Path, cmdline: &str) -> Option<ConfinedShell> {
        let token = make_low_token()?;
        let allow = prepare_runtime_dirs(ws)?;
        let mut restores: Vec<LabelRestore> = Vec::new();
        let workspace_labels = label_workspace_tree(ws, cmdline)?;
        for dir in &allow {
            if dir == ws {
                continue;
            }
            let transient = dir == ws;
            match ensure_label_low(dir, transient) {
                LabelOutcome::Transient(r) => restores.push(r),
                LabelOutcome::Provisioned => {}
                LabelOutcome::Failed => {}
            }
        }
        let job = create_job();

        let mut sa: SECURITY_ATTRIBUTES = unsafe { std::mem::zeroed() };
        sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
        sa.bInheritHandle = 1;

        // stdin : l'enfant LIT (hStdInput = read end), le parent ÉCRIT.
        let (in_read, in_write) = make_pipe(&sa)?;
        clear_inherit(in_write.raw());
        let (out_read, out_write) = make_pipe(&sa)?;
        let (err_read, err_write) = make_pipe(&sa)?;
        clear_inherit(out_read.raw());
        clear_inherit(err_read.raw());

        let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = in_read.raw();
        si.StartupInfo.hStdOutput = out_write.raw();
        si.StartupInfo.hStdError = err_write.raw();

        let mut attr_buf: Vec<u8> = Vec::new();
        let mut job_handles: [HANDLE; 1] = [ptr::null_mut()];
        let mut have_attr_list = false;
        if let Some(ref j) = job {
            job_handles[0] = j.raw();
            if let Some(buf) = build_job_attr_list(&job_handles) {
                attr_buf = buf;
                si.lpAttributeList = attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
                have_attr_list = true;
            }
        }

        let mut cmdline_w = wide_str(cmdline);
        let cwd_w = wide(ws);
        let mut env_block = environment_block(ws);
        let creation_flags = CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | 0x0000_0400; // UNICODE env
        let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

        // SAFETY: same contract as run_confined's CreateProcessAsUserW call.
        let spawned = unsafe {
            CreateProcessAsUserW(
                token.raw(),
                ptr::null(),
                cmdline_w.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                creation_flags,
                env_block.as_mut_ptr() as *mut core::ffi::c_void,
                cwd_w.as_ptr(),
                &si.StartupInfo,
                &mut pi,
            )
        };
        if have_attr_list {
            // SAFETY: attr_buf was initialized by InitializeProcThreadAttributeList.
            unsafe {
                DeleteProcThreadAttributeList(attr_buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST);
            }
        }
        if spawned == 0 {
            let err = std::io::Error::last_os_error();
            eprintln!("[agent:sandbox] WARN confined no-block spawn failed ({err})");
            return None;
        }
        let proc = OwnedHandle::new(pi.hProcess);
        let _thread = OwnedHandle::new(pi.hThread);
        if !have_attr_list {
            if let (Some(ref j), Some(ref p)) = (&job, &proc) {
                // SAFETY: both handles are live; assignment is idempotent.
                unsafe {
                    AssignProcessToJobObject(j.raw(), p.raw());
                }
            }
        }
        let pid = pi.dwProcessId;

        // Le parent garde : write-end de stdin, read-ends de stdout/stderr.
        // Les extrémités de l'enfant sont droppées (sinon jamais d'EOF).
        drop(in_read);
        drop(out_write);
        drop(err_write);

        let stdin_file = unsafe { std::fs::File::from_raw_handle(in_write.raw() as *mut _) };
        let out_file = unsafe { std::fs::File::from_raw_handle(out_read.raw() as *mut _) };
        let err_file = unsafe { std::fs::File::from_raw_handle(err_read.raw() as *mut _) };
        std::mem::forget(in_write);
        std::mem::forget(out_read);
        std::mem::forget(err_read);

        Some(ConfinedShell {
            handle: ConfinedShellHandle {
                pid,
                job,
                proc,
                _workspace_labels: workspace_labels,
                _restores: restores,
                _token: token,
            },
            stdin: stdin_file,
            stdout: out_file,
            stderr: err_file,
        })
    }

    /// Session shell persistante confinée (`cmd /d /q /k` — /d skip AutoRun,
    /// /q pas d'écho, /k reste ouvert).
    pub(super) fn spawn_shell(ws: &Path) -> Option<ConfinedShell> {
        spawn_confined_noblock(ws, "cmd /d /q /k")
    }

    /// Processus d'arrière-plan confiné (`cmd /d /s /c <command>`).
    pub(super) fn spawn_detached(ws: &Path, command: &str) -> Option<ConfinedShell> {
        spawn_confined_noblock(ws, &format!("cmd /d /s /c {command}"))
    }

    fn build_job_attr_list(jobs: &[HANDLE; 1]) -> Option<Vec<u8>> {
        unsafe {
            // Size the list for 1 attribute.
            let mut size: usize = 0;
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
            if size == 0 {
                return None;
            }
            let mut buf = vec![0u8; size];
            let list = buf.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
                return None;
            }
            // PROC_THREAD_ATTRIBUTE_JOB_LIST takes an array of job handles.
            let ok = UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                jobs.as_ptr() as *const core::ffi::c_void,
                std::mem::size_of::<HANDLE>(),
                ptr::null_mut(),
                ptr::null(),
            );
            if ok == 0 {
                DeleteProcThreadAttributeList(list);
                return None;
            }
            Some(buf)
        }
    }

    /// Drain a child stream into a byte buffer on its own thread.
    fn spawn_reader(mut f: std::fs::File) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = f.read_to_end(&mut buf);
            buf
        })
    }

    /// Join a reader thread and turn its bytes into a capped UTF-8 string.
    fn join_reader(h: std::thread::JoinHandle<Vec<u8>>, cap: usize) -> String {
        match h.join() {
            Ok(bytes) => cap_utf8(&String::from_utf8_lossy(&bytes), cap),
            Err(_) => String::new(),
        }
    }

    /// Same capping policy as exec.rs::truncate, parameterized by `cap`.
    fn cap_utf8(s: &str, cap: usize) -> String {
        if s.len() <= cap {
            return s.to_string();
        }
        let mut end = cap;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n[... tronqué à {cap} octets ...]", &s[..end])
    }
}

// ════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── activation / disable env ────────────────────────────────────────

    #[test]
    fn disable_env_defaults_off() {
        // Save & clear so we test the default (unset) state deterministically.
        let prev = std::env::var(DISABLE_ENV).ok();
        std::env::remove_var(DISABLE_ENV);
        assert!(!should_disable(), "unset → sandbox stays ON");

        std::env::set_var(DISABLE_ENV, "1");
        assert!(should_disable(), "1 → disabled");
        std::env::set_var(DISABLE_ENV, "true");
        assert!(should_disable(), "true → disabled");
        std::env::set_var(DISABLE_ENV, "0");
        assert!(!should_disable(), "0 → stays ON");
        std::env::set_var(DISABLE_ENV, "banana");
        assert!(
            !should_disable(),
            "unknown → stays ON (never accidentally OFF)"
        );

        // restore
        match prev {
            Some(v) => std::env::set_var(DISABLE_ENV, v),
            None => std::env::remove_var(DISABLE_ENV),
        }
    }

    // ── write-allowlist resolution (pure, no FFI) ───────────────────────

    #[test]
    fn allowlist_includes_workspace_temp_and_caches() {
        let ws = Path::new("C:\\proj\\app");
        let home = Path::new("C:\\Users\\tester");
        let allow = write_allowlist(ws, Some(home));
        assert!(allow.iter().any(|p| p == ws), "workspace must be writable");
        assert!(allow.iter().any(|p| p.ends_with("agent-runtime\\temp")));
        assert!(allow
            .iter()
            .any(|p| p.ends_with("agent-runtime\\cargo-home")));
        assert!(allow
            .iter()
            .any(|p| p.ends_with("agent-runtime\\pnpm-store")));
        assert!(!allow.contains(&home.join(".cargo")));
        assert!(!allow.contains(&std::env::temp_dir()));
    }

    #[test]
    fn allowlist_without_home_still_has_workspace_and_temp() {
        let ws = Path::new("C:\\proj\\app");
        let allow = write_allowlist(ws, None);
        assert!(allow.iter().any(|p| p == ws));
        assert!(allow.iter().all(|p| p.starts_with(ws)));
    }

    #[test]
    fn allowlist_is_deduped() {
        // No path should appear twice (env overrides colliding with defaults).
        let ws = Path::new("C:\\proj\\app");
        let home = Path::new("C:\\Users\\tester");
        let allow = write_allowlist(ws, Some(home));
        let mut sorted = allow.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), allow.len(), "allowlist must be deduped");
    }

    // ── the REAL confined-spawn integration test (Windows only) ─────────
    //
    // This SPAWNS a command under the sandbox and proves the three contract
    // properties: (a) out-of-allowlist write FAILS, (b) in-workspace write
    // SUCCEEDS, (c) reading a file outside the workspace SUCCEEDS. It restores
    // every label and cleans up its temp files. Runnable via plain `cargo test`
    // — no Tauri host needed.

    #[cfg(windows)]
    #[test]
    fn confined_spawn_enforces_write_jail_and_open_reads() {
        use std::fs;

        // Ensure the emergency disable isn't set in this process.
        let prev_disable = std::env::var(DISABLE_ENV).ok();
        std::env::remove_var(DISABLE_ENV);

        // Unique medium-integrity parent under the user profile. Creating the
        // existing file BEFORE sandbox setup proves Auto can modify real project
        // files, not merely create new files in an already-low temp tree.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let home = home_dir().expect("home dir for the test");
        let test_root = home.join(format!("shugu-sbx-it-{stamp}"));
        let ws = test_root.join("workspace");
        fs::create_dir_all(&ws).expect("create test workspace");
        let existing = ws.join("existing.txt");
        fs::write(&existing, "before").expect("seed existing medium file");

        // An OUT-OF-ALLOWLIST target: a sibling dir NOT under temp/workspace/
        // caches. Use the user profile root with a unique name. We must NOT be
        // able to write here from the confined child.
        let outside_file = test_root.join("outside.txt");
        // Make sure it doesn't pre-exist.
        let _ = fs::remove_file(&outside_file);

        // A READABLE file outside the workspace (we'll `type` it). Use this
        // crate's own Cargo.toml — guaranteed to exist and live outside `ws`.
        let readable = std::env::current_dir()
            .ok()
            .map(|d| d.join("Cargo.toml"))
            .filter(|p| p.exists())
            // Fallback: any file that surely exists outside ws.
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
                    .join("win.ini")
            });

        // ── (b) write INSIDE the workspace → must SUCCEED ──────────────
        let in_ws_name = "in_ws.txt";
        let cmd_b = format!("echo hello-ws> {in_ws_name}");
        let res_b = match run_confined(&ws, &cmd_b, 30, 8 * 1024) {
            ConfinedRun::Executed(outcome) => outcome,
            ConfinedRun::Unavailable { reason } => {
                panic!("sandbox should have run the in-workspace write: {reason}")
            }
        };
        let in_ws_path = ws.join(in_ws_name);
        assert!(
            in_ws_path.exists(),
            "(b) in-workspace write must create the file; exit={}, stderr={}",
            res_b.exit_code,
            res_b.stderr
        );

        // ── (b2) modify a PRE-EXISTING workspace file → must SUCCEED ──
        let cmd_b2 = "echo after> existing.txt";
        let res_b2 = match run_confined(&ws, cmd_b2, 30, 8 * 1024) {
            ConfinedRun::Executed(outcome) => outcome,
            ConfinedRun::Unavailable { reason } => {
                panic!("sandbox should edit an existing workspace file: {reason}")
            }
        };
        let existing_after = fs::read_to_string(&existing).unwrap_or_default();
        assert!(
            res_b2.exit_code == 0 && existing_after.contains("after"),
            "(b2) existing workspace files must be writable; exit={}, stderr={}, content={existing_after:?}",
            res_b2.exit_code,
            res_b2.stderr
        );

        // ── (a) write OUTSIDE the allowlist → must FAIL ────────────────
        // Redirect into the profile root. Under MIC-low this dir is MEDIUM, the
        // child is LOW → no-write-up → the create fails (non-zero exit and/or no
        // file).
        let cmd_a = format!("echo boom> \"{}\"", outside_file.display());
        let res_a = match run_confined(&ws, &cmd_a, 30, 8 * 1024) {
            ConfinedRun::Executed(outcome) => outcome,
            ConfinedRun::Unavailable { reason } => {
                panic!("sandbox should have run the out-of-allowlist write attempt: {reason}")
            }
        };
        let created_outside = outside_file.exists();
        // Clean up immediately if (against the contract) it got created, so a
        // failing assertion doesn't litter the profile.
        let _ = fs::remove_file(&outside_file);
        assert!(
            !created_outside,
            "(a) out-of-allowlist write MUST be blocked — but {} was created (exit={}, stderr={})",
            outside_file.display(),
            res_a.exit_code,
            res_a.stderr
        );

        // ── (c) READ a file outside the workspace → must SUCCEED ───────
        let cmd_c = format!("type \"{}\"", readable.display());
        let res_c = match run_confined(&ws, &cmd_c, 30, 8 * 1024) {
            ConfinedRun::Executed(outcome) => outcome,
            ConfinedRun::Unavailable { reason } => {
                panic!("sandbox should have run the outside-read: {reason}")
            }
        };
        assert_eq!(
            res_c.exit_code,
            0,
            "(c) reading {} outside the workspace must succeed (reads are open); stderr={}",
            readable.display(),
            res_c.stderr
        );
        assert!(
            !res_c.stdout.is_empty(),
            "(c) reading {} should produce content (reads open)",
            readable.display()
        );

        // ── cleanup: remove the workspace (label restored on Drop already) ──
        let _ = fs::remove_dir_all(&test_root);

        // restore disable env
        match prev_disable {
            Some(v) => std::env::set_var(DISABLE_ENV, v),
            None => std::env::remove_var(DISABLE_ENV),
        }
    }
}
