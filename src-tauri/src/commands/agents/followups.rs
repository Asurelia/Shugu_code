//! File d'attente des messages de suivi pendant un run agent (P6.1).
//!
//! Avant ce module, un message envoyé pendant un run lançait un run
//! CONCURRENT. Désormais le chemin d'envoi du chat passe par
//! [`agent_run_or_queue`] qui, si un run est déjà actif sur la conversation,
//! route le message selon le mode effectif (`agents.followUpQueueMode`,
//! résolu côté TS + inverse one-shot Ctrl+Shift+Enter) :
//!
//!   * `queue`     — persisté `pending` ; quand le run se termine, le frontend
//!                   re-conduit CE message par le pipeline d'envoi normal
//!                   (mêmes gates qu'un message frais) et le nouveau spawn le
//!                   consomme atomiquement via `SpawnArgs.followup_id`.
//!   * `steer`     — persisté `pending` ; la boucle `tool_use_loop` le draine
//!                   entre deux tours d'outils ([`drain_steer_into_history`]) :
//!                   message user réel dans l'historique vivant + events
//!                   persistés (honnête après reload).
//!   * `interrupt` — kill coopératif du run actif (même chemin que `agent_kill`)
//!                   puis spawn immédiat comme nouvelle instruction. Jamais
//!                   persisté (rien à attendre).
//!
//! Garanties :
//!   - un kill ne touche JAMAIS les lignes : elles restent `pending`, visibles
//!     dans l'UI, jusqu'à un retrait explicite (`agent_dequeue_followup`) ;
//!   - au boot, une ligne `pending` d'un run mort est re-servie telle quelle
//!     par `agent_list_followups` (jamais prétendue injectée) ; une ligne
//!     `injected` reste un fait historique (events dans `agent_events`) ;
//!   - toutes les transitions de statut sont des CAS
//!     (`UPDATE ... WHERE status='pending'`) — pas de double consommation.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use super::{now_ms, persist_and_emit, AgentEvent, AgentManagerState, FullAccessGrant, SpawnArgs};

// ────────────────────────────────────────────────────────────────────────
// Row shape (frontend mirrors via TS interface in src/lib/agents.ts)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedFollowupRow {
    pub id: String,
    pub run_id: String,
    pub conversation_id: String,
    pub content: String,
    /// "queue" | "steer" | "interrupt" — string-typed, le CHECK SQLite borne.
    pub mode: String,
    /// "pending" | "injected" | "dropped".
    pub status: String,
    pub created_at: i64,
    pub injected_at: Option<i64>,
}

fn row_to_followup(row: &rusqlite::Row) -> rusqlite::Result<QueuedFollowupRow> {
    Ok(QueuedFollowupRow {
        id: row.get(0)?,
        run_id: row.get(1)?,
        conversation_id: row.get(2)?,
        content: row.get(3)?,
        mode: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        injected_at: row.get(7)?,
    })
}

const FOLLOWUP_SELECT: &str =
    "SELECT id, run_id, conversation_id, content, mode, status, created_at, injected_at
       FROM queued_followups";

// ────────────────────────────────────────────────────────────────────────
// Helpers sur Connection — testables sans AppHandle (base en mémoire)
// ────────────────────────────────────────────────────────────────────────

pub(crate) fn enqueue_on_conn(conn: &Connection, row: &QueuedFollowupRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO queued_followups
            (id, run_id, conversation_id, content, mode, status, created_at, injected_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, NULL)",
        params![
            row.id,
            row.run_id,
            row.conversation_id,
            row.content,
            row.mode,
            row.created_at
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("enqueue followup: {e}"))
}

/// Run actif (running | pending) le plus récent d'une conversation, s'il existe.
pub(crate) fn active_run_for_conversation_on_conn(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM agents
          WHERE conversation_id = ?1 AND status IN ('pending', 'running')
          ORDER BY created_at DESC
          LIMIT 1",
        params![conversation_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| format!("active run lookup: {e}"))
}

/// Lignes `pending` d'une conversation, FIFO (created_at puis rowid pour
/// départager deux envois dans la même milliseconde).
pub(crate) fn pending_for_conversation_on_conn(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<QueuedFollowupRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{FOLLOWUP_SELECT} WHERE conversation_id = ?1 AND status = 'pending'
              ORDER BY created_at ASC, rowid ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![conversation_id], row_to_followup)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Lignes `steer` `pending` d'un RUN précis, FIFO — drainées par la boucle.
