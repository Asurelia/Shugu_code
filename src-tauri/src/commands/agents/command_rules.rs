//! Learned command rules — persistence + Tauri surface for the « mode fluide ».
//!
//! The pure matching/override logic lives in [`super::policy`] (`CommandRule`,
//! `command_matches`, `classify_with_rules`). This module owns the DB I/O
//! (table `agent_command_rules`, created in `super::get_conn`) and the Tauri
//! commands the UI uses to add / list / remove rules.
//!
//! A rule is GLOBAL (not per-role): the user blesses a command pattern once
//! (e.g. `git push *` to their own fork) and it silences the risk badge for
//! every run. `verdict = "allow"` ⇒ matching commands become `Safe`;
//! `verdict = "deny"` ⇒ `Danger` (flag a pattern the static classifier misses).
//! Persistence mirrors `skills.rs` (same `get_conn` handle, `INSERT OR REPLACE`).

use rusqlite::params;
use serde::Serialize;
use tauri::AppHandle;

use super::policy::CommandRule;
use super::{get_conn, now_ms};

/// A rule as shown in the management UI (Phase 7). `verdict` is the stored
/// string form (`"allow"` / `"deny"`); the classifier consumes the typed
/// [`CommandRule`] via [`load_for_classify`].
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandRuleRow {
    pub pattern: String,
    pub verdict: String,
    pub detail: Option<String>,
    pub created_at: i64,
}

/// Load every rule as a typed [`CommandRule`] for the classifier. Degrades to
/// an empty vec on ANY DB error — a missing/locked rule table must NEVER block
/// an agent's `run_command` (the static classifier still applies).
pub(super) fn load_for_classify(app: &AppHandle) -> Vec<CommandRule> {
    let Ok(conn_mutex) = get_conn(app) else {
        return Vec::new();
    };
    let Ok(conn) = conn_mutex.lock() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare("SELECT pattern, verdict, detail FROM agent_command_rules")
    else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        let verdict: String = r.get(1)?;
        Ok(CommandRule {
            pattern: r.get(0)?,
            allow: verdict == "allow",
            detail: r.get::<_, Option<String>>(2)?,
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

fn list_inner(app: &AppHandle) -> Vec<CommandRuleRow> {
    let Ok(conn_mutex) = get_conn(app) else {
        return Vec::new();
    };
    let Ok(conn) = conn_mutex.lock() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT pattern, verdict, detail, created_at FROM agent_command_rules
         ORDER BY created_at DESC",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(CommandRuleRow {
            pattern: r.get(0)?,
            verdict: r.get(1)?,
            detail: r.get::<_, Option<String>>(2)?,
            created_at: r.get(3)?,
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

// ────────────────────────────────────────────────────────────────────
// Tauri commands (UI) — "Toujours autoriser" button + rules manager (Phase 7)
// ────────────────────────────────────────────────────────────────────

/// Save (or refine) a learned rule. `verdict` must be `"allow"` or `"deny"`.
/// A pattern is a whitespace-token glob, optionally ending in `*`
/// (e.g. `git push *`, `npm run build`). `detail` is an optional note shown on
/// the risk card for a `deny` rule.
#[tauri::command]
pub async fn command_rule_save(
    app: AppHandle,
    pattern: String,
    verdict: String,
    detail: Option<String>,
) -> Result<(), String> {
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() {
        return Err("le motif (pattern) ne peut pas être vide".to_string());
    }
    if verdict != "allow" && verdict != "deny" {
        return Err("verdict doit être \"allow\" ou \"deny\"".to_string());
    }
    // SÉCURITÉ : un motif sans token fixe (« * » seul) matcherait TOUTES les
    // commandes — un `allow` ainsi posé ferait taire le drapeau de rm -rf & co.
    // Refusé (cohérent avec policy::command_matches qui le rend inerte).
    if !pattern.split_whitespace().any(|t| t != "*") {
        return Err(
            "motif trop large : il doit contenir au moins un token fixe (pas seulement « * »)"
                .to_string(),
        );
    }
    // Borne la taille du detail (affiché verbatim dans la risk card).
    let detail = detail.map(|d| d.trim().chars().take(200).collect::<String>());
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO agent_command_rules (pattern, verdict, detail, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![pattern, verdict, detail, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// List all learned rules, newest first (for the rules-manager UI).
#[tauri::command]
pub async fn command_rule_list(app: AppHandle) -> Result<Vec<CommandRuleRow>, String> {
    Ok(list_inner(&app))
}

/// Delete a learned rule by its exact pattern.
#[tauri::command]
pub async fn command_rule_delete(app: AppHandle, pattern: String) -> Result<(), String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM agent_command_rules WHERE pattern = ?1",
        params![pattern.trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
