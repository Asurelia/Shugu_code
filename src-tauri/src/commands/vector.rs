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

use rusqlite::{ffi::sqlite3_auto_extension, params, Connection};
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Embedding dimension for `AllMiniLML6V2` (384-dimensional model).
const EMBED_DIM: usize = 384;

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

    // WAL for concurrent access alongside the plugin's sqlx connection.
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("WAL pragma: {e}"))?;

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
    let guard = get_conn(&app)?.lock().map_err(|e| format!("lock: {e}"))?;
    let sql = format!("DELETE FROM vec_{collection} WHERE id = ?1");
    guard
        .execute(&sql, params![id])
        .map_err(|e| format!("vec_delete: {e}"))?;
    // AM-2 — keep the `memory` side table in lockstep: deleting the embedding
    // must also drop its payload row so a recall never resurrects a tombstoned
    // memory. No-op for other collections (no matching id in agent_memory).
    if collection == "memory" {
        guard
            .execute("DELETE FROM agent_memory WHERE id = ?1", params![id])
            .map_err(|e| format!("vec_delete agent_memory: {e}"))?;
    }
    Ok(())
}

/// Delete ALL entries from `vec_<collection>`. Used by "réindexer le code"
/// (Lot 4 suite) pour purger les ids whole-file stale avant un rebuild en
/// chunks. Ne supprime pas la table, juste ses lignes.
#[tauri::command(async)]
pub fn vec_clear(app: tauri::AppHandle, collection: String) -> Result<(), String> {
    validate_collection(&collection)?;
    let guard = get_conn(&app)?.lock().map_err(|e| format!("lock: {e}"))?;
    let sql = format!("DELETE FROM vec_{collection}");
    guard
        .execute(&sql, [])
        .map_err(|e| format!("vec_clear: {e}"))?;
    // AM-2 — clearing the memory collection also wipes its payload side table.
    if collection == "memory" {
        guard
            .execute("DELETE FROM agent_memory", [])
            .map_err(|e| format!("vec_clear agent_memory: {e}"))?;
    }
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
    let guard = get_conn(app)?.lock().map_err(|e| format!("lock: {e}"))?;
    guard
        .execute(
            "INSERT OR REPLACE INTO vec_memory(id, embedding) VALUES (?1, ?2)",
            params![id, blob],
        )
        .map_err(|e| format!("memory_remember vec: {e}"))?;
    guard
        .execute(
            "INSERT OR REPLACE INTO agent_memory(id, kind, role, conversation_id, text, ts) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, kind, role, conversation_id, trimmed, now],
        )
        .map_err(|e| format!("memory_remember payload: {e}"))?;
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