pub(crate) fn pending_steer_for_run_on_conn(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<QueuedFollowupRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{FOLLOWUP_SELECT} WHERE run_id = ?1 AND status = 'pending' AND mode = 'steer'
              ORDER BY created_at ASC, rowid ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![run_id], row_to_followup)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Prochaine ligne `pending` d'une conversation, FIFO, filtrable par mode
/// (`Some("queue")` pour le drain automatique, `None` pour le « reprendre »
/// manuel qui accepte aussi un steer orphelin de run mort).
pub(crate) fn next_pending_on_conn(
    conn: &Connection,
    conversation_id: &str,
    mode: Option<&str>,
) -> Result<Option<QueuedFollowupRow>, String> {
    let row = match mode {
        Some(m) => conn.query_row(
            &format!(
                "{FOLLOWUP_SELECT} WHERE conversation_id = ?1 AND status = 'pending' AND mode = ?2
                  ORDER BY created_at ASC, rowid ASC LIMIT 1"
            ),
            params![conversation_id, m],
            row_to_followup,
        ),
        None => conn.query_row(
            &format!(
                "{FOLLOWUP_SELECT} WHERE conversation_id = ?1 AND status = 'pending'
                  ORDER BY created_at ASC, rowid ASC LIMIT 1"
            ),
            params![conversation_id],
            row_to_followup,
        ),
    };
    row.optional()
        .map_err(|e| format!("next followup lookup: {e}"))
}

/// CAS pending → injected. `true` = cette ligne a été consommée par CET appel.
pub(crate) fn mark_injected_on_conn(conn: &Connection, id: &str, now: i64) -> Result<bool, String> {
    conn.execute(
        "UPDATE queued_followups
            SET status = 'injected', injected_at = ?1
          WHERE id = ?2 AND status = 'pending'",
        params![now, id],
    )
    .map(|changed| changed == 1)
    .map_err(|e| format!("mark followup injected: {e}"))
}

/// CAS pending → dropped (retrait explicite par l'utilisateur).
pub(crate) fn mark_dropped_on_conn(conn: &Connection, id: &str, now: i64) -> Result<bool, String> {
    conn.execute(
        "UPDATE queued_followups
            SET status = 'dropped', injected_at = ?1
          WHERE id = ?2 AND status = 'pending'",
        params![now, id],
    )
    .map(|changed| changed == 1)
    .map_err(|e| format!("mark followup dropped: {e}"))
}

pub(crate) fn get_on_conn(
    conn: &Connection,
    id: &str,
) -> Result<Option<QueuedFollowupRow>, String> {
    conn.query_row(
        &format!("{FOLLOWUP_SELECT} WHERE id = ?1"),
        params![id],
        row_to_followup,
    )
    .optional()
    .map_err(|e| format!("followup lookup: {e}"))
}

// ────────────────────────────────────────────────────────────────────────
// Injection « steer » — drainée par tool_use_loop entre deux tours d'outils
// ────────────────────────────────────────────────────────────────────────

/// Drain FIFO les lignes `steer` pending de CE run : chaque ligne devient un
/// VRAI message user dans l'historique vivant (l'agent corrige sa trajectoire
/// au prochain appel LLM) et laisse deux traces persistées — le `Message`
/// (rôle user, honnête dans le transcript) et `FollowUpInjected` (styling
/// distinct côté UI). Le CAS `mark_injected` se fait sous le même lock que la
/// lecture : une ligne n'est jamais injectée deux fois, même si un emit échoue.
/// Best-effort par ligne : une erreur DB n'arrête jamais la boucle agent.
pub(crate) fn drain_steer_into_history(
    app: &tauri::AppHandle,
    agent_id: &str,
    history: &mut Vec<super::runner::AgentMessage>,
) {
    let won: Vec<QueuedFollowupRow> = {
        let Ok(conn_mutex) = super::get_conn(app) else {
            return;
        };
        let Ok(conn) = conn_mutex.lock() else {
            return;
        };
        let Ok(rows) = pending_steer_for_run_on_conn(&conn, agent_id) else {
            return;
        };
        let now = now_ms();
        rows.into_iter()
            .filter(|row| mark_injected_on_conn(&conn, &row.id, now).unwrap_or(false))
            .collect()
    };
    for row in won {
        history.push(super::runner::AgentMessage::Text {
            role: "user".to_string(),
            content: row.content.clone(),
        });
        let _ = persist_and_emit(
            app,
            &AgentEvent::Message {
                agent_id: agent_id.to_string(),
                role: "user".to_string(),
                content: row.content.clone(),
            },
        );
        let _ = persist_and_emit(
            app,
            &AgentEvent::FollowUpInjected {
                agent_id: agent_id.to_string(),
                followup_id: row.id,
                conversation_id: row.conversation_id,
                mode: row.mode,
                content: row.content,
            },
        );
    }
}

