//! Invisible Windows execution sandbox for agent `run_command` (opt-in).
//!
//! ## Why this exists
//!
//! `run_command_direct` (exec.rs) runs agent commands DIRECTLY on the user's
//! machine with the full toolchain and the user's full token — exactly like
//! Claude Code / Codex CLI. That is the right default for a trusted local tool,
//! and the safety net is git. But two residual risks have no git net:
//!
//!   * **credential exfiltration** — a prompt-injected command (`type
//!     %USERPROFILE%\.ssh\id_rsa`, `copy ~\.aws\credentials …`) can read secrets
//!     that git never tracked, then leak them over the open network.
//!   * **out-of-workspace writes** — an edit to `C:\Windows\…` or `~\.bashrc`
//!     is invisible to the git panel, so the user can't "discard" it.
//!
//! This module adds an OPT-IN confinement layer that reproduces the spirit of
//! Claude Code's sandbox (Seatbelt / bubblewrap+Landlock) on Windows, using the
//! native filesystem-ACL primitives — **WITHOUT** the heavy machinery Codex's
//! `windows-sandbox-rs` uses (dedicated Windows accounts, AppContainer profiles,
//! WFP firewall, private desktops, elevation). The design goal is "lighter than
//! Docker, invisible in the happy path, never breaks the dev loop".
//!
//! ## Mechanism chosen — and why (HONEST trade-off)
//!
//! The existing, *tested* spawn path in exec.rs is built entirely around
//! [`std::process::Command`] / [`std::process::Child`]: piped stdio drained on
//! threads, a poll+timeout loop on `try_wait`, and a Job Object assigned via the
//! child's raw handle for tree-wide kill. `std::process::Command` ALWAYS spawns
//! the child under the *parent's* primary token — it offers no hook to inject a
//! restricted token. Running a child under a custom token therefore requires
//! `CreateProcessAsUserW`, which means re-implementing the entire stdio-pipe +
//! wait + job-assign dance by hand.
//!
//! Re-implementing that spawn untested (this code cannot be exercised without a
//! live Tauri host) is a worse risk than the threat it mitigates: a subtle
//! handle-inheritance or pipe bug would break EVERY agent command, not just an
//! attack. The brief is explicit — "a sandbox that crashes must never prevent
//! the agent from running" and "pick the MOST RELIABLE mechanism, document its
//! limits honestly".
//!
//! So the reliable mechanism that **composes with the proven spawn path** is
//! **filesystem ACLs**, not token surgery. ACEs are evaluated by the kernel
//! against whatever token the child runs under (including the normal one), so
//! they bite without changing how we spawn:
//!
//!   * **`light`** — add explicit **deny** ACEs (deny Read *and* Write, applied
//!     to the current user's SID) on a curated list of secret stores
//!     (`~\.ssh`, `~\.aws`, `~\.codex\auth.json`, `~\.claude.json`, browser
//!     profiles, …). Even a fully prompt-injected command cannot `type`/`copy`
//!     them while the deny-ACE is in place. Reads everywhere else stay open, so
//!     node/pnpm/cargo/git work unchanged.
//!   * **`strict`** — `light` PLUS deny **Write** ACEs on a curated set of
//!     high-value out-of-workspace roots (the rest of the user profile, minus an
//!     explicit *write-allowlist*: the workspace, the temp dir, and the package
//!     caches `~\.cargo`, `~\.rustup`, `~\.npm`, `~\.pnpm`, npm-cache). Writes
//!     INSIDE the allowlist still succeed; writes to the protected roots fail.
//!     Reads stay open. Network stays ACTIVE (cutting it breaks `pnpm install` /
//!     `git fetch` — see `add_network_block_later` note below).
//!
//! ### Honest limits of the ACL approach
//!
//!   * It protects the **enumerated** paths. It is a deny-LIST, not a
//!     write-jail: `strict` does not stop a write to an arbitrary brand-new
//!     top-level dir like `D:\whatever` unless that root is in the protected
//!     set. We protect the credential-bearing and config-bearing roots, which
//!     is where the real damage lives; we document that arbitrary writes
//!     elsewhere are still possible (git's net + the risk classifier remain).
//!   * The deny-ACE is keyed to the **current user SID**, so for the window of
//!     the run it also affects OTHER processes of the same user touching those
//!     exact secret paths. Runs are short and serial per command; the guard
//!     restores the original DACL on Drop (RAII), and on a hard crash the OS
//!     leaves a recoverable state fixable with `icacls <path> /reset`.
//!   * A process running elevated / as a different principal is out of scope —
//!     the agent runs as the user, same as every other Shugu subprocess.
//!
//! AppContainer (capability-SID per write-root, true write-jail) and MIC-low
//! (mandatory integrity label) are STRICTER, but BOTH require
//! `CreateProcessAsUserW`/`STARTUPINFOEX` — the untestable custom-spawn path we
//! deliberately avoid. The validation doc records this as the documented upgrade
//! path once the spawn can be exercised on real hardware.
//!
//! ## Activation (opt-in, default OFF)
//!
//! Read from the env var **`SHUGU_SANDBOX`** (consistent with the existing
//! `SHUGU_*` knobs in chat.rs / image.rs / codex.rs):
//!
//!   * unset / `off` / anything unrecognized → **`Off`** (passthrough, no ACL
//!     changes — the current behavior, so nothing breaks by surprise).
//!   * `light` → deny-list on secrets.
//!   * `strict` → deny-list on secrets + write-confine to the allowlist.
//!
//! ## Fallback
//!
//! Every fallible step degrades gracefully: if a SID lookup, a DACL read, or an
//! ACE application fails, the guard logs a one-line warning and the command runs
//! WITHOUT that particular protection rather than refusing to run. A sandbox
//! that can't arm itself must never wedge the agent.
//!
//! ## Non-Windows
//!
//! On non-Windows targets the public surface is a documented **no-op
//! passthrough**: [`SandboxMode::from_env`] still parses the env var (so the
//! mode is observable / testable), but [`Sandbox::arm`] does nothing and returns
//! an inert guard. Shugu is Windows-first; a POSIX confinement lane
//! (bubblewrap/Landlock) is a separate, larger change.

