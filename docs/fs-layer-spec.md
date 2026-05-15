# B1 — Real Filesystem Layer: Implementation Spec

> **Scope:** Replace the prototype's fake file tree (`src/mocks/seedFileTree.ts`)
> and fake file contents (`src/mocks/seedFileContents.ts`) with real OS-backed
> files. Covers: Rust commands, frontend wrapper, UI wiring, save-file enablement.
> Does NOT cover `git2`, project-wide search, or the language server.
>
> **Status:** Analysis only — no code written.

---

## 1. Current-State Audit

### Rust side

| File | Symbol | State |
|---|---|---|
| `src-tauri/src/commands/fs.rs:4-8` | `Entry { name, path, is_dir }` | Defined, missing `children` (no recursion). |
| `src-tauri/src/commands/fs.rs:11-15` | `fs_read_dir` | Stub — ignores `path`, returns `vec![]`. |
| `src-tauri/src/commands/fs.rs:18-21` | `fs_read_file` | Stub — returns `"(stub) would read {path}"`. |
| `src-tauri/src/commands/fs.rs:23-28` | `fs_write_file` | Stub — silent no-op. |
| `src-tauri/src/lib.rs:98` | `tauri_plugin_fs::init()` | Registered. Provides the JS plugin APIs (not used by our custom commands). |
| `src-tauri/src/lib.rs:104-115` | `invoke_handler!` | All three fs commands registered. No `fs_open_folder`. |
| `src-tauri/Cargo.toml` | dependencies | `tauri-plugin-fs = "2"` present. `tauri-plugin-dialog` **absent**. `walkdir` **absent**. |
| `src-tauri/capabilities/default.json:9` | `"fs:default"` | Present — scopes the JS plugin only, not our custom commands. |

There is no `tauri-plugin-dialog` registration anywhere in `lib.rs` or `Cargo.toml`.

### Frontend side

| File | Symbol | State |
|---|---|---|
| `src/mocks/seedFileTree.ts` | `seedFileTree: FileNode[]` | Hard-coded 10-node fake tree with `git` status badges. |
| `src/mocks/seedFileContents.ts` | `seedFileContents: Record<string, FileContent>` | 5 fake file bodies keyed by relative path. |
| `src/lib/tauri.ts:17` | `mocks.fs_read_dir` | Returns `seedFileTree`. |
| `src/lib/tauri.ts:18` | `mocks.fs_read_file` | Returns `seedFileContents[path]?.text ?? ""`. |
| `src/lib/tauri.ts:19` | `mocks.fs_write_file` | Returns `{ ok: true }`. |
| `src/lib/types.ts:42-48` | `FileNode` | `{ name, path, open?, git?, children? }` — adequate. |
| `src/lib/types.ts:50-55` | `FileContent` | `{ lang, text, original?, dirty? }` — adequate. |
| `src/routes/RootLayout.tsx:45-46` | Imports | `seedFileTree` and `seedFileContents` imported at module level. |
| `src/routes/RootLayout.tsx:318-321` | State init | `openFiles` hardcoded to 3 fake paths; `fileContents` init'd from `seedFileContents`. |
| `src/routes/RootLayout.tsx:532-536` | `SideFiles` | Receives `tree={seedFileTree}` — never reads from a real command. |
| `src/components/components.tsx:178-212` | `SideFiles` + `FileNode` | Full recursive renderer; driven entirely by the `tree` prop. |
| `src/features/code/views-code.tsx:10-63` | `CodeView` | Reads/writes `fileContents` via shell state; `onChange` sets `dirty: true` at line 21. |
| `src/lib/commands.ts:182-196` | `save-file`, `save-all` | Registered with `when: () => false` and empty `run`. |
| `src/lib/commands.ts:46-57` | `CommandContext` | Has `openFiles`, `activeFile`; lacks `fileContents`, `setFileContents`, `saveFile`. |

