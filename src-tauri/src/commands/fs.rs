//! Real filesystem commands for the Shugu Forge workspace.
//!
//! ## Security model
//! All I/O is bounded to the `workspace_root` managed in Tauri state.
//! Two resolvers enforce containment:
//! - `safe_resolve` — for reads (file must exist; uses canonicalize).
//! - `safe_resolve_for_write` — for writes (file may be new; lexical
//!   normalization + ancestor canonicalize).
//!
//! No I/O is performed outside `workspace_root`.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single node in the workspace file tree.
#[derive(Serialize, Clone)]
pub struct FsEntry {
    pub name: String,
    /// Workspace-relative path, forward-slash normalised (never starts with `/`).
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FsEntry>,
}

// ---------------------------------------------------------------------------
// Ignore list
// ---------------------------------------------------------------------------

const IGNORED_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    ".venv",
    // `venv` SANS point : convention Python tout aussi répandue que `.venv`.
    // Son absence a laissé un virtualenv de 76k fichiers entrer dans l'index
    // sémantique (2026-07). PAS de `env` en revanche : trop de faux positifs
    // (`src/env/`…) — ce cas est couvert par le .gitignore du workspace.
    "venv",
    "site-packages",
    ".tox",
    ".nox",
    "__pypackages__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    ".playwright-mcp",
    ".pcc",
    ".DS_Store",
    ".svn",
    ".hg",
];

/// Noms exclus de l'INDEXATION sémantique mais VISIBLES dans l'arbre de
/// fichiers : internes à Shugu ou aux harnais d'agents, jamais du code du
/// projet. `.shugu-snippets` doit rester navigable (la fonctionnalité
/// « ouvrir dans l'éditeur » y écrit des fichiers que l'utilisateur édite),
/// et `.claude/` peut contenir des worktrees entiers — les indexer
/// dupliquerait tout le repo dans `vec_code` (36k vecteurs constatés).
const INDEX_IGNORED_NAMES: &[&str] = &[".claude", ".shugu", ".shugu-forge", ".shugu-snippets"];

/// Suffixes (extensions) ignored to prevent feedback loops with the
/// debug `trace-*.log` files captured by `tauri-dev.cmd > trace.log`
/// (cf. CLAUDE.md "Diagnostic cross-process"). Without this, every log
/// write triggers fs://changed → tree invalidate → js diag log →
/// another trace write → ... a tight loop that saturates IPC.
const IGNORED_SUFFIXES: &[&str] = &[".log"];

// Phase 7 #10 (option A) — priorité d'indexation sémantique. Sur un gros repo
// (ML : 30k+ fichiers réels), le budget `max_files` est rempli AVEC LE CODE
// d'abord, puis la config/markup, puis le reste (dumps de données .txt/.csv/…).
// Tri stable AVANT le cap → ce sont les données qui sautent, jamais le code.
// Une mémoire sémantique de CODE doit indexer du code, pas des dumps.
const CODE_EXTS: &[&str] = &[
    // ipynb : notebooks Jupyter = code principal des repos ML (revue [2]).
    "py", "pyi", "ipynb", "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "java", "kt",
    "kts", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "cs", "rb", "php",
    "swift", "scala", "sh", "bash", "zsh", "fish", "ps1", "lua", "r", "jl", "dart",
    "ex", "exs", "erl", "hrl", "hs", "ml", "mli", "clj", "cljs", "cljc", "vue",
    "svelte", "astro", "sql", "graphql", "gql", "proto", "md", "mdx", "rst", "adoc",
];
const CONFIG_EXTS: &[&str] = &[
    "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "html",
    "htm", "css", "scss", "sass", "less", "gradle", "cmake", "tf", "env",
];

/// Fichiers SANS extension qui sont du code/build (revue [1]) : sinon ils
/// tombent en tier 2 (données) et sautent avant un vulgaire .csv.
const EXTENSIONLESS_CODE_NAMES: &[&str] = &[
    "makefile", "dockerfile", "gemfile", "rakefile", "procfile", "jenkinsfile",
    "vagrantfile", "brewfile", "containerfile", "justfile",
];

/// Tier de priorité d'indexation : 0 = code/docs, 1 = config/markup, 2 = autre
/// (données / texte divers). `ext` est déjà en minuscules.
fn index_tier(ext: &str) -> u8 {
    if CODE_EXTS.contains(&ext) {
        0
    } else if CONFIG_EXTS.contains(&ext) {
        1
    } else {
        2
    }
}

/// Tier d'un fichier d'après son NOM + extension. Gère le cas sans extension
/// (Makefile, Dockerfile…) qui serait sinon classé en données. `name` est le
/// nom de fichier (pas le chemin) ; `ext` sa dernière extension en minuscules.
fn index_tier_for_file(name: &str, ext: &str) -> u8 {
    if !ext.is_empty() {
        return index_tier(ext);
    }
    if EXTENSIONLESS_CODE_NAMES.contains(&name.to_lowercase().as_str()) {
        0
    } else {
        2
    }
}

pub(crate) fn is_ignored(name: &str) -> bool {
    // Case-insensitive on Windows, case-sensitive on macOS/Linux.
    #[cfg(target_os = "windows")]
    {
        if IGNORED_NAMES
            .iter()
            .any(|&n| n.eq_ignore_ascii_case(name))
        {
            return true;
        }
        return IGNORED_SUFFIXES
            .iter()
            .any(|&s| name.to_ascii_lowercase().ends_with(s));
    }
    #[cfg(not(target_os = "windows"))]
    {
        if IGNORED_NAMES.contains(&name) {
            return true;
        }
        return IGNORED_SUFFIXES.iter().any(|&s| name.ends_with(s));
    }
}

/// Filtre d'INDEXATION : tout ce que `is_ignored` couvre, PLUS les répertoires
/// internes (`INDEX_IGNORED_NAMES`) qui restent visibles dans l'arbre mais ne
/// doivent jamais nourrir `vec_code`. Utilisé par `fs_list_files` (walk de
/// l'indexeur), `watcher::plan_reindex` (reindex incrémental) et
/// `vector::purge_ignored_chunks` (purge au boot) — les trois DOIVENT partager
/// la même définition, sinon le watcher ré-insère ce que la purge supprime.
pub(crate) fn is_index_ignored(name: &str) -> bool {
    if is_ignored(name) {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        INDEX_IGNORED_NAMES
            .iter()
            .any(|&n| n.eq_ignore_ascii_case(name))
    }
    #[cfg(not(target_os = "windows"))]
    {
        INDEX_IGNORED_NAMES.contains(&name)
    }
}

/// Matcher `.gitignore` du workspace pour l'INDEXATION sémantique.
///
/// Seul le `.gitignore` RACINE est lu (pas les imbriqués ni les excludes
/// globaux) : c'est lui qui porte `venv/`, `dist/`, les dossiers de données…
/// dans l'immense majorité des repos, et un seul fichier à parser garde le
/// coût négligeable au flush du watcher. `None` si absent ou illisible ; les
/// lignes invalides sont ignorées une à une par le builder (comportement git).
pub(crate) fn build_workspace_gitignore(root: &Path) -> Option<ignore::gitignore::Gitignore> {
    let file = root.join(".gitignore");
    if !file.is_file() {
        return None;
    }
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    if builder.add(&file).is_some() {
        return None; // erreur I/O sur le fichier entier
    }
    builder.build().ok()
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/// Resolve a workspace-relative path for **reading**.
///
/// The file must already exist on disk (we call `canonicalize` on the full
/// joined path).  Rejects null bytes, absolute `rel`, and traversal sequences
/// that escape the workspace root.
///
/// `root` must be pre-canonicalized (done once in `fs_open_folder`).
pub fn safe_resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') {
        return Err("invalid path: null byte".into());
    }
    // Reject absolute paths from the frontend (they would bypass the root join).
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("invalid path: must be relative".into());
    }
    let joined = root.join(rel_path);
    // canonicalize resolves `..`, symlinks, and normalises separators.
    // It errors if the path does not exist — correct for reads.
    let canonical = std::fs::canonicalize(&joined)
        .map_err(|e| format!("path not found: {e}"))?;
    if !canonical.starts_with(root) {
        return Err("path escapes workspace root".into());
    }
    Ok(canonical)
}