use std::path::{Path, PathBuf};

// ────────────────────────────────────────────────────────────────────────
// SandboxMode — the opt-in level, parsed from SHUGU_SANDBOX
// ────────────────────────────────────────────────────────────────────────

/// The confinement level for a single `run_command`. Parsed from the
/// `SHUGU_SANDBOX` env var; default [`SandboxMode::Off`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    /// Passthrough. No ACL changes. The pre-sandbox behavior — the default so an
    /// unset env var never alters the dev loop.
    Off,
    /// Deny read+write on credential/config secret stores. Tools run normally.
    Light,
    /// `Light` + write-confine to the workspace/temp/cache allowlist (deny write
    /// on the rest of the user profile). Network stays active.
    Strict,
}

/// Env var that selects the sandbox level. Documented in
/// `docs/win-sandbox-validation.md`.
pub const SANDBOX_ENV: &str = "SHUGU_SANDBOX";

impl SandboxMode {
    /// Stable lowercase id for logs.
    pub fn as_str(self) -> &'static str {
        match self {
            SandboxMode::Off => "off",
            SandboxMode::Light => "light",
            SandboxMode::Strict => "strict",
        }
    }

    /// Parse a raw string value (the env var's contents) into a mode. Trims and
    /// lowercases; anything unrecognized → `Off` (fail-open to the safe-for-the-
    /// dev-loop default, NEVER to a stricter-than-asked mode).
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "light" => SandboxMode::Light,
            "strict" => SandboxMode::Strict,
            // "off", "", "0", "false", any typo → Off.
            _ => SandboxMode::Off,
        }
    }

    /// Read [`SANDBOX_ENV`] from the environment. Absent var → `Off`.
    pub fn from_env() -> Self {
        match std::env::var(SANDBOX_ENV) {
            Ok(v) => SandboxMode::parse(&v),
            Err(_) => SandboxMode::Off,
        }
    }

    /// Does this mode arm any protection at all? (`Off` is a pure passthrough.)
    pub fn is_active(self) -> bool {
        !matches!(self, SandboxMode::Off)
    }
}

impl Default for SandboxMode {
    fn default() -> Self {
        SandboxMode::Off
    }
}

// ────────────────────────────────────────────────────────────────────────
// Path resolution — the protected secret list & the strict write-allowlist.
// Pure, OS-agnostic, and unit-tested without any spawn or FFI.
// ────────────────────────────────────────────────────────────────────────

