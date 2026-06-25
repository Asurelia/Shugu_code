//! Local semantic-search layer using sqlite-vec + fastembed.
//!
//! Uses a dedicated `rusqlite::Connection` (separate from tauri-plugin-sql's
//! sqlx pool) because registering the sqlite-vec extension requires the
//! `rusqlite::ffi::sqlite3_auto_extension` mechanism, which sqlx cannot do.
//!
//! DB path: `app.path().app_config_dir()/shugu.db` — the same file that
//! tauri-plugin-sql opens (on Windows: %APPDATA%\dev.shugu.forge\shugu.db),
//! resolved at first use via the AppHandle so we always target the same file.
//!
//! SECURITY: collection names are validated against an allowlist before being
//! interpolated into table identifiers (SQL-injection prevention for the
//! identifier position). All user-supplied values are bound parameters.
//!
//! CONCURRENCY (AM-5) — multi-agent safety on a SHARED database.
//! ------------------------------------------------------------------
//! `shugu.db` is opened by THREE independent SQLite handles in the same
//! process:
//!   1. this module's `VEC_CONN`        (vector tables + `agent_memory`),
//!   2. `agents::get_conn`'s `AGENTS_CONN` (agent rows/events/skills/usage),
//!   3. tauri-plugin-sql's sqlx pool    (the migrated relational schema).
//! When several agents run in parallel they drive these handles concurrently.
//!
//! Each rusqlite handle sits behind its OWN `Mutex`, so a Mutex only serialises
//! access WITHIN one handle — it does NOT serialise the OTHER two handles or
//! the sqlx pool. SQLite itself is the cross-handle arbiter: in WAL mode any
//! number of readers proceed concurrently, but only ONE writer holds the write
//! lock at a time. A second writer that finds the database write-locked gets
//! `SQLITE_BUSY` ("database is locked").
//!
//! The fix this module guarantees for its OWN connection:
//!   * WAL journal mode — readers never block the writer and vice-versa, and we
//!     VERIFY the pragma actually took (some filesystems silently downgrade it).
//!   * `busy_timeout` = 5000 ms — when another handle holds the write lock, this
//!     connection now WAITS (polling) up to 5 s instead of failing immediately,
//!     turning a hard "database is locked" error into bounded back-pressure.
//!   * `synchronous = NORMAL` — the durable, corruption-safe setting under WAL;
//!     fewer fsyncs than FULL, so the writer releases the lock sooner.
//! Compound writes that touch TWO tables (`memory_remember` writes both the
//! vec0 row and its `agent_memory` payload; `vec_delete`/`vec_clear` purge both)
//! run inside a single IMMEDIATE transaction so the pair is atomic — a crash or
//! a losing race can never leave an orphaned vector or a tombstone half-applied.

use rusqlite::{ffi::sqlite3_auto_extension, params, Connection};
use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Embedding dimension for `AllMiniLML6V2` (384-dimensional model).
const EMBED_DIM: usize = 384;

/// How long a write blocked by another handle's write lock waits before giving
/// up with `SQLITE_BUSY`. 5 s comfortably covers a contended embed+insert or a
/// WAL checkpoint by another agent; longer would risk hanging the UI thread on
/// a genuine deadlock, shorter would re-surface spurious "database is locked".
const BUSY_TIMEOUT_MS: u32 = 5_000;

/// Allowed collection names — these become SQL table-name identifiers.
///
/// `memory` (AM-2) extends the index BEYOND code: it holds the agent's
/// ORCHESTRATED memory — salient facts/results `remember()`ed after a turn, and
/// episodic SUMMARIES written by compaction when the conversation outgrows the
/// in-context history window. The runner's `recall()` hook searches it before
/// each turn so past knowledge resurfaces instead of evaporating at the 30-msg
/// drop. The vector row is keyed by a UUID; the human-readable text + metadata
/// live in the `agent_memory` side table (vec0 stores only the embedding).
const ALLOWED_COLLECTIONS: &[&str] =
    &["messages", "docs", "errors", "patterns", "code", "memory"];

// ---------------------------------------------------------------------------
// sqlite-vec auto-extension registration (once per process)
// ---------------------------------------------------------------------------

fn register_vec_extension() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        // `sqlite_vec::sqlite3_vec_init` is the C-level init function exported
        // by the sqlite-vec FFI crate.  It must be registered as an
        // auto-extension so every new rusqlite Connection picks it up.
        sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

// ---------------------------------------------------------------------------
// Connection hardening for concurrent multi-agent access (AM-5)
// ---------------------------------------------------------------------------

/// Apply the concurrency pragmas to a freshly opened connection and VERIFY that
/// WAL actually took effect.
///
/// Returns the journal mode SQLite reports back (lower-case, e.g. `"wal"`), so
/// callers/tests can assert the file is genuinely in WAL and not a silent
/// downgrade (`delete`/`truncate`) — which would re-introduce the writer-blocks-
/// reader contention WAL is meant to remove.
///
/// `busy_timeout` and `synchronous` are set with plain `pragma_update` /
/// `execute_batch` because they cannot fail meaningfully on a valid handle; WAL
/// is set via `query_row` so we read the resulting mode in the same round-trip.
fn configure_connection(conn: &Connection) -> Result<String, String> {
    // busy_timeout FIRST: every subsequent statement (including the WAL switch
    // itself, which briefly needs the write lock) benefits from the wait.
    conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS as u64))
        .map_err(|e| format!("busy_timeout pragma: {e}"))?;

    // WAL — `PRAGMA journal_mode=WAL` RETURNS the new mode as a result row, so
    // we read it back to confirm the switch instead of assuming it worked.
    let mode: String = conn
        .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
        .map_err(|e| format!("WAL pragma: {e}"))?;
    let mode = mode.to_lowercase();

    // synchronous=NORMAL is the recommended durability level UNDER WAL: it still
    // guarantees no corruption on OS crash (only the last in-flight txn can be
    // lost on power loss), while issuing far fewer fsyncs than FULL — so the
    // write lock is released sooner and contending agents wait less.
    conn.execute_batch("PRAGMA synchronous=NORMAL;")
        .map_err(|e| format!("synchronous pragma: {e}"))?;

    if mode != "wal" {
        // Don't hard-fail: an in-memory or network-mounted DB legitimately can't
        // do WAL. Log loudly so the degraded-concurrency case is visible, and
        // the busy_timeout still gives us back-pressure instead of hard errors.
        eprintln!(
            "[vector] WARNING: journal_mode is '{mode}', not 'wal' — concurrent \
             access will rely on busy_timeout ({BUSY_TIMEOUT_MS} ms) alone"
        );
    }
    Ok(mode)
}

// ---------------------------------------------------------------------------
// Global connection pool (single shared connection, opened once)
// ---------------------------------------------------------------------------

