# Windows exec sandbox — runtime validation checklist

> Status: **implemented + unit-tested, NOT yet runtime-validated** (the spawn
> path can only be exercised with a live Tauri host + a running agent, which the
> implementing agent could not do). This document is the checklist YOU run to
> promote the feature from *partial* to *green*.

The sandbox confines the agent's `run_command` tool (the `run_command_direct`
path in `src-tauri/src/commands/agents/exec.rs`). It is **opt-in** and **OFF by
default** — nothing changes until you set the env var.

---

## 1. Mechanism, in one paragraph

The sandbox is built on **native Windows filesystem ACLs** (deny-ACEs keyed to
your user SID), applied just before the command spawns and **automatically
restored** when the command finishes (RAII guard in `sandbox.rs`). It was chosen
over AppContainer / MIC-low **on purpose**: those two are stricter but require
re-implementing the process spawn with `CreateProcessAsUserW` + `STARTUPINFOEX`,
which would replace the existing, tested `std::process::Command` spawn (piped
stdio, poll/timeout loop, Job-Object tree-kill). An untestable hand-rolled spawn
is a worse risk than the threat it mitigates — so the ACL approach was taken
because it **composes** with the proven spawn path. See the upgrade note at the
bottom for how to move to AppContainer later.

---

## 2. Activation

The level is read from the **`SHUGU_SANDBOX`** environment variable (same family
as `SHUGU_CUSTOM_*`, `SHUGU_CODEX_BIN`, etc.):

| `SHUGU_SANDBOX` | Mode      | Effect                                                              |
|-----------------|-----------|--------------------------------------------------------------------|
| *unset* / `off` | **Off**   | Passthrough. No ACL changes. The pre-sandbox behavior (default).   |
| `light`         | **Light** | Deny **read+write** on credential/config secret stores.            |
| `strict`        | **Strict**| Light + deny **write** on out-of-workspace tamper targets.         |
| anything else   | **Off**   | Unknown value fails OPEN to Off (never silently stricter).         |

Set it for the Shugu process (the value is read per command, at spawn time):

```powershell
# PowerShell — set for the current session, then launch Shugu from it
$env:SHUGU_SANDBOX = "light"     # or "strict", or "off"
# … launch the app (pnpm tauri dev / the built exe) from THIS shell …
```

Confirm it armed by watching the dev log (stderr) — each confined command emits:

```
[agent:exec] sandbox mode=light armed=N path(s)
[agent:sandbox] mode=light armed: N path(s) protected.
```

`armed=0` means none of the protected paths existed on your machine (e.g. you
have no `~\.ssh`) — that is expected and harmless, the protection is vacuous.

---

## 3. Validation matrix — run these by having the AGENT execute the commands

> Run each via the agent's `run_command` (or the in-app exec surface), **not** a
> plain terminal — the sandbox only wraps the agent's exec path. Use a throwaway
> workspace with a committed git tree so you can discard freely.

### 3a. Mode OFF (default) — nothing is confined

| # | `SHUGU_SANDBOX` | Command (run via agent)                         | Expected                       |
|---|-----------------|-------------------------------------------------|--------------------------------|
| 1 | *unset*         | `pnpm -v`                                        | prints version (exit 0)        |
| 2 | *unset*         | `type %USERPROFILE%\.ssh\id_rsa` (if you have one)| **succeeds** (no confinement)  |
| 3 | *unset*         | `echo x > %USERPROFILE%\shugu-sbx-test.txt`      | **succeeds** (then delete it)  |

Mode OFF must behave exactly as before — this is the "never break the dev loop"
guarantee.

### 3b. Mode LIGHT — secrets fenced, tools unaffected

Set `$env:SHUGU_SANDBOX = "light"` and relaunch Shugu from that shell.

| # | Command (run via agent)                              | Expected                                  |
|---|------------------------------------------------------|-------------------------------------------|
| 4 | `pnpm -v`                                             | **succeeds** (exit 0) — tools still work  |
| 5 | `cargo --version`                                    | **succeeds**                              |
| 6 | `git status`                                         | **succeeds** (reads are open)             |
| 7 | `type %USERPROFILE%\.ssh\id_rsa`                      | **FAILS** "Access is denied"              |
| 8 | `type %USERPROFILE%\.aws\credentials`                | **FAILS** "Access is denied"              |
| 9 | `copy %USERPROFILE%\.ssh\id_rsa .\stolen.txt`        | **FAILS** "Access is denied"              |
|10 | `dir %USERPROFILE%\.ssh`                              | **FAILS** to list (deny is on the dir)    |
|11 | `echo x > %USERPROFILE%\shugu-sbx-test.txt`          | **succeeds** (light does NOT confine writes) — delete it |

After the command returns, verify the protection was lifted: in a normal
terminal, `type %USERPROFILE%\.ssh\id_rsa` should work again (DACL restored on
guard Drop). If it still fails, run `icacls "%USERPROFILE%\.ssh" /reset /t` to
recover (this should not be necessary unless Shugu crashed mid-command).

### 3c. Mode STRICT — writes confined to the allowlist

Set `$env:SHUGU_SANDBOX = "strict"` and relaunch.