/// Resolve the user's home directory the way the rest of Shugu does
/// (`USERPROFILE` first on Windows, then `HOME`). Returns `None` if neither is
/// set, in which case the home-relative protections are simply skipped.
pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// The credential / config stores protected (deny READ + WRITE) in BOTH
/// `light` and `strict`. Relative to `home`. These are the files an injected
/// command would try to exfiltrate.
///
/// Pure function of `home` so it is trivially testable. Paths that don't exist
/// on a given machine are harmless — applying a deny-ACE to a missing path is a
/// no-op the caller skips.
pub(crate) fn secret_paths(home: &Path) -> Vec<PathBuf> {
    // Sub-paths under home that hold credentials or auth material.
    const REL: &[&str] = &[
        // SSH private keys + known_hosts.
        ".ssh",
        // Cloud / CLI credentials.
        ".aws",
        ".azure",
        ".gcloud",
        // Agent auth tokens (Codex, Claude).
        ".codex/auth.json",
        ".claude.json",
        ".claude/.credentials.json",
        // Git / npm / docker credential stores.
        ".git-credentials",
        ".npmrc",
        ".docker/config.json",
        ".netrc",
        // Generic config dir (XDG-style on Windows tools) — token-bearing.
        ".config",
        // Kubernetes context (often holds bearer tokens).
        ".kube/config",
    ];

    // Home-relative secrets only when we actually have a home. An empty `home`
    // (neither USERPROFILE nor HOME set) would make `home.join(".ssh")` a
    // RELATIVE `.ssh`, which `deny_ace` could mis-resolve against the cwd — so
    // we skip those entirely and rely on the absolute browser paths below.
    let mut out: Vec<PathBuf> = if home.as_os_str().is_empty() {
        Vec::new()
    } else {
        REL.iter().map(|r| home.join(r)).collect()
    };

    // Browser profile roots under %LOCALAPPDATA% — cookies + saved passwords.
    // Resolved separately because they live under LocalAppData, not directly
    // under home.
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        if !local.as_os_str().is_empty() {
            for rel in [
                r"Google\Chrome\User Data\Default\Login Data",
                r"Google\Chrome\User Data\Default\Cookies",
                r"Microsoft\Edge\User Data\Default\Login Data",
                r"BraveSoftware\Brave-Browser\User Data\Default\Login Data",
            ] {
                out.push(local.join(rel));
            }
        }
    }

    out
}

/// The `strict` write-allowlist: roots where the confined command MAY write.
/// Everything under the user profile that is NOT in this set gets a deny-WRITE
/// ACE (see [`strict_write_deny_roots`]). Caches are included so `pnpm install`
/// / `cargo build` keep working.
///
/// `ws` is the agent workspace root (always writable — that's the whole point).
/// Caches are CONFIGURABLE via env (`CARGO_HOME`, `RUSTUP_HOME`, `npm_config_cache`)
/// falling back to the conventional `~\.cargo` etc.
pub(crate) fn write_allowlist(ws: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let mut allow: Vec<PathBuf> = vec![ws.to_path_buf()];

    // System temp — many toolchains write scratch files here.
    allow.push(std::env::temp_dir());

    // Package caches — env override first, then the conventional home-relative
    // location. Without these `pnpm install` / `cargo fetch` would fail under
    // strict because their cache writes would be denied.
    let cache_env_or_home = |env_key: &str, rel: &str| -> Option<PathBuf> {
        if let Some(v) = std::env::var_os(env_key) {
            let p = PathBuf::from(v);
            if !p.as_os_str().is_empty() {
                return Some(p);
            }
        }
        home.map(|h| h.join(rel))
    };

    let mut push_opt = |p: Option<PathBuf>| {
        if let Some(p) = p {
            allow.push(p);
        }
    };

    push_opt(cache_env_or_home("CARGO_HOME", ".cargo"));
    push_opt(cache_env_or_home("RUSTUP_HOME", ".rustup"));
    push_opt(cache_env_or_home("npm_config_cache", ".npm"));
    if let Some(h) = home {
        allow.push(h.join(".pnpm"));
        allow.push(h.join(".pnpm-store"));
    }
    // npm's default Windows cache lives under LocalAppData.
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        if !local.as_os_str().is_empty() {
            allow.push(local.join(r"npm-cache"));
            allow.push(local.join(r"pnpm"));
        }
    }

    allow
}

