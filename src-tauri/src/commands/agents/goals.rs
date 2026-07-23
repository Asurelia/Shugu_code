//! Durable user goals.
//!
//! A Goal is the long-lived objective; `agents` are its successive execution
//! attempts. This separation lets an objective survive a WebView reload or a
//! native process restart without pretending an orphaned process is still
//! running. Credentials are deliberately not stored here: a resumed run resolves
//! the provider again through the normal, keychain-backed spawn path.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use tauri::AppHandle;
use uuid::Uuid;

use super::{get_conn, now_ms, AgentEvent};

const MAX_TITLE_CHARS: usize = 120;
const MAX_OBJECTIVE_CHARS: usize = 20_000;
const MAX_OUTPUT_CHARS: usize = 12_000;
const MAX_ERROR_CHARS: usize = 4_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalRow {
    pub id: String,
    pub conversation_id: String,
    pub workspace_id: Option<String>,
    pub title: String,
    pub objective: String,
    pub status: String,
    pub role: String,
    pub model: String,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub execution_profile: String,
    pub isolate: bool,
    pub current_agent_id: Option<String>,
    pub last_output: Option<String>,
    pub last_error: Option<String>,
    pub resume_count: i64,
    pub archived: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
}

pub(super) struct AttachGoal<'a> {
    pub existing_goal_id: Option<&'a str>,
    pub conversation_id: &'a str,
    pub workspace_id: Option<&'a str>,
    pub title: Option<&'a str>,
    pub objective: &'a str,
    pub role: &'a str,
    pub model: &'a str,
    pub protocol: Option<&'a str>,
    pub base_url: Option<&'a str>,
    pub execution_profile: &'a str,
    pub isolate: bool,
    pub agent_id: &'a str,
    pub now: i64,
}

fn cap(input: &str, max_chars: usize) -> String {
    input.trim().chars().take(max_chars).collect()
}

fn optional_cap(input: Option<&str>, max_chars: usize) -> Option<String> {
    input
        .map(|value| cap(value, max_chars))
        .filter(|value| !value.is_empty())
}

fn title_from_objective(objective: &str) -> String {
    let first_meaningful = objective
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "---")
        .unwrap_or("Objectif sans titre");
    cap(first_meaningful, MAX_TITLE_CHARS)
}

