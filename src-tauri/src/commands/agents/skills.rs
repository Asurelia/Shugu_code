//! Skill library — the agent's persistent, reusable learned capabilities
//! (Voyager / Hermes pattern).
//!
//! The agent SAVES a skill it figured out via the `skill_save` tool; every
//! future run for that role LOADS its skills into context. This is learning that
//! COMPOUNDS without needing the model to stall: a saved skill is reused
//! deterministically (unlike prompt-rewrite-on-stall, which adaptive models
//! escape). Scoped per role; re-saving the same name REFINES the skill
//! (`id = "<role>:<name>"`, INSERT OR REPLACE).

use rusqlite::params;
use serde::Serialize;
use tauri::AppHandle;

use super::{get_conn, now_ms};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillRow {
    pub name: String,
    pub when_to_use: String,
    pub body: String,
    pub created_at: i64,
    /// Source (V14) : "agent" (tool skill_save pendant un run) ou "advisor"
    /// (distillé par l'advisor via skill_save_advisor). Affiché en badge.
    pub created_by: String,
}

/// Persist (or refine) a skill for `role`. Returns a String error so the
/// `skill_save` tool surfaces it to the agent without crashing the run.
///
/// `created_by` — source identifier stored in the `created_by` column
/// (V14): `"agent"` for skills saved via the `skill_save` tool during a
/// normal run, `"advisor"` for skills created by the `skill_save_advisor`
/// Tauri command (written by the external advisor, no exec-gate required).
pub(super) fn save_skill(
    app: &AppHandle,
    role: &str,
    name: &str,
    when_to_use: &str,
    body: &str,
    created_by: &str,
) -> Result<(), String> {
    let conn_mutex = get_conn(app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO agent_skills (id, role, name, when_to_use, body, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            format!("{role}:{name}"),
            role,
            name,
            when_to_use,
            body,
            now_ms(),
            created_by,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// All skills for a role, newest first. Degrades to empty on any DB error — a
/// missing skill library must never block an agent run.
pub(super) fn load_skills(app: &AppHandle, role: &str) -> Vec<SkillRow> {
    let Ok(conn_mutex) = get_conn(app) else {
        return Vec::new();
    };
    let Ok(conn) = conn_mutex.lock() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT name, when_to_use, body, created_at, created_by FROM agent_skills
         WHERE role = ?1 ORDER BY created_at DESC",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map(params![role], |r| {
        Ok(SkillRow {
            name: r.get(0)?,
            when_to_use: r.get(1)?,
            body: r.get(2)?,
            created_at: r.get(3)?,
            created_by: r.get(4)?,
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

/// Formatted skills section to inject into the agent's system context, or empty
/// when the role has none. The agent reads this and applies its learned skills.
pub(super) fn skills_prompt_block(app: &AppHandle, role: &str) -> String {
    let skills = load_skills(app, role);
    if skills.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "[Compétences apprises] Tu as déjà acquis ces compétences réutilisables. \
         Applique celle qui correspond à la tâche au lieu de tout refaire de zéro :\n",
    );
    for sk in &skills {
        s.push_str(&format!(
            "\n### {}\nQuand l'utiliser : {}\n{}\n",
            sk.name, sk.when_to_use, sk.body
        ));
    }
    s
}

// ────────────────────────────────────────────────────────────────────
// Tauri commands (UI)
// ────────────────────────────────────────────────────────────────────

/// List the skills a role has learned (for the Harness panel).
#[tauri::command]
pub async fn skills_list(app: AppHandle, role: String) -> Result<Vec<SkillRow>, String> {
    Ok(load_skills(&app, &role))
}

/// Wipe a role's skill library (demo reset / cleanup).
#[tauri::command]
pub async fn skills_clear(app: AppHandle, role: String) -> Result<(), String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM agent_skills WHERE role = ?1", params![role])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Create or refine a skill on behalf of the **advisor** (the external reviewer
/// model that synthesises lessons across runs). Unlike the in-agent `skill_save`
/// tool, this command:
///   - does NOT require a prior passing `run_command` (the advisor reviews
///     completed runs, so exec-verification has already happened implicitly).
///   - stores `created_by = "advisor"` so the UI / analytics can distinguish
///     advisor-injected skills from agent-discovered skills.
///   - emits `AgentEvent::SkillLearned { source: "advisor" }` on the
///     `"agent://lifecycle"` channel so the chat UI can surface a badge.
///
/// The event uses `agent_id = "advisor"` (a sentinel, not a real UUID) since
/// advisor skills are not tied to a specific agent run. The event will NOT
/// appear in any individual agent's transcript pane (expected by design).
#[tauri::command]
pub async fn skill_save_advisor(
    app: AppHandle,
    role: String,
    name: String,
    when_to_use: String,
    body: String,
) -> Result<(), String> {
    if name.trim().is_empty() || body.trim().is_empty() {
        return Err("skill_save_advisor needs a non-empty name and body".to_string());
    }
    // M4 (revue sécurité) — un skill body est INJECTÉ verbatim dans le system
    // prompt des runs futurs (skills_prompt_block). On borne donc les tailles :
    // un body géant = bloat de contexte + surface d'injection plus large.
    // Troncature en scalaires Unicode (texte FR multi-octet, pas de panic).
    let name_capped: String = name.trim().chars().take(120).collect();
    let when_capped: String = when_to_use.trim().chars().take(300).collect();
    let body_capped: String = body.trim().chars().take(2000).collect();
    save_skill(
        &app,
        &role,
        &name_capped,
        &when_capped,
        &body_capped,
        "advisor",
    )?;
    let _ = super::persist_and_emit(
        &app,
        &super::AgentEvent::SkillLearned {
            agent_id: "advisor".to_string(),
            role: role.clone(),
            name: name_capped.clone(),
            source: "advisor".to_string(),
        },
    );
    Ok(())
}