/// Resolve a workspace-relative path for **writing**.
///
/// The target file need not exist yet.  We:
/// 1. Reject null bytes and absolute `rel`.
/// 2. Lexically normalise `rel` via `Path::components()`, rejecting any `..`,
///    root-dir, or prefix component — a legitimate workspace path never needs
///    these.
/// 3. Join to `root` (guaranteed-in-root after step 2).
/// 4. Canonicalize the deepest *existing* ancestor directory and assert it
///    `starts_with(root)` to catch symlinked directories.
///
/// Only after all checks pass does the caller proceed to `create_dir_all` + write.
pub fn safe_resolve_for_write(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains('\0') {
        return Err("invalid path: null byte".into());
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("invalid path: must be relative".into());
    }

    // Lexical normalisation: rebuild the path component by component.
    let mut normalized = PathBuf::new();
    for component in rel_path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {} // `.` — skip
            // `..`, absolute prefix, root — all rejected.
            Component::ParentDir => {
                return Err("invalid path: parent directory traversal".into())
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("invalid path: must be relative".into())
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("invalid path: empty after normalization".into());
    }

    let target = root.join(&normalized);

    // Find the deepest ancestor directory that actually exists on disk and
    // canonicalize it to catch symlinked directory escapes.
    let mut ancestor = target.as_path();
    loop {
        match ancestor.parent() {
            Some(p) => ancestor = p,
            None => break,
        }
        if ancestor.exists() {
            break;
        }
    }

    // If even root doesn't exist (edge-case during tests), fall back to root.
    let check_base = if ancestor.exists() {
        ancestor
    } else {
        root
    };

    let canonical_ancestor = std::fs::canonicalize(check_base)
        .map_err(|e| format!("cannot canonicalize ancestor directory: {e}"))?;

    if !canonical_ancestor.starts_with(root) {
        return Err("path escapes workspace root".into());
    }

    Ok(target)
}

// ---------------------------------------------------------------------------
// SQLite helper for settings (workspace_root persistence)
// ---------------------------------------------------------------------------

/// Open a bare rusqlite connection to `shugu.db` in the app config directory.
/// Mirrors the pattern in `vector.rs:get_conn` but without the OnceLock cache
/// (settings access is infrequent — one open/close per call is acceptable).
fn open_settings_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?
        .join("shugu.db");
    let conn =
        Connection::open(&db_path).map_err(|e| format!("rusqlite open {}: {e}", db_path.display()))?;
    // Ensure the settings table exists even on a fresh install before
    // tauri-plugin-sql has run its migrations (idempotent — no-ops if the
    // table was already created by the plugin).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings \
         (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
    )
    .map_err(|e| format!("ensure settings table: {e}"))?;
    Ok(conn)
}

fn persist_workspace_root(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    let conn = open_settings_db(app)?;
    let value = root.to_string_lossy().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        params!["workspace_root", value, now],
    )
    .map_err(|e| format!("persist workspace_root: {e}"))?;
    Ok(())
}

/// Read `workspace_root` from the settings table.  Returns `None` if the row
/// doesn't exist or the path no longer exists on disk.  Never panics.
pub fn restore_workspace_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let conn = open_settings_db(app).ok()?;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'workspace_root'",
            [],
            |row| row.get(0),
        )
        .ok();
    let value = value?;
    let path = PathBuf::from(&value);
    // Canonicalize the restored path; silently return None if it no longer exists.
    let canonical = std::fs::canonicalize(&path).ok()?;
    if canonical.is_dir() {
        Some(canonical)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Tree builder (used by fs_read_dir)
// ---------------------------------------------------------------------------

const MAX_ENTRIES: usize = 5_000;

/// Build a nested `Vec<FsEntry>` from a flat walkdir iterator.
/// Entries are sorted: directories first, then files, both alphabetical.
fn build_tree(root: &Path, entries: Vec<walkdir::DirEntry>) -> Vec<FsEntry> {
    // We need to reconstruct the hierarchy from the flat list.
    // Use a recursive helper: given a parent path, collect immediate children
    // from `entries`, then recurse.
    fn collect_children(
        parent: &Path,
        root: &Path,
        all_entries: &[walkdir::DirEntry],
        depth: usize,
    ) -> Vec<FsEntry> {
        let mut children: Vec<FsEntry> = all_entries
            .iter()
            .filter(|e| e.path().parent() == Some(parent))
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let rel = e
                    .path()
                    .strip_prefix(root)
                    .unwrap_or(e.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                let is_dir = e.file_type().is_dir();
                let children = if is_dir && depth < 8 {
                    collect_children(e.path(), root, all_entries, depth + 1)
                } else {
                    vec![]
                };
                FsEntry {
                    name,
                    path: rel,
                    is_dir,
                    children,
                }
            })
            .collect();

        // Sort: directories first, then files, both alphabetical.
        children.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        children
    }

    collect_children(root, root, &entries, 1)
}

/// Like `build_tree`, but the hierarchy is reconstructed starting at `start`
/// (a subdirectory of `root`) instead of `root` itself, while paths stay
/// workspace-relative (stripped against `root`).
///
/// `build_tree` anchors its recursion at `root`: its first level only keeps
/// entries whose `.parent()` equals `root`. That is correct for a whole-tree
/// walk (where the shallowest entries ARE direct children of `root`), but WRONG
/// for a scoped walk whose shallowest entries are children of `start` (two or
/// more levels below `root`) — the first level would match nothing and the
/// whole tree would come back empty. We therefore anchor recursion at `start`
/// while keeping `root` as the path-stripping base.
fn build_subtree(root: &Path, start: &Path, entries: Vec<walkdir::DirEntry>) -> Vec<FsEntry> {
    fn collect_children(
        parent: &Path,
        root: &Path,
        all_entries: &[walkdir::DirEntry],
        depth: usize,
    ) -> Vec<FsEntry> {
        let mut children: Vec<FsEntry> = all_entries
            .iter()
            .filter(|e| e.path().parent() == Some(parent))
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let rel = e
                    .path()
                    .strip_prefix(root)
                    .unwrap_or(e.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                let is_dir = e.file_type().is_dir();
                let children = if is_dir && depth < 12 {
                    collect_children(e.path(), root, all_entries, depth + 1)
                } else {
                    vec![]
                };
                FsEntry {
                    name,
                    path: rel,
                    is_dir,
                    children,
                }
            })
            .collect();

        children.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        children
    }

    collect_children(start, root, &entries, 1)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Shared tail of `fs_open_folder` / `fs_set_workspace_root` : canonicalize,
/// store in managed state, persist to settings, rewire both watchers, and
/// broadcast `workspace://changed` so anything anchored to the OLD root can
/// react — notably the integrated terminal, which respawns its PTY in the new
/// directory (VS Code behaviour). These two commands are the ONLY runtime
/// mutations of `root_state` (Studio's openProject writes to .shugu-forge/
/// preview without touching it), so this single emit covers every switch.
fn apply_workspace_root(
    app: &tauri::AppHandle,
    root_state: &tauri::State<'_, Mutex<Option<PathBuf>>>,
    watcher_ctl: &tauri::State<'_, crate::commands::watcher::WatcherCtl>,
    git_watcher_ctl: &tauri::State<'_, crate::commands::git_watcher::WatcherCtl>,
    raw_path: &Path,
) -> Result<String, String> {
    let canonical = std::fs::canonicalize(raw_path)
        .map_err(|e| format!("canonicalize workspace: {e}"))?;

    // Store in managed state.
    // Forme IPC/affichage : préfixe verbatim `\\?\` retiré. Le STATE garde le
    // chemin canonicalisé COMPLET (contrat safe_resolve/watchers/terminal/lsp),
    // mais le frontend ne doit JAMAIS voir le préfixe — il compare/relativise
    // contre des chemins de dialog/git qui n'en ont pas.
    let display = super::pathutil::strip_extended_prefix(canonical.clone())
        .to_string_lossy()
        .to_string();
    {
        let mut guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        *guard = Some(canonical.clone());
    }

    // Persist to settings table (best-effort — don't fail the command on DB error).
    let _ = persist_workspace_root(app, &canonical);

    // Notify both watchers of the new root (best-effort — never fail the command).
    let _ = watcher_ctl.0.send(canonical.clone());
    let _ = git_watcher_ctl.0.send(canonical);

    // Payload is the display path (forward-slash, no `\\?\`) for the frontend.
    let _ = app.emit("workspace://changed", display.replace('\\', "/"));

    Ok(display)
}