No `src/lib/fs.ts` module exists today.

---

## 2. Recommended Pass Structure

The work is too large and too risky to land as one PR. The split below isolates
reviewable, verifiable chunks with clear blast radii.

### B1-A — Rust + frontend wrapper (no UI wiring)

**Goal:** Real implementations of the four Rust commands behind the same invoke
boundary; a new `src/lib/fs.ts` that wraps them; web-mode mocks preserved.
The SideFiles panel still renders `seedFileTree` — nothing visible changes in
the UI.

**Deliverables:**
- `src-tauri/Cargo.toml`: add `walkdir = "2"`, `tauri-plugin-dialog = "2"`.
- `src-tauri/src/lib.rs`: register `tauri_plugin_dialog::init()`, add
  `fs_open_folder` to `invoke_handler!`, add
  `Mutex<Option<PathBuf>>` as managed state.
- `src-tauri/src/commands/fs.rs`: full implementations of all four commands
  (see Section 3).
- `src-tauri/capabilities/default.json`: add `"dialog:allow-open"`.
- `src/lib/fs.ts` (new file): typed wrapper (see Section 6).

**Verification:** `cargo check` passes. `pnpm typecheck` passes. In `pnpm tauri
dev`, open devtools console and call
`window.__TAURI_INTERNALS__.invoke("fs_open_folder", {})` — confirms folder
picker opens, and a subsequent `invoke("fs_read_dir", {})` returns a real tree.

### B1-B — UI wiring + save-file enablement

**Goal:** SideFiles renders real tree; tabs load real content; Cmd+S saves.

**Deliverables:**
- `src/routes/RootLayout.tsx`: swap `seedFileTree` for `fsReadDir()` on mount
  (or on workspace change event); swap `seedFileContents` initial state for lazy
  load via `fsReadFile()` on `openFile()`; wire "Open Folder" to `fsOpenFolder()`;
  clear stale state on workspace change.
- `src/lib/commands.ts`: extend `CommandContext` with `fileContents`,
  `setFileContents`, `saveFile`; implement `save-file` and `save-all` `run` bodies;
  flip their `when` predicates.
- `src/components/components.tsx`: add "Open Folder" button in `SideFiles` header.

**Verification:** `pnpm typecheck` passes. In Tauri dev mode: open a folder, see
real tree, click a file, see real content, edit, press Cmd+S, verify the file on
disk changed. In `pnpm dev` (web mode): still shows `seedFileTree` — no
regression.

### B1-C — File watching + create/rename/delete (deferred)

**Goal:** The tree auto-updates when files change on disk; right-click context
menu enables new-file, rename, delete.

**Deliverables:**
- `src-tauri/Cargo.toml`: add `notify = "6"`.
- New `src-tauri/src/commands/watcher.rs`.
- Frontend event listener in `src/lib/fs.ts` for `fs://changed` events.
- Context menu wiring in `SideFiles`.

**Recommendation:** Do NOT include in B1. It adds a background thread, a new
event bus, and cross-platform path normalisation complexity. B1-A+B are already
a significant scope. File watching belongs in a separate PR after B1-B is
stable.

---

## 3. Rust Command Designs

### Workspace-relative path contract

All IPC paths cross the boundary as **workspace-relative strings**
(`src/components/Forge.tsx`, not `C:\...\src\components\Forge.tsx`). This
matches the existing `FileNode.path` convention in `seedFileTree.ts` and what
`openFiles`/`fileContents` state already stores. The Rust side joins the
relative path to the current `workspace_root` and canonicalizes before any I/O.
The frontend never constructs or handles absolute OS paths.

### Workspace root state

```rust
// In lib.rs — register before invoke_handler:
.manage(Mutex::new(None::<PathBuf>))  // workspace root
```