| # | Command (run via agent)                              | Expected                                      |
|---|------------------------------------------------------|-----------------------------------------------|
|12 | `pnpm install` (in a JS project)                     | **succeeds** — cache writes allowed           |
|13 | `cargo build`                                        | **succeeds** — `~\.cargo` writes allowed      |
|14 | `echo x > .\in-workspace.txt`                        | **succeeds** — workspace is writable          |
|15 | `echo x > %TEMP%\shugu-sbx-tmp.txt`                  | **succeeds** — temp is in the allowlist       |
|16 | `echo x > %USERPROFILE%\hack.txt`                    | **FAILS** "Access is denied" (profile root)   |
|17 | `echo x >> %USERPROFILE%\.bashrc`                    | **FAILS** "Access is denied"                  |
|18 | `echo x > %USERPROFILE%\.gitconfig`                  | **FAILS** "Access is denied"                  |
|19 | `type %USERPROFILE%\.ssh\id_rsa`                     | **FAILS** (light protections still apply)     |
|20 | `git fetch` / `git pull`                             | **succeeds** — network is NOT cut             |

### 3d. Fallback / robustness

| # | Scenario                                              | Expected                                              |
|---|-------------------------------------------------------|-------------------------------------------------------|
|21 | `SHUGU_SANDBOX=strict`, no `~\.ssh` etc. on machine   | command runs; log shows `armed=` a smaller count; no error |
|22 | `SHUGU_SANDBOX=banana` (typo)                          | treated as **Off** — no confinement, dev loop intact  |
|23 | Kill Shugu mid-command (Task Manager) during step 16  | DACL may remain; recover with `icacls <path> /reset`  |

---

## 4. What is protected — honest scope

### Protected in **light** (and strict)
Deny **read + write** (so even `type`/`copy` fail) on, relative to your home:
`~\.ssh`, `~\.aws`, `~\.azure`, `~\.gcloud`, `~\.codex\auth.json`,
`~\.claude.json`, `~\.claude\.credentials.json`, `~\.git-credentials`,
`~\.npmrc`, `~\.docker\config.json`, `~\.netrc`, `~\.config`, `~\.kube\config`,
plus browser login/cookie stores under `%LOCALAPPDATA%` (Chrome, Edge, Brave).

### Additionally protected in **strict**
Deny **write** (non-recursive on the profile root, so the caches below still
work) on: the user-profile root (`~\hack.txt`, etc.), `~\.bashrc`,
`~\.bash_profile`, `~\.profile`, `~\.zshrc`, `~\.gitconfig`,
`~\Documents\WindowsPowerShell`, and the per-user Startup folder.

### Writable in **strict** (the allowlist)
The workspace root, the system temp dir, and package caches: `~\.cargo`
(or `CARGO_HOME`), `~\.rustup` (or `RUSTUP_HOME`), `~\.npm`
(or `npm_config_cache`), `~\.pnpm`, `~\.pnpm-store`,
`%LOCALAPPDATA%\npm-cache`, `%LOCALAPPDATA%\pnpm`.

### NOT protected — be honest about the gaps
- **Arbitrary writes outside the enumerated deny set.** `strict` is a deny-LIST
  of the realistic tamper/persistence targets, not a whole-disk write-jail. A
  write to a brand-new `D:\whatever` still succeeds (a whole-disk ACL sweep would
  be slow and dangerous). The `CommandRisk` classifier still flags out-of-
  workspace writes, and git still nets workspace changes.
- **Arbitrary deletes outside the workspace.** An `rm`/`del` of some unprotected
  out-of-workspace path is not blocked (the risk classifier flags `rm -rf`, but
  the ACL layer does not jail deletes broadly).
- **Network.** Left fully active in every mode — cutting it would break
  `pnpm install` / `git fetch`. See the upgrade note for how to add an opt-in
  network block later.
- **Same-user concurrency window.** The deny-ACE is keyed to your user SID, so
  while a confined command runs, OTHER processes of yours touching those exact
  secret paths are also denied. Commands are short and serial, and the DACL is
  restored on completion.
- **Privilege.** The agent runs as you; an attacker who could already run
  elevated code is out of scope.

---

## 5. Upgrade path (future, optional)

To move from "deny-list ACLs" to a true **write-jail** (Claude-Code parity), the
mechanism is **AppContainer**: derive a capability SID per write-root, grant it
on the allowlist dirs, and spawn the child with that AppContainer token via
`CreateProcessAsUserW` + `STARTUPINFOEX` (`PROC_THREAD_ATTRIBUTE_SECURITY_-
CAPABILITIES`). That requires re-implementing the spawn (stdio pipes + job
assignment) — do it behind the same `SHUGU_SANDBOX=strict` flag, keep the ACL
path as the fallback, and validate with this same matrix. The `windows-sys`
features needed (`Win32_Security_Isolation`, `Win32_System_Threading` proc-thread
attributes) are a small Cargo.toml addition.

To add an **opt-in network block** (e.g. `SHUGU_SANDBOX=strict-nonet`): the
lightest reliable lever is a per-run WFP filter or a restricted-token with the
network-capability SID removed under AppContainer. Keep it OFF by default so
`pnpm install` / `git fetch` keep working unless explicitly opted in.