/// Open a native folder picker and set the workspace root.
///
/// Returns the chosen folder's absolute path, or `null` if the user cancelled.
#[tauri::command(async)]
pub fn fs_open_folder(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
    watcher_ctl: tauri::State<'_, crate::commands::watcher::WatcherCtl>,
    git_watcher_ctl: tauri::State<'_, crate::commands::git_watcher::WatcherCtl>,
) -> Result<Option<String>, String> {
    // Show blocking native folder picker.
    let picked = app.dialog().file().blocking_pick_folder();
    let file_path = match picked {
        Some(p) => p,
        None => return Ok(None), // user cancelled
    };

    let raw_path = file_path
        .into_path()
        .map_err(|e| format!("invalid path from dialog: {e}"))?;

    apply_workspace_root(&app, &root_state, &watcher_ctl, &git_watcher_ctl, &raw_path).map(Some)
}

/// Set the workspace root from a KNOWN absolute path — the « projets récents »
/// path (lot 2026-06-10) : pas de dialog, même canonicalize/persist/watchers/
/// broadcast que `fs_open_folder`. Rejette un chemin qui n'est pas un dossier
/// existant pour qu'une entrée récente périmée échoue avec un message propre.
#[tauri::command(async)]
pub fn fs_set_workspace_root(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
    watcher_ctl: tauri::State<'_, crate::commands::watcher::WatcherCtl>,
    git_watcher_ctl: tauri::State<'_, crate::commands::git_watcher::WatcherCtl>,
    path: String,
) -> Result<String, String> {
    let raw = PathBuf::from(&path);
    if !raw.is_dir() {
        return Err(format!("dossier introuvable : {path}"));
    }
    apply_workspace_root(&app, &root_state, &watcher_ctl, &git_watcher_ctl, &raw)
}

/// List the IMMEDIATE children of one directory (lazy tree loading).
///
/// `rel` is a workspace-relative dir path (forward-slash), or `None`/empty for
/// the workspace root. Returns ONE level: each child carries `is_dir` and an
/// empty `children` vec (the UI fetches a folder's children on first expand).
///
/// This is what the file-explorer UI uses, so a huge project (Comfyui = 98k
/// entries, node-heavy ML trees) opens instantly instead of failing the 5000-
/// entry cap of the recursive `fs_read_dir` (which stays for the bulk indexer).
///
/// Containment: the root is canonicalized; `rel` is resolved with `safe_resolve`
/// (rejects traversal / symlink escape). Returns `Err("no workspace open")` when
/// no folder is open, or `Err` if `rel` is not a directory inside the root.
#[tauri::command(async)]
pub fn fs_read_dir_shallow(
    rel: Option<String>,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<Vec<FsEntry>, String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };

    // Resolve the directory to list: the root itself, or a relative subdir.
    let dir = match rel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => root.clone(),
        Some(r) => {
            let resolved = safe_resolve(&root, r)?;
            if !resolved.is_dir() {
                return Err(format!("not a directory: {r}"));
            }
            resolved
        }
    };

    let read = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
    let mut children: Vec<FsEntry> = Vec::new();
    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[fs_read_dir_shallow] skipping entry: {e}");
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored(&name) {
            continue;
        }
        // file_type() avoids a full stat where possible; fall back to is_dir().
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or(false);
        // Workspace-relative, forward-slash path. Derive from the listed dir's
        // path relative to root, then append the child name — robust to the
        // `\\?\` prefix because we strip the canonicalized root prefix.
        let child_abs = entry.path();
        let rel_path = child_abs
            .strip_prefix(&root)
            .unwrap_or(&child_abs)
            .to_string_lossy()
            .replace('\\', "/");
        children.push(FsEntry {
            name,
            path: rel_path,
            is_dir,
            children: Vec::new(), // lazy — fetched on expand
        });
    }

    // Sort: directories first, then files, both case-insensitive alphabetical.
    children.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(children)
}

/// Walk the workspace root and return a recursive directory tree.
///
/// Returns `Err("no workspace open")` if no folder has been opened yet.
#[tauri::command(async)]
pub fn fs_read_dir(
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<Vec<FsEntry>, String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };

    // TODO: add .gitignore parsing (deferred to B1.5).

    let mut flat_entries: Vec<walkdir::DirEntry> = Vec::new();
    let mut count = 0usize;

    let walker = WalkDir::new(&root)
        .follow_links(false)
        .max_depth(8)
        .min_depth(1) // exclude the root itself
        .into_iter()
        .filter_entry(|e| {
            // Filter out ignored directory names.
            let name = e.file_name().to_string_lossy();
            !is_ignored(&name)
        });

    for result in walker {
        match result {
            Ok(entry) => {
                count += 1;
                if count > MAX_ENTRIES {
                    return Err(
                        "workspace too large (>5000 entries); open a subdirectory".to_string()
                    );
                }
                flat_entries.push(entry);
            }
            Err(e) => {
                // Broken symlinks, permission errors — log and continue.
                eprintln!("[fs_read_dir] skipping entry: {e}");
            }
        }
    }

    Ok(build_tree(&root, flat_entries))
}

/// Recursive directory tree rooted at a SUBPATH of the workspace (not the whole
/// root). `rel` is a workspace-relative dir (forward-slash); `None`/empty falls
/// back to the whole-root `fs_read_dir` behaviour. No 5000-entry cap: callers
/// use this on small, known subtrees (e.g. Studio's `.shugu-forge/preview/`),
/// so the cap that protects the file-explorer's eager whole-tree render doesn't
/// apply. Paths are full workspace-relative (so `fs_read_file`/`openFile` still
/// resolve). Same `is_ignored` filter + dir-first sort as `fs_read_dir`.
#[tauri::command(async)]
pub fn fs_read_dir_scoped(
    rel: Option<String>,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<Vec<FsEntry>, String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };

    // Resolve the subtree root. `safe_resolve` enforces containment + rejects
    // traversal; an absent/empty `rel` means "the workspace root itself".
    let base = match rel.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => root.clone(),
        Some(r) => {
            let resolved = safe_resolve(&root, r)?;
            if !resolved.is_dir() {
                // Not a dir (or doesn't exist yet, e.g. preview not generated):
                // return empty rather than erroring — callers treat [] as "none".
                return Ok(Vec::new());
            }
            resolved
        }
    };

    let mut flat_entries: Vec<walkdir::DirEntry> = Vec::new();
    let walker = WalkDir::new(&base)
        .follow_links(false)
        .max_depth(12)
        .min_depth(1)
        .into_iter()
        .filter_entry(|e| !is_ignored(&e.file_name().to_string_lossy()));
    for result in walker {
        match result {
            Ok(entry) => flat_entries.push(entry),
            Err(e) => eprintln!("[fs_read_dir_scoped] skipping entry: {e}"),
        }
    }
    // `build_subtree` reconstructs the hierarchy starting at `base` (the
    // scoped subtree's actual root — the shallowest walked entries are its
    // children), while deriving each node's path relative to the workspace
    // `root` (so paths stay workspace-relative and usable by fs_read_file).
    // Using `build_tree` here would anchor recursion at `root` and, since no
    // walked entry is a direct child of `root`, return an empty tree.
    Ok(build_subtree(&root, &base, flat_entries))
}

/// Flat list of workspace-relative FILE paths (no directories), for the vector
/// indexer. Walks WITHOUT the 5000-entry tree cap — that cap guards the eager
/// DOM render of the file explorer, irrelevant to a background indexer. Applies:
///   - `is_index_ignored` (node_modules/target/venv/.claude/…, pruned mid-walk),
///   - le `.gitignore` RACINE du workspace (répertoires élagués pendant le walk),
///   - an `exclude_exts` filter (binaries/models/datasets) BEFORE counting, so
///     a 98k-file ML project's `.safetensors`/`.png` never enter the budget,
///   - a `max_files` budget; when exceeded, returns what fit + `truncated:true`
///     and the total seen, so the caller can SHOW what was dropped (never a
///     silent cap, never a hard fail).
// `rename_all = "camelCase"` so `total_seen` serializes as `totalSeen` to match
// the TS `FileListResult` interface (cf. workspaceIndexer's `{ totalSeen }`).
// Tauri converts camelCase ARGUMENT keys to snake_case, but return values are
// plain serde — without this, the TS side reads `totalSeen` as `undefined` and
// the truncation toast renders "sur undefined".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListResult {
    pub paths: Vec<String>,
    pub truncated: bool,
    /// Total code-eligible files seen before the budget cut in (>= paths.len()).
    pub total_seen: usize,
}