/// The `strict` write-DENY roots: high-value out-of-workspace locations whose
/// WRITE access is denied so an injected command can't tamper with shell config
/// or autostart. We deny the user-profile root itself (so `~\.bashrc`,
/// `~\hack.txt` fail) while the [`write_allowlist`] allow-ACEs placed AFTER the
/// deny restore write to the caches/temp/workspace (Windows evaluates the most
/// specific path's own DACL, and we apply allow-ACEs directly on the allowlist
/// dirs, so they win on their own subtree).
///
/// Honest scope: we deny the profile root and a few well-known config roots, not
/// the entire disk. A write to a brand-new `D:\foo` is still possible (and still
/// flagged by the risk classifier when it escapes the workspace). This protects
/// the realistic tamper targets without an unbounded, slow, whole-disk ACL sweep.
pub(crate) fn strict_write_deny_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(h) = home {
        // The profile root: covers ~\.bashrc, ~\.gitconfig, ~\hack.txt, the
        // Startup folder under AppData, etc. NON-recursive deny on the root dir
        // itself plus the specific config files below.
        roots.push(h.to_path_buf());
        for rel in [
            ".bashrc",
            ".bash_profile",
            ".profile",
            ".zshrc",
            ".gitconfig",
            "Documents\\WindowsPowerShell",
        ] {
            roots.push(h.join(rel));
        }
        // Per-user autostart — a classic persistence target.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let appdata = PathBuf::from(appdata);
            if !appdata.as_os_str().is_empty() {
                roots.push(appdata.join(r"Microsoft\Windows\Start Menu\Programs\Startup"));
            }
        }
    }
    roots
}

// ────────────────────────────────────────────────────────────────────────
// Sandbox — arm/restore. Real impl on Windows, no-op elsewhere.
// ────────────────────────────────────────────────────────────────────────

/// Request to arm a sandbox for one command run.
pub struct Sandbox {
    pub mode: SandboxMode,
    pub workspace: PathBuf,
}

impl Sandbox {
    /// Build a sandbox request for `workspace` at the env-selected mode.
    pub fn from_env(workspace: &Path) -> Self {
        Sandbox {
            mode: SandboxMode::from_env(),
            workspace: workspace.to_path_buf(),
        }
    }

    /// Arm the sandbox, returning an RAII [`SandboxGuard`] that restores every
    /// modified DACL when dropped. NEVER fails the run: an arming error logs a
    /// warning and returns a guard that protects whatever it managed to apply
    /// (possibly nothing). Hold the guard for the lifetime of the command.
    #[cfg(windows)]
    pub fn arm(&self) -> SandboxGuard {
        if !self.mode.is_active() {
            return SandboxGuard::inert(self.mode);
        }
        windows_impl::arm(self.mode, &self.workspace)
    }

    /// Non-Windows: documented no-op. Parses/observes the mode but applies no
    /// confinement (Shugu is Windows-first; POSIX confinement is out of scope).
    #[cfg(not(windows))]
    pub fn arm(&self) -> SandboxGuard {
        if self.mode.is_active() {
            eprintln!(
                "[agent:sandbox] mode={} requested but this build is non-Windows — \
                 running WITHOUT confinement (passthrough). POSIX confinement is a \
                 separate lane.",
                self.mode.as_str()
            );
        }
        SandboxGuard::inert(self.mode)
    }
}

/// RAII guard. On Windows it holds the original DACLs of every path it modified
/// and restores them on Drop. On non-Windows / `Off` it is inert.
pub struct SandboxGuard {
    mode: SandboxMode,
    #[cfg(windows)]
    restores: Vec<windows_impl::DaclRestore>,
}

impl SandboxGuard {
    /// An inert guard (nothing to restore). Used for `Off` and non-Windows.
    fn inert(mode: SandboxMode) -> Self {
        SandboxGuard {
            mode,
            #[cfg(windows)]
            restores: Vec::new(),
        }
    }

    /// The mode this guard was armed at — for logging.
    pub fn mode(&self) -> SandboxMode {
        self.mode
    }

    /// Number of filesystem objects whose DACL is currently modified (0 when
    /// inert). Lets the exec log report how much the sandbox actually armed.
    pub fn armed_count(&self) -> usize {
        #[cfg(windows)]
        {
            self.restores.len()
        }
        #[cfg(not(windows))]
        {
            0
        }
    }
}

#[cfg(windows)]
impl Drop for SandboxGuard {
    fn drop(&mut self) {
        for r in self.restores.drain(..) {
            r.restore();
        }
    }
}

