//! Règles de permission allow / ask / deny (P6.10) — persistance + surface
//! Tauri. La logique pure (grammaire, matching, précédence) vit dans
//! [`super::permission`] ; ce module fait l'I/O SQLite (table
//! `agent_permission_rules`, V28) et expose les commandes UI.
//!
//! Compatibilité : [`load_for_classify`] alimente encore le classifieur de
//! risque de `run_command` (règles allow/deny de la NOUVELLE table, scope
//! global + scope du workspace courant) — le `ask` n'est pas du ressort du
//! classifieur statique (il est résolu par `permission::resolve` au dispatch).

use rusqlite::params;
use serde::Serialize;
use tauri::AppHandle;

use super::permission::{Decision, PermissionRule};
use super::policy::CommandRule;
use super::{get_conn, now_ms};

/// Une règle telle qu'exposée à l'UI de gestion (trois listes + scope).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRuleRow {
    pub pattern: String,
    pub decision: String,
    /// "" = global, sinon chemin du workspace.
    pub scope: String,
    pub detail: Option<String>,
    pub created_at: i64,
}

fn row_to_rule(r: &rusqlite::Row) -> rusqlite::Result<PermissionRule> {
    let decision: String = r.get(1)?;
    Ok(PermissionRule {
        pattern: r.get(0)?,
        decision: Decision::from_str(&decision).unwrap_or(Decision::Allow),
        scope: r.get(2)?,
        detail: r.get(3)?,
        created_at: r.get(4)?,
    })
}

const RULE_SELECT: &str =
    "SELECT pattern, decision, scope, detail, created_at FROM agent_permission_rules";

/// Toutes les règles (allow / ask / deny, tous scopes) pour le moteur pur.
pub(crate) fn load_permission_rules(app: &AppHandle) -> Result<Vec<PermissionRule>, String> {
    let conn_mutex = get_conn(app)?;
    let conn = conn_mutex
        .lock()
        .map_err(|e| format!("permission rules lock: {e}"))?;
    let mut stmt = conn
        .prepare(&format!(
            "{RULE_SELECT} ORDER BY length(pattern) DESC, pattern ASC"
        ))
        .map_err(|e| format!("permission rules prepare: {e}"))?;
    let rows = stmt
        .query_map([], row_to_rule)
        .map_err(|e| format!("permission rules query: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("permission rules row: {e}"))
}

/// Compatibilité classifieur : règles allow/deny de la nouvelle table, scope
/// global + scope du workspace courant (le `ask` vit dans `permission::resolve`).
pub(super) fn load_for_classify(app: &AppHandle) -> Result<Vec<CommandRule>, String> {
    let scope = super::runner::get_workspace_root(app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(load_permission_rules(app)?
        .into_iter()
        .filter(|r| {
            (r.scope.is_empty() || r.scope == scope)
                && matches!(r.decision, Decision::Allow | Decision::Deny)
        })
        .map(|r| CommandRule {
            allow: r.decision == Decision::Allow,
            pattern: r.pattern,
            detail: r.detail,
        })
        .collect())
}

fn list_inner(app: &AppHandle) -> Vec<PermissionRuleRow> {
    let Ok(conn_mutex) = get_conn(app) else {
        return Vec::new();
    };
    let Ok(conn) = conn_mutex.lock() else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(&format!("{RULE_SELECT} ORDER BY created_at DESC")) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |r| {
        Ok(PermissionRuleRow {
            pattern: r.get(0)?,
            decision: r.get(1)?,
            scope: r.get(2)?,
            detail: r.get(3)?,
            created_at: r.get(4)?,
        })
    });
    match rows {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => Vec::new(),
    }
}

// ────────────────────────────────────────────────────────────────────────
// Tauri commands (UI)
// ────────────────────────────────────────────────────────────────────────

/// Enregistre (ou raffine) une règle de permission. `decision` ∈
/// {"allow","ask","deny"} ; `scope` vide = global. La forme du motif est
/// validée par le parseur unique (permission::parse_pattern) : un motif
/// invalide ou trop large (« * » nu) est refusé.
#[tauri::command]
pub async fn permission_rule_save(
    app: AppHandle,
    pattern: String,
    decision: String,
    scope: Option<String>,
    detail: Option<String>,
) -> Result<(), String> {
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() {
        return Err("le motif (pattern) ne peut pas être vide".to_string());
    }
    let Some(decision) = Decision::from_str(&decision) else {
        return Err("decision doit être \"allow\", \"ask\" ou \"deny\"".to_string());
    };
    // Forme valide selon la grammaire unique (sinon le motif ne matcherait
    // jamais rien — un motif mort est un bug silencieux).
    if super::permission::parse_pattern(&pattern).is_none() {
        return Err(format!(
            "motif invalide : attendu `git push *`, `run_command(...)` (glob), \
             `web_fetch(domain:...)` ou `mcp__<serveur>__<outil|*>` — reçu « {pattern} »"
        ));
    }
    // SÉCURITÉ : un glob sans token fixe (« * » seul) matcherait TOUT.
    if !pattern.split_whitespace().any(|t| t != "*") && !pattern.contains('(') {
        return Err(
            "motif trop large : il doit contenir au moins un token fixe (pas seulement « * »)"
                .to_string(),
        );
    }
    let scope = scope.unwrap_or_default().trim().to_string();
    let detail = detail.map(|d| d.trim().chars().take(200).collect::<String>());
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO agent_permission_rules (pattern, decision, scope, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![pattern, decision.as_str(), scope, detail, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Liste toutes les règles (trois décisions + scopes), les plus récentes d'abord.
#[tauri::command]
pub async fn permission_rule_list(app: AppHandle) -> Result<Vec<PermissionRuleRow>, String> {
    Ok(list_inner(&app))
}

/// Supprime une règle par (pattern, scope) — la PK exacte.
#[tauri::command]
pub async fn permission_rule_delete(
    app: AppHandle,
    pattern: String,
    scope: Option<String>,
) -> Result<(), String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM agent_permission_rules WHERE pattern = ?1 AND scope = ?2",
        params![pattern.trim(), scope.unwrap_or_default().trim()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEvaluation {
    /// "allow" | "ask" | "deny" | "noRule".
    pub outcome: String,
    pub matched_pattern: Option<String>,
    pub reason: Option<String>,
}

/// Testeur live (Settings) : évalue un appel d'outil contre les règles
/// actuelles — montre QUELLE règle matche et la décision résultante.
#[tauri::command]
pub async fn permission_rule_evaluate(
    app: AppHandle,
    tool: String,
    args: serde_json::Value,
) -> Result<PermissionEvaluation, String> {
    let rules = load_permission_rules(&app)?;
    let scope = super::runner::get_workspace_root(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    match super::permission::resolve(&tool, &args, &rules, &scope) {
        super::permission::Outcome::Allow { pattern } => Ok(PermissionEvaluation {
            outcome: "allow".to_string(),
            matched_pattern: Some(pattern),
            reason: None,
        }),
        super::permission::Outcome::Ask { pattern } => Ok(PermissionEvaluation {
            outcome: "ask".to_string(),
            matched_pattern: Some(pattern),
            reason: None,
        }),
        super::permission::Outcome::Deny { pattern, reason } => Ok(PermissionEvaluation {
            outcome: "deny".to_string(),
            matched_pattern: Some(pattern),
            reason: Some(reason),
        }),
        super::permission::Outcome::NoRule => Ok(PermissionEvaluation {
            outcome: "noRule".to_string(),
            matched_pattern: None,
            reason: Some("aucune règle ne matche — classifieur statique".to_string()),
        }),
    }
}