static VEC_CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Open (or return the cached) rusqlite connection to `shugu.db`.
///
/// On first open: enables WAL mode and ensures all five `vec0` virtual tables
/// exist.  Subsequent calls return the cached `Mutex<Connection>` immediately.
fn get_conn(app: &tauri::AppHandle) -> Result<&'static Mutex<Connection>, String> {
    if let Some(c) = VEC_CONN.get() {
        return Ok(c);
    }

    // Resolve to the exact same path as tauri-plugin-sql.
    // tauri-plugin-sql v2 (wrapper.rs) calls `app.path().app_config_dir()`
    // then pushes the bare db name from after the `sqlite:` prefix.
    // On Windows this is %APPDATA%\dev.shugu.forge\shugu.db (Roaming).
    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?
        .join("shugu.db");

    // Log the resolved path once at startup so developers can verify it
    // matches what tauri-plugin-sql uses (both call app_config_dir()).
    static LOG_ONCE: OnceLock<()> = OnceLock::new();
    LOG_ONCE.get_or_init(|| {
        eprintln!("[vector] shugu.db resolved to: {}", db_path.display());
    });

    // Ensure the parent directory exists (mirrors what tauri-plugin-sql does
    // via create_dir_all before its own Connection::open).
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create app config dir: {e}"))?;
    }

    // Extension must be registered before any Connection::open.
    register_vec_extension();

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("rusqlite open {}: {e}", db_path.display()))?;

    // AM-5 — harden for concurrent multi-agent access: WAL (verified) +
    // busy_timeout (wait instead of "database is locked") + synchronous=NORMAL.
    // Done BEFORE any DDL so the CREATE statements below already benefit from
    // the busy_timeout if another handle is mid-write at startup.
    let mode = configure_connection(&conn)?;
    static MODE_LOG_ONCE: OnceLock<()> = OnceLock::new();
    MODE_LOG_ONCE.get_or_init(|| {
        eprintln!("[vector] connection journal_mode={mode}, busy_timeout={BUSY_TIMEOUT_MS}ms");
    });

    // Create vec0 virtual tables for every allowed collection.
    for name in ALLOWED_COLLECTIONS {
        let ddl = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS vec_{name} \
             USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[{EMBED_DIM}])"
        );
        conn.execute_batch(&ddl)
            .map_err(|e| format!("create vec_{name}: {e}"))?;
    }

    // AM-2 — side table holding the human-readable content + metadata of every
    // `memory` vector. vec0 only stores `(id, embedding)`; to RECALL an actual
    // fact we map the kNN hit id back to its text here. Kept in the same DB so
    // the embedding and its payload live and die together (a `vec_delete` on the
    // memory collection should also purge this row — done in `vec_delete`).
    //   - `kind`            : "fact" (remember hook) | "episode" (compaction)
    //   - `role`            : the agent role that produced it ("orchestrator"…)
    //   - `conversation_id` : the chat it belongs to (NULL for Atelier/Grounded)
    //   - `text`            : the recalled content
    //   - `ts`              : creation time (ms) — used to scope/age memories
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_memory (
            id              TEXT PRIMARY KEY,
            kind            TEXT NOT NULL,
            role            TEXT NOT NULL,
            conversation_id TEXT,
            text            TEXT NOT NULL,
            ts              INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_memory_conv
            ON agent_memory(conversation_id);",
    )
    .map_err(|e| format!("create agent_memory: {e}"))?;

    // Phase 5 — side table tracking, per workspace-relative file, the EXACT set
    // of chunk ids currently indexed for it in `vec_code`. vec0 has no
    // DELETE-by-LIKE / range query, so to re-index a single file we must know its
    // PRIOR ids to delete them precisely before inserting the new chunks. Storing
    // the id list as a JSON array keeps it one row per file (no fan-out table) and
    // lets `index_file_internal` diff old→new deterministically. `indexed_at` is a
    // millisecond timestamp for observability / future staleness checks.
    //   - `path`       : workspace-relative, forward-slash (same space as chunk ids)
    //   - `chunk_ids`  : JSON array of `path#Lstart-end` strings (current chunks)
    //   - `indexed_at` : last (re)index time (ms since epoch)
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vec_code_files (
            path       TEXT PRIMARY KEY,
            chunk_ids  TEXT NOT NULL,
            indexed_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("create vec_code_files: {e}"))?;

    let _ = VEC_CONN.set(Mutex::new(conn));
    Ok(VEC_CONN.get().unwrap())
}

// ---------------------------------------------------------------------------
// Float vector serialisation
//
// sqlite-vec's vec0 table expects embeddings as a BLOB of little-endian f32
// values (IEEE 754, 4 bytes each, no header).  We convert in-place.
// ---------------------------------------------------------------------------

fn serialize_f32_vec(v: &[f32]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(v.len() * 4);
    for &f in v {
        buf.extend_from_slice(&f.to_le_bytes());
    }
    buf
}

// ---------------------------------------------------------------------------
// Embedding (fastembed)
// ---------------------------------------------------------------------------

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

static EMBED_MODEL: OnceLock<Result<TextEmbedding, String>> = OnceLock::new();

/// Lazily initialise the fastembed model.
///
/// On Windows, the ONNX Runtime native DLL is downloaded on first use from
/// HuggingFace.  If init fails (network, ONNX runtime mismatch, etc.), this
/// returns `Err(...)` and every call to `embed()` propagates that error
/// gracefully — no panic.
fn get_model() -> Result<&'static TextEmbedding, String> {
    let result = EMBED_MODEL.get_or_init(|| {
        TextEmbedding::try_new(InitOptions::new(EmbeddingModel::AllMiniLML6V2))
            .map_err(|e| format!("embedding model unavailable: {e}"))
    });
    result.as_ref().map_err(|e| e.clone())
}

/// Embed a single string into an `EMBED_DIM`-dimensional f32 vector.
fn embed(text: &str) -> Result<Vec<f32>, String> {
    let model = get_model()?;
    let mut batch = model
        .embed(vec![text.to_string()], None)
        .map_err(|e| format!("embed error: {e}"))?;
    batch
        .pop()
        .filter(|v| v.len() == EMBED_DIM)
        .ok_or_else(|| format!("expected {EMBED_DIM}-dim vector, got unexpected output"))
}

// ---------------------------------------------------------------------------
// Collection validation
// ---------------------------------------------------------------------------

fn validate_collection(collection: &str) -> Result<(), String> {
    if ALLOWED_COLLECTIONS.contains(&collection) {
        Ok(())
    } else {
        Err(format!(
            "invalid collection '{collection}'; allowed: {}",
            ALLOWED_COLLECTIONS.join(", ")
        ))
    }
}

// ---------------------------------------------------------------------------
// Phase 5 — deterministic source chunker (Rust port of src/features/fs/chunker.ts)
//
// PARITY IS LOAD-BEARING. The TS chunker (workspaceIndexer's full-walk) and this
// Rust chunker (incremental single-file reindex) BOTH write into the SAME
// `vec_code` collection using the SAME id scheme `path#Lstart-end`. If they
// disagree on where a file's chunk boundaries fall, an incremental reindex would
// DELETE the TS-shaped ids it recorded… but then INSERT Rust-shaped ids that the
// full-walk would later treat as foreign — producing duplicate or orphan chunks
// and a silently corrupt index. The chunker-parity test pins this invariant.
//
// Rules, mirrored 1:1 from chunker.ts:
//   - lines = text.split(/\r?\n/)  (CRLF normalised to LF; a trailing newline
//     yields a final empty line element, exactly like JS String.split).
//   - MAX_CHUNK_LINES = 160, MIN_CHUNK_LINES = 6.
//   - a line is a boundary iff it is in column 0 (non-empty, not starting with
//     whitespace) AND matches DECL_RE or MD_HEADER_RE.
//   - flush(endExclusive): no-op when endExclusive <= start; otherwise emit the
//     [start, endExclusive) slice (joined by \n) ONLY when its trimmed body is
//     non-empty, then advance `start = endExclusive` unconditionally.
//   - chunk ranges are 1-indexed inclusive: startLine = start+1, endLine =
//     endExclusive (the count of lines up to and including the last one).
// ---------------------------------------------------------------------------

const MAX_CHUNK_LINES: usize = 160;
const MIN_CHUNK_LINES: usize = 6;

/// Mirror of chunker.ts `isBoundary`. The two regexes there are anchored at the
/// start of the line; here we hand-roll the same matching with plain string ops
/// (no regex crate dependency, and it keeps the parity reviewable). A boundary
/// line must be in column 0 — non-empty and not starting with ASCII/Unicode
/// whitespace — and then either look like a top-level declaration or a markdown
/// header.
fn is_boundary(line: &str) -> bool {
    // chunker.ts: `if (line.length === 0 || /^\s/.test(line)) return false;`
    // JS \s also matches \r; our lines are already CR-stripped, but guard anyway.
    let first = match line.chars().next() {
        None => return false,
        Some(c) => c,
    };
    if first.is_whitespace() {
        return false;
    }
    md_header_re(line) || decl_re(line)
}

/// MD_HEADER_RE = /^#{1,6}\s/ — 1..=6 '#' then a whitespace char.
fn md_header_re(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut hashes = 0usize;
    while hashes < bytes.len() && bytes[hashes] == b'#' {
        hashes += 1;
    }
    if hashes == 0 || hashes > 6 {
        return false;
    }
    // The char immediately after the hashes must be whitespace (and must exist).
    match line[hashes..].chars().next() {
        Some(c) => c.is_whitespace(),
        None => false,
    }
}