pub(super) fn attach_run_on_conn(
    conn: &Connection,
    args: AttachGoal<'_>,
) -> Result<String, String> {
    let objective = cap(args.objective, MAX_OBJECTIVE_CHARS);
    if objective.is_empty() {
        return Err("un Goal doit avoir un objectif non vide".to_string());
    }
    if args.conversation_id.trim().is_empty() {
        return Err("un Goal doit être lié à une conversation".to_string());
    }
    let requested_existing = args
        .existing_goal_id
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let live_goal: Option<String> = conn
        .query_row(
            "SELECT id FROM agent_goals
              WHERE conversation_id=?1 AND status IN ('active', 'waiting')
              LIMIT 1",
            params![args.conversation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("goal live lookup: {e}"))?;
    if live_goal
        .as_deref()
        .is_some_and(|live_id| requested_existing != Some(live_id))
    {
        return Err(
            "cette conversation possède déjà un Goal actif ; termine-le ou attends sa réponse"
                .to_string(),
        );
    }
    if let Some(existing_id) = requested_existing {
        let stored_conversation: Option<String> = conn
            .query_row(
                "SELECT conversation_id FROM agent_goals WHERE id=?1",
                params![existing_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("goal lookup: {e}"))?;
        let stored_conversation =
            stored_conversation.ok_or_else(|| format!("Goal introuvable : {existing_id}"))?;
        if stored_conversation != args.conversation_id {
            return Err("ce Goal appartient à une autre conversation".to_string());
        }
        let changed = conn
            .execute(
                "UPDATE agent_goals
                    SET status='active',
                        role=?1,
                        model=?2,
                        protocol=?3,
                        base_url=?4,
                        execution_profile=?5,
                        isolate=?6,
                        current_agent_id=?7,
                        last_error=NULL,
                        archived=0,
                        resume_count=resume_count+1,
                        updated_at=?8,
                        finished_at=NULL
                  WHERE id=?9",
                params![
                    cap(args.role, 80),
                    cap(args.model, 240),
                    optional_cap(args.protocol, 40),
                    optional_cap(args.base_url, 2_000),
                    args.execution_profile,
                    args.isolate,
                    args.agent_id,
                    args.now,
                    existing_id,
                ],
            )
            .map_err(|e| format!("goal resume: {e}"))?;
        if changed != 1 {
            return Err(format!("Goal introuvable : {existing_id}"));
        }
        return Ok(existing_id.to_string());
    }

    let goal_id = Uuid::new_v4().to_string();
    let title = args
        .title
        .map(|value| cap(value, MAX_TITLE_CHARS))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| title_from_objective(&objective));
    conn.execute(
        "INSERT INTO agent_goals
            (id, conversation_id, workspace_id, title, objective, status, role,
             model, protocol, base_url, execution_profile, isolate,
             current_agent_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            goal_id,
            args.conversation_id,
            args.workspace_id,
            title,
            objective,
            cap(args.role, 80),
            cap(args.model, 240),
            optional_cap(args.protocol, 40),
            optional_cap(args.base_url, 2_000),
            args.execution_profile,
            args.isolate,
            args.agent_id,
            args.now,
        ],
    )
    .map_err(|e| format!("goal create: {e}"))?;
    Ok(goal_id)
}

/// Update only the Goal whose current run emitted this event. Sub-agent events
/// cannot accidentally complete the parent Goal.
pub(super) fn apply_event_on_conn(
    conn: &Connection,
    event: &AgentEvent,
    now: i64,
) -> Result<(), String> {
    match event {
        AgentEvent::QuestionAsked { agent_id, .. } | AgentEvent::PlanSubmitted { agent_id, .. } => {
            conn.execute(
                "UPDATE agent_goals
                    SET status='waiting', updated_at=?1
                  WHERE current_agent_id=?2 AND status='active'",
                params![now, agent_id],
            )
            .map_err(|e| format!("goal waiting transition: {e}"))?;
        }
        AgentEvent::Complete {
            agent_id, output, ..
        } => {
            let output = cap(output, MAX_OUTPUT_CHARS);
            conn.execute(
                "UPDATE agent_goals
                    SET status=CASE WHEN status='active' THEN 'completed' ELSE status END,
                        last_output=?1,
                        last_error=NULL,
                        updated_at=?2,
                        finished_at=CASE WHEN status='active' THEN ?2 ELSE finished_at END
                  WHERE current_agent_id=?3
                    AND status IN ('active', 'waiting')",
                params![output, now, agent_id],
            )
            .map_err(|e| format!("goal complete transition: {e}"))?;
        }
        AgentEvent::Error { agent_id, error } => {
            let error = cap(error, MAX_ERROR_CHARS);
            conn.execute(
                "UPDATE agent_goals
                    SET status='paused',
                        last_error=?1,
                        updated_at=?2,
                        finished_at=NULL
                  WHERE current_agent_id=?3
                    AND status IN ('active', 'waiting')",
                params![error, now, agent_id],
            )
            .map_err(|e| format!("goal pause transition: {e}"))?;
        }
        _ => {}
    }
    Ok(())
}

/// Native restart recovery. The dead process is an execution failure, not the
/// death of the user's objective: the Goal becomes resumable (`paused`).
pub(super) fn pause_orphaned_on_conn(conn: &Connection, now: i64) -> Result<usize, String> {
    let has_goals: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_goals')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("goal recovery schema check: {e}"))?;
    if !has_goals {
        return Ok(0);
    }
    conn.execute(
        "UPDATE agent_goals
            SET status='paused',
                last_error=COALESCE(last_error, 'Shugu a redémarré pendant cette exécution'),
                updated_at=?1,
                finished_at=NULL
          WHERE status='active'
            AND current_agent_id IN (
              SELECT id FROM agents
               WHERE status='error'
            )",
        params![now],
    )
    .map_err(|e| format!("pause orphaned goals: {e}"))
}

fn row_to_goal(row: &Row<'_>) -> rusqlite::Result<GoalRow> {
    Ok(GoalRow {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        workspace_id: row.get(2)?,
        title: row.get(3)?,
        objective: row.get(4)?,
        status: row.get(5)?,
        role: row.get(6)?,
        model: row.get(7)?,
        protocol: row.get(8)?,
        base_url: row.get(9)?,
        execution_profile: row.get(10)?,
        isolate: row.get(11)?,
        current_agent_id: row.get(12)?,
        last_output: row.get(13)?,
        last_error: row.get(14)?,
        resume_count: row.get(15)?,
        archived: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
        finished_at: row.get(19)?,
    })
}

const SELECT_GOAL: &str = "SELECT id, conversation_id, workspace_id, title, objective,
    status, role, model, protocol, base_url, execution_profile, isolate,
    current_agent_id, last_output, last_error, resume_count, archived,
    created_at, updated_at, finished_at
  FROM agent_goals";

#[tauri::command]
pub async fn goal_list_by_conversation(
    app: AppHandle,
    conversation_id: String,
) -> Result<Vec<GoalRow>, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let sql = format!(
        "{SELECT_GOAL}
          WHERE conversation_id=?1 AND archived=0
          ORDER BY
            CASE status
              WHEN 'active' THEN 0 WHEN 'waiting' THEN 1 WHEN 'paused' THEN 2
              WHEN 'completed' THEN 3 ELSE 4
            END,
            updated_at DESC
          LIMIT 20"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let goals = stmt
        .query_map(params![conversation_id], row_to_goal)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(goals)
}

#[tauri::command]
pub async fn goal_get(app: AppHandle, goal_id: String) -> Result<GoalRow, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("{SELECT_GOAL} WHERE id=?1"),
        params![goal_id],
        row_to_goal,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Goal introuvable : {goal_id}"))
}