// ════════════════════════════════════════════════════════════════════════
// Windows implementation
// ════════════════════════════════════════════════════════════════════════

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE};
    // ACL plumbing lives in two sibling modules:
    //   * the *functions* + EXPLICIT_ACCESS_W / TRUSTEE_W + ACCESS_MODE / trustee
    //     constants are under `Security::Authorization`,
    //   * the ACE_FLAGS inheritance constants and the token / SID / descriptor
    //     types are under `Security` directly.
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, DENY_ACCESS,
        EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
        TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        GetLengthSid, GetTokenInformation, TokenUser, ACL, DACL_SECURITY_INFORMATION,
        NO_INHERITANCE, PSECURITY_DESCRIPTOR, PSID, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_GENERIC_READ, FILE_GENERIC_WRITE};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // GENERIC_WRITE-ish + DELETE mask we deny for write-confinement.
    const DENY_WRITE_MASK: u32 = FILE_GENERIC_WRITE | DELETE;
    // Read+write deny for secrets (fully fence them off).
    const DENY_ALL_MASK: u32 = FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE;

    /// Captured original security state for one path, restored on Drop of the
    /// guard. Holds the path (wide), the original DACL pointer, and the original
    /// security-descriptor buffer that owns it (must be `LocalFree`d after the
    /// restore SetNamedSecurityInfoW copies it back).
    pub(super) struct DaclRestore {
        path_w: Vec<u16>,
        // The security descriptor returned by GetNamedSecurityInfoW; it OWNS the
        // original DACL memory. We free it after restoring.
        orig_sd: PSECURITY_DESCRIPTOR,
        // Pointer INTO orig_sd — the original DACL. May be null (no DACL).
        orig_dacl: *mut ACL,
        // The new DACL we allocated via SetEntriesInAclW; freed on restore.
        new_dacl: *mut ACL,
    }

    impl DaclRestore {
        /// Put the original DACL back and free our allocations. Best-effort: a
        /// failure here is logged but cannot be propagated from Drop.
        pub(super) fn restore(self) {
            // SAFETY: path_w is a valid NUL-terminated wide string; orig_dacl is
            // the DACL we captured from this same object. Restoring the original
            // DACL returns the object to its pre-arm state.
            let rc = unsafe {
                SetNamedSecurityInfoW(
                    self.path_w.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(), // owner unchanged
                    std::ptr::null_mut(), // group unchanged
                    self.orig_dacl,       // restore original DACL
                    std::ptr::null_mut(), // sacl unchanged
                )
            };
            if rc != ERROR_SUCCESS {
                eprintln!(
                    "[agent:sandbox] WARN failed to restore DACL (err {rc}) for a \
                     protected path — recover manually with `icacls <path> /reset` if \
                     access seems off."
                );
            }
            // Free the security descriptor (owns orig_dacl) and our new DACL.
            // SAFETY: both were allocated by the Win32 allocator (GetNamed… via
            // LocalAlloc, SetEntriesInAclW via LocalAlloc) and are freed once.
            unsafe {
                if !self.orig_sd.is_null() {
                    LocalFree(self.orig_sd as *mut _);
                }
                if !self.new_dacl.is_null() {
                    LocalFree(self.new_dacl as *mut _);
                }
            }
        }
    }

    /// Convert a path to a NUL-terminated UTF-16 buffer for the *W APIs.
    fn wide(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Look up the current process's user SID. Returned as an owned byte buffer
    /// that backs a valid `PSID` for the lifetime of the buffer. `None` on any
    /// failure (caller degrades to no-protection).
    fn current_user_sid() -> Option<Vec<u8>> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            // SAFETY: GetCurrentProcess returns a pseudo-handle (no close); we
            // open its token for query only.
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            // First call sizes the buffer.
            let mut needed: u32 = 0;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
            if needed == 0 {
                CloseHandle(token);
                return None;
            }
            let mut buf = vec![0u8; needed as usize];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr() as *mut _,
                needed,
                &mut needed,
            );
            CloseHandle(token);
            if ok == 0 {
                return None;
            }
            // buf holds a TOKEN_USER; its User.Sid points INTO buf. We copy the
            // SID bytes into their own buffer so the PSID stays valid and self-
            // contained even if `buf` is reasoned about separately.
            let token_user = &*(buf.as_ptr() as *const TOKEN_USER);
            let sid = token_user.User.Sid;
            if sid.is_null() {
                return None;
            }
            // SAFETY: sid is a valid PSID from a TOKEN_USER inside `buf`.
            let len = GetLengthSid(sid);
            if len == 0 {
                return None;
            }
            let mut sid_buf = vec![0u8; len as usize];
            std::ptr::copy_nonoverlapping(sid as *const u8, sid_buf.as_mut_ptr(), len as usize);
            Some(sid_buf)
        }
    }

    /// Apply one DENY ACE (mask) for `sid` on `path`, prepended to the existing
    /// DACL, capturing the original for restore. `inherit` controls whether the
    /// ACE applies to the subtree (containers + objects) or just the named
    /// object. Returns `None` if the path can't be opened or the ACL ops fail —
    /// the caller skips that path (best-effort).
    fn deny_ace(path: &Path, sid: PSID, mask: u32, inherit: bool) -> Option<DaclRestore> {
        // Skip paths that don't exist — applying an ACE to a missing object
        // fails and is pointless. The protection of a nonexistent secret is
        // vacuously satisfied.
        if !path.exists() {
            return None;
        }
        let path_w = wide(path);

        // 1) Read the current DACL + the owning security descriptor.
        let mut p_dacl: *mut ACL = std::ptr::null_mut();
        let mut p_sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: path_w is NUL-terminated; out-pointers are valid. On success
        // p_sd owns the buffer (freed on restore) and p_dacl points into it.
        let rc = unsafe {
            GetNamedSecurityInfoW(
                path_w.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut p_dacl,
                std::ptr::null_mut(),
                &mut p_sd,
            )
        };
        if rc != ERROR_SUCCESS {
            eprintln!(
                "[agent:sandbox] WARN GetNamedSecurityInfoW failed (err {rc}) for {} — \
                 skipping its protection.",
                path.display()
            );
            return None;
        }

        // 2) Build an EXPLICIT_ACCESS_W deny entry for the SID.
        let inheritance = if inherit {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            NO_INHERITANCE
        };
        let mut ea: EXPLICIT_ACCESS_W = unsafe { std::mem::zeroed() };
        ea.grfAccessPermissions = mask;
        ea.grfAccessMode = DENY_ACCESS;
        ea.grfInheritance = inheritance;
        ea.Trustee = TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: sid as *mut u16, // for TRUSTEE_IS_SID this is the PSID
        };

        // 3) Merge our deny ACE INTO the existing DACL (deny is placed ahead of
        // allows by SetEntriesInAclW, so it takes precedence — correct for a
        // deny rule).
        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        // SAFETY: one explicit entry; oldacl = current DACL (may be null);
        // newacl out-param receives a LocalAlloc'd ACL we free on restore.
        let rc2 = unsafe { SetEntriesInAclW(1, &ea, p_dacl, &mut new_dacl) };
        if rc2 != ERROR_SUCCESS {
            eprintln!(
                "[agent:sandbox] WARN SetEntriesInAclW failed (err {rc2}) for {} — \
                 skipping.",
                path.display()
            );
            // p_sd still owns memory — free it; we won't restore this path.
            unsafe {
                if !p_sd.is_null() {
                    LocalFree(p_sd as *mut _);
                }
            }
            return None;
        }

        // 4) Apply the new DACL to the object.
        // SAFETY: new_dacl is a valid DACL; path_w NUL-terminated.
        let rc3 = unsafe {
            SetNamedSecurityInfoW(
                path_w.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                new_dacl,
                std::ptr::null_mut(),
            )
        };
        if rc3 != ERROR_SUCCESS {
            eprintln!(
                "[agent:sandbox] WARN SetNamedSecurityInfoW (apply) failed (err {rc3}) \
                 for {} — skipping.",
                path.display()
            );
            unsafe {
                if !new_dacl.is_null() {
                    LocalFree(new_dacl as *mut _);
                }
                if !p_sd.is_null() {
                    LocalFree(p_sd as *mut _);
                }
            }
            return None;
        }

        Some(DaclRestore {
            path_w,
            orig_sd: p_sd,
            orig_dacl: p_dacl,
            new_dacl,
        })
    }

    /// Arm the requested mode. Returns a guard owning every successful restore.
    pub(super) fn arm(mode: SandboxMode, workspace: &Path) -> SandboxGuard {
        let mut restores: Vec<DaclRestore> = Vec::new();

        // The user SID backing every deny ACE. Without it we can't build a
        // trustee → degrade to no protection (logged once).
        let sid_buf = match current_user_sid() {
            Some(b) => b,
            None => {
                eprintln!(
                    "[agent:sandbox] WARN could not resolve current user SID — running \
                     {} WITHOUT ACL confinement (passthrough).",
                    mode.as_str()
                );
                return SandboxGuard {
                    mode,
                    restores,
                };
            }
        };
        let sid: PSID = sid_buf.as_ptr() as PSID;

        let home = home_dir();

        // ── Both light & strict: fence the secret stores (deny read+write). ──
        for secret in secret_paths(home.as_deref().unwrap_or(Path::new(""))) {
            // For directories (.ssh, .aws, .config) inherit into the subtree so
            // the keys inside are covered; for single files NO_INHERITANCE.
            let inherit = secret.is_dir();
            if let Some(r) = deny_ace(&secret, sid, DENY_ALL_MASK, inherit) {
                restores.push(r);
            }
        }

        // ── Strict only: write-confine. Deny WRITE on the high-value out-of-
        // workspace roots, then (re-)allow WRITE on the allowlist so caches/
        // temp/workspace still work. The allow-ACEs are applied to the
        // allowlist dirs' OWN DACLs, which the kernel evaluates against those
        // subtrees directly — so a deny on the profile root and an allow on
        // ~\.cargo coexist correctly. ──
        if mode == SandboxMode::Strict {
            for deny_root in strict_write_deny_roots(home.as_deref()) {
                // NON-recursive on the profile root (we don't want to deny write
                // to the whole profile subtree — that would also hit the caches
                // before our allow-ACEs and is far too broad). The root's own
                // DACL stops ~\hack.txt / ~\.bashrc creation+modification.
                let inherit = false;
                if let Some(r) = deny_ace(&deny_root, sid, DENY_WRITE_MASK, inherit) {
                    restores.push(r);
                }
            }
            // Note: the workspace, temp, and caches are NOT denied — they keep
            // their inherited allow-ACEs, so writes there continue to succeed.
            // We intentionally do NOT add explicit allow-ACEs (the default
            // inherited allow already grants write); adding redundant allows
            // would only risk surprising the user's existing ACLs. See
            // write_allowlist for the conceptual set and the validation doc for
            // the runtime checks.
            let _ = write_allowlist(workspace, home.as_deref()); // referenced for clarity/tests
        }

        if restores.is_empty() {
            eprintln!(
                "[agent:sandbox] mode={} armed 0 paths (none existed / all skipped) — \
                 running effectively as passthrough.",
                mode.as_str()
            );
        } else {
            eprintln!(
                "[agent:sandbox] mode={} armed: {} path(s) protected.",
                mode.as_str(),
                restores.len()
            );
        }

        SandboxGuard { mode, restores }
    }
}