// ────────────────────────────────────────────────────────────────────────
// Tauri commands
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOrQueueArgs {
    pub spawn: SpawnArgs,
    /// Mode effectif résolu côté TS (`agents.followUpQueueMode` + inverse
    /// one-shot Ctrl+Shift+Enter). None / "" ⇒ "queue" (défaut produit).
    pub follow_up_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunOrQueueResult {
    Spawned { agent_id: String },
    Queued { followup: QueuedFollowupRow },
}

/// Chemin d'envoi du chat pendant (ou hors) un run agent. Sans run actif sur
/// la conversation : délègue intégralement à `agent_spawn`. Avec un run actif :
/// `queue`/`steer` persistent et rendent la main sans run concurrent ;
/// `interrupt` tue le run actif (même kill coopératif + CAS que `agent_kill`)
/// puis spawne la nouvelle instruction — Stop + send atomique côté utilisateur.
#[tauri::command]
pub async fn agent_run_or_queue(
    app: tauri::AppHandle,
    state: State<'_, AgentManagerState>,
    full_access: State<'_, FullAccessGrant>,
    args: RunOrQueueArgs,
) -> Result<RunOrQueueResult, String> {
    let mode = match args.follow_up_mode.as_deref().map(str::trim) {
        None | Some("") => "queue",
        Some(m @ ("queue" | "steer" | "interrupt")) => m,
        Some(other) => return Err(format!("mode de suivi invalide: {other}")),
    };

    let active_run: Option<String> = match args.spawn.conversation_id.as_deref() {
        Some(cid) if !cid.is_empty() => {
            let conn_mutex = super::get_conn(&app)?;
            let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
            active_run_for_conversation_on_conn(&conn, cid)?
        }
        _ => None,
    };

    if let Some(run_id) = active_run {
        if mode == "interrupt" {
            // Kill coopératif + cascade sous-agents + CAS terminal, exactement
            // comme le bouton Stop. Les lignes pending de la file ne sont PAS
            // touchées (elles restent visibles ; l'utilisateur les retire
            // explicitement ou les reprend à la main).
            super::kill_agent_tree(&app, &state.0, &run_id).await?;
        } else {
            let row = QueuedFollowupRow {
                id: Uuid::new_v4().to_string(),
                run_id: run_id.clone(),
                conversation_id: args.spawn.conversation_id.clone().unwrap_or_default(),
                content: args.spawn.task.clone(),
                mode: mode.to_string(),
                status: "pending".to_string(),
                created_at: now_ms(),
                injected_at: None,
            };
            {
                let conn_mutex = super::get_conn(&app)?;
                let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
                enqueue_on_conn(&conn, &row)?;
            }
            persist_and_emit(
                &app,
                &AgentEvent::FollowUpQueued {
                    agent_id: run_id,
                    followup_id: row.id.clone(),
                    conversation_id: row.conversation_id.clone(),
                    mode: row.mode.clone(),
                    content: row.content.clone(),
                },
            )?;
            return Ok(RunOrQueueResult::Queued { followup: row });
        }
    }

    let agent_id = super::agent_spawn(app, state, full_access, args.spawn).await?;
    Ok(RunOrQueueResult::Spawned { agent_id })
}

/// File `pending` d'une conversation (FIFO) — alimente les chips au-dessus du
/// composer. Re-sert aussi les lignes orphelines d'un run mort (boot recovery) :
/// elles restent honnêtement `pending`, jamais prétendues injectées.
#[tauri::command]
pub async fn agent_list_followups(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<Vec<QueuedFollowupRow>, String> {
    let conn_mutex = super::get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    pending_for_conversation_on_conn(&conn, &conversation_id)
}

/// Prochaine ligne `pending` (lecture seule, aucune consommation). Le frontend
/// l'utilise pour le drain automatique (`mode="queue"`) et pour le déclencheur
/// manuel « reprendre » (`mode=None`). La consommation réelle est atomique au
/// spawn (`SpawnArgs.followup_id`).
#[tauri::command]
pub async fn agent_next_followup(
    app: tauri::AppHandle,
    conversation_id: String,
    mode: Option<String>,
) -> Result<Option<QueuedFollowupRow>, String> {
    let conn_mutex = super::get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    next_pending_on_conn(&conn, &conversation_id, mode.as_deref())
}

/// Retrait explicite d'une ligne `pending` (le ✕ d'un chip). CAS : une ligne
/// déjà injectée/consommée n'est plus droppable. Émet `FollowUpDropped` sur le
/// flux du run visé pour que l'UI live retire le chip partout.
#[tauri::command]
pub async fn agent_dequeue_followup(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    let row = {
        let conn_mutex = super::get_conn(&app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        let dropped = mark_dropped_on_conn(&conn, &id, now_ms())?;
        if !dropped {
            return Ok(false);
        }
        get_on_conn(&conn, &id)?
    };
    if let Some(row) = row {
        persist_and_emit(
            &app,
            &AgentEvent::FollowUpDropped {
                agent_id: row.run_id,
                followup_id: row.id,
                conversation_id: row.conversation_id,
                mode: row.mode,
                content: row.content,
            },
        )?;
    }
    Ok(true)
}

// ────────────────────────────────────────────────────────────────────────
// Tests — base SQLite en mémoire (pattern des tests goals.rs) + provider
// scripté loopback pour l'ordre d'injection steer dans la boucle.
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agents::runner::AgentMessage;
    use crate::commands::agents::AgentEvent;
    use serde_json::json;

    /// Schéma minimal : queued_followups (calque MIGRATION_V25) + la colonne
    /// d'`agents` lue par `active_run_for_conversation_on_conn` + agent_events
    /// pour vérifier la persistance des events.
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE queued_followups (
                id              TEXT    PRIMARY KEY,
                run_id          TEXT    NOT NULL,
                conversation_id TEXT    NOT NULL,
                content         TEXT    NOT NULL CHECK (length(content) >= 1),
                mode            TEXT    NOT NULL CHECK (mode IN ('queue', 'steer', 'interrupt')),
                status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'injected', 'dropped')),
                created_at      INTEGER NOT NULL,
                injected_at     INTEGER
            );
            CREATE TABLE agents (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                conversation_id TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE agent_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT NOT NULL,
                ts INTEGER NOT NULL,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL
            );",
        )
        .expect("create test schema");
        conn
    }

    fn followup(id: &str, run: &str, conv: &str, mode: &str, ts: i64) -> QueuedFollowupRow {
        QueuedFollowupRow {
            id: id.to_string(),
            run_id: run.to_string(),
            conversation_id: conv.to_string(),
            content: format!("contenu de {id}"),
            mode: mode.to_string(),
            status: "pending".to_string(),
            created_at: ts,
            injected_at: None,
        }
    }

    fn insert_agent(conn: &Connection, id: &str, conv: &str, status: &str, ts: i64) {
        conn.execute(
            "INSERT INTO agents (id, status, conversation_id, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, status, conv, ts],
        )
        .expect("insert agent");
    }

    #[test]
    fn enqueue_fifo_order_per_mode() {
        let conn = test_conn();
        // Désordre d'arrivée volontaire : steer s2 avant queue q1.
        enqueue_on_conn(&conn, &followup("s1", "run-1", "conv-1", "steer", 10)).unwrap();
        enqueue_on_conn(&conn, &followup("s2", "run-1", "conv-1", "steer", 20)).unwrap();
        enqueue_on_conn(&conn, &followup("q1", "run-1", "conv-1", "queue", 30)).unwrap();
        enqueue_on_conn(&conn, &followup("q2", "run-1", "conv-1", "queue", 40)).unwrap();

        // Steer : FIFO strict, scopé au run.
        let steer = pending_steer_for_run_on_conn(&conn, "run-1").unwrap();
        assert_eq!(
            steer.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["s1", "s2"]
        );
        assert!(pending_steer_for_run_on_conn(&conn, "run-autre")
            .unwrap()
            .is_empty());

        // Queue : la plus ancienne sort d'abord, jamais une steer.
        let next = next_pending_on_conn(&conn, "conv-1", Some("queue"))
            .unwrap()
            .expect("a pending queue row");
        assert_eq!(next.id, "q1");
        // Sans filtre de mode, FIFO global (manuel « reprendre »).
        let any = next_pending_on_conn(&conn, "conv-1", None)
            .unwrap()
            .expect("any pending row");
        assert_eq!(any.id, "s1");
    }

    #[test]
    fn cas_transitions_are_one_shot() {
        let conn = test_conn();
        enqueue_on_conn(&conn, &followup("f1", "run-1", "conv-1", "steer", 10)).unwrap();
        enqueue_on_conn(&conn, &followup("f2", "run-1", "conv-1", "queue", 20)).unwrap();

        assert!(mark_injected_on_conn(&conn, "f1", 100).unwrap());
        // Deuxième consommation refusée par le CAS.
        assert!(!mark_injected_on_conn(&conn, "f1", 101).unwrap());
        // Une ligne injectée n'est plus droppable.
        assert!(!mark_dropped_on_conn(&conn, "f1", 102).unwrap());

        assert!(mark_dropped_on_conn(&conn, "f2", 103).unwrap());
        assert!(!mark_dropped_on_conn(&conn, "f2", 104).unwrap());
        assert!(!mark_injected_on_conn(&conn, "f2", 105).unwrap());

        let f1 = get_on_conn(&conn, "f1").unwrap().unwrap();
        assert_eq!(f1.status, "injected");
        assert_eq!(f1.injected_at, Some(100));
        // Les lignes consommées sortent de la file pending.
        assert!(pending_for_conversation_on_conn(&conn, "conv-1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn kill_keeps_rows_pending_and_no_zombie_run() {
        let conn = test_conn();
        insert_agent(&conn, "run-1", "conv-1", "running", 10);
        enqueue_on_conn(&conn, &followup("q1", "run-1", "conv-1", "queue", 20)).unwrap();
        enqueue_on_conn(&conn, &followup("s1", "run-1", "conv-1", "steer", 30)).unwrap();

        // CAS de kill (même SQL que agent_kill) — gagné une seule fois.
        let changed = conn
            .execute(
                "UPDATE agents SET status = 'killed'
                  WHERE id = 'run-1' AND status IN ('running', 'pending')",
                [],
            )
            .unwrap();
        assert_eq!(changed, 1, "le kill gagne le CAS la première fois");
        let changed_again = conn
            .execute(
                "UPDATE agents SET status = 'killed'
                  WHERE id = 'run-1' AND status IN ('running', 'pending')",
                [],
            )
            .unwrap();
        assert_eq!(changed_again, 0, "pas de zombie : le run est déjà terminal");
        assert!(active_run_for_conversation_on_conn(&conn, "conv-1")
            .unwrap()
            .is_none());

        // Les lignes NE sont PAS droppées par le kill : pending, re-servies
        // telles quelles (boot recovery — jamais prétendues injectées).
        let pending = pending_for_conversation_on_conn(&conn, "conv-1").unwrap();
        assert_eq!(
            pending.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["q1", "s1"]
        );
        assert!(pending.iter().all(|r| r.status == "pending"));
    }

    #[test]
    fn interrupt_kills_old_run_cas_then_new_run_drives() {
        let conn = test_conn();
        insert_agent(&conn, "run-old", "conv-1", "running", 10);

        // interrupt = kill CAS de l'ancien run…
        let killed = conn
            .execute(
                "UPDATE agents SET status = 'killed'
                  WHERE id = 'run-old' AND status IN ('running', 'pending')",
                [],
            )
            .unwrap();
        assert_eq!(killed, 1);
        // …puis la nouvelle instruction devient le run actif de la conv.
        insert_agent(&conn, "run-new", "conv-1", "running", 20);
        assert_eq!(
            active_run_for_conversation_on_conn(&conn, "conv-1").unwrap(),
            Some("run-new".to_string())
        );
    }

    // ── Intégration : provider scripté + drain steer entre deux tours ──
    //
    // Rejoue le contrat de la boucle (chaque appel provider reçoit TOUT
    // l'historique) avec un drain `steer` entre deux tours, et vérifie :
    //   1. l'ORDRE d'injection FIFO dans l'historique envoyé au provider ;
    //   2. la persistance SQLite (statuts `injected` + events followUpInjected
    //      dans l'ordre).
    // Le drain de production (`drain_steer_into_history`) exige un AppHandle ;
    // il est testé ici via ses briques on-conn, qui portent toute la logique
    // (lecture FIFO, CAS, push historique, ordre des events).

    async fn read_json_request(socket: &mut tokio::net::TcpStream) -> serde_json::Value {
        use tokio::io::AsyncReadExt;
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        let header_end = loop {
            let read = socket.read(&mut buffer).await.expect("read request");
            assert!(read > 0, "connection closed before HTTP headers");
            request.extend_from_slice(&buffer[..read]);
            if let Some(pos) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]);
        let content_length: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().ok())
                    .flatten()
            })
            .expect("content-length");
        while request.len() < header_end + content_length {
            let read = socket.read(&mut buffer).await.expect("read request body");
            assert!(read > 0, "connection closed before HTTP body");
            request.extend_from_slice(&buffer[..read]);
        }
        serde_json::from_slice(&request[header_end..header_end + content_length])
            .expect("provider request JSON")
    }

    async fn start_scripted_openai(
        rounds: usize,
    ) -> (String, tokio::task::JoinHandle<Vec<serde_json::Value>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake provider");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let mut bodies = Vec::new();
            for round in 0..rounds {
                let (mut socket, _) = listener.accept().await.expect("accept");
                let body = read_json_request(&mut socket).await;
                bodies.push(body);
                let event = if round + 1 < rounds {
                    json!({
                        "choices": [{
                            "delta": {
                                "tool_calls": [{
                                    "index": 0,
                                    "id": format!("call-{round}"),
                                    "function": {"name": "fs_list_dir", "arguments": "{\"path\":\".\"}"}
                                }]
                            }
                        }]
                    })
                } else {
                    json!({"choices":[{"delta":{"content":"fini"}}]})
                };
                let payload = format!("data: {event}\n\ndata: [DONE]\n\n");
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                use tokio::io::AsyncWriteExt;
                socket
                    .write_all(response.as_bytes())
                    .await
                    .expect("write response");
            }
            bodies
        });
        (format!("http://{addr}"), server)
    }

    /// Brique testable du drain : CAS + push historique + retour des lignes
    /// consommées (l'enrobage production émet en plus les events Tauri).
    fn drain_steer_on_conn(
        conn: &Connection,
        run_id: &str,
        history: &mut Vec<AgentMessage>,
        now: i64,
    ) -> Vec<QueuedFollowupRow> {
        let rows = pending_steer_for_run_on_conn(conn, run_id).expect("steer rows");
        let mut won = Vec::new();
        for row in rows {
            if mark_injected_on_conn(conn, &row.id, now).expect("cas") {
                history.push(AgentMessage::Text {
                    role: "user".to_string(),
                    content: row.content.clone(),
                });
                won.push(row);
            }
        }
        won
    }

    fn persist_event_on_conn(conn: &Connection, event: &AgentEvent, now: i64) {
        let payload = serde_json::to_string(event).expect("event json");
        conn.execute(
            "INSERT INTO agent_events (agent_id, ts, kind, payload) VALUES (?1, ?2, ?3, ?4)",
            params![event.agent_id(), now, event.kind_str(), payload],
        )
        .expect("persist event");
    }

    async fn call_fake_provider(
        client: &reqwest::Client,
        base_url: &str,
        history: &[AgentMessage],
    ) -> crate::commands::chat::AssistantTurn {
        use crate::commands::agents::runner::build_openai_messages;
        use crate::commands::chat::call_openai_compat_structured;
        let tools = Some(json!([{
            "type":"function",
            "function":{"name":"fs_list_dir","description":"list","parameters":{"type":"object"}}
        }]));
        call_openai_compat_structured(
            client,
            base_url,
            "fake-gpt",
            build_openai_messages(history),
            "test-key",
            "openai",
            &None,
            true,
            tools,
            None,
            None,
            &mut |_, _| {},
        )
        .await
        .expect("provider call")
    }

    #[tokio::test]
    async fn steer_injection_order_visible_to_provider_and_persisted() {
        let conn = test_conn();
        insert_agent(&conn, "run-1", "conv-1", "running", 1);
        enqueue_on_conn(&conn, &followup("s1", "run-1", "conv-1", "steer", 10)).unwrap();
        enqueue_on_conn(&conn, &followup("s2", "run-1", "conv-1", "steer", 20)).unwrap();
        enqueue_on_conn(&conn, &followup("q1", "run-1", "conv-1", "queue", 30)).unwrap();

        let (base_url, server) = start_scripted_openai(2).await;
        let client = reqwest::Client::new();
        let mut history = vec![
            AgentMessage::Text {
                role: "system".into(),
                content: "Tu es un agent.".into(),
            },
            AgentMessage::Text {
                role: "user".into(),
                content: "Tâche initiale.".into(),
            },
        ];

        // Tour 0 : le provider demande un outil.
        let turn0 = call_fake_provider(&client, &base_url, &history).await;
        assert_eq!(turn0.tool_calls.len(), 1);
        history.push(AgentMessage::AssistantWithTools {
            content: turn0.content,
            tool_calls: turn0.tool_calls.clone(),
        });
        history.push(AgentMessage::ToolResults(vec![
            crate::commands::agents::ToolResult {
                id: turn0.tool_calls[0].id.clone(),
                name: turn0.tool_calls[0].name.clone(),
                is_error: false,
                content: "ok".into(),
            },
        ]));

        // ENTRE DEUX TOURS : drain steer (la brique du point d'injection réel).
        let injected = drain_steer_on_conn(&conn, "run-1", &mut history, 100);
        assert_eq!(
            injected.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["s1", "s2"],
            "drain FIFO des deux steer"
        );
        for row in &injected {
            persist_event_on_conn(
                &conn,
                &AgentEvent::FollowUpInjected {
                    agent_id: "run-1".to_string(),
                    followup_id: row.id.clone(),
                    conversation_id: row.conversation_id.clone(),
                    mode: row.mode.clone(),
                    content: row.content.clone(),
                },
                100,
            );
        }
        // La ligne queue n'est PAS touchée par le drain steer.
        assert_eq!(get_on_conn(&conn, "q1").unwrap().unwrap().status, "pending");

        // Tour 1 : le provider REÇOIT les deux steer, dans l'ordre, en user.
        let _turn1 = call_fake_provider(&client, &base_url, &history).await;
        let bodies = server.await.expect("server join");
        let body1 = bodies[1].to_string();
        let pos_s1 = body1.find("contenu de s1").expect("s1 visible au provider");
        let pos_s2 = body1.find("contenu de s2").expect("s2 visible au provider");
        assert!(pos_s1 < pos_s2, "ordre FIFO respecté dans la requête");
        assert!(
            !body1.contains("contenu de q1"),
            "une ligne queue n'est jamais injectée par le drain steer"
        );

        // Persistance : statuts + events dans l'ordre d'injection.
        assert_eq!(
            get_on_conn(&conn, "s1").unwrap().unwrap().status,
            "injected"
        );
        assert_eq!(
            get_on_conn(&conn, "s2").unwrap().unwrap().status,
            "injected"
        );
        let kinds: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT payload FROM agent_events WHERE kind = 'followUpInjected' ORDER BY id ASC")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(kinds.len(), 2);
        assert!(kinds[0].contains("contenu de s1"));
        assert!(kinds[1].contains("contenu de s2"));

        // Deuxième drain : rien à re-injecter (CAS déjà consommé).
        let again = drain_steer_on_conn(&conn, "run-1", &mut history, 200);
        assert!(again.is_empty());
    }
}