#[tauri::command(async)]
pub fn fs_list_files(
    exclude_exts: Vec<String>,
    max_files: usize,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<FileListResult, String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };

    // Lowercased extension set for O(1) membership (case-insensitive).
    let excluded: std::collections::HashSet<String> =
        exclude_exts.iter().map(|e| e.to_lowercase()).collect();

    // (rel, tier) — on collecte AU-DELÀ de `max_files` (borné par HARD_LIST_CAP)
    // puis on TRIE par priorité (code d'abord) avant de tronquer au budget.
    const HARD_LIST_CAP: usize = 200_000; // garde-fou mémoire (repos pathologiques)
    let mut scored: Vec<(String, u8)> = Vec::new();
    let mut total_seen = 0usize;

    // Matcher .gitignore racine construit UNE fois avant le walk. Il prune les
    // RÉPERTOIRES ignorés pendant la descente (pas seulement les fichiers) —
    // sans quoi on traverserait 76k entrées d'un venv pour les jeter une à une.
    let gitignore = build_workspace_gitignore(&root);
    let root_for_filter = root.clone();
    let walker = WalkDir::new(&root)
        .follow_links(false)
        .max_depth(24) // deep enough for real source trees; dirs pruned by the filter
        .min_depth(1)
        .into_iter()
        .filter_entry(move |e| {
            // depth 0 = la racine elle-même : toujours traversée, même si le
            // dossier du workspace porte lui-même un nom « ignoré » (workspace
            // ouvert directement sur un dossier nommé build/, dist/…).
            if e.depth() == 0 {
                return true;
            }
            if is_index_ignored(&e.file_name().to_string_lossy()) {
                return false;
            }
            if let Some(gi) = &gitignore {
                // Chemin RELATIF au root : le matcher est ancré là, et cela
                // neutralise le préfixe verbatim `\\?\` des chemins canonisés
                // Windows (les deux côtés du strip_prefix le portent).
                let rel = e.path().strip_prefix(&root_for_filter).unwrap_or(e.path());
                if gi.matched(rel, e.file_type().is_dir()).is_ignore() {
                    return false;
                }
            }
            true
        });

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[fs_list_files] skipping entry: {e}");
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        let ext = name
            .rsplit_once('.')
            .map(|(_, e)| e.to_lowercase())
            .unwrap_or_default();
        // Extension filter BEFORE the budget so binaries/models never consume it.
        if !ext.is_empty() && excluded.contains(&ext) {
            continue;
        }
        total_seen += 1;
        // Collecte au-delà de max_files (jusqu'au garde-fou) pour pouvoir
        // prioriser le code AVANT de tronquer. total_seen compte TOUT.
        if scored.len() < HARD_LIST_CAP {
            let abs = entry.path();
            let rel = abs
                .strip_prefix(&root)
                .unwrap_or(abs)
                .to_string_lossy()
                .replace('\\', "/");
            scored.push((rel, index_tier_for_file(&name, &ext)));
        }
    }

    // Priorise code (0) > config (1) > autre/données (2). `sort_by_key` est STABLE
    // → l'ordre de walk est préservé dans chaque tier. La troncature au budget
    // fait donc sauter les fichiers de données en premier, jamais le code.
    scored.sort_by_key(|(_, tier)| *tier);
    let truncated = total_seen > max_files;
    scored.truncate(max_files);
    let paths: Vec<String> = scored.into_iter().map(|(rel, _)| rel).collect();

    Ok(FileListResult {
        paths,
        truncated,
        total_seen,
    })
}

/// Read a workspace-relative file path and return its content as a string.
///
/// Rejects binary files (null bytes in first 8 KiB) and files over 5 MiB.
/// Delegates to `read_file_inner` (the agent-tools core, defined below) with
/// no soft cap — same guards, single implementation.
#[tauri::command(async)]
pub fn fs_read_file(
    path: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<String, String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };
    read_file_inner(&root, &path, None)
}

/// One entry of `fs_read_files`. `content: None` means the file could not be
/// read (renamed/deleted/binary/too large) — callers skip those silently,
/// matching the per-file catch the boot restoration used to do around
/// individual `fs_read_file` invokes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredFile {
    pub path: String,
    pub content: Option<String>,
}

/// Read MANY workspace-relative files in ONE IPC round-trip.
///
/// Boot-time open-tabs restoration used to issue one `fs_read_file` invoke
/// per persisted tab (N round-trips + 2 React setState per file). This batch
/// returns everything at once; the result vec mirrors the order of `paths`.
#[tauri::command(async)]
pub fn fs_read_files(
    paths: Vec<String>,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<Vec<RestoredFile>, String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };
    Ok(paths
        .into_iter()
        .map(|path| {
            let content = read_file_inner(&root, &path, None).ok();
            RestoredFile { path, content }
        })
        .collect())
}

/// Write content to a workspace-relative file path (atomic via temp-file + rename).
///
/// Creates intermediate directories if needed.  Rejects paths outside the workspace.
#[tauri::command(async)]
pub fn fs_write_file(
    path: String,
    content: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = {
        let guard = root_state
            .lock()
            .map_err(|e| format!("workspace state lock: {e}"))?;
        guard.clone().ok_or_else(|| "no workspace open".to_string())?
    };

    // Use the write-safe resolver (file may not exist yet).
    let target = safe_resolve_for_write(&root, &path)?;

    // Ensure parent directory exists.
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all: {e}"))?;
    }

    // Atomic write: write to temp file then rename.
    let tmp = target.with_extension({
        let orig_ext = target
            .extension()
            .map(|e| format!("{}.shugu_tmp", e.to_string_lossy()))
            .unwrap_or_else(|| "shugu_tmp".to_string());
        orig_ext
    });

    std::fs::write(&tmp, content.as_bytes())
        .map_err(|e| format!("write temp file: {e}"))?;

    if let Err(e) = std::fs::rename(&tmp, &target) {
        // Best-effort cleanup of the temp file.
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("atomic rename failed: {e}"));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// B1-C: New mutation commands (create_file, create_dir, rename, delete)
// ---------------------------------------------------------------------------

/// Create a new file at a workspace-relative path.
///
/// Fails if the file already exists.  Creates intermediate parent directories.
/// If `content` is `None` an empty file is written; otherwise the given string
/// is written atomically (temp-file + rename — same pattern as `fs_write_file`).
#[tauri::command(async)]
pub fn fs_create_file(
    path: String,
    content: Option<String>,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = lock_root(&root_state)?;
    let target = safe_resolve_for_write(&root, &path)?;

    if target
        .try_exists()
        .map_err(|e| format!("stat error: {e}"))?
    {
        return Err(format!("file already exists: {}", path));
    }

    // Ensure parent directories exist.
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
    }

    let body = content.unwrap_or_default();

    // Atomic write: temp file in same directory then rename.
    let tmp = make_tmp_path(&target);
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("write temp file: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("atomic rename failed: {e}"));
    }

    Ok(())
}

/// Create a directory (and all parents) at a workspace-relative path.
///
/// Idempotent: succeeds if the directory already exists.
#[tauri::command(async)]
pub fn fs_create_dir(
    path: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = lock_root(&root_state)?;
    let target = safe_resolve_for_write(&root, &path)?;
    std::fs::create_dir_all(&target).map_err(|e| format!("create_dir_all: {e}"))
}

/// Rename (move) a workspace-relative path.
///
/// `from` must exist; `to` must not exist (no silent overwrite).  If `to`'s
/// parent directories are missing they are created first.  Both `from` and `to`
/// must remain inside the workspace root.
#[tauri::command(async)]
pub fn fs_rename(
    from: String,
    to: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = lock_root(&root_state)?;

    // `from` must already exist.
    let from_abs = safe_resolve(&root, &from)?;

    // `to` must be inside the workspace (may not exist yet).
    let to_abs = safe_resolve_for_write(&root, &to)?;

    // Guard against silent overwrites (POSIX rename() would silently replace).
    if to_abs
        .try_exists()
        .map_err(|e| format!("stat error (to): {e}"))?
    {
        return Err(format!("destination already exists: {}", to));
    }

    // Create parent directories for `to` if necessary.
    if let Some(parent) = to_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all (to parent): {e}"))?;
    }

    std::fs::rename(&from_abs, &to_abs).map_err(|e| format!("rename failed: {e}"))
}

