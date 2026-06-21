# Windows exec sandbox — mechanism + runtime validation checklist

> Status: **implemented, unit + integration tested in-process**. The confined
> spawn is exercised by a real `cargo test` (`confined_spawn_enforces_write_jail_and_open_reads`)
> that spawns a command under the sandbox and proves the three contract
> properties (out-of-allowlist write blocked, workspace write allowed, outside
> read allowed). What remains is **runtime toolchain compat** validation (does
> `pnpm install` / `cargo build` / `git fetch` work under the sandbox in the live
> app) — section 3 below.

The sandbox confines the agent's `run_command` tool (the `run_command_direct`
path in `src-tauri/src/commands/agents/exec.rs`). It is **always on** and
**invisible** — there is no toggle and no UI. The only opt-out is an emergency
env var.

---

## 1. Mechanism — Mandatory Integrity Control, LOW integrity

Every agent command runs in a **write-confined / reads-open low-integrity
child**, spawned via `CreateProcessAsUserW` (not `std::process::Command`, which
can't inject a custom token). Two steps:

1. **A LOW-integrity primary token.** We duplicate the current process token and
   lower its integrity to **LOW** (`SetTokenInformation(TokenIntegrityLevel)`,
   SID `S-1-16-4096`). Lowering your own token needs no privilege; the kernel
   forbids RAISING it. A LOW process obeys Mandatory Integrity Control:
   - **no-write-up** — it cannot write objects labeled HIGHER than itself.
     Ordinary files/dirs are MEDIUM, so a LOW child cannot write them. ← the
     write-jail, native.
   - **reads are NOT restricted** — MIC's read-up restriction is off on normal
     objects, so the LOW child reads MEDIUM/HIGH fine. ← reads open, native.

2. **A LOW mandatory label on each write-allowlist dir.** We stamp
   `S:(ML;OICI;NW;;;LW)` (Low label, container+object inherit, no-write-up) on
   the workspace + temp + caches. An object's own integrity gates writes: once a
   dir is LOW, the LOW child MAY write it (equal level). The rest of the disk
   stays MEDIUM → read-only to the child.

### Why this over AppContainer

AppContainer confines **reads** too (everything needs an explicit
`ALL_APPLICATION_PACKAGES` read-grant), so every toolchain dir would need an ACE
and a single miss breaks a tool. MIC-low gives "reads open, writes confined" as
the native default — exactly the spec. AppContainer remains the documented
stricter upgrade if a capability-true jail is ever required.

### Performance — why it doesn't slow the dev loop

Labeling uses the **object-only** `SetFileSecurityW`, NOT `SetNamedSecurityInfoW`
(which recursively re-stamps every existing child — that made labeling
`~\.cargo` + `~\.rustup`, ~87k files, a 7-minute walk). The directory's own
inheritable (OICI) ACE is enough: files the child CREATES inherit the LOW label
at creation. Labels are also **idempotent** (skip if the dir is already LOW) and
the cache/temp labels are **provisioned once** (left in place; a LOW label only
GRANTS low-IL write, it removes no access). Net result: the full integration
test (3 confined spawns, each labeling every allowlist dir) runs in **~0.18 s**
even after the cache labels are reset.

### Honest limits

- **Granularity is the integrity label, not a path ACL.** Anything labeled LOW is
  writable; everything MEDIUM is not. A pre-existing LOW object elsewhere (rare)
  would also be writable — we don't scan for those.
- **Same-user concurrency window.** The LOW label on an allowlist dir is visible
  to other processes during a run; it only GRANTS low-IL write, so it reduces no
  one's access. The workspace label is removed on completion (RAII); cache/temp
  labels persist (benign).
- **Delete semantics.** A LOW child can delete files *inside* the workspace
  (intended — git is the net). It cannot delete MEDIUM files outside the
  allowlist (no-write-up covers delete).
- **Privilege.** The agent runs as the user; an attacker who could already run
  elevated code is out of scope (a LOW child cannot raise its own integrity).

### Fail-safe

Token setup, labeling, and the confined spawn can each fail for environmental
reasons. ANY failure logs a one-line warning and falls back to the existing
**direct** `std::process::Command` spawn — the agent loop is never blocked.

---

## 2. Activation — always on; one emergency opt-out

There is **no enable toggle**. The sandbox wraps every agent `run_command`. The
only escape hatch is:

| `SHUGU_SANDBOX_DISABLE` | Effect                                                       |
|-------------------------|--------------------------------------------------------------|
| *unset* / `0` / anything| **Sandbox ON** (confined spawn). The default.                |
| `1` / `true` / `on`/`yes`| **Sandbox OFF** — plain direct spawn (emergency unblock).   |

```powershell
# Emergency only — disable confinement for the current session, then launch Shugu
$env:SHUGU_SANDBOX_DISABLE = "1"
# … launch the app from THIS shell …
```

Watch the dev log (stderr) to confirm behavior:

```
# disabled:
[agent:sandbox] SHUGU_SANDBOX_DISABLE set — confinement OFF, running command directly.
# a fallback (setup failed → direct spawn), e.g.:
[agent:sandbox] WARN CreateProcessAsUserW failed (...) — falling back to direct spawn.
```

No warning line = the command ran confined (the silent happy path).

---

## 3. Runtime validation matrix — run these via the AGENT's `run_command`

> Use a throwaway workspace with a committed git tree so you can discard freely.
> Run each via the agent's `run_command` (or the in-app exec surface), not a
> plain terminal — the sandbox only wraps the agent's exec path.

### 3a. Write-jail (the core contract)

| # | Command (run via agent)                              | Expected                                          |
|---|------------------------------------------------------|---------------------------------------------------|
| 1 | `echo x > .\in-workspace.txt`                        | **succeeds** — workspace is writable              |
| 2 | `echo x > %TEMP%\shugu-sbx-tmp.txt`                  | **succeeds** — temp is in the allowlist           |
| 3 | `echo x > %USERPROFILE%\shugu-hack.txt`              | **FAILS** "Access is denied" (profile is MEDIUM)  |
| 4 | `echo x >> %USERPROFILE%\.bashrc`                    | **FAILS** "Access is denied"                      |
| 5 | `echo x > C:\Windows\Temp\shugu.txt`                 | **FAILS** "Access is denied"                      |

### 3b. Reads stay open

| # | Command (run via agent)                              | Expected                                          |
|---|------------------------------------------------------|---------------------------------------------------|
| 6 | `type %USERPROFILE%\.gitconfig` (if present)         | **succeeds** — reads are open                      |
| 7 | `dir %USERPROFILE%`                                  | **succeeds** — listing is a read                   |
| 8 | `type C:\Windows\win.ini`                            | **succeeds** — system reads open                   |

### 3c. Toolchain compatibility (the remaining unknown — VALIDATE THIS)

| # | Command (run via agent)                              | Expected                                          |
|---|------------------------------------------------------|---------------------------------------------------|
| 9 | `node -v` / `pnpm -v` / `cargo --version`            | **succeeds** — toolchains read fine               |
|10 | `pnpm install` (in a JS project)                     | **succeeds** — cache + node_modules writes allowed |
|11 | `cargo build`                                        | **succeeds** — `~\.cargo` / target writes allowed |
|12 | `git status` / `git fetch` / `git pull`             | **succeeds** — reads open, network active         |

> If a toolchain step FAILS with "Access is denied", a cache root it writes is
> missing from the allowlist (`write_allowlist` in `sandbox.rs`). Add it there
> (honor any env override the tool uses), or set `SHUGU_SANDBOX_DISABLE=1` to
> unblock while you patch it. `node_modules` lives INSIDE the workspace, so
> `pnpm install`'s package writes are covered by the workspace label; the global
> store/cache writes are what the allowlist must cover.

### 3d. Robustness

| # | Scenario                                                   | Expected                                                |
|---|------------------------------------------------------------|---------------------------------------------------------|
|13 | `SHUGU_SANDBOX_DISABLE=1`                                   | commands run unconfined; the disable log line appears   |
|14 | A long command exceeding the per-command timeout           | killed tree-wide (Job Object), exit 124 — same as before|
|15 | Kill Shugu mid-command (Task Manager)                      | the workspace may stay LOW-labeled; harmless. Recover with `icacls <dir> /setintegritylevel Medium` |

---

## 4. What is protected — honest scope

### Writable (the allowlist)
The workspace root, the OS temp dir, and package caches: `~\.cargo`
(or `CARGO_HOME`), `~\.rustup` (or `RUSTUP_HOME`), `~\.npm`
(or `npm_config_cache`), `~\.pnpm`, `~\.pnpm-store`, `~\.cache`,
`%LOCALAPPDATA%\npm-cache`, `%LOCALAPPDATA%\pnpm`, `%LOCALAPPDATA%\pnpm-cache`.

### Read-only to the confined child (everything else)
The whole rest of the disk is MEDIUM and the LOW child cannot write it: the user
profile root, `~\.ssh` / `~\.aws` / agent auth tokens, `C:\Windows`, Program
Files, other drives, etc. Note this is a **write-jail by integrity**, not a
read-deny — secrets are still READABLE (reads are open, by design, so tools
work). The protection here is against **out-of-workspace WRITES** (tampering /
persistence), which git's net cannot cover; credential *exfiltration* over the
network is a separate concern the risk classifier flags but this layer does not
block (cutting network breaks `pnpm install` / `git fetch`).

### NOT covered — be honest
- **Reading secrets.** Reads are open by design. An injected command can still
  `type %USERPROFILE%\.ssh\id_rsa`. The risk classifier flags exfiltration
  patterns (`curl … | sh`, out-of-workspace copies) but does not block reads.
- **Writes to a pre-existing LOW-labeled object** elsewhere on the machine (rare;
  we don't scan).
- **Network.** Fully active in every mode (cutting it breaks installs/fetch).

---

## 5. Upgrade path (future, optional)

- **Capability-true jail** → AppContainer: derive a capability SID per write-root,
  grant read on the toolchain dirs (`ALL_APPLICATION_PACKAGES`), and spawn with
  the AppContainer token via the same `CreateProcessAsUserW` + `STARTUPINFOEX`
  plumbing already in `sandbox.rs`. Heavier (every toolchain read needs a grant),
  stricter. Keep the MIC-low path as the fallback.
- **Read-deny on secrets** (block exfiltration too) → layer the previous
  deny-ACE approach on the credential stores ON TOP of the integrity jail, OR run
  under AppContainer (no read grant on `~\.ssh` ⇒ no read). Both narrow what tools
  can read, so validate the toolchain matrix (3c) carefully after.
- **Opt-in network block** (`SHUGU_SANDBOX=strict-nonet`) → a per-run WFP filter
  or an AppContainer token without the network-capability SID. OFF by default so
  installs/fetch keep working.
