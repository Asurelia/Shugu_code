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
}

/// Persist (or refine) a skill for `role`. Returns a String error so the
/// `skill_save` tool surfaces it to the agent without crashing the run.
pub(super) fn save_skill(
    app: &AppHandle,
    role: &str,
    name: &str,
    when_to_use: &str,
    body: &str,
) -> Result<(), String> {
    let conn_mutex = get_conn(app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO agent_skills (id, role, name, when_to_use, body, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            format!("{role}:{name}"),
            role,
            name,
            when_to_use,
            body,
            now_ms()
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
        "SELECT name, when_to_use, body, created_at FROM agent_skills
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
