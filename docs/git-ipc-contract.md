# Git IPC Contract — Shugu Forge

**Status** : FROZEN. Source of truth shared between LOT 1 (Rust), LOT 2 (TS), LOT 3 (UI).
**Any signature change requires updating this file FIRST, then propagating to all consumers.**

Tous les types serde côté Rust utilisent `#[serde(rename_all = "camelCase")]`. Les enums tagged utilisent `#[serde(tag="kind", rename_all="camelCase", rename_all_fields="camelCase")]` (cf. memory `feedback_serde_enum_camel_case`).

Tous les paths qui traversent l'IPC sont **workspace-relative, forward-slash**, **sans préfixe `\\?\`** (cf. memory `feedback_windows_extended_path_prefix`). La normalisation se fait côté Rust avant retour.

CRLF est normalisé `\r\n` → `\n` sur tout output `git show` / `git diff` avant retour (déjà appliqué dans l'existant `git_show_head`).

---

## Types serde (Rust) / TypeScript

### GitFileStatus
```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,            // workspace-relative, forward-slash
    pub index_status: char,      // 'M' 'A' 'D' 'R' 'C' 'T' 'U' '?' ' '
    pub worktree_status: char,   // same alphabet
    pub is_conflicted: bool,
    pub is_staged: bool,         // derived: index_status != ' ' && index_status != '?'
    pub is_untracked: bool,      // index_status == '?'
}
```
```typescript
export interface GitFileStatus {
  path: string;
  indexStatus: string;     // single char
  worktreeStatus: string;  // single char
  isConflicted: boolean;
  isStaged: boolean;
  isUntracked: boolean;
}
```

### GitLogEntry
```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub oid: String,             // full 40-char SHA
    pub short_oid: String,       // 7-char SHA
    pub summary: String,         // first line of commit message
    pub message: String,         // full commit message
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,          // unix seconds (UTC)
    pub parents: Vec<String>,    // parent OIDs (1 normal, 2+ merge)
}
```
```typescript
export interface GitLogEntry {
  oid: string;
  shortOid: string;
  summary: string;
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  parents: string[];
}
```

### GitBranchList
```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchList {
    pub current: Option<String>,    // detached HEAD => None
    pub local: Vec<GitBranch>,
    pub remote: Vec<GitBranch>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,               // "main", "origin/feature/x"
    pub upstream: Option<String>,   // tracking branch if any
    pub ahead: u32,                 // commits ahead of upstream
    pub behind: u32,                // commits behind upstream
    pub last_commit_oid: String,
}
```
```typescript
export interface GitBranchList {
  current: string | null;
  local: GitBranch[];
  remote: GitBranch[];
}

export interface GitBranch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommitOid: string;
}
```

### GitBlameLine
```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameLine {
    pub line_number: u32,        // 1-indexed
    pub oid: String,             // commit OID for this line
    pub short_oid: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub summary: String,         // commit summary
    pub is_uncommitted: bool,    // true for lines not yet committed
}
```
```typescript
export interface GitBlameLine {
  lineNumber: number;
  oid: string;
  shortOid: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  summary: string;
  isUncommitted: boolean;
}
```

### GitStash
```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    pub index: u32,              // 0-indexed stash position
    pub oid: String,
    pub message: String,         // "WIP on main: ..."
    pub timestamp: i64,
}
```
```typescript
export interface GitStash {
  index: number;
  oid: string;
  message: string;
  timestamp: number;
}
```

### GitRemote
```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitRemote {
    pub name: String,            // "origin"
    pub url: String,             // fetch URL
    pub push_url: Option<String>,// only if different from fetch
}
```
```typescript
export interface GitRemote {
  name: string;
  url: string;
  pushUrl: string | null;
}
```

### DiffSource (enum côté TS, string-literal côté Rust args)
```typescript
export type DiffSource = "head" | "index" | "worktree";
```
Côté Rust : argument `vs: String` que la command parse en `match vs.as_str() { "head" => ..., "index" => ..., "worktree" => ..., _ => Err(...) }`.

---

## Commands (Rust) ↔ Wrappers (TS)

Chaque ligne : `command_rust(args_camel_case_as_serde_payload) → ReturnType` + wrapper TS dans `src/lib/git.ts`.

| Rust command | Args (JS payload) | Return | TS wrapper |
|---|---|---|---|
| `git_is_repo` (existant) | `()` | `bool` | `gitIsRepo(): Promise<boolean>` |
| `git_show_head` (existant) | `{ path: string }` | `Option<String>` | `gitShowHead(path: string): Promise<string \| null>` |
| `git_status` | `()` | `Vec<GitFileStatus>` | `gitStatus(): Promise<GitFileStatus[]>` |
| `git_diff_file` | `{ path: string, vs: DiffSource }` | `String` (unified diff text) | `gitDiffFile(path: string, vs: DiffSource): Promise<string>` |
| `git_stage` | `{ paths: string[] }` | `()` | `gitStage(paths: string[]): Promise<void>` |
| `git_unstage` | `{ paths: string[] }` | `()` | `gitUnstage(paths: string[]): Promise<void>` |
| `git_discard` | `{ paths: string[] }` | `()` | `gitDiscard(paths: string[]): Promise<void>` |
| `git_stage_hunk` | `{ path: string, hunkPatch: string }` | `()` | `gitStageHunk(path: string, hunkPatch: string): Promise<void>` |
| `git_unstage_hunk` | `{ path: string, hunkPatch: string }` | `()` | `gitUnstageHunk(path: string, hunkPatch: string): Promise<void>` |
| `git_commit` | `{ message: string, amend: bool }` | `String` (new commit OID) | `gitCommit(message: string, amend: boolean): Promise<string>` |
| `git_log` | `{ maxCount: u32, branch: Option<String> }` | `Vec<GitLogEntry>` | `gitLog(maxCount: number, branch?: string \| null): Promise<GitLogEntry[]>` |
| `git_branches` | `()` | `GitBranchList` | `gitBranches(): Promise<GitBranchList>` |
| `git_checkout` | `{ branch: string, create: bool }` | `()` | `gitCheckout(branch: string, create: boolean): Promise<void>` |
| `git_blame` | `{ path: string }` | `Vec<GitBlameLine>` | `gitBlame(path: string): Promise<GitBlameLine[]>` |
| `git_push` | `{ remote: string, branch: string }` | `String` (stdout summary) | `gitPush(remote: string, branch: string): Promise<string>` |
| `git_pull` | `{ remote: string, branch: string }` | `String` | `gitPull(remote: string, branch: string): Promise<string>` |
| `git_fetch` | `{ remote: Option<String> }` | `String` | `gitFetch(remote?: string \| null): Promise<string>` |
| `git_stash_list` | `()` | `Vec<GitStash>` | `gitStashList(): Promise<GitStash[]>` |
| `git_stash_save` | `{ message: Option<String> }` | `()` | `gitStashSave(message?: string \| null): Promise<void>` |
| `git_stash_apply` | `{ index: u32, pop: bool }` | `()` | `gitStashApply(index: number, pop: boolean): Promise<void>` |
| `git_remotes` | `()` | `Vec<GitRemote>` | `gitRemotes(): Promise<GitRemote[]>` |
| `git_remote_add` | `{ name: string, url: string }` | `()` | `gitRemoteAdd(name: string, url: string): Promise<void>` |
| `git_remote_remove` | `{ name: string }` | `()` | `gitRemoteRemove(name: string): Promise<void>` |

**IMPORTANT — argument naming JS** : Tauri 2 mappe automatiquement `path: String` (Rust) ↔ `{ path: "..." }` (JS) si le snake_case Rust est cohérent. Pour les args camelCase (`maxCount`, `hunkPatch`), la commande Rust doit utiliser `#[tauri::command(rename_all = "camelCase")]` OU renommer en snake_case. **Convention figée pour ce LOT** : `#[tauri::command(rename_all = "camelCase")]` sur chaque command qui prend un arg multi-mot. Les wrappers TS passent des objets camelCase au call `invoke()`.

---

## Tauri Events

| Event name | Payload | Source | Consumer |
|---|---|---|---|
| `git://changed` | `()` (vide) | `commands/git_watcher.rs` (debounce 300ms sur `.git/HEAD`, `.git/index`, `.git/refs/heads/*`, `.git/refs/remotes/*`, `.git/MERGE_HEAD`, `.git/ORIG_HEAD`) | `src/features/git/useEvents.ts` → `invalidateAllGit()` |

L'existant `fs://changed` continue à déclencher `invalidateAllGit()` également (cf. `src/features/fs/useEvents.ts:38`) — over-invalidation acceptable.

---

## Erreurs

Toutes les commands retournent `Result<T, String>` côté Rust → `Promise<T>` qui rejette avec `string` côté JS. Format error attendu :

- `"not a git repository"` — workspace n'est pas un repo
- `"no workspace open"` — aucun dossier ouvert (workspace_root vide)
- `"git error: <stderr_first_3_lines>"` — pour les commands CLI qui échouent
- `"libgit2: <description>"` — pour les commands git2 qui échouent
- `"<paths>: file not in repository"` — path inconnu
- Cas spécifiques (untracked, no commits) : `Ok(None)` ou `Ok(Vec::new())` selon return type, pas une erreur

---

## Conventions code

- **Strip `\\?\` prefix** sur tout path Windows retourné après `canonicalize`. Helper : `crate::commands::fs::strip_extended_prefix(p: PathBuf) -> PathBuf` (à ajouter si pas déjà présent dans `fs.rs`).
- **`workspace_root(app)`** existant (`git.rs:67`) — toujours réutiliser, NE PAS dupliquer.
- **`open_repo(app)`** — nouveau helper qui retourne `Result<git2::Repository, String>` en discoverant depuis `workspace_root`.
- **Caching** : `REPO_CACHE` existant (`git.rs:55`) reste pour `git_is_repo`. Pas de cache pour status/log/blame (TanStack côté front s'en occupe).
- **Tests** : chaque command Rust avec au moins un test sur un repo temp créé/cleaned (pattern `fs.rs::tests::make_temp_dir`).
- **camelCase Tauri** : toujours `#[tauri::command(rename_all = "camelCase")]` quand l'arg est multi-mot.