/// DECL_RE (chunker.ts):
/// `^(?:export\s+(?:default\s+)?)?(?:pub(?:\([^)]*\))?\s+)?
///   (?:public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|
///      abstract\s+|final\s+|unsafe\s+)*
///   (?:function|class|interface|type|enum|struct|impl|trait|fn|def|func|module|
///      namespace|component|const|let|var|val|public|private|protected|@|#\[)`
///
/// Ported as a small deterministic scanner over the line's leading tokens. The
/// regex is anchored at `^`, so we consume the optional `export …`, optional
/// `pub …`, then zero-or-more visibility/modifier keywords, and finally require
/// one of the declaration keywords / sigils. The two trailing alternatives `@`
/// and `#[` are sigils (not followed by a word boundary), so they are matched as
/// raw prefixes; every keyword alternative is matched as a prefix exactly as the
/// regex would (the regex has no trailing `\b`, mirroring chunker.ts verbatim).
fn decl_re(line: &str) -> bool {
    let mut rest = line;

    // (?:export\s+(?:default\s+)?)?
    if let Some(after) = strip_kw_ws(rest, "export") {
        rest = after;
        if let Some(after2) = strip_kw_ws(rest, "default") {
            rest = after2;
        }
    }

    // (?:pub(?:\([^)]*\))?\s+)?
    if let Some(after) = strip_pub(rest) {
        rest = after;
    }

    // (?:public\s+|private\s+|...|unsafe\s+)*  — zero or more, each kw + \s+ —
    // FOLLOWED BY the required keyword group. The JS regex engine BACKTRACKS:
    // because `public`/`private`/`protected` appear in BOTH the modifier set and
    // the keyword set, a line like "public static void …" matches by consuming
    // ZERO modifiers and letting the keyword group match `public` directly. A
    // greedy no-backtrack scan (consume `public static`, then fail on `void`)
    // would WRONGLY reject it and diverge from chunker.ts. We therefore try the
    // keyword group at every modifier-boundary: after zero modifiers, after one,
    // after two, …  If it matches at ANY split point, the whole regex matches.
    const MODIFIERS: &[&str] = &[
        "public", "private", "protected", "internal", "static", "async",
        "abstract", "final", "unsafe",
    ];
    loop {
        // Try the required keyword group AT THIS position first (the engine can
        // stop consuming modifiers here and hand off to the keyword alternative).
        if matches_decl_keyword(rest) {
            return true;
        }
        // Otherwise consume one more modifier and retry; stop when none match.
        let mut advanced = false;
        for kw in MODIFIERS {
            if let Some(after) = strip_kw_ws(rest, kw) {
                rest = after;
                advanced = true;
                break;
            }
        }
        if !advanced {
            return false;
        }
    }
}

/// The final required alternative of DECL_RE:
/// `(?:function|class|...|@|#\[)`. Word keywords are matched as prefixes (the
/// regex has no trailing word boundary, mirroring chunker.ts verbatim); `@` and
/// `#[` are sigil prefixes.
fn matches_decl_keyword(rest: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "function", "class", "interface", "type", "enum", "struct", "impl",
        "trait", "fn", "def", "func", "module", "namespace", "component",
        "const", "let", "var", "val", "public", "private", "protected",
    ];
    for kw in KEYWORDS {
        if rest.starts_with(kw) {
            return true;
        }
    }
    rest.starts_with('@') || rest.starts_with("#[")
}

/// If `s` starts with the keyword `kw` followed by at least one whitespace char,
/// return the remainder AFTER the whitespace run (mirrors `kw\s+`). The regex
/// `\s+` is greedy, so we consume all consecutive whitespace.
fn strip_kw_ws<'a>(s: &'a str, kw: &str) -> Option<&'a str> {
    let after_kw = s.strip_prefix(kw)?;
    let trimmed = after_kw.trim_start_matches(|c: char| c.is_whitespace());
    if trimmed.len() == after_kw.len() {
        // No whitespace consumed → `\s+` (one-or-more) failed.
        return None;
    }
    Some(trimmed)
}

/// `pub(?:\([^)]*\))?\s+` — `pub`, an optional `(…)` visibility scope, then
/// required whitespace.
fn strip_pub(s: &str) -> Option<&str> {
    let after_pub = s.strip_prefix("pub")?;
    // Optional (?:\([^)]*\))
    let after_scope = if after_pub.starts_with('(') {
        match after_pub.find(')') {
            Some(idx) => &after_pub[idx + 1..],
            None => return None, // unbalanced `(` — regex's `[^)]*\)` can't match
        }
    } else {
        after_pub
    };
    let trimmed = after_scope.trim_start_matches(|c: char| c.is_whitespace());
    if trimmed.len() == after_scope.len() {
        return None; // required `\s+` failed
    }
    Some(trimmed)
}

/// Split `text` into LF-normalised lines exactly like JS `text.split(/\r?\n/)`:
/// a trailing `\n` produces a final empty element. We achieve this by splitting
/// on `\n` and stripping a single trailing `\r` from each piece.
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// Port of chunker.ts `chunkSource`. Returns `(chunk_text, start_line, end_line)`
/// with 1-indexed inclusive line ranges. Empty / all-whitespace input → empty vec.
fn chunk_source(text: &str) -> Vec<(String, usize, usize)> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let lines = split_lines(text);
    let mut chunks: Vec<(String, usize, usize)> = Vec::new();
    let mut start: usize = 0; // 0-indexed start of the current chunk

    // flush(endExclusive): emit [start, endExclusive) if non-blank, advance start.
    let flush = |chunks: &mut Vec<(String, usize, usize)>, start: &mut usize, end_exclusive: usize| {
        if end_exclusive <= *start {
            return;
        }
        let body = lines[*start..end_exclusive].join("\n");
        if !body.trim().is_empty() {
            // startLine = start + 1, endLine = end_exclusive (1-indexed inclusive).
            chunks.push((body, *start + 1, end_exclusive));
        }
        *start = end_exclusive;
    };

    for i in 0..lines.len() {
        let size_so_far = i - start;
        let at_boundary = i > start && is_boundary(lines[i]) && size_so_far >= MIN_CHUNK_LINES;
        let too_big = size_so_far >= MAX_CHUNK_LINES;
        if at_boundary || too_big {
            flush(&mut chunks, &mut start, i);
        }
    }
    flush(&mut chunks, &mut start, lines.len());
    chunks
}

/// Stable chunk id, identical to chunker.ts `chunkId`: `path#Lstart-end`.
fn chunk_id(path: &str, start: usize, end: usize) -> String {
    format!("{path}#L{start}-{end}")
}

// ---------------------------------------------------------------------------
// Phase 5 — code-eligibility filter (mirror of workspaceIndexer.ts gates)
// ---------------------------------------------------------------------------

/// Extensions excluded from indexing — binaries, media, models/datasets, huge
/// lockfiles. Mirror of `EXCLUDE_EXTS` in workspaceIndexer.ts. The extension is
/// the LAST dot-segment, lower-cased (so `foo.min.js` → "js"), matching both the
/// TS list's intent and `fs_list_files`'s `rsplit_once('.')` behaviour.
const EXCLUDE_EXTS: &[&str] = &[
    // images / media
    "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "avif",
    "mp3", "mp4", "wav", "ogg", "flac", "webm", "mov", "avi", "mkv",
    // archives
    "pdf", "zip", "tar", "gz", "br", "7z", "rar", "xz", "zst",
    // compiled / native
    "wasm", "bin", "dll", "so", "dylib", "exe", "o", "a", "lib", "pdb",
    // fonts
    "ttf", "otf", "woff", "woff2", "eot",
    // ML models / weights / datasets
    "safetensors", "ckpt", "pt", "pth", "onnx", "gguf", "ggml",
    "npy", "npz", "h5", "hdf5", "pkl", "pickle", "parquet", "arrow",
    // huge / non-useful text
    "lock", "map",
];

/// Max file size eligible for indexing (mirror of workspaceIndexer's
/// `MAX_FILE_BYTES`). fastembed would time out on larger inputs.
const MAX_FILE_BYTES: usize = 200_000;