#[tauri::command]
pub async fn goal_archive(app: AppHandle, goal_id: String) -> Result<(), String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            "UPDATE agent_goals SET archived=1, updated_at=?1
              WHERE id=?2 AND status NOT IN ('active', 'waiting')",
            params![now_ms(), goal_id],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("un Goal actif ou en attente ne peut pas être archivé".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_goals (
                id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, workspace_id TEXT,
                title TEXT NOT NULL, objective TEXT NOT NULL, status TEXT NOT NULL,
                role TEXT NOT NULL, model TEXT NOT NULL, protocol TEXT, base_url TEXT,
                execution_profile TEXT NOT NULL, isolate INTEGER NOT NULL,
                current_agent_id TEXT, last_output TEXT, last_error TEXT,
                resume_count INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
             );
             CREATE TABLE agents (
                id TEXT PRIMARY KEY, status TEXT, error TEXT
             );",
        )
        .unwrap();
        conn
    }

    fn attach<'a>(agent_id: &'a str, existing: Option<&'a str>, now: i64) -> AttachGoal<'a> {
        AttachGoal {
            existing_goal_id: existing,
            conversation_id: "conv-1",
            workspace_id: Some("f:/dev/app"),
            title: Some("Rendre l'application fiable"),
            objective: "Rendre l'application fiable et tout vérifier",
            role: "orchestrator",
            model: "model",
            protocol: Some("openai"),
            base_url: Some("https://example.test/v1"),
            execution_profile: "auto",
            isolate: false,
            agent_id,
            now,
        }
    }

    #[test]
    fn goal_waits_for_hitl_then_resumes_and_completes() {
        let conn = conn();
        let id = attach_run_on_conn(&conn, attach("agent-1", None, 10)).unwrap();
        apply_event_on_conn(
            &conn,
            &AgentEvent::QuestionAsked {
                agent_id: "agent-1".into(),
                tool_call_id: "tool-1".into(),
                questions: serde_json::json!([]),
            },
            20,
        )
        .unwrap();
        apply_event_on_conn(
            &conn,
            &AgentEvent::Complete {
                agent_id: "agent-1".into(),
                output: String::new(),
                tokens_used: None,
                reasoning: None,
                ms: 1,
            },
            21,
        )
        .unwrap();
        let waiting: String = conn
            .query_row(
                "SELECT status FROM agent_goals WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(waiting, "waiting");

        attach_run_on_conn(&conn, attach("agent-2", Some(&id), 30)).unwrap();
        apply_event_on_conn(
            &conn,
            &AgentEvent::Complete {
                agent_id: "agent-2".into(),
                output: "verified".into(),
                tokens_used: None,
                reasoning: None,
                ms: 2,
            },
            40,
        )
        .unwrap();
        let result: (String, String, i64) = conn
            .query_row(
                "SELECT status, last_output, resume_count FROM agent_goals WHERE id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(result, ("completed".into(), "verified".into(), 1));
    }

    #[test]
    fn child_event_cannot_complete_the_current_goal() {
        let conn = conn();
        let id = attach_run_on_conn(&conn, attach("root-agent", None, 10)).unwrap();
        apply_event_on_conn(
            &conn,
            &AgentEvent::Complete {
                agent_id: "child-agent".into(),
                output: "child result".into(),
                tokens_used: None,
                reasoning: None,
                ms: 1,
            },
            20,
        )
        .unwrap();
        let status: String = conn
            .query_row(
                "SELECT status FROM agent_goals WHERE id=?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "active");
    }

    #[test]
    fn restart_pauses_the_goal_instead_of_losing_it() {
        let conn = conn();
        let id = attach_run_on_conn(&conn, attach("agent-1", None, 10)).unwrap();
        conn.execute(
            "INSERT INTO agents (id, status, error)
             VALUES ('agent-1', 'error', 'process restarted — agent orphaned')",
            [],
        )
        .unwrap();
        assert_eq!(pause_orphaned_on_conn(&conn, 50).unwrap(), 1);
        let row: (String, String) = conn
            .query_row(
                "SELECT status, last_error FROM agent_goals WHERE id=?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, "paused");
        assert!(row.1.contains("redémarré"));
    }
}