The Tauri `AppHandle` injects this as `tauri::State<Mutex<Option<PathBuf>>>`.
`fs_open_folder` sets it; all other commands read it. On startup (next session),
the last workspace root is reloaded from the `settings` table
(`settings.get("workspace_root")`) and restored into state — giving the user
their last folder without re-picking.

---

### `fs_open_folder`

New command. Requires `tauri-plugin-dialog`.

```rust
#[tauri::command]
pub fn fs_open_folder(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<Option<String>, String>
```

**Behavior:**
1. Call `tauri_plugin_dialog` to show a native folder picker (single folder,
   no file filter).
2. If user cancels, return `Ok(None)`.
3. Canonicalize the selected path with `std::fs::canonicalize` — errors if the
   path no longer exists.
4. Store the canonicalized `PathBuf` in the managed state.
5. Persist it to the `settings` table via a direct `rusqlite` call (reuse the
   vector command's connection pattern from `vector.rs:56-59`) under key
   `"workspace_root"`.
6. Return `Ok(Some(root_string))` where the string is the canonical absolute
   path (the frontend stores this opaquely for display only — e.g. the
   `SideFiles` header subtitle).

**Return type (TypeScript side):** `string | null`.

---

### `fs_read_dir`

Recursive walk with safety caps.

```rust
#[tauri::command]
pub fn fs_read_dir(
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<Vec<FsEntry>, String>
```

Takes no path argument: it always walks the entire workspace root. The frontend
calls this once on folder open and stores the tree in state.

**Return type:**

```rust
#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,       // workspace-relative, forward-slash normalized
    pub is_dir: bool,
    pub children: Vec<FsEntry>,
}
```

Note: `Entry` in the current stub lacks `children` — it must be extended to
`FsEntry`.

**Behavior:**
1. Read workspace root from state. Return `Err("no workspace open")` if `None`.
2. Use `walkdir::WalkDir` with `.follow_links(false)` (symlinks are not followed
   — see Section 4).
3. Apply ignore list filter on each directory entry name (case-insensitive on
   Windows, case-sensitive on macOS/Linux):
   `.git, node_modules, target, dist, build, .next, .turbo, .cache, .venv,
   __pycache__, .DS_Store, .svn, .hg`
4. Depth cap: `max_depth(8)` — entries at depth > 8 are silently dropped.
5. Entry count cap: 5 000 total entries. If exceeded, return
   `Err("workspace too large (>5000 entries); open a subdirectory")`.
6. Convert each absolute path to workspace-relative by stripping the
   canonicalized root prefix, then replace OS path separators with `/`.
7. Build the `Vec<FsEntry>` tree in memory (sort each directory's children:
   directories first, then files, both alphabetical).
8. `.gitignore` parsing is **out of scope for B1** — add a TODO comment.

---

### `fs_read_file`

```rust
#[tauri::command]
pub fn fs_read_file(
    path: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<String, String>
```

**Behavior:**
1. Read workspace root. Return `Err("no workspace open")` if `None`.
2. Resolve and validate the path (see Security section — canonicalize + assert
   containment).
3. Stat the file. If size exceeds **5 MiB**, return
   `Err("file too large (>5 MiB)")` — do not read into memory.
4. `std::fs::read` the file as raw bytes.
5. Binary detection: scan the first 8 KiB for null bytes. If found, return
   `Err("binary file")`.
6. Convert to `String` via `String::from_utf8_lossy` and return. Invalid UTF-8
   sequences become the Unicode replacement character `\u{FFFD}` — the editor
   displays them visibly.
7. Preserve CRLF sequences byte-for-byte — no normalization.

**Return type (TypeScript):** `string`.

---

### `fs_write_file`

```rust
#[tauri::command]
pub fn fs_write_file(
    path: String,
    content: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String>
```

**Behavior:**
1. Read workspace root. Return `Err("no workspace open")` if `None`.
2. Resolve and validate the path (same containment check as `fs_read_file`).
3. Ensure the parent directory exists — `std::fs::create_dir_all(parent)`.
4. Atomic write:
   a. Write `content` to `<path>.shugu_tmp` in the same directory.
   b. `std::fs::rename(<path>.shugu_tmp, <path>)` — atomic on the same volume
      on both POSIX and Windows NTFS.
   c. If rename fails, attempt to remove the temp file before propagating the
      error.
5. Preserve content bytes exactly — no CRLF normalization.

**Return type (TypeScript):** `void`.

---

### Language detection (frontend responsibility)

The Rust commands do not infer language. The frontend wrapper's `fsReadFile()`
infers `lang` from the file extension using a lookup table before populating
`FileContent`. This keeps Rust commands stateless and easily testable.

---

## 4. Security Analysis

The custom `std::fs` commands run with full process privilege. There is no
sandboxed fs API intermediary — all validation is our own code. Every vector
below must be defended in the Rust implementation.

### Path traversal

**Risk:** Frontend sends `../../etc/passwd` or `../../../Windows/System32/calc.exe`.
The `walkdir` walk is safe (it never follows `..`), but `fs_read_file` and
`fs_write_file` accept a raw path string from the frontend.

**Defense (mandatory for both read and write):**

```rust
fn safe_resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // 1. Reject early if the raw string contains null bytes (poison for fs calls).
    if rel.contains('\0') {
        return Err("invalid path: null byte".into());
    }
    // 2. Join root + relative path — do NOT call canonicalize on the joined path
    //    before this check because canonicalize follows symlinks (see below).
    let joined = root.join(rel);
    // 3. Canonicalize to resolve all '..' and symlinks.
    let canonical = std::fs::canonicalize(&joined)
        .map_err(|e| format!("path not found: {e}"))?;
    // 4. Assert the canonical result starts with the canonical root.
    if !canonical.starts_with(root) {
        return Err("path escapes workspace root".into());
    }
    Ok(canonical)
}
```

**Note on ordering:** `root` itself must be pre-canonicalized (done once in
`fs_open_folder`). This pairing (canonicalize root once; canonicalize joined
path per-call; prefix-check) closes the TOCTOU window on both Windows and POSIX.

### Recursive walk DoS

**Risk:** User opens `/` or `C:\` — walk generates millions of entries.

**Defense:**
- `max_depth(8)` on the `WalkDir` builder.
- 5 000 entry cap with early-exit `Err` return.
- Ignore list removes known large subtrees (`node_modules`, `target`, etc.)
  before the walk descends.

### Symlink escapes

**Risk:** A symlink inside the workspace points to `/etc` or any path outside
the workspace root. `walkdir` by default does not follow symlinks
(`follow_links` defaults to `false`). Our explicit `.follow_links(false)` is a
belt-and-suspenders guard.

**Defense for `fs_read_file` / `fs_write_file`:** The `safe_resolve` function
above canonicalizes the final path, which resolves any symlink chain. The
resulting canonical path then fails the `starts_with(root)` check if the symlink
target is outside the workspace. This closes the escape even for symlinks
encountered via direct path input (not via the tree walk).

### Write-outside-workspace

**Risk:** `fs_write_file` is passed an absolute path or traversal sequence
targeting a path outside the workspace.

**Defense:** `safe_resolve` is called at the start of `fs_write_file`. Any path
that does not resolve under the canonical workspace root is rejected before any
I/O.

### Workspace root as capability boundary

All four commands share a single invariant: **no I/O occurs outside
`workspace_root`**. The root is set only by `fs_open_folder` (via a native OS
dialog — the user explicitly consented). Commands that find the state is `None`
return an `Err` immediately. This means opening a folder is a hard precondition
for any other fs operation — not an optional optimization.

### The `custom` protocol / SSRF note

This concern applies to `image.rs` (already documented in CLAUDE.md). It is not
a new surface introduced by B1. No network I/O is performed by any fs command.

---

## 5. New Dependencies

### `tauri-plugin-dialog`

- **Cargo.toml addition:** `tauri-plugin-dialog = "2"`
- **lib.rs registration:** `.plugin(tauri_plugin_dialog::init())` before
  `invoke_handler!`
- **capabilities/default.json:** Add `"dialog:allow-open"` to the permissions
  array. `dialog:default` is broader (includes save, message, ask) — use the
  narrower `dialog:allow-open` since we only need a folder picker.
- **JS side (not needed):** B1 does not call the dialog from JavaScript. The
  plugin is invoked from Rust inside `fs_open_folder`. No JS import required.

### `walkdir`

- **Cargo.toml addition:** `walkdir = "2"`
- Mature crate, no transitive heavy dependencies. Provides `WalkDir` builder
  with `max_depth`, `follow_links`, and per-entry error handling (broken
  symlinks become `WalkDir::Error`, not panics).

### `notify` (file watching)

Deferred to B1-C. Do not add in B1-A or B1-B. Reason: it spawns an OS-level
watcher thread, introduces cross-platform normalization complexity (inotify vs.
FSEvents vs. ReadDirectoryChangesW), and creates a new Tauri event bus.
The risk/complexity is disproportionate to the B1 scope.

---

## 6. Web-Mode Degradation Plan

The new `src/lib/fs.ts` module follows the exact pattern of `src/lib/vector.ts`:

```typescript
// src/lib/fs.ts

import { invoke } from "@/lib/tauri";
import type { FileNode, FileContent } from "@/lib/types";
import { seedFileTree } from "@/mocks/seedFileTree";
import { seedFileContents } from "@/mocks/seedFileContents";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Language detection by extension (frontend responsibility).
const LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  rs: "rust", py: "python", json: "json", md: "markdown",
  css: "css", html: "html", toml: "toml", yaml: "yaml", yml: "yaml",
};
function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_MAP[ext] ?? "text";
}

