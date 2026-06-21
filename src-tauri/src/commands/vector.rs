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
}