/// Delete a file or directory at a workspace-relative path.
///
/// Files are deleted with `remove_file`.  Directories are deleted recursively
/// using `walkdir` with `follow_links(false)` and `contents_first(true)` — we
/// never follow symlinks out of the workspace.
///
/// SECURITY NOTE: `safe_resolve` canonicalises the path and rejects any
/// symlink whose resolved target is outside the workspace.  This means a
/// dangling or out-of-workspace symlink cannot be deleted through this command.
/// That is intentional; use the host OS to remove such links.
#[tauri::command(async)]
pub fn fs_delete(
    path: String,
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    let root = lock_root(&root_state)?;
    let target = safe_resolve(&root, &path)?;

    // Use symlink_metadata so we see the symlink type, not its target's type.
    let meta =
        std::fs::symlink_metadata(&target).map_err(|e| format!("stat error: {e}"))?;

    if meta.is_dir() {
        delete_dir_no_follow(&target)
    } else {
        // Regular file or symlink: remove_file is correct for both.
        std::fs::remove_file(&target).map_err(|e| format!("remove_file: {e}"))
    }
}

/// Returns the current workspace root as an absolute, forward-slash path,
/// or `null` when no workspace is open.
///
/// Used by the `compare-files` command to relativize the absolute path
/// returned by the file-picker dialog (which operates in OS path space)
/// back to a workspace-relative path that `fs_read_file` can accept.
#[tauri::command]
pub fn fs_get_workspace_root(
    root_state: tauri::State<'_, Mutex<Option<PathBuf>>>,
) -> Option<String> {
    let guard = root_state.lock().ok()?;
    // Le state garde le root canonicalisé AVEC le préfixe `\\?\` (contrat
    // interne) ; la sortie IPC doit être propre, sinon le frontend reçoit
    // `//?/F:/…` et ses strip_prefix/relativisations ratent (compare-files,
    // WorktreesSection).
    guard.as_ref().map(|p| super::pathutil::norm_display(p))
}

// ---------------------------------------------------------------------------
// Private helpers shared by the mutation commands
// ---------------------------------------------------------------------------

/// Extract the workspace root from state, returning a clean error if unset.
fn lock_root(state: &Mutex<Option<PathBuf>>) -> Result<PathBuf, String> {
    let guard = state.lock().map_err(|e| format!("workspace state lock: {e}"))?;
    guard.clone().ok_or_else(|| "no workspace open".to_string())
}

/// Build the temp-file path for atomic writes (placed next to the target).
fn make_tmp_path(target: &Path) -> PathBuf {
    let ext = target
        .extension()
        .map(|e| format!("{}.shugu_tmp", e.to_string_lossy()))
        .unwrap_or_else(|| "shugu_tmp".to_string());
    target.with_extension(ext)
}