/// Decide whether `(rel, text)` should be indexed into `vec_code`. Mirrors the
/// three workspaceIndexer gates: extension not in EXCLUDE_EXTS, byte size within
/// MAX_FILE_BYTES, and non-empty (trimmed) content.
fn is_code_eligible(rel: &str, text: &str) -> bool {
    if text.len() > MAX_FILE_BYTES {
        return false;
    }
    if text.trim().is_empty() {
        return false;
    }
    // Extension = last dot-segment of the file name (not the whole rel path), so
    // a directory like `a.b/file` doesn't get mis-classified by `a.b`.
    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
    if let Some((_, ext)) = name.rsplit_once('.') {
        let ext = ext.to_ascii_lowercase();
        if EXCLUDE_EXTS.contains(&ext.as_str()) {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Phase 5 — incremental single-file (re)index
// ---------------------------------------------------------------------------

/// Current epoch time in milliseconds (0 on the impossible clock-before-epoch).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// (Re)index a single workspace-relative file into `vec_code`.
///
/// Returns the number of chunks indexed (0 for a no-op: missing/binary/too-large
/// file, or an ineligible/empty one — these are NORMAL outcomes, not errors, so
/// the watcher loop doesn't log-spam on every deleted or binary file). Only a
/// genuine failure (embedding model not ready, DB error) returns `Err`.
///
/// Stale-purge correctness: vec0 exposes no DELETE-by-range, so we read the file's
/// PRIOR chunk ids from `vec_code_files`, delete each by EXACT id from `vec_code`,
/// then insert the freshly-computed chunks and upsert the new id list — all inside
/// ONE IMMEDIATE transaction so a concurrent search never sees a half-reindexed
/// file (old chunks gone, new ones not yet in) or a crash leaving orphans.
///
/// Embeddings are computed OUTSIDE the connection lock (they're the slow part and
/// must not hold the write lock while the model runs).
pub(crate) fn index_file_internal(
    app: &tauri::AppHandle,
    root: &Path,
    rel: &str,
) -> Result<usize, String> {
    // Read via the same guarded reader the editor/agent use (size + binary +
    // containment guards). A missing/binary/too-large file is a NO-OP (Ok(0)),
    // not an error: on a Remove or a binary save we simply have nothing to index.
    let text = match crate::commands::fs::read_file_inner(root, rel, None) {
        Ok(t) => t,
        Err(_) => return Ok(0),
    };

    if !is_code_eligible(rel, &text) {
        return Ok(0);
    }

    let chunks = chunk_source(&text);
    if chunks.is_empty() {
        return Ok(0);
    }

    // Embed every chunk OUTSIDE the conn lock. A single embed failure (model not
    // ready) aborts the whole file with Err so the caller can log-once-and-skip;
    // we never index a file partially.
    let mut prepared: Vec<(String, Vec<u8>)> = Vec::with_capacity(chunks.len());
    for (body, start, end) in &chunks {
        let id = chunk_id(rel, *start, *end);
        let blob = serialize_f32_vec(&embed(body)?);
        prepared.push((id, blob));
    }
    let new_ids: Vec<String> = prepared.iter().map(|(id, _)| id.clone()).collect();
    let new_ids_json =
        serde_json::to_string(&new_ids).map_err(|e| format!("serialize chunk ids: {e}"))?;

    let mut guard = get_conn(app)?.lock().map_err(|e| format!("lock: {e}"))?;
    let tx = guard
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| format!("index_file begin: {e}"))?;

    // 1. Read the file's PRIOR chunk ids (if any) and delete each by exact id.
    let prior_json: Option<String> = tx
        .query_row(
            "SELECT chunk_ids FROM vec_code_files WHERE path = ?1",
            params![rel],
            |r| r.get(0),
        )
        .ok();
    if let Some(json) = prior_json {
        let prior_ids: Vec<String> =
            serde_json::from_str(&json).map_err(|e| format!("parse prior chunk ids: {e}"))?;
        for id in &prior_ids {
            tx.execute("DELETE FROM vec_code WHERE id = ?1", params![id])
                .map_err(|e| format!("index_file delete prior chunk: {e}"))?;
        }
    }

    // 2. Insert the new chunks.
    for (id, blob) in &prepared {
        tx.execute(
            "INSERT OR REPLACE INTO vec_code(id, embedding) VALUES (?1, ?2)",
            params![id, blob],
        )
        .map_err(|e| format!("index_file insert chunk: {e}"))?;
    }

    // 3. Upsert the side-table row with the new id list + timestamp.
    tx.execute(
        "INSERT OR REPLACE INTO vec_code_files(path, chunk_ids, indexed_at) VALUES (?1, ?2, ?3)",
        params![rel, new_ids_json, now_ms()],
    )
    .map_err(|e| format!("index_file upsert side table: {e}"))?;

    tx.commit().map_err(|e| format!("index_file commit: {e}"))?;
    Ok(prepared.len())
}

/// Remove a file's index entirely: delete its tracked chunk ids from `vec_code`
/// and drop its `vec_code_files` row, in one IMMEDIATE transaction. Used for
/// filesystem Remove events. A file with no tracked row is a clean no-op (Ok).
pub(crate) fn delete_file_index_internal(
    app: &tauri::AppHandle,
    rel: &str,
) -> Result<(), String> {
    let mut guard = get_conn(app)?.lock().map_err(|e| format!("lock: {e}"))?;
    let tx = guard
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| format!("delete_file begin: {e}"))?;

    let prior_json: Option<String> = tx
        .query_row(
            "SELECT chunk_ids FROM vec_code_files WHERE path = ?1",
            params![rel],
            |r| r.get(0),
        )
        .ok();
    if let Some(json) = prior_json {
        let prior_ids: Vec<String> =
            serde_json::from_str(&json).map_err(|e| format!("parse prior chunk ids: {e}"))?;
        for id in &prior_ids {
            tx.execute("DELETE FROM vec_code WHERE id = ?1", params![id])
                .map_err(|e| format!("delete_file delete chunk: {e}"))?;
        }
    }
    tx.execute("DELETE FROM vec_code_files WHERE path = ?1", params![rel])
        .map_err(|e| format!("delete_file drop side row: {e}"))?;

    tx.commit().map_err(|e| format!("delete_file commit: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A single KNN search result returned to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VecHit {
    pub id: String,
    pub distance: f32,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Embed `text` and upsert the vector under `id` in `vec_<collection>`.
///
/// Errors if the collection name is not in the allowlist or if the embedding
/// model is unavailable.
#[tauri::command(async)]
pub fn vec_index(
    app: tauri::AppHandle,
    collection: String,
    id: String,
    text: String,
) -> Result<(), String> {
    validate_collection(&collection)?;
    let blob = serialize_f32_vec(&embed(&text)?);
    let guard = get_conn(&app)?.lock().map_err(|e| format!("lock: {e}"))?;
    let sql = format!(
        "INSERT OR REPLACE INTO vec_{collection}(id, embedding) VALUES (?1, ?2)"
    );
    guard
        .execute(&sql, params![id, blob])
        .map_err(|e| format!("vec_index: {e}"))?;
    Ok(())
}

/// Internal kNN search — reusable across crates without going through the
/// Tauri command boundary. Validates `collection`, embeds `query`, executes
/// the kNN SQL, and returns the ordered hits. Returns `Err` (never panics)
/// on any failure so callers can degrade gracefully.
pub(crate) fn vec_search_internal(
    app: &tauri::AppHandle,
    collection: &str,
    query: &str,
    k: u32,
) -> Result<Vec<VecHit>, String> {
    validate_collection(collection)?;
    let blob = serialize_f32_vec(&embed(query)?);
    let guard = get_conn(app)?.lock().map_err(|e| format!("lock: {e}"))?;
    let sql = format!(
        "SELECT id, distance FROM vec_{collection} \
         WHERE embedding MATCH ?1 AND k = ?2 \
         ORDER BY distance"
    );
    let mut stmt = guard
        .prepare(&sql)
        .map_err(|e| format!("vec_search prepare: {e}"))?;
    let hits = stmt
        .query_map(params![blob, k], |row| {
            Ok(VecHit {
                id: row.get(0)?,
                distance: row.get(1)?,
            })
        })
        .map_err(|e| format!("vec_search query: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("vec_search row: {e}"))?;
    Ok(hits)
}

/// Return the `k` nearest vectors in `vec_<collection>` to `query`.
///
/// Results are ordered by ascending distance (closest first).
#[tauri::command(async)]
pub fn vec_search(
    app: tauri::AppHandle,
    collection: String,
    query: String,
    k: u32,
) -> Result<Vec<VecHit>, String> {
    vec_search_internal(&app, &collection, &query, k)
}

/// Delete the entry identified by `id` from `vec_<collection>`.
#[tauri::command(async)]
pub fn vec_delete(
    app: tauri::AppHandle,
    collection: String,
    id: String,
) -> Result<(), String> {
    validate_collection(&collection)?;
    let mut guard = get_conn(&app)?.lock().map_err(|e| format!("lock: {e}"))?;
    let sql = format!("DELETE FROM vec_{collection} WHERE id = ?1");
    // AM-5 — the embedding and its payload are deleted as one atomic unit (single
    // IMMEDIATE transaction) so a concurrent recall on another handle never sees
    // a half-deleted state: either both the vector and its agent_memory row are
    // gone, or neither is. For non-`memory` collections the second statement is
    // skipped, so this is still a single-statement transaction.
    let tx = guard
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| format!("vec_delete begin: {e}"))?;
    tx.execute(&sql, params![id])
        .map_err(|e| format!("vec_delete: {e}"))?;
    // AM-2 — keep the `memory` side table in lockstep: deleting the embedding
    // must also drop its payload row so a recall never resurrects a tombstoned
    // memory. No-op for other collections (no matching id in agent_memory).
    if collection == "memory" {
        tx.execute("DELETE FROM agent_memory WHERE id = ?1", params![id])
            .map_err(|e| format!("vec_delete agent_memory: {e}"))?;
    }
    tx.commit().map_err(|e| format!("vec_delete commit: {e}"))?;
    Ok(())
}

/// Delete ALL entries from `vec_<collection>`. Used by "réindexer le code"
/// (Lot 4 suite) pour purger les ids whole-file stale avant un rebuild en
/// chunks. Ne supprime pas la table, juste ses lignes.
#[tauri::command(async)]
pub fn vec_clear(app: tauri::AppHandle, collection: String) -> Result<(), String> {
    validate_collection(&collection)?;
    let mut guard = get_conn(&app)?.lock().map_err(|e| format!("lock: {e}"))?;
    let sql = format!("DELETE FROM vec_{collection}");
    // AM-5 — purge the vec0 table and (for `memory`) its payload side table in a
    // single atomic IMMEDIATE transaction, so a concurrent reindex/recall never
    // observes the embeddings cleared while the payload rows still linger.
    let tx = guard
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| format!("vec_clear begin: {e}"))?;
    tx.execute(&sql, [])
        .map_err(|e| format!("vec_clear: {e}"))?;
    // AM-2 — clearing the memory collection also wipes its payload side table.
    if collection == "memory" {
        tx.execute("DELETE FROM agent_memory", [])
            .map_err(|e| format!("vec_clear agent_memory: {e}"))?;
    }
    // Phase 5 — clearing the code collection MUST also wipe `vec_code_files`, in
    // the SAME atomic transaction. Otherwise the side table keeps stale id lists:
    // after a manual "Réindexer le code" (which calls vec_clear("code") then
    // rebuilds), the next incremental `index_file_internal` would read those
    // orphaned ids and try to DELETE chunks that the rebuild already replaced —
    // and, worse, the side table would claim files are indexed that are no longer
    // present. Mirror of the memory→agent_memory special-case above.
    if collection == "code" {
        tx.execute("DELETE FROM vec_code_files", [])
            .map_err(|e| format!("vec_clear vec_code_files: {e}"))?;
    }
    tx.commit().map_err(|e| format!("vec_clear commit: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// AM-2 — Orchestrated memory (recall / remember)
//
// The `memory` collection holds the agent's durable, searchable memory. Two
// kinds of payload live in it, distinguished by the `kind` column of the
// `agent_memory` side table:
//   - "fact"    : a salient fact/result written by the runner's `remember()`
//                 hook AFTER a turn (e.g. "the build is run with `pnpm build`").
//   - "episode" : an episodic SUMMARY of older conversation turns, written by
//                 COMPACTION when the in-context history outgrows its window —
//                 so old turns are RESUMED into memory instead of dropped.
//
// These helpers are intentionally INFALLIBLE-FRIENDLY: they return `Result` so
// the caller can log, but the runner treats every error as "nothing happened"
// and never lets a memory failure break the agent loop (zero-regression rule).
// ---------------------------------------------------------------------------

/// A single recalled memory — the payload mapped back from a kNN hit.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub distance: f32,
    pub ts: i64,
}

/// Persist one memory: embed `text`, upsert the vector under a fresh UUID, and
/// store its payload + metadata in `agent_memory`. Returns the new id.
///
/// Empty/whitespace text is rejected (nothing to embed) with an explicit error
/// rather than writing a useless zero-signal row.
pub(crate) fn memory_remember(
    app: &tauri::AppHandle,
    kind: &str,
    role: &str,
    conversation_id: Option<&str>,
    text: &str,
) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("memory_remember: empty text".to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let blob = serialize_f32_vec(&embed(trimmed)?);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut guard = get_conn(app)?.lock().map_err(|e| format!("lock: {e}"))?;
    // AM-5 — the embedding row and its payload row are TWO tables that must move
    // together. An IMMEDIATE transaction takes the write lock up front (so a
    // concurrent writer on another handle waits on busy_timeout rather than
    // deadlocking mid-pair) and makes the two INSERTs atomic: a crash or rollback
    // can never leave a vec_memory row whose agent_memory payload is missing
    // (which `memory_recall` would silently skip — a vanished memory).
    let tx = guard
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| format!("memory_remember begin: {e}"))?;
    tx.execute(
        "INSERT OR REPLACE INTO vec_memory(id, embedding) VALUES (?1, ?2)",
        params![id, blob],
    )
    .map_err(|e| format!("memory_remember vec: {e}"))?;
    tx.execute(
        "INSERT OR REPLACE INTO agent_memory(id, kind, role, conversation_id, text, ts) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, kind, role, conversation_id, trimmed, now],
    )
    .map_err(|e| format!("memory_remember payload: {e}"))?;
    tx.commit()
        .map_err(|e| format!("memory_remember commit: {e}"))?;
    Ok(id)
}

/// Recall the `k` memories most semantically relevant to `query`, mapping each
/// kNN hit back to its payload row. Hits whose payload row is missing (a
/// vector orphaned by a partial delete) are skipped. Ordered by ascending
/// distance (closest first). Returns `Ok(vec![])` when the index is empty.
pub(crate) fn memory_recall(
    app: &tauri::AppHandle,
    query: &str,
    k: u32,
) -> Result<Vec<MemoryHit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let hits = vec_search_internal(app, "memory", query, k)?;
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    let guard = get_conn(app)?.lock().map_err(|e| format!("lock: {e}"))?;
    let mut out: Vec<MemoryHit> = Vec::with_capacity(hits.len());
    for h in hits {
        let row: rusqlite::Result<(String, String, i64)> = guard.query_row(
            "SELECT kind, text, ts FROM agent_memory WHERE id = ?1",
            params![h.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        );
        if let Ok((kind, text, ts)) = row {
            out.push(MemoryHit {
                id: h.id,
                kind,
                text,
                distance: h.distance,
                ts,
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// AM-2 — Tauri commands (frontend-facing memory surface)
// ---------------------------------------------------------------------------

/// Search the agent's orchestrated memory for the `k` entries most relevant to
/// `query`. Thin async wrapper over `memory_recall` so the UI (Diagnostics /
/// memory inspector) can browse what the agent has remembered.
#[tauri::command(async)]
pub fn memory_search(
    app: tauri::AppHandle,
    query: String,
    k: u32,
) -> Result<Vec<MemoryHit>, String> {
    memory_recall(&app, &query, k.clamp(1, 50))
}

// ---------------------------------------------------------------------------
// Phase 5 — incremental index + semantic search (frontend-facing commands)
// ---------------------------------------------------------------------------

/// Resolve the current workspace root from managed state, or `Err` when no
/// folder is open. Same `Mutex<Option<PathBuf>>` state the fs.rs commands use.
fn lock_workspace_root(
    root_state: &tauri::State<'_, Mutex<Option<std::path::PathBuf>>>,
) -> Result<std::path::PathBuf, String> {
    let guard = root_state
        .lock()
        .map_err(|e| format!("workspace state lock: {e}"))?;
    guard
        .clone()
        .ok_or_else(|| "no workspace open".to_string())
}

/// (Re)index a single workspace-relative file into the `code` collection.
///
/// Returns the number of chunks indexed. A missing / binary / too-large / empty
/// file is a no-op (`Ok(0)`), not an error — so the watcher and a manual reindex
/// of a deleted-then-recreated file both behave predictably. Embedding-model or
/// DB failures propagate as `Err` for the caller to surface.
#[tauri::command(async)]
pub fn vec_index_file(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<std::path::PathBuf>>>,
    path: String,
) -> Result<usize, String> {
    let root = lock_workspace_root(&root_state)?;
    index_file_internal(&app, &root, &path)
}

/// Remove a single workspace-relative file's chunks from the `code` collection
/// (and its `vec_code_files` row). Used when a file is deleted. A file that was
/// never indexed is a clean no-op.
#[tauri::command(async)]
pub fn vec_remove_file(
    app: tauri::AppHandle,
    root_state: tauri::State<'_, Mutex<Option<std::path::PathBuf>>>,
    path: String,
) -> Result<(), String> {
    // root_state isn't strictly needed for a delete (ids are workspace-relative),
    // but we take it for symmetry with `vec_index_file` and to fail fast with a
    // clean "no workspace open" rather than silently no-op'ing when none is set.
    let _root = lock_workspace_root(&root_state)?;
    delete_file_index_internal(&app, &path)
}

/// Standalone semantic search over the indexed `code` collection — the command
/// the palette's "Search semantically" action and the parity work call directly,
/// without going through the generic `vec_search` (which exposes every
/// collection). `k` is clamped to 1..=50. Returns `Ok(vec![])` when the index is
/// empty OR the embedding model isn't ready yet, so the UI degrades to "no
/// results" instead of surfacing an error on a cold model.
#[tauri::command(async)]
pub fn semantic_search(
    app: tauri::AppHandle,
    query: String,
    k: u32,
) -> Result<Vec<VecHit>, String> {
    match vec_search_internal(&app, "code", &query, k.clamp(1, 50)) {
        Ok(hits) => Ok(hits),
        // An empty/cold index or an unavailable embedding model must not error
        // the palette — degrade to no results (the full-walk indexer surfaces
        // model-unavailability through its own toast).
        Err(_) => Ok(Vec::new()),
    }
}

// ---------------------------------------------------------------------------
// Tests — AM-5 concurrency safety
//
// These tests exercise the ACTUAL concurrency mechanism (the pragma config in
// `configure_connection` + the IMMEDIATE-transaction compound-write pattern)
// against a real on-disk `shugu.db`. They deliberately do NOT go through the
// Tauri command layer (which needs an AppHandle): the command bodies are thin
// wrappers, and the property under test — "two independent connections to the
// same file don't error with 'database is locked'" — lives entirely in the
// connection configuration, which is what these tests pin down.
//
// `vec0` virtual tables require the sqlite-vec extension; `configure_connection`
// and the transaction semantics are extension-independent, so the tests use a
// plain table mirroring the `(vec_memory, agent_memory)` two-table pattern to
// keep them hermetic (no model download, no extension registration needed).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    /// Monotonic-ish unique tag so parallel test cases never collide on a path.
    fn unique_tag(name: &str) -> String {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{name}_{now}_{n}")
    }

    fn temp_db(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("shugu_vec_test_{}", unique_tag(tag)));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("shugu.db")
    }

    /// Open a connection configured EXACTLY as `get_conn` does in production.
    fn open_configured(path: &std::path::Path) -> (Connection, String) {
        let conn = Connection::open(path).unwrap();
        let mode = configure_connection(&conn).expect("configure_connection must succeed");
        (conn, mode)
    }

    /// Create the two-table shape that `memory_remember` writes to, mirroring the
    /// `(vec_memory, agent_memory)` pair without needing the sqlite-vec extension.
    fn create_pair_schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vec_memory (id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS agent_memory (
                 id TEXT PRIMARY KEY, kind TEXT NOT NULL, role TEXT NOT NULL,
                 conversation_id TEXT, text TEXT NOT NULL, ts INTEGER NOT NULL);",
        )
        .unwrap();
    }

    /// The compound write `memory_remember` performs, distilled to the
    /// transaction mechanics (no embedding model needed).
    fn remember_pair(conn: &mut Connection, id: &str, text: &str) -> Result<(), String> {
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("begin: {e}"))?;
        tx.execute(
            "INSERT OR REPLACE INTO vec_memory(id, embedding) VALUES (?1, ?2)",
            params![id, vec![0u8, 1, 2, 3]],
        )
        .map_err(|e| format!("vec insert: {e}"))?;
        tx.execute(
            "INSERT OR REPLACE INTO agent_memory(id, kind, role, conversation_id, text, ts) \
             VALUES (?1, 'fact', 'tester', NULL, ?2, 0)",
            params![id, text],
        )
        .map_err(|e| format!("payload insert: {e}"))?;
        tx.commit().map_err(|e| format!("commit: {e}"))
    }

    /// `configure_connection` must put a real file in WAL and report it back.
    #[test]
    fn configure_connection_enables_wal_and_busy_timeout() {
        let db = temp_db("wal");
        let (conn, mode) = open_configured(&db);
        assert_eq!(mode, "wal", "on-disk DB must be in WAL mode");

        // The pragma is observable on the live connection.
        let live: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(live.to_lowercase(), "wal");

        // busy_timeout is reflected back by `PRAGMA busy_timeout` (ms).
        let bt: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(bt, BUSY_TIMEOUT_MS as i64, "busy_timeout must be applied");

        // synchronous=NORMAL maps to integer 1.
        let sync: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 1, "synchronous must be NORMAL (1) under WAL");

        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    /// The compound write is atomic: a forced failure mid-pair (here: a rollback
    /// triggered by a constraint we provoke) leaves NEITHER row, never a half.
    #[test]
    fn compound_write_is_atomic() {
        let db = temp_db("atomic");
        let (mut conn, _) = open_configured(&db);
        create_pair_schema(&conn);

        // Happy path: both rows land together.
        remember_pair(&mut conn, "m1", "hello").unwrap();
        let vec_n: i64 = conn
            .query_row("SELECT COUNT(*) FROM vec_memory", [], |r| r.get(0))
            .unwrap();
        let pay_n: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_memory", [], |r| r.get(0))
            .unwrap();
        assert_eq!((vec_n, pay_n), (1, 1), "both tables in lockstep");

        // Failure path: a transaction whose second statement errors must roll the
        // first one back — no orphaned vec_memory row survives.
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        tx.execute(
            "INSERT OR REPLACE INTO vec_memory(id, embedding) VALUES ('m2', x'00')",
            [],
        )
        .unwrap();
        // Force an error: NOT NULL violation on agent_memory.text.
        let bad = tx.execute(
            "INSERT INTO agent_memory(id, kind, role, text, ts) VALUES ('m2','fact','t', NULL, 0)",
            [],
        );
        assert!(bad.is_err(), "NULL into NOT NULL must fail");
        drop(tx); // dropping without commit rolls back

        let vec_n2: i64 = conn
            .query_row("SELECT COUNT(*) FROM vec_memory", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vec_n2, 1, "rolled-back vec_memory insert left no orphan");

        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    /// THE AM-5 TEST: many threads, TWO independent connections to the SAME file
    /// (mimicking VEC_CONN vs AGENTS_CONN), writing concurrently. With WAL +
    /// busy_timeout configured, NOT ONE write may fail with "database is locked",
    /// and every committed row must be present and consistent across both tables.
    #[test]
    fn concurrent_writers_two_connections_no_lock_errors() {
        let db = temp_db("concurrent");

        // Seed schema on a primary connection (the "VEC_CONN" analogue).
        {
            let (conn, mode) = open_configured(&db);
            assert_eq!(mode, "wal");
            create_pair_schema(&conn);
        }

        const THREADS: usize = 8;
        const PER_THREAD: usize = 40;

        // Shared Mutex<Connection> #1 — the VEC_CONN analogue, shared by half the
        // threads (serialised within itself, exactly like production).
        let conn_a = Arc::new(Mutex::new({
            let (c, _) = open_configured(&db);
            c
        }));
        // Shared Mutex<Connection> #2 — a SEPARATE connection (AGENTS_CONN
        // analogue). SQLite, not the Mutex, arbitrates between A and B: this is
        // the exact cross-handle contention AM-5 is about.
        let conn_b = Arc::new(Mutex::new({
            let (c, _) = open_configured(&db);
            c
        }));

        let errors = Arc::new(Mutex::new(Vec::<String>::new()));
        let mut handles = Vec::new();

        for t in 0..THREADS {
            // Even threads drive connection A, odd threads drive connection B —
            // so writes genuinely contend ACROSS two handles, not just within one.
            let conn = if t % 2 == 0 {
                Arc::clone(&conn_a)
            } else {
                Arc::clone(&conn_b)
            };
            let errors = Arc::clone(&errors);
            handles.push(std::thread::spawn(move || {
                for i in 0..PER_THREAD {
                    let id = format!("t{t}_i{i}");
                    let mut guard = conn.lock().unwrap();
                    if let Err(e) = remember_pair(&mut guard, &id, &format!("text-{id}")) {
                        // The whole point: with busy_timeout this branch must
                        // stay empty. "database is locked" here = AM-5 regression.
                        errors.lock().unwrap().push(e);
                    }
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let errs = errors.lock().unwrap();
        assert!(
            errs.is_empty(),
            "concurrent writers across two connections must not error (busy_timeout \
             should absorb contention); got {} error(s), first: {:?}",
            errs.len(),
            errs.first()
        );

        // Consistency: every (id) committed to vec_memory has its agent_memory
        // payload, and the counts match the total work issued.
        let (conn, _) = open_configured(&db);
        let expected = (THREADS * PER_THREAD) as i64;
        let vec_n: i64 = conn
            .query_row("SELECT COUNT(*) FROM vec_memory", [], |r| r.get(0))
            .unwrap();
        let pay_n: i64 = conn
            .query_row("SELECT COUNT(*) FROM agent_memory", [], |r| r.get(0))
            .unwrap();
        let orphans: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vec_memory v \
                 LEFT JOIN agent_memory a ON a.id = v.id WHERE a.id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(vec_n, expected, "all vec rows committed");
        assert_eq!(pay_n, expected, "all payload rows committed");
        assert_eq!(orphans, 0, "no vec row left without its payload (atomic pairs)");

        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    // =======================================================================
    // Phase 5 — chunker parity, eligibility, and incremental-index tests
    // =======================================================================

    // -----------------------------------------------------------------------
    // THE MANDATORY GATE: Rust chunk_source must match chunker.ts byte-for-byte
    // on the SAME fixtures used by src/features/fs/chunker.test.ts. Divergence
    // here means the full-walk (TS) and incremental (Rust) indexers disagree on
    // chunk boundaries → duplicate/orphan chunks in `vec_code`.
    // -----------------------------------------------------------------------

    /// Helper: assert the universal chunker invariants on any output —
    /// contiguous, non-overlapping, 1-indexed inclusive, covering every
    /// non-blank line, and chunk_id formatting.
    fn assert_chunk_invariants(text: &str, chunks: &[(String, usize, usize)]) {
        let lines = split_lines(text);
        // Find the indices of all non-blank lines (1-indexed).
        let nonblank: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.trim().is_empty())
            .map(|(i, _)| i + 1)
            .collect();

        if chunks.is_empty() {
            assert!(
                nonblank.is_empty(),
                "empty chunk output is only valid for all-blank input"
            );
            return;
        }

        // Contiguous + non-overlapping: each chunk starts right after the prior.
        for w in chunks.windows(2) {
            let (_, _, prev_end) = &w[0];
            let (_, next_start, _) = &w[1];
            assert_eq!(
                *next_start,
                prev_end + 1,
                "chunks must be contiguous and non-overlapping"
            );
        }
        // 1-indexed inclusive, ordered, start<=end.
        for (_, start, end) in chunks {
            assert!(*start >= 1, "startLine is 1-indexed");
            assert!(start <= end, "startLine <= endLine (inclusive range)");
        }
        // Every non-blank line is covered by exactly one chunk's [start,end].
        for ln in &nonblank {
            let covered = chunks.iter().any(|(_, s, e)| ln >= s && ln <= e);
            assert!(covered, "non-blank line {ln} must be covered by some chunk");
        }
        // chunk_id formatting.
        let (_, s, e) = &chunks[0];
        assert_eq!(chunk_id("src/foo.ts", *s, *e), format!("src/foo.ts#L{s}-{e}"));
    }

    #[test]
    fn chunker_parity_empty_and_whitespace() {
        // chunker.test.ts: empty / whitespace → []
        assert!(chunk_source("").is_empty());
        assert!(chunk_source("   \n  \n").is_empty());
    }

    #[test]
    fn chunker_parity_small_boundaryless_single_chunk() {
        // chunker.test.ts: "line1\nline2\nline3" → single chunk 1..3
        let r = chunk_source("line1\nline2\nline3");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], ("line1\nline2\nline3".to_string(), 1, 3));
        assert_chunk_invariants("line1\nline2\nline3", &r);
    }

    #[test]
    fn chunker_parity_splits_at_function_boundary_at_min_size() {
        // chunker.test.ts: two functions, boundary at line 7 (chunk so far = 6 = MIN)
        let src = [
            "function a() {",
            "  return 1;",
            "}",
            "// filler",
            "// filler",
            "// filler",
            "function b() {",
            "  return 2;",
            "}",
        ]
        .join("\n");
        let r = chunk_source(&src);
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].1, r[0].2), (1, 6));
        assert_eq!((r[1].1, r[1].2), (7, 9));
        assert!(r[1].0.contains("function b()"));
        assert_chunk_invariants(&src, &r);
    }

    #[test]
    fn chunker_parity_does_not_split_tiny_consecutive_decls() {
        // chunker.test.ts: three short consts below MIN size → single chunk
        let src = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
        assert_eq!(chunk_source(&src).len(), 1);
    }

    #[test]
    fn chunker_parity_enforces_max_cap() {
        // chunker.test.ts: 400 boundary-less lines → >=3 chunks, each <=160 lines
        let src: String = (0..400)
            .map(|i| format!("data line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let r = chunk_source(&src);
        assert!(r.len() >= 3, "expected the hard MAX cap to split into >=3");
        for (_, s, e) in &r {
            assert!(e - s + 1 <= 160, "no chunk exceeds MAX_CHUNK_LINES");
        }
        assert_chunk_invariants(&src, &r);
    }

    #[test]
    fn chunker_parity_contiguous_covering_all_lines() {
        // chunker.test.ts: contiguous, non-overlapping, covers lines 1..9
        let src = [
            "function a() {", "  x", "}", "f", "f", "f",
            "function b() {", "  y", "}",
        ]
        .join("\n");
        let r = chunk_source(&src);
        for w in r.windows(2) {
            assert_eq!(w[1].1, w[0].2 + 1);
        }
        assert_eq!(r[0].1, 1);
        assert_eq!(r[r.len() - 1].2, 9);
        assert_chunk_invariants(&src, &r);
    }

    #[test]
    fn chunker_parity_normalizes_crlf() {
        // chunker.test.ts: "a\r\nb\r\nc" → single chunk, CRLF normalised to LF
        let r = chunk_source("a\r\nb\r\nc");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, "a\nb\nc");
    }

    #[test]
    fn chunker_parity_python_and_rust_boundaries() {
        // chunker.test.ts: Python `def` and Rust `fn` boundaries each split into 2
        let py = ["def a():", "  pass", "  pass", "  pass", "  pass", "  pass", "def b():", "  pass"].join("\n");
        assert_eq!(chunk_source(&py).len(), 2);
        let rs = ["fn a() {", "  1", "  1", "  1", "  1", "  1", "fn b() {", "  2", "}"].join("\n");
        assert_eq!(chunk_source(&rs).len(), 2);
    }

    #[test]
    fn chunk_id_matches_ts_format() {
        // chunker.test.ts: chunkId("src/foo.ts", {7,12}) === "src/foo.ts#L7-12"
        assert_eq!(chunk_id("src/foo.ts", 7, 12), "src/foo.ts#L7-12");
        // A path that itself contains a hash is preserved verbatim in the prefix
        // (parseChunkId on the TS side anchors on the final #L<n>-<n>).
        assert_eq!(chunk_id("a#b/c.ts", 1, 2), "a#b/c.ts#L1-2");
    }

    #[test]
    fn boundary_detection_matches_decl_re() {
        // Positive cases drawn from DECL_RE / MD_HEADER_RE.
        assert!(is_boundary("function foo() {"));
        assert!(is_boundary("export function foo() {"));
        assert!(is_boundary("export default class X {"));
        assert!(is_boundary("pub fn bar() {"));
        assert!(is_boundary("pub(crate) fn bar() {"));
        assert!(is_boundary("async fn baz() {"));
        assert!(is_boundary("public static void main() {"));
        assert!(is_boundary("impl Foo {"));
        assert!(is_boundary("def python():"));
        assert!(is_boundary("const X = 1;"));
        assert!(is_boundary("@Decorator"));
        assert!(is_boundary("#[derive(Debug)]"));
        assert!(is_boundary("# Markdown header"));
        assert!(is_boundary("###### h6"));
        // Negative cases.
        assert!(!is_boundary("  function indented() {"), "col-0 required");
        assert!(!is_boundary(""), "empty line is not a boundary");
        assert!(!is_boundary("foobar()"), "not a declaration keyword");
        assert!(!is_boundary("####### too many hashes"), ">6 hashes is not MD");
        assert!(!is_boundary("#noheaderspace"), "MD header needs a space");
        assert!(!is_boundary("return 1;"), "plain statement");
    }

    // -----------------------------------------------------------------------
    // is_code_eligible — mirror of workspaceIndexer gates
    // -----------------------------------------------------------------------

    #[test]
    fn is_code_eligible_rejects_and_accepts() {
        // Rejected by extension.
        assert!(!is_code_eligible("assets/logo.png", "data"));
        assert!(!is_code_eligible("models/model.safetensors", "weights"));
        assert!(!is_code_eligible("pnpm-lock.yaml.lock", "x")); // last seg "lock"
        assert!(!is_code_eligible("Cargo.lock", "[[package]]"));
        // Rejected by size (>200 KB).
        let big = "a".repeat(MAX_FILE_BYTES + 1);
        assert!(!is_code_eligible("src/big.ts", &big));
        // Rejected by emptiness.
        assert!(!is_code_eligible("src/empty.ts", ""));
        assert!(!is_code_eligible("src/blank.ts", "   \n  \t\n"));
        // Accepted: source files within size.
        assert!(is_code_eligible("src/main.ts", "export const x = 1;"));
        assert!(is_code_eligible("src/lib.rs", "fn main() {}"));
        assert!(is_code_eligible("docs/README.md", "# Title\n\ntext"));
        // Accepted exactly at the size boundary (==, not >).
        let at_cap = "a".repeat(MAX_FILE_BYTES);
        assert!(is_code_eligible("src/exact.ts", &at_cap));
        // Extension is the LAST dot-segment: foo.min.js → "js" (kept).
        assert!(is_code_eligible("bundle.min.js", "var x=1"));
    }

    // -----------------------------------------------------------------------
    // Stale-purge + atomicity of the incremental-reindex transaction.
    //
    // `index_file_internal` needs an AppHandle (for get_conn + read_file_inner),
    // which a unit test can't construct. Following the precedent of
    // `compound_write_is_atomic`, we exercise the EXACT transaction body against
    // a real on-disk sqlite DB using a plain `vec_code` table (BLOB id/embedding,
    // mirroring vec0's shape) — the delete-prior / insert-new / upsert-side-table
    // logic is identical whether the embedding table is vec0 or a plain table.
    // -----------------------------------------------------------------------

    /// Create the `(vec_code, vec_code_files)` shape that `index_file_internal`
    /// writes to, without needing the sqlite-vec extension.
    fn create_code_schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS vec_code (id TEXT PRIMARY KEY, embedding BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS vec_code_files (
                 path TEXT PRIMARY KEY, chunk_ids TEXT NOT NULL, indexed_at INTEGER NOT NULL);",
        )
        .unwrap();
    }

    /// The reindex transaction body of `index_file_internal`, distilled to its
    /// mechanics: delete the file's prior chunk ids, insert `new_ids`, upsert the
    /// side-table row. `fail_after_first_insert` forces the 2nd insert statement
    /// to error (NOT NULL violation) to test atomic rollback.
    fn reindex_pair(
        conn: &mut Connection,
        rel: &str,
        new_ids: &[String],
        fail_after_first_insert: bool,
    ) -> Result<(), String> {
        let new_ids_json = serde_json::to_string(new_ids).unwrap();
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("begin: {e}"))?;

        let prior_json: Option<String> = tx
            .query_row(
                "SELECT chunk_ids FROM vec_code_files WHERE path = ?1",
                params![rel],
                |r| r.get(0),
            )
            .ok();
        if let Some(json) = prior_json {
            let prior_ids: Vec<String> = serde_json::from_str(&json).unwrap();
            for id in &prior_ids {
                tx.execute("DELETE FROM vec_code WHERE id = ?1", params![id])
                    .map_err(|e| format!("delete prior: {e}"))?;
            }
        }
        for (i, id) in new_ids.iter().enumerate() {
            if fail_after_first_insert && i == 1 {
                // Provoke a constraint failure: NULL into NOT NULL embedding.
                let bad = tx.execute(
                    "INSERT INTO vec_code(id, embedding) VALUES (?1, NULL)",
                    params![id],
                );
                bad.map_err(|e| format!("forced fail: {e}"))?;
            } else {
                tx.execute(
                    "INSERT OR REPLACE INTO vec_code(id, embedding) VALUES (?1, ?2)",
                    params![id, vec![0u8, 1, 2, 3]],
                )
                .map_err(|e| format!("insert: {e}"))?;
            }
        }
        tx.execute(
            "INSERT OR REPLACE INTO vec_code_files(path, chunk_ids, indexed_at) VALUES (?1, ?2, ?3)",
            params![rel, new_ids_json, 12345i64],
        )
        .map_err(|e| format!("upsert side: {e}"))?;

        tx.commit().map_err(|e| format!("commit: {e}"))
    }

    fn code_ids(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT id FROM vec_code ORDER BY id").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn index_file_stale_purge_replaces_exact_prior_ids() {
        let db = temp_db("stale_purge");
        let (mut conn, _) = open_configured(&db);
        create_code_schema(&conn);

        let rel = "src/foo.ts";
        // First index: a 3-chunk file.
        let v1 = vec![
            chunk_id(rel, 1, 6),
            chunk_id(rel, 7, 12),
            chunk_id(rel, 13, 20),
        ];
        reindex_pair(&mut conn, rel, &v1, false).unwrap();
        assert_eq!(code_ids(&conn), {
            let mut s = v1.clone();
            s.sort();
            s
        });
        let stored: String = conn
            .query_row(
                "SELECT chunk_ids FROM vec_code_files WHERE path = ?1",
                params![rel],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Vec<String>>(&stored).unwrap(), v1);

        // Edit shifts ranges so the file is now 2 chunks (DIFFERENT ids).
        let v2 = vec![chunk_id(rel, 1, 8), chunk_id(rel, 9, 15)];
        reindex_pair(&mut conn, rel, &v2, false).unwrap();

        // vec_code holds EXACTLY the 2 new ids and ZERO old ids.
        let now_ids = code_ids(&conn);
        assert_eq!(now_ids.len(), 2, "exactly the 2 new chunks remain");
        for old in &v1 {
            assert!(!now_ids.contains(old), "old chunk id {old} must be purged");
        }
        for new in &v2 {
            assert!(now_ids.contains(new), "new chunk id {new} must be present");
        }
        // Side table now holds the new list.
        let stored2: String = conn
            .query_row(
                "SELECT chunk_ids FROM vec_code_files WHERE path = ?1",
                params![rel],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Vec<String>>(&stored2).unwrap(), v2);

        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    #[test]
    fn index_file_reindex_is_atomic_on_failure() {
        let db = temp_db("reindex_atomic");
        let (mut conn, _) = open_configured(&db);
        create_code_schema(&conn);

        let rel = "src/bar.rs";
        // Seed a clean 2-chunk index.
        let v1 = vec![chunk_id(rel, 1, 6), chunk_id(rel, 7, 12)];
        reindex_pair(&mut conn, rel, &v1, false).unwrap();
        let before = code_ids(&conn);

        // A reindex whose 2nd insert fails must roll back ENTIRELY: neither the
        // prior-id deletes nor the partial inserts persist; the side row is intact.
        let v2 = vec![chunk_id(rel, 1, 4), chunk_id(rel, 5, 10), chunk_id(rel, 11, 18)];
        let r = reindex_pair(&mut conn, rel, &v2, true);
        assert!(r.is_err(), "forced 2nd-statement failure must error");

        // vec_code is byte-identical to before (old chunks NOT deleted, new NOT inserted).
        assert_eq!(
            code_ids(&conn),
            before,
            "a failed reindex leaves vec_code exactly as it was (atomic)"
        );
        // Side table still points at the ORIGINAL list.
        let stored: String = conn
            .query_row(
                "SELECT chunk_ids FROM vec_code_files WHERE path = ?1",
                params![rel],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(serde_json::from_str::<Vec<String>>(&stored).unwrap(), v1);

        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }

    #[test]
    fn delete_file_index_removes_tracked_ids() {
        let db = temp_db("delete_idx");
        let (mut conn, _) = open_configured(&db);
        create_code_schema(&conn);

        let rel = "src/gone.ts";
        let ids = vec![chunk_id(rel, 1, 6), chunk_id(rel, 7, 12)];
        reindex_pair(&mut conn, rel, &ids, false).unwrap();
        assert_eq!(code_ids(&conn).len(), 2);

        // Distilled delete_file_index_internal transaction body.
        {
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .unwrap();
            let prior_json: Option<String> = tx
                .query_row(
                    "SELECT chunk_ids FROM vec_code_files WHERE path = ?1",
                    params![rel],
                    |r| r.get(0),
                )
                .ok();
            if let Some(json) = prior_json {
                let prior: Vec<String> = serde_json::from_str(&json).unwrap();
                for id in &prior {
                    tx.execute("DELETE FROM vec_code WHERE id = ?1", params![id]).unwrap();
                }
            }
            tx.execute("DELETE FROM vec_code_files WHERE path = ?1", params![rel]).unwrap();
            tx.commit().unwrap();
        }

        assert!(code_ids(&conn).is_empty(), "all tracked chunks deleted");
        let side_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vec_code_files WHERE path = ?1", params![rel], |r| r.get(0))
            .unwrap();
        assert_eq!(side_count, 0, "side-table row dropped");

        let _ = std::fs::remove_dir_all(db.parent().unwrap());
    }
}