/** Open a native folder picker. Returns the absolute path of the chosen folder,
 *  or null if the user cancelled. No-op in web mode (returns null). */
export async function fsOpenFolder(): Promise<string | null> {
  if (!inTauri) return null;
  return invoke<string | null>("fs_open_folder");
}

/** Read the recursive directory tree rooted at the current workspace.
 *  In web mode returns seedFileTree unchanged (prototype data). */
export async function fsReadDir(): Promise<FileNode[]> {
  if (!inTauri) return seedFileTree;
  return invoke<FileNode[]>("fs_read_dir");
}

/** Read a workspace-relative file path.
 *  In web mode looks up seedFileContents, returning an empty FileContent
 *  if the path is unknown (never throws). */
export async function fsReadFile(path: string): Promise<FileContent> {
  if (!inTauri) {
    return (seedFileContents as any)[path] ?? { lang: langFromPath(path), text: "" };
  }
  const text = await invoke<string>("fs_read_file", { path });
  return { lang: langFromPath(path), text };
}

/** Write content to a workspace-relative file path.
 *  In web mode is a silent no-op. */
export async function fsWriteFile(path: string, content: string): Promise<void> {
  if (!inTauri) return;
  await invoke<void>("fs_write_file", { path, content });
}
```

Key points:
- `seedFileTree` and `seedFileContents` are **not deleted** in B1. They are
  retained as the web-mode fallback and as the bootstrap data for a fresh
  install experience during development.
- `src/lib/tauri.ts` retains its existing `mocks.fs_read_dir` and
  `mocks.fs_read_file` entries as a second line of defense for any direct
  `invoke()` calls that bypass `src/lib/fs.ts`.
- `pnpm dev` (web mode) continues working without any Tauri runtime.

---

## 7. The `save-file` Enablement Plan

### What `CommandContext` must gain

Today (`src/lib/commands.ts:22-57`), `CommandContext` has `openFiles` and
`activeFile` but no access to file content or a save function. The following
fields must be added to the `CommandContext` interface:

```typescript
// In CommandContext:
fileContents: Record<string, FileContent>;
setFileContents: React.Dispatch<React.SetStateAction<Record<string, FileContent>>>;
saveFile: (path: string) => Promise<void>;
saveAll: () => Promise<void>;
```

### Where these thread through `RootLayout`

In `RootLayout.tsx`, the `cmdCtx` useMemo (lines 469-496) is the assembly point.
Two additions are required:

1. A `saveFile` async function defined in `RootLayout` scope:
   ```typescript
   const saveFile = useCallback(async (path: string) => {
     const content = fileContents[path];
     if (!content) return;
     await fsWriteFile(path, content.text);
     setFileContents(c => ({
       ...c,
       [path]: { ...c[path], dirty: false, original: content.text },
     }));
   }, [fileContents, setFileContents]);
   ```

2. A `saveAll` that maps over all dirty files:
   ```typescript
   const saveAll = useCallback(async () => {
     const dirty = openFiles.filter(p => fileContents[p]?.dirty);
     await Promise.all(dirty.map(saveFile));
   }, [openFiles, fileContents, saveFile]);
   ```

3. Add `fileContents`, `setFileContents`, `saveFile`, `saveAll` to the `cmdCtx`
   useMemo and its dependency array. This is purely additive — no existing
   fields change.

### Changes to `commands.ts`

```typescript
// save-file: flip when, implement run
{
  id: "save-file",
  title: "Save file",
  category: "File",
  keybinding: ["Cmd", "S"],
  when: (ctx) => ctx.currentView === "code" && ctx.activeFile !== null,
  run: (ctx) => ctx.saveFile(ctx.activeFile!),
},