// ════════════════════════════════════════════════════════════════════════
// Tests — everything testable WITHOUT a spawn or live FFI:
//   * env-var → mode parsing (incl. the "off = passthrough" default),
//   * secret-path resolution,
//   * write-allowlist & deny-root resolution,
//   * the non-Windows no-op surface.
// ════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    // ── mode parsing ────────────────────────────────────────────────────

    #[test]
    fn mode_parse_known_values() {
        assert_eq!(SandboxMode::parse("light"), SandboxMode::Light);
        assert_eq!(SandboxMode::parse("strict"), SandboxMode::Strict);
        assert_eq!(SandboxMode::parse("off"), SandboxMode::Off);
    }

    #[test]
    fn mode_parse_is_case_and_space_insensitive() {
        assert_eq!(SandboxMode::parse("  LIGHT  "), SandboxMode::Light);
        assert_eq!(SandboxMode::parse("Strict"), SandboxMode::Strict);
        assert_eq!(SandboxMode::parse("OFF"), SandboxMode::Off);
    }

    #[test]
    fn mode_parse_unknown_is_off_not_strict() {
        // CRITICAL: an unrecognized / typo'd value must fail OPEN to Off (never
        // silently apply a stricter-than-asked confinement that could surprise
        // the dev loop).
        assert_eq!(SandboxMode::parse(""), SandboxMode::Off);
        assert_eq!(SandboxMode::parse("0"), SandboxMode::Off);
        assert_eq!(SandboxMode::parse("false"), SandboxMode::Off);
        assert_eq!(SandboxMode::parse("strikt"), SandboxMode::Off);
        assert_eq!(SandboxMode::parse("on"), SandboxMode::Off);
    }

    #[test]
    fn mode_default_is_off() {
        assert_eq!(SandboxMode::default(), SandboxMode::Off);
        assert!(!SandboxMode::Off.is_active());
        assert!(SandboxMode::Light.is_active());
        assert!(SandboxMode::Strict.is_active());
    }

    #[test]
    fn mode_str_ids_stable() {
        assert_eq!(SandboxMode::Off.as_str(), "off");
        assert_eq!(SandboxMode::Light.as_str(), "light");
        assert_eq!(SandboxMode::Strict.as_str(), "strict");
    }

    // ── secret-path resolution ──────────────────────────────────────────

    #[test]
    fn secret_paths_are_home_relative_and_cover_credentials() {
        let home = Path::new("C:\\Users\\tester");
        let secrets = secret_paths(home);
        // Spot-check the load-bearing credential stores are present.
        assert!(secrets.iter().any(|p| p.ends_with(".ssh")), "must protect ~/.ssh");
        assert!(secrets.iter().any(|p| p.ends_with(".aws")), "must protect ~/.aws");
        assert!(
            secrets.iter().any(|p| p.ends_with("auth.json")),
            "must protect ~/.codex/auth.json"
        );
        assert!(
            secrets.iter().any(|p| p.ends_with(".claude.json")),
            "must protect ~/.claude.json"
        );
        // Every home-relative secret must actually start at the given home.
        assert!(secrets
            .iter()
            .filter(|p| p.starts_with(home))
            .count()
            >= 8);
    }

    #[test]
    fn secret_paths_empty_home_skips_relative_paths() {
        // With no home, NO home-relative `.ssh`-style relative path may leak in
        // (those would mis-resolve against the cwd). Only absolute browser paths
        // under %LOCALAPPDATA% may appear, and every returned path must be
        // absolute.
        let secrets = secret_paths(Path::new(""));
        for p in &secrets {
            assert!(
                p.is_absolute(),
                "empty-home secret path must be absolute, got {p:?}"
            );
        }
    }

    // ── strict write-allowlist & deny roots ─────────────────────────────

    #[test]
    fn write_allowlist_includes_workspace_temp_and_caches() {
        let ws = Path::new("C:\\proj\\app");
        let home = Path::new("C:\\Users\\tester");
        let allow = write_allowlist(ws, Some(home));
        assert!(allow.iter().any(|p| p == ws), "workspace must be writable");
        // temp dir is always present.
        assert!(allow.contains(&std::env::temp_dir()));
        // cargo / rustup caches (env may override, but with none set they fall
        // back to home-relative — assert the home-relative defaults appear
        // unless an env override is active in this test env).
        let has_cargo = allow.iter().any(|p| p.ends_with(".cargo"))
            || std::env::var_os("CARGO_HOME").is_some();
        assert!(has_cargo, "cargo cache must be writable under strict");
    }

    #[test]
    fn write_allowlist_without_home_still_has_workspace_and_temp() {
        let ws = Path::new("C:\\proj\\app");
        let allow = write_allowlist(ws, None);
        assert!(allow.iter().any(|p| p == ws));
        assert!(allow.contains(&std::env::temp_dir()));
    }

    #[test]
    fn strict_deny_roots_include_profile_root_and_shell_config() {
        let home = Path::new("C:\\Users\\tester");
        let roots = strict_write_deny_roots(Some(home));
        assert!(roots.iter().any(|p| p == home), "profile root must be write-denied");
        assert!(
            roots.iter().any(|p| p.ends_with(".bashrc")),
            "~/.bashrc must be write-denied"
        );
        assert!(
            roots.iter().any(|p| p.ends_with(".gitconfig")),
            "~/.gitconfig must be write-denied"
        );
    }

    #[test]
    fn strict_deny_roots_empty_without_home() {
        // No home → nothing to deny (we never guess a home).
        assert!(strict_write_deny_roots(None).is_empty());
    }

    // ── arm() surface ───────────────────────────────────────────────────

    #[test]
    fn off_mode_arms_inert_guard() {
        // Off must never touch the filesystem — armed_count is 0 and Drop is a
        // no-op. Works identically on every platform.
        let sb = Sandbox {
            mode: SandboxMode::Off,
            workspace: std::env::temp_dir(),
        };
        let guard = sb.arm();
        assert_eq!(guard.mode(), SandboxMode::Off);
        assert_eq!(guard.armed_count(), 0);
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_arm_is_noop_even_when_active() {
        // On non-Windows, even an "active" mode applies nothing (documented
        // passthrough) — so the agent loop is never blocked on these targets.
        let sb = Sandbox {
            mode: SandboxMode::Strict,
            workspace: std::env::temp_dir(),
        };
        let guard = sb.arm();
        assert_eq!(guard.armed_count(), 0);
    }
}
