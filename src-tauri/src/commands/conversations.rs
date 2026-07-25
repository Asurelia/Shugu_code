//! Branche de conversation (fork) — P6.3 rewind.
//!
//! Modèle choisi : **fork = COPIE**. Une nouvelle conversation contient une
//! copie des messages de la source JUSQU'AU POINT DE BRANCHE INCLUS, et la
//! conversation source reste STRICTEMENT intacte. Pourquoi pas « truncate +
//! branch » :
//!   - non-destructif : l'utilisateur garde les deux branches (il peut
//!     comparer, ou revenir à la source si le rewind fichiers ne suffit pas) ;
//!   - le schéma existant s'y prête : une conversation est un agrégat de
//!     `messages` par `conversation_id` — une copie bornée est une INSERT
//!     locale, pas une réécriture de la lignée ;
//!   - la provenance est explicite (`forked_from_id` + `fork_point_message_id`,
//!     V26) au lieu d'être implicite dans l'ordre des messages.
//!
//! Accès DB : la connexion rusqlite partagée `agents::get_conn` (même fichier
//! `shugu.db` que tauri-plugin-sql — WAL, écrivains concurrents tolérés).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::AppHandle;
use uuid::Uuid;

/// Résultat d'un fork — l'id de la nouvelle conversation + le nombre de
/// messages copiés (preuve pour l'UI que le contenu attendu est bien là).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkResult {
    pub conversation_id: String,
    pub title: String,
    pub copied_messages: usize,
    /// agent_id du message de branche s'il s'agit d'un tour agent (via_agent) —
    /// sert à tracer un event rewind sur le flux du run correspondant.
    pub fork_point_agent_id: Option<String>,
}