// save-all
{
  id: "save-all",
  title: "Save all",
  category: "File",
  keybinding: ["Cmd", "Alt", "S"],
  when: (ctx) => ctx.currentView === "code",
  run: (ctx) => ctx.saveAll(),
},
```

The `when` predicate for `save-file` gates on both `currentView === "code"` and
`activeFile !== null` — the command stays hidden in web mode because
`activeFile` will be set but `saveFile` becomes a no-op via `fsWriteFile`'s
`!inTauri` guard, which is an acceptable safety net. However, making the save
commands visible in web mode is fine — they will silently succeed (no actual
disk write happens), and the `dirty` flag will still clear. Whether to hide or
show in web mode is an open question (see Section 9).

### Dirty-flag lifecycle

`CodeView.onChange` (views-code.tsx:18-22) already sets `dirty: true` on every
keystroke. `saveFile` above clears it on successful write and updates `original`
(enabling the diff view to compare against the last-saved baseline). No changes
to `CodeView` itself are needed for B1-B.

### `open-folder` command

A new command should be added alongside save-file in B1-B:

```typescript
{
  id: "open-folder",
  title: "Open Folder…",
  category: "File",
  keybinding: ["Cmd", "Shift", "O"],
  run: async (ctx) => {
    const root = await fsOpenFolder();
    if (!root) return;
    const tree = await fsReadDir();
    ctx.setFileTree(tree);
    ctx.setOpenFiles([]);
    ctx.setActiveFile(null);
    ctx.setFileContents({});
  },
},
```

This requires adding `setFileTree`, `setOpenFiles`, `setActiveFile`,
`setFileContents` (the dispatchers) to `CommandContext`. These are already in
`ShellContext` — the pattern is established.

### Stale state on workspace change

`RootLayout.tsx:318-321` hardcodes three seed paths as the initial `openFiles`.
When a real folder is opened, those paths will not exist in the real workspace.
The `open-folder` command run above must clear `openFiles`, `activeFile`, and
`fileContents` before setting the new tree. A "welcome screen" state
(neither `activeFile` nor any open files) should render the
`"No file open. Pick one from the explorer."` message already present in
`CodeView` (views-code.tsx:47-48).

---

## 8. Test Surface Note

| Pass | Verification |
|---|---|
| **B1-A** | `cargo check` (Rust type-safety). `pnpm typecheck` (TS boundary). Manual smoke in `pnpm tauri dev`: devtools console `invoke("fs_open_folder")` → picker opens; `invoke("fs_read_dir")` → real JSON tree; `invoke("fs_read_file", {path: "README.md"})` → file text; `invoke("fs_write_file", {path: "README.md", content: "test"})` then verify on disk. |
| **B1-B** | All of the above, plus: UI interaction — click file in SideFiles, text loads in CodeMirror, edit, Cmd+S, verify file on disk changes, dirty dot clears. `pnpm dev` (web mode): SideFiles still shows `seedFileTree`, CodeMirror still shows seed content, Cmd+S silently succeeds. |
| **B1-C** | Tauri-mode only: create a file outside the app in Explorer, verify tree updates within watch debounce window. |

No automated test runner is configured (confirmed by CLAUDE.md). The verification
gates are `cargo check`, `pnpm typecheck`/`pnpm build`, and manual Tauri-mode
smoke tests. A Playwright web-mode test suite could cover the mock path without
Tauri, but that infrastructure does not exist today.

Real filesystem integration tests (creating a temp dir, invoking commands,
asserting output) could be added as Rust integration tests under
`src-tauri/tests/` in a future pass — this is the recommended long-term approach
for security regression coverage of `safe_resolve`.

---

## 9. Open Questions for Human Decision

1. **Ignored patterns — `.gitignore` parsing.** Should B1 respect `.gitignore`
   rules, or only apply the hardcoded ignore list? The `ignore` crate supports
   `.gitignore` parsing. Recommended: defer to a B1.5 pass. If the answer is
   "yes for B1", `ignore` must be added to Cargo.toml and the walk logic
   substantially changes.

2. **Save in web mode — visible or hidden?** The `save-file` command can either
   be shown (silently succeeds as a no-op via the `!inTauri` guard in
   `fsWriteFile`) or hidden (`when` predicate adds `inTauri`). Showing it gives
   a consistent command palette experience across modes; hiding it avoids
   confusing a developer who expects disk I/O.

3. **Auto-save on tab close.** When a user closes a dirty tab (the `×` in
   `CodeView.closeTab`), should the app: (a) silently discard, (b) show a
   confirm dialog (requires `tauri-plugin-dialog:allow-message`), or (c) prompt
   in a custom React modal? Currently it silently discards (views-code.tsx:11-16).

4. **Session restore — last workspace root.** The spec recommends persisting the
   workspace root to the `settings` table and restoring it on startup. Should
   the tree be reloaded automatically on startup (reopening the last folder), or
   should the user always click "Open Folder" explicitly each session?

5. **`FsEntry` vs `FileNode` unification.** The Rust `FsEntry` struct and the
   TS `FileNode` type are structurally compatible but not identical (`FsEntry`
   has `is_dir: bool`; `FileNode` uses `children?: FileNode[]` as the
   dir-discriminant). Should the IPC shape be made to match `FileNode` exactly
   (rename `is_dir` to `isDir`, always include `children: []` for files), or
   should `src/lib/fs.ts` translate between them? The latter is cleaner —
   the translation is trivial and keeps Rust idiomatic (snake_case, explicit
   bool flag).

6. **Maximum file size for editing.** 5 MiB is proposed. Is this too small for
   some source files (e.g. large generated JSON, minified bundles the user wants
   to inspect)? Should the limit be configurable via settings?

7. **`target/` ignore — Cargo workspace check.** The hardcoded ignore list
   includes `target`. This is correct for the Shugu project root but may be
   wrong if a user opens a non-Rust project. Is a content-aware ignore list
   (detect `Cargo.toml` before applying `target`) in scope, or is the blanket
   ignore sufficient?