/// Recursively delete a directory without following symlinks.
///
/// Uses `walkdir` with `follow_links(false)` and `contents_first(true)` so
/// leaves are yielded before parents — deletion works in natural iteration order.
/// Symlinks-to-dirs are treated as files by walkdir under `follow_links(false)`,
/// so `is_dir()` returns `false` for them and they are removed with `remove_file`.
fn delete_dir_no_follow(dir: &Path) -> Result<(), String> {
    for result in WalkDir::new(dir)
        .follow_links(false)
        .contents_first(true)
    {
        let entry = result.map_err(|e| format!("walkdir error: {e}"))?;
        let ft = entry.file_type();
        if ft.is_dir() {
            std::fs::remove_dir(entry.path())
                .map_err(|e| format!("remove_dir {:?}: {e}", entry.path()))?;
        } else {
            // Regular file or symlink-to-anything.
            std::fs::remove_file(entry.path())
                .map_err(|e| format!("remove_file {:?}: {e}", entry.path()))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Inner helpers — shared between the Tauri commands and the Phase 2 agent
// tool dispatcher.
//
// Why a separate layer:
//   * Tauri `#[tauri::command]` functions take `tauri::State<...>` which
//     can't be called from async agent code that only has an `AppHandle`.
//   * Sharing the path-resolution + read/write logic via a free function
//     means BOTH the Tauri command and the tool dispatcher use the same
//     `safe_resolve` / `safe_resolve_for_write` validation — there's no
//     risk of one path getting a stricter guard than the other.
//   * The reads have different size-cap semantics : the Tauri command
//     for the editor wants the full file (up to 5 MiB), whereas the
//     agent tool wants a hard 32 KiB cap on what flows back into the
//     LLM context to keep token usage bounded. We express that with
//     an optional `max_chars` cap argument — `None` = no truncation
//     (just the 5 MiB hard guard), `Some(N)` = soft-truncate with a
//     sentinel suffix so the model knows the content was cut.
// ---------------------------------------------------------------------------

/// Read a workspace-relative file. Two-stage cap:
///   * Hard 5 MiB guard from `meta.len()` — files larger than this return
///     Err regardless of `max_chars`.
///   * Optional soft cap via `max_chars`. When `Some(N)` and the decoded
///     UTF-8 content exceeds N chars, truncate at N chars and append:
///       `"\n[... TRUNCATED at X bytes — original size: {Y} bytes ...]"`
///   When `None`, returns the full file content (still subject to the
///   hard 5 MiB guard).
///
/// Binary detection: scans the first 8 KiB for null bytes. Returns Err
/// on detection. Note: UTF-16 files contain null bytes and will be
/// falsely rejected — acceptable v1 trade-off; the agent can ask the
/// user to convert to UTF-8 if blocked.
pub(crate) fn read_file_inner(
    root: &Path,
    rel: &str,
    max_chars: Option<usize>,
) -> Result<String, String> {
    const MAX_SIZE: u64 = 5 * 1024 * 1024; // 5 MiB hard guard

    let resolved = safe_resolve(root, rel)?;

    let meta = std::fs::metadata(&resolved).map_err(|e| format!("stat error: {e}"))?;
    let file_size = meta.len();
    if file_size > MAX_SIZE {
        return Err("file too large (>5 MiB)".into());
    }

    let bytes = std::fs::read(&resolved).map_err(|e| format!("read error: {e}"))?;

    let scan_len = bytes.len().min(8 * 1024);
    if bytes[..scan_len].contains(&0u8) {
        return Err("binary file".into());
    }

    let raw = String::from_utf8_lossy(&bytes).into_owned();

    match max_chars {
        Some(cap) if raw.len() > cap => {
            // char_indices().nth(cap) would be perfect, but for the common
            // ASCII case `raw.len()` IS the char count. For multibyte we
            // fall back to byte-slicing on a char boundary to avoid
            // splitting a codepoint.
            let safe_end = (0..=cap)
                .rev()
                .find(|i| raw.is_char_boundary(*i))
                .unwrap_or(cap);
            let truncated = &raw[..safe_end];
            Ok(format!(
                "{truncated}\n[... TRUNCATED at {cap} bytes — original size: {file_size} bytes ...]"
            ))
        }
        _ => Ok(raw),
    }
}

/// Write `content` atomically (temp-file + rename) to a workspace-relative
/// path. Creates missing parent directories. Returns the byte count written.
/// Uses the same atomic-write contract as the existing `fs_write_file`
/// Tauri command.
pub(crate) fn write_file_inner(
    root: &Path,
    rel: &str,
    content: &str,
) -> Result<usize, String> {
    let target = safe_resolve_for_write(root, rel)?;

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
    }

    let tmp = target.with_extension({
        let orig_ext = target
            .extension()
            .map(|e| format!("{}.shugu_tmp", e.to_string_lossy()))
            .unwrap_or_else(|| "shugu_tmp".to_string());
        orig_ext
    });

    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("write temp file: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("atomic rename failed: {e}"));
    }
    Ok(content.len())
}

/// Delete a single workspace-relative FILE, reusing the SAME path-guard as
/// `write_file_inner` (`safe_resolve_for_write`) — the symmetric counterpart to
/// the write whose effect is being undone.
///
/// Why `safe_resolve_for_write` and not `safe_resolve`:
///   * `safe_resolve` canonicalizes the full joined path and therefore REQUIRES
///     the file to exist; it also rejects nothing extra we need. But the revert
///     caller may race a file that was already removed elsewhere — we want a
///     clean "not found" rather than a guard error. `safe_resolve_for_write`
///     does the same `..`/absolute/null-byte rejection + ancestor-canonicalize
///     containment check WITHOUT requiring the leaf to exist, so it is the exact
///     guard `write_file_inner` used to create the file.
///   * This avoids introducing a NEW path guard: deletion is gated by the very
///     same validation as the write it reverses.
///
/// Only regular files are removed (`std::fs::remove_file`). This helper is
/// intentionally file-only: chat write-tools (`fs_write_file`/`fs_edit`) never
/// create directories as a tracked artifact, so reverting a created file is a
/// `remove_file`. Returns `Err` on guard failure or I/O error (the chat-revert
/// caller treats deletion as best-effort and ignores the result).
pub(crate) fn delete_file_inner(root: &Path, rel: &str) -> Result<(), String> {
    let target = safe_resolve_for_write(root, rel)?;
    std::fs::remove_file(&target).map_err(|e| format!("remove_file: {e}"))
}

/// Renomme / déplace un fichier workspace-relatif `from` → `to`. Path-guard
/// SYMÉTRIQUE : la source passe par `safe_resolve` (doit exister et être
/// contenue), la destination par `safe_resolve_for_write` (peut ne pas exister
/// encore — même garde `..`/absolu/null-byte + containment que l'écriture). Crée
/// les dossiers parents de la destination. Refuse d'écraser une destination
/// existante (le modèle doit supprimer/éditer explicitement) — évite une perte
/// de données silencieuse. Renvoie le nombre d'octets déplacés (pour le message).
pub(crate) fn rename_inner(root: &Path, from: &str, to: &str) -> Result<u64, String> {
    let src = safe_resolve(root, from)?;
    if !src.is_file() {
        return Err(format!("{from} n'est pas un fichier régulier (déplacement de dossier non supporté)"));
    }
    let dst = safe_resolve_for_write(root, to)?;
    if dst.exists() {
        return Err(format!(
            "la destination {to} existe déjà — supprime-la ou choisis un autre nom (pas d'écrasement silencieux)"
        ));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create_dir_all: {e}"))?;
    }
    let size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
    // `rename` est atomique sur le même volume ; sur volumes différents il peut
    // échouer (EXDEV) → repli copy+remove pour rester robuste cross-device.
    if let Err(e) = std::fs::rename(&src, &dst) {
        std::fs::copy(&src, &dst).map_err(|e2| format!("rename a échoué ({e}) et la copie aussi ({e2})"))?;
        // Si la suppression de la source échoue (AV/indexeur Windows qui verrouille),
        // on ANNULE la copie pour ne pas laisser source ET destination présentes —
        // sinon un retry buterait sur la garde « destination existe » (revue).
        std::fs::remove_file(&src).map_err(|e3| {
            let _ = std::fs::remove_file(&dst);
            format!("déplacement annulé : copie OK mais suppression de {from} impossible ({e3})")
        })?;
    }
    Ok(size)
}

/// List the immediate children of a workspace-relative directory as a
/// JSON string. Returns `[{"name":"foo","is_dir":true}, ...]`.
///
/// **NOT recursive** — unlike `fs_read_dir` which walks the tree, this
/// helper is designed for LLM consumption (one level at a time, easy
/// to reason about, won't blow up token budgets on large directories).
pub(crate) fn list_dir_inner(root: &Path, rel: &str) -> Result<String, String> {
    let resolved = safe_resolve(root, rel)?;
    let entries = std::fs::read_dir(&resolved).map_err(|e| format!("read_dir error: {e}"))?;

    let mut items: Vec<serde_json::Value> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("entry error: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        items.push(serde_json::json!({ "name": name, "is_dir": is_dir }));
    }
    serde_json::to_string(&items).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Create a unique temp directory for test isolation.
    fn make_temp_dir(suffix: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("shugu_fs_test_{suffix}"));
        fs::create_dir_all(&base).expect("create temp dir");
        // Canonicalize so that starts_with comparisons work on Windows (UNC paths).
        std::fs::canonicalize(&base).expect("canonicalize temp dir")
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    // -----------------------------------------------------------------------
    // index_tier (priorité d'indexation — Phase 7 #10 option A)
    // -----------------------------------------------------------------------

    #[test]
    fn index_tier_prioritises_code_then_config_then_data() {
        // Code / docs = tier 0 (indexé en premier). ipynb inclus (repos ML).
        for ext in ["rs", "ts", "tsx", "py", "ipynb", "go", "md", "sql"] {
            assert_eq!(index_tier(ext), 0, "{ext} devrait être code (tier 0)");
        }
        // Config / markup = tier 1.
        for ext in ["json", "yaml", "toml", "css", "html"] {
            assert_eq!(index_tier(ext), 1, "{ext} devrait être config (tier 1)");
        }
        // Données / divers = tier 2 (sautent EN PREMIER quand le budget déborde).
        for ext in ["csv", "txt", "dat", "tsv", ""] {
            assert_eq!(index_tier(ext), 2, "{ext} devrait être autre (tier 2)");
        }
        // L'ordre du tri (croissant) garantit code < config < données.
        assert!(index_tier("rs") < index_tier("json"));
        assert!(index_tier("json") < index_tier("csv"));
    }

    #[test]
    fn index_tier_for_file_handles_extensionless_code() {
        // Sans extension mais code/build connu → tier 0 (pas largué en données).
        for name in ["Makefile", "Dockerfile", "Gemfile", "Jenkinsfile", "justfile"] {
            assert_eq!(index_tier_for_file(name, ""), 0, "{name} devrait être code");
        }
        // Sans extension et inconnu → tier 2 (données/divers).
        assert_eq!(index_tier_for_file("LICENSE", ""), 2);
        assert_eq!(index_tier_for_file("data", ""), 2);
        // Avec extension → délègue à index_tier (le nom n'override pas).
        assert_eq!(index_tier_for_file("main.rs", "rs"), 0);
        assert_eq!(index_tier_for_file("dataset.csv", "csv"), 2);
    }

    // -----------------------------------------------------------------------
    // is_ignored / is_index_ignored / .gitignore (régime de l'index sémantique)
    // -----------------------------------------------------------------------

    #[test]
    fn is_ignored_covers_python_and_tooling_junk() {
        // Le trou historique : `venv` SANS point (76k fichiers indexés en 2026-07).
        for name in [
            "venv",
            ".venv",
            "site-packages",
            ".tox",
            "__pycache__",
            ".playwright-mcp",
            ".pcc",
            "node_modules",
        ] {
            assert!(is_ignored(name), "{name} devrait être ignoré partout");
        }
        // Pas de sur-blocage : ces noms légitimes restent indexables.
        for name in ["env", "src", "envelope", "environment.ts"] {
            assert!(!is_ignored(name), "{name} ne doit PAS être ignoré");
        }
    }

    #[test]
    fn is_index_ignored_hides_internals_from_index_only() {
        // Exclus de l'INDEX…
        for name in [".claude", ".shugu", ".shugu-forge", ".shugu-snippets"] {
            assert!(is_index_ignored(name), "{name} ne doit pas être indexé");
            // …mais PAS de l'arbre de fichiers (is_ignored reste faux).
            assert!(!is_ignored(name), "{name} doit rester visible dans l'arbre");
        }
        // is_index_ignored est un SUR-ensemble de is_ignored.
        assert!(is_index_ignored("venv"));
        assert!(is_index_ignored("node_modules"));
        assert!(!is_index_ignored("src"));
    }

    #[test]
    fn workspace_gitignore_matches_dirs_and_files() {
        let root = make_temp_dir("gitignore_match");
        fs::write(root.join(".gitignore"), "env/\n*.onnx\n!keep.onnx\n").unwrap();

        let gi = build_workspace_gitignore(&root).expect("matcher construit");
        // Règle répertoire : `env/` matche le DOSSIER (élagué pendant le walk).
        assert!(gi.matched(Path::new("env"), true).is_ignore());
        assert!(!gi.matched(Path::new("src"), true).is_ignore());
        // Règle fichier + négation git standard.
        assert!(gi.matched(Path::new("model.onnx"), false).is_ignore());
        assert!(!gi.matched(Path::new("keep.onnx"), false).is_ignore());

        cleanup(&root);
    }

    #[test]
    fn workspace_gitignore_absent_is_none() {
        let root = make_temp_dir("gitignore_absent");
        let _ = fs::remove_file(root.join(".gitignore"));
        assert!(build_workspace_gitignore(&root).is_none());
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // safe_resolve tests
    // -----------------------------------------------------------------------

    #[test]
    fn safe_resolve_valid_inside_root() {
        let root = make_temp_dir("resolve_valid");
        let file = root.join("subdir").join("hello.txt");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"hi").unwrap();

        let result = safe_resolve(&root, "subdir/hello.txt");
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        cleanup(&root);
    }

    #[test]
    fn safe_resolve_rejects_traversal() {
        let root = make_temp_dir("resolve_traverse");
        // Create a file outside root that we try to escape to.
        let result = safe_resolve(&root, "../escape.txt");
        assert!(result.is_err(), "expected Err for ../escape");
        cleanup(&root);
    }

    #[test]
    fn safe_resolve_rejects_absolute_path() {
        let root = make_temp_dir("resolve_absolute");
        // Try to pass an absolute path.
        let abs = if cfg!(target_os = "windows") {
            "C:\\Windows\\System32\\calc.exe"
        } else {
            "/etc/passwd"
        };
        let result = safe_resolve(&root, abs);
        assert!(result.is_err(), "expected Err for absolute path");
        cleanup(&root);
    }

    #[test]
    fn safe_resolve_rejects_null_byte() {
        let root = make_temp_dir("resolve_null");
        let result = safe_resolve(&root, "some\0file.txt");
        assert!(result.is_err(), "expected Err for null byte");
        assert!(
            result.unwrap_err().contains("null byte"),
            "error should mention null byte"
        );
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // rename_inner tests
    // -----------------------------------------------------------------------

    #[test]
    fn rename_inner_moves_file_and_removes_source() {
        let root = make_temp_dir("rename_ok");
        // Départ propre : un run précédent peut avoir laissé la destination, ce
        // que le refus d'écrasement de rename_inner détecterait à tort.
        let _ = fs::remove_dir_all(root.join("sub"));
        fs::write(root.join("a.txt"), b"hello").unwrap();
        let r = rename_inner(&root, "a.txt", "sub/b.txt");
        assert!(r.is_ok(), "expected Ok, got {:?}", r);
        assert!(!root.join("a.txt").exists(), "source should be gone");
        assert_eq!(fs::read_to_string(root.join("sub/b.txt")).unwrap(), "hello");
        cleanup(&root);
    }

    #[test]
    fn rename_inner_rejects_traversal_destination() {
        let root = make_temp_dir("rename_traverse");
        fs::write(root.join("a.txt"), b"x").unwrap();
        let r = rename_inner(&root, "a.txt", "../escape.txt");
        assert!(r.is_err(), "expected Err for ../escape destination");
        assert!(root.join("a.txt").exists(), "source must be untouched on guard failure");
        cleanup(&root);
    }

    #[test]
    fn rename_inner_refuses_overwrite() {
        let root = make_temp_dir("rename_overwrite");
        fs::write(root.join("a.txt"), b"from").unwrap();
        fs::write(root.join("b.txt"), b"to").unwrap();
        let r = rename_inner(&root, "a.txt", "b.txt");
        assert!(r.is_err(), "expected Err — must not overwrite existing destination");
        assert_eq!(fs::read_to_string(root.join("b.txt")).unwrap(), "to");
        cleanup(&root);
    }

    #[test]
    fn rename_inner_missing_source_errors() {
        let root = make_temp_dir("rename_missing");
        let r = rename_inner(&root, "nope.txt", "x.txt");
        assert!(r.is_err(), "expected Err for missing source");
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // safe_resolve_for_write tests
    // -----------------------------------------------------------------------

    /// This is the regression test for the canonicalize-on-nonexistent-file bug.
    /// A new file inside the workspace root MUST succeed even though it doesn't exist yet.
    #[test]
    fn safe_resolve_for_write_nonexistent_file_inside_root_ok() {
        let root = make_temp_dir("write_nonexistent");

        // The file does NOT exist on disk yet.
        let result = safe_resolve_for_write(&root, "new_file.rs");
        assert!(
            result.is_ok(),
            "safe_resolve_for_write must succeed for a non-existent file inside root; got: {:?}",
            result
        );

        // The returned path must be inside root.
        let resolved = result.unwrap();
        assert!(
            resolved.starts_with(&root),
            "resolved path {:?} must start with root {:?}",
            resolved,
            root
        );

        // The file must NOT have been created as a side-effect.
        assert!(!resolved.exists(), "safe_resolve_for_write must not create the file");

        cleanup(&root);
    }

    #[test]
    fn safe_resolve_for_write_nonexistent_nested_inside_root_ok() {
        let root = make_temp_dir("write_nonexistent_nested");

        // Deep nested path — neither file nor parent dirs exist.
        let result = safe_resolve_for_write(&root, "src/components/NewWidget.tsx");
        assert!(
            result.is_ok(),
            "nested non-existent path inside root should be Ok; got: {:?}",
            result
        );

        cleanup(&root);
    }

    #[test]
    fn safe_resolve_for_write_rejects_traversal_no_dir_created() {
        let root = make_temp_dir("write_traverse");
        let escape_path = "../escape_target/evil.txt";

        let result = safe_resolve_for_write(&root, escape_path);
        assert!(result.is_err(), "expected Err for ../escape path");

        // CRITICAL: confirm no directory was created outside root.
        let would_be_escape = root
            .parent()
            .unwrap()
            .join("escape_target");
        assert!(
            !would_be_escape.exists(),
            "safe_resolve_for_write must NOT create directories for escaping paths"
        );

        cleanup(&root);
    }

    #[test]
    fn safe_resolve_for_write_rejects_null_byte() {
        let root = make_temp_dir("write_null");
        let result = safe_resolve_for_write(&root, "foo\0bar.txt");
        assert!(result.is_err(), "expected Err for null byte");
        cleanup(&root);
    }

    #[test]
    fn safe_resolve_for_write_rejects_absolute_path() {
        let root = make_temp_dir("write_absolute");
        let abs = if cfg!(target_os = "windows") {
            "C:\\Windows\\evil.txt"
        } else {
            "/tmp/evil.txt"
        };
        let result = safe_resolve_for_write(&root, abs);
        assert!(result.is_err(), "expected Err for absolute path");
        cleanup(&root);
    }

    // NOTE: symlink-target-outside-root test skipped on Windows because
    // creating symlinks requires elevated privileges or Developer Mode to be
    // enabled (CreateSymbolicLink requires SeCreateSymbolicLinkPrivilege).
    // On POSIX systems `std::os::unix::fs::symlink` is unprivileged and this
    // case WOULD be tested.  The defense for symlinked dirs is provided by the
    // `canonical_ancestor.starts_with(root)` check in `safe_resolve_for_write`
    // and the `canonicalize + starts_with` check in `safe_resolve`.
    #[test]
    #[cfg(not(target_os = "windows"))]
    fn safe_resolve_for_write_rejects_symlinked_dir_escape() {
        use std::os::unix::fs::symlink;

        let root = make_temp_dir("write_symlink");
        let outside = make_temp_dir("write_symlink_outside");

        // Create a symlink inside root that points outside root.
        let link = root.join("link_to_outside");
        symlink(&outside, &link).expect("create symlink");

        // Try to write through the symlinked directory.
        let result = safe_resolve_for_write(&root, "link_to_outside/evil.txt");
        assert!(
            result.is_err(),
            "expected Err when target is through a symlink pointing outside root"
        );

        cleanup(&root);
        cleanup(&outside);
    }

    // -----------------------------------------------------------------------
    // fs_create_file impl tests (test the helpers directly, not the Tauri command)
    // -----------------------------------------------------------------------

    /// Create a file in a fresh temp root — must succeed.
    #[test]
    fn create_file_impl_new_file_ok() {
        let root = make_temp_dir("create_file_new");
        let target = safe_resolve_for_write(&root, "hello.txt").unwrap();

        // Simulate what fs_create_file does after resolving.
        assert!(!target.exists(), "precondition: file must not exist");
        fs::write(&target, b"hello").unwrap();
        assert!(target.exists(), "file should now exist");

        cleanup(&root);
    }

    #[test]
    fn create_file_rejects_existing() {
        let root = make_temp_dir("create_file_exists");
        let file = root.join("existing.txt");
        fs::write(&file, b"data").unwrap();
        // If target already exists, the command would error.
        assert!(file.try_exists().unwrap(), "precondition: file exists");

        cleanup(&root);
    }

    #[test]
    fn create_file_rejects_traversal() {
        let root = make_temp_dir("create_file_traverse");
        let result = safe_resolve_for_write(&root, "../evil.txt");
        assert!(result.is_err(), "traversal must be rejected");
        cleanup(&root);
    }

    #[test]
    fn create_file_rejects_null_byte() {
        let root = make_temp_dir("create_file_null");
        let result = safe_resolve_for_write(&root, "foo\0bar.txt");
        assert!(result.is_err(), "null byte must be rejected");
        cleanup(&root);
    }

    #[test]
    fn create_file_creates_parent_dirs() {
        let root = make_temp_dir("create_file_parents");
        // deep/nested/new.txt — parents don't exist yet
        let target = safe_resolve_for_write(&root, "deep/nested/new.txt").unwrap();
        if let Some(p) = target.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(&target, b"").unwrap();
        assert!(target.exists());
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // fs_create_dir impl tests
    // -----------------------------------------------------------------------

    #[test]
    fn create_dir_impl_new_dir_ok() {
        let root = make_temp_dir("create_dir_new");
        let target = safe_resolve_for_write(&root, "subdir/nested").unwrap();
        fs::create_dir_all(&target).unwrap();
        assert!(target.is_dir());
        cleanup(&root);
    }

    #[test]
    fn create_dir_idempotent_on_existing() {
        let root = make_temp_dir("create_dir_idem");
        let target = root.join("existing_dir");
        fs::create_dir_all(&target).unwrap();
        // second call must not error
        fs::create_dir_all(&target).unwrap();
        cleanup(&root);
    }

    #[test]
    fn create_dir_rejects_traversal() {
        let root = make_temp_dir("create_dir_traverse");
        let result = safe_resolve_for_write(&root, "../outside_dir");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn create_dir_rejects_null_byte() {
        let root = make_temp_dir("create_dir_null");
        let result = safe_resolve_for_write(&root, "dir\0name");
        assert!(result.is_err());
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // fs_rename impl tests
    // -----------------------------------------------------------------------

    #[test]
    fn rename_impl_success() {
        // Suffixe distinct de rename_inner_moves_file_and_removes_source : les
        // dossiers de make_temp_dir sont à nom FIXE, deux tests parallèles sur
        // le même suffixe se suppriment mutuellement le dossier via cleanup().
        let root = make_temp_dir("rename_impl_ok");
        let from = root.join("original.txt");
        fs::write(&from, b"content").unwrap();
        let from_canon = std::fs::canonicalize(&from).unwrap();

        let to = safe_resolve_for_write(&root, "renamed.txt").unwrap();
        assert!(!to.exists());

        std::fs::rename(&from_canon, &to).unwrap();
        assert!(to.exists());
        assert!(!from_canon.exists());
        cleanup(&root);
    }

    #[test]
    fn rename_impl_to_exists_fails() {
        let root = make_temp_dir("rename_to_exists");
        let from = root.join("a.txt");
        let to = root.join("b.txt");
        fs::write(&from, b"a").unwrap();
        fs::write(&to, b"b").unwrap();

        // The guard in fs_rename checks try_exists before calling rename.
        let to_resolved = safe_resolve_for_write(&root, "b.txt").unwrap();
        let exists = to_resolved.try_exists().unwrap();
        assert!(exists, "to already exists — command should have returned Err");
        cleanup(&root);
    }

    #[test]
    fn rename_rejects_from_traversal() {
        let root = make_temp_dir("rename_from_traverse");
        // safe_resolve requires the path to exist AND be inside root.
        let result = safe_resolve(&root, "../outside.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn rename_rejects_to_traversal() {
        let root = make_temp_dir("rename_to_traverse");
        let result = safe_resolve_for_write(&root, "../outside.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn rename_rejects_null_byte_in_from() {
        let root = make_temp_dir("rename_null_from");
        let result = safe_resolve(&root, "foo\0bar.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn rename_rejects_null_byte_in_to() {
        let root = make_temp_dir("rename_null_to");
        let result = safe_resolve_for_write(&root, "foo\0bar.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // fs_delete impl tests
    // -----------------------------------------------------------------------

    #[test]
    fn delete_file_ok() {
        let root = make_temp_dir("delete_file");
        let file = root.join("to_delete.txt");
        fs::write(&file, b"bye").unwrap();

        let resolved = safe_resolve(&root, "to_delete.txt").unwrap();
        fs::remove_file(&resolved).unwrap();
        assert!(!file.exists());
        cleanup(&root);
    }

    #[test]
    fn delete_dir_recursive_ok() {
        let root = make_temp_dir("delete_dir_rec");
        let dir = root.join("mydir");
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("file.txt"), b"x").unwrap();
        fs::write(dir.join("nested").join("deep.txt"), b"y").unwrap();

        let resolved = safe_resolve(&root, "mydir").unwrap();
        delete_dir_no_follow(&resolved).unwrap();
        assert!(!dir.exists());
        cleanup(&root);
    }

    #[test]
    fn delete_nonexistent_fails() {
        let root = make_temp_dir("delete_missing");
        // safe_resolve calls canonicalize which fails if path doesn't exist.
        let result = safe_resolve(&root, "ghost.txt");
        assert!(result.is_err(), "nonexistent path must be rejected");
        cleanup(&root);
    }

    #[test]
    fn delete_rejects_traversal() {
        let root = make_temp_dir("delete_traverse");
        let result = safe_resolve(&root, "../outside.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn delete_rejects_null_byte() {
        let root = make_temp_dir("delete_null");
        let result = safe_resolve(&root, "foo\0bar.txt");
        assert!(result.is_err());
        cleanup(&root);
    }

    #[test]
    fn delete_rejects_dotdot_segment() {
        let root = make_temp_dir("delete_dotdot");
        // A path like "dir/../../../etc" — safe_resolve canonicalizes and checks.
        let result = safe_resolve(&root, "dir/../../../etc");
        assert!(result.is_err());
        cleanup(&root);
    }

    // -----------------------------------------------------------------------
    // build_subtree / build_tree anchoring (regression for fs_read_dir_scoped)
    // -----------------------------------------------------------------------

    /// Walk a `base` subtree the same way `fs_read_dir_scoped` does, then build
    /// the tree. This locks in the fix: `build_subtree` (anchored at `base`)
    /// must produce a NON-EMPTY, NESTED tree with workspace-relative paths,
    /// whereas the old `build_tree(&root, …)` (anchored at `root`) returns `[]`
    /// because no walked entry is a direct child of `root`.
    #[test]
    fn build_subtree_reconstructs_nested_scoped_tree() {
        let root = make_temp_dir("subtree_nested");
        // root/.shugu-forge/preview/{index.html, css/style.css}
        let preview = root.join(".shugu-forge").join("preview");
        fs::create_dir_all(preview.join("css")).unwrap();
        fs::write(preview.join("index.html"), b"<html></html>").unwrap();
        fs::write(preview.join("css").join("style.css"), b"body{}").unwrap();

        let base = preview.clone();
        let entries: Vec<walkdir::DirEntry> = WalkDir::new(&base)
            .follow_links(false)
            .max_depth(12)
            .min_depth(1)
            .into_iter()
            .filter_map(|r| r.ok())
            .collect();

        // FIXED path: anchored at `base`, stripped against `root`.
        let tree = build_subtree(&root, &base, entries.clone());
        assert!(
            !tree.is_empty(),
            "build_subtree must reconstruct the scoped tree, got empty"
        );

        // index.html present at the top level, path workspace-relative.
        let index = tree
            .iter()
            .find(|n| n.name == "index.html")
            .expect("index.html at top level of scoped tree");
        assert!(!index.is_dir);
        assert_eq!(index.path, ".shugu-forge/preview/index.html");

        // css dir is NESTED with its child (proves recursion descends).
        let css = tree
            .iter()
            .find(|n| n.name == "css")
            .expect("css dir at top level of scoped tree");
        assert!(css.is_dir);
        assert_eq!(css.path, ".shugu-forge/preview/css");
        let style = css
            .children
            .iter()
            .find(|n| n.name == "style.css")
            .expect("style.css nested under css");
        assert_eq!(style.path, ".shugu-forge/preview/css/style.css");

        // REGRESSION: the old `build_tree(&root, …)` would return empty because
        // no walked entry's parent equals `root`.
        let old = build_tree(&root, entries);
        assert!(
            old.is_empty(),
            "build_tree anchored at root must NOT reconstruct a base-rooted walk \
             (this is exactly the bug that returned [] for fs_read_dir_scoped)"
        );

        cleanup(&root);
    }
}