/// Fork transactionnel, testable sans AppHandle (base en mémoire).
///
/// `new_conv_id` / `new_msg_id` injectés pour la déterminance des tests
/// (la commande passe des UUID v4).
pub(crate) fn fork_at_on_conn(
    conn: &Connection,
    source_id: &str,
    message_id: &str,
    new_conv_id: &str,
    new_msg_id: &dyn Fn() -> String,
    now: i64,
) -> Result<ForkResult, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin fork: {e}"))?;

    // 1. La source existe ?
    let source: Option<(String, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT title, project_id, env FROM conversations WHERE id = ?1",
            params![source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("fork source lookup: {e}"))?;
    let (source_title, project_id, env) =
        source.ok_or_else(|| format!("conversation introuvable: {source_id}"))?;

    // 2. Le message de branche appartient bien à la source et n'est pas
    //    soft-deleted (sinon le point de branche serait un mensonge).
    let fork_point: Option<(i64, Option<String>)> = tx
        .query_row(
            "SELECT ts, agent_id FROM messages
              WHERE id = ?1 AND conversation_id = ?2 AND deleted_at IS NULL",
            params![message_id, source_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("fork point lookup: {e}"))?;
    let (fork_ts, fork_agent_id) = fork_point
        .ok_or_else(|| "message de branche introuvable dans cette conversation".to_string())?;

    // 3. Nouvelle conversation (provenance V26). parent_id = celui de la source
    //    n'est PAS repris : la lignée du fork vit dans forked_from_id.
    let title = format!("{source_title} (branche)");
    tx.execute(
        "INSERT INTO conversations
            (id, title, project_id, pinned, archived, unread, env, parent_id,
             updated_at, forked_from_id, fork_point_message_id)
         VALUES (?1, ?2, ?3, 0, 0, 0, ?4, NULL, ?5, ?6, ?7)",
        params![
            new_conv_id,
            title,
            project_id,
            env,
            now,
            source_id,
            message_id
        ],
    )
    .map_err(|e| format!("insert fork conversation: {e}"))?;

    // 4. Copie des messages jusqu'au point de branche INCLUS. Ordre identique
    //    au lecteur UI (ts ASC, rowid en tiebreak) ; on coupe APRÈS avoir posé
    //    le message de branche — pas « ts <= fork_ts » (deux messages peuvent
    //    partager une ts, et un message plus récent mais même ts serait copié
    //    par erreur).
    let mut stmt = tx
        .prepare(
            "SELECT id, role, text, body, code_lang, code_text, reasoning, image,
                    ts, agent_id, via_agent, edited_at, parent_id
               FROM messages
              WHERE conversation_id = ?1 AND deleted_at IS NULL
              ORDER BY ts ASC, rowid ASC",
        )
        .map_err(|e| format!("prepare fork copy: {e}"))?;
    let rows = stmt
        .query_map(params![source_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, Option<i64>>(11)?,
                r.get::<_, Option<String>>(12)?,
            ))
        })
        .map_err(|e| format!("fork copy query: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("fork copy collect: {e}"))?;
    // Les lignes sont matérialisées (owned) : le Statement peut être relâché
    // AVANT les INSERT, qui empruntent `tx` à leur tour.
    drop(stmt);

    let mut copied = 0usize;
    let mut reached = false;
    for row in &rows {
        tx.execute(
            "INSERT INTO messages
                (id, conversation_id, role, text, body, code_lang, code_text,
                 reasoning, image, ts, agent_id, via_agent,
                 edited_at, deleted_at, parent_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14)",
            params![
                new_msg_id(),
                new_conv_id,
                row.1,
                row.2,
                row.3,
                row.4,
                row.5,
                row.6,
                row.7,
                row.8,
                row.9,
                row.10,
                row.11,
                row.12,
            ],
        )
        .map_err(|e| format!("fork copy insert: {e}"))?;
        copied += 1;
        if row.0 == message_id {
            reached = true;
            break;
        }
    }
    if !reached {
        return Err("message de branche hors de la liste ordonnée (incohérent)".to_string());
    }

    tx.commit().map_err(|e| format!("commit fork: {e}"))?;
    let _ = fork_ts; // ts du point de branche — conservée dans les messages copiés
    Ok(ForkResult {
        conversation_id: new_conv_id.to_string(),
        title,
        copied_messages: copied,
        fork_point_agent_id: fork_agent_id,
    })
}

/// Fork une conversation au message donné : la NOUVELLE conversation contient
/// les messages jusqu'à ce message inclus ; la source est conservée intacte.
/// Quand le message de branche est un tour agent, un event `rewindApplied`
/// (kind "conversation") est tracé sur le flux du run correspondant.
#[tauri::command]
pub async fn conversation_fork_at(
    app: AppHandle,
    conversation_id: String,
    message_id: String,
) -> Result<ForkResult, String> {
    let new_conv_id = format!("c-fork-{}", Uuid::new_v4());
    let result = {
        let conn_mutex = crate::commands::agents::get_conn(&app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        fork_at_on_conn(
            &conn,
            &conversation_id,
            &message_id,
            &new_conv_id,
            &|| format!("m-fork-{}", Uuid::new_v4()),
            crate::commands::agents::now_ms(),
        )?
    };
    // Trace durable côté run agent (contrat d'honnêteté : le fork est visible
    // dans l'historique du run après reload). Pas de run pour un message
    // utilisateur/chat direct → la provenance V26 + la branche suffisent.
    if let Some(agent_id) = result.fork_point_agent_id.as_deref() {
        crate::commands::agents::record_rewind_event(
            &app,
            agent_id,
            "conversation",
            "",
            Vec::new(),
            Vec::new(),
            None,
            Some(result.conversation_id.clone()),
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                project_id TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                unread INTEGER NOT NULL DEFAULT 0,
                env TEXT,
                parent_id TEXT,
                updated_at INTEGER NOT NULL,
                forked_from_id TEXT,
                fork_point_message_id TEXT
            );
            CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                text TEXT,
                body TEXT,
                code_lang TEXT,
                code_text TEXT,
                reasoning TEXT,
                image INTEGER NOT NULL DEFAULT 0,
                ts INTEGER NOT NULL,
                agent_id TEXT,
                via_agent INTEGER NOT NULL DEFAULT 0,
                edited_at INTEGER,
                deleted_at INTEGER,
                parent_id TEXT
            );",
        )
        .expect("create test schema");
        conn
    }

    fn seed(conn: &Connection) {
        conn.execute(
            "INSERT INTO conversations (id, title, project_id, updated_at)
             VALUES ('c1', 'Refactor auth', 'p1', 100)",
            [],
        )
        .unwrap();
        let msgs = [
            ("m1", "user", "fais X", 10),
            ("m2", "ai", "voici X", 20),
            ("m3", "user", "puis Y", 30),
            ("m4", "ai", "voici Y", 40),
        ];
        for (id, role, text, ts) in msgs {
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, text, ts)
                 VALUES (?1, 'c1', ?2, ?3, ?4)",
                params![id, role, text, ts],
            )
            .unwrap();
        }
        // Message soft-deleted : jamais copié, jamais un point de branche valide.
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, text, ts, deleted_at)
             VALUES ('m-dead', 'c1', 'user', 'fantôme', 15, 1)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn fork_copies_messages_up_to_fork_point_and_links_provenance() {
        let conn = test_conn();
        seed(&conn);
        let seq = std::cell::Cell::new(0);
        let result = fork_at_on_conn(
            &conn,
            "c1",
            "m2",
            "c-fork-test",
            &|| {
                seq.set(seq.get() + 1);
                format!("new-{}", seq.get())
            },
            200,
        )
        .expect("fork");

        // Branche : provenance + titre + updated_at.
        let (title, from, point, updated): (String, String, String, i64) = conn
            .query_row(
                "SELECT title, forked_from_id, fork_point_message_id, updated_at
                   FROM conversations WHERE id = 'c-fork-test'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "Refactor auth (branche)");
        assert_eq!(from, "c1");
        assert_eq!(point, "m2");
        assert_eq!(updated, 200);

        // Exactement m1 + m2 (le point de branche INCLUS), ids frais, ts d'origine.
        let copied: Vec<(String, String, i64)> = {
            let mut stmt = conn
                .prepare("SELECT id, text, ts FROM messages WHERE conversation_id = 'c-fork-test' ORDER BY ts ASC")
                .unwrap();
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(copied.len(), 2);
        assert_eq!(result.copied_messages, 2);
        assert_eq!(copied[0], ("new-1".to_string(), "fais X".to_string(), 10));
        assert_eq!(copied[1], ("new-2".to_string(), "voici X".to_string(), 20));

        // La source est STRICTEMENT intacte (4 messages + le soft-deleted).
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation_id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 5);
    }

    #[test]
    fn fork_rejects_unknown_or_deleted_fork_point() {
        let conn = test_conn();
        seed(&conn);
        let seq = std::cell::Cell::new(0);
        let id_gen = || {
            seq.set(seq.get() + 1);
            format!("n{}", seq.get())
        };
        assert!(fork_at_on_conn(&conn, "c1", "m-inexistant", "f1", &id_gen, 1).is_err());
        assert!(fork_at_on_conn(&conn, "c1", "m-dead", "f2", &id_gen, 1).is_err());
        assert!(fork_at_on_conn(&conn, "c-inconnue", "m1", "f3", &id_gen, 1).is_err());
        // Aucune branche partielle laissée derrière (transaction).
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE id LIKE 'f%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }
}
