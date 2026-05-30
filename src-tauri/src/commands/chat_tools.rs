//! Outils du CHAT : sous-ensemble lecture (+écriture si activée) des outils
//! agents, exécutés en boucle bornée par chat_send. Pas de run_command, pas
//! de skill_save. Écritures path-guardées (fs::safe_resolve_for_write) et
//! consignées dans un journal d'annulation renvoyé au front (réversibilité du
//! tour, esprit agent_reverse_patch mais sans Docker).
//!
//! ## Pourquoi un module séparé de `agents::tools`
//!
//! Le dispatcher agent (`agents::tools::dispatch_inner`) expose un set PLUS LARGE
//! (run_command sandboxé, skill_save, todo_write) destiné au banc Atelier. Le
//! chat veut un sous-ensemble strict : lecture toujours, écriture optionnelle,
//! JAMAIS d'exécution de code. Plutôt que de propager un flag à travers le
//! dispatcher agent, on isole ici le renderer JSON filtré + le dispatcher chat,
//! qui réutilisent les MÊMES helpers d'exécution (`fs::*_inner`, `grep::grep_inner`)
//! que les agents — donc le même path-guard, sans duplication de la logique d'I/O.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

/// Une écriture du tour, pour l'annulation. `before = None` = fichier créé
/// (l'annulation devra donc le supprimer ; cf. Task 13 `chat_revert_writes`).
///
/// `Deserialize` AUSSI : la commande `chat_revert_writes` reçoit ce même type
/// depuis le front (qui l'a obtenu via l'event `chat://writes`), donc Tauri doit
/// pouvoir le désérialiser depuis l'invoke. Sans `Deserialize`,
/// `Vec<ChatWriteRecord>` n'implémente pas `CommandArg` → erreur de compilation
/// du `generate_handler!`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatWriteRecord {
    pub path: String,
    pub before: Option<String>,
}

/// Schéma OpenAI des outils chat. `write_enabled` ajoute write/edit.
pub fn chat_tools_json_openai(write_enabled: bool) -> Value {
    json!(tool_defs(write_enabled)
        .into_iter()
        .map(|(n, d, p)| json!({
            "type": "function",
            "function": { "name": n, "description": d, "parameters": p }
        }))
        .collect::<Vec<_>>())
}

/// Schéma Anthropic des outils chat.
pub fn chat_tools_json_anthropic(write_enabled: bool) -> Value {
    json!(tool_defs(write_enabled)
        .into_iter()
        .map(|(n, d, p)| json!({
            "name": n, "description": d, "input_schema": p
        }))
        .collect::<Vec<_>>())
}

/// Définitions communes (nom, description, schéma de paramètres). Source unique
/// pour les deux renderers, qui ne diffèrent que par l'enveloppe provider.
fn tool_defs(write_enabled: bool) -> Vec<(&'static str, &'static str, Value)> {
    let mut v = vec![
        (
            "fs_read_file",
            "Lit un fichier workspace-relatif (UTF-8, cap 32 KiB).",
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        ),
        (
            "fs_list_dir",
            "Liste les enfants directs d'un dossier workspace-relatif.",
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        ),
        (
            "fs_search",
            "Recherche ripgrep dans le workspace (cap 80).",
            json!({"type":"object","properties":{"query":{"type":"string"},"regex":{"type":"boolean"},"case_sensitive":{"type":"boolean"}},"required":["query"]}),
        ),
    ];
    if write_enabled {
        v.push((
            "fs_write_file",
            "Écrit (écrase) un fichier workspace-relatif. Crée les dossiers parents.",
            json!({"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}),
        ));
        v.push((
            "fs_edit",
            "Remplace un snippet exact et unique dans un fichier existant.",
            json!({"type":"object","properties":{"path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["path","old_string","new_string"]}),
        ));
    }
    v
}

/// Exécute un tool-call chat. NE retourne jamais Err : échec → (texte, is_error).
/// Pousse un ChatWriteRecord dans `journal` AVANT toute écriture (réversibilité).
///
/// La forme d'appel des helpers fs/grep est CALQUÉE sur `agents::tools::dispatch_inner`
/// (tools.rs:432-515) : `fs::read_file_inner(root, path, Some(cap))`,
/// `fs::write_file_inner(root, path, content)`, `fs::list_dir_inner(root, path)`,
/// `grep::grep_inner(root, query, &GrepOpts{..})`.
pub fn execute_chat_tool(
    name: &str,
    args: &Value,
    root: &Path,
    write_enabled: bool,
    journal: &mut Vec<ChatWriteRecord>,
) -> (String, bool) {
    match name {
        "fs_read_file" => string_or_err(crate::commands::fs::read_file_inner(
            root,
            getstr(args, "path"),
            Some(32 * 1024),
        )),
        "fs_list_dir" => string_or_err(crate::commands::fs::list_dir_inner(
            root,
            args["path"].as_str().unwrap_or("."),
        )),
        "fs_search" => {
            let opts = crate::commands::grep::GrepOpts {
                case_sensitive: args["case_sensitive"].as_bool().unwrap_or(false),
                regex: args["regex"].as_bool().unwrap_or(false),
                max_results: 80,
            };
            match crate::commands::grep::grep_inner(root, getstr(args, "query"), &opts) {
                Ok(ms) => (
                    format!(
                        "{} match(es):\n{}",
                        ms.len(),
                        ms.iter()
                            .map(|m| format!("{}:{}: {}", m.path, m.line, m.preview))
                            .collect::<Vec<_>>()
                            .join("\n")
                    ),
                    false,
                ),
                Err(e) => (e, true),
            }
        }
        "fs_write_file" if write_enabled => {
            let path = getstr(args, "path");
            record_before(root, path, journal);
            match crate::commands::fs::write_file_inner(root, path, getstr(args, "content")) {
                Ok(n) => (format!("wrote {n} bytes to {path}"), false),
                Err(e) => (e, true),
            }
        }
        "fs_edit" if write_enabled => {
            let path = getstr(args, "path");
            let (old, new) = (getstr(args, "old_string"), getstr(args, "new_string"));
            // Guard identique à agents::tools (tools.rs:497) : un old vide n'est
            // pas un edit mais une création → "" matche partout, ce qui ferait
            // tomber le compteur sur count>1 avec un message confus. On refuse
            // explicitement avec le conseil correct.
            if old.is_empty() {
                return (
                    format!("old_string vide — utilise fs_write_file pour créer/écraser {path}"),
                    true,
                );
            }
            // Lit le fichier ENTIER (cap None) : une lecture tronquée pourrait
            // sinon corrompre le fichier en réécrivant une version coupée.
            match crate::commands::fs::read_file_inner(root, path, None) {
                Ok(content) => {
                    let count = content.matches(old).count();
                    if count == 0 {
                        return (format!("old_string introuvable dans {path}"), true);
                    }
                    if count > 1 {
                        return (
                            format!("old_string apparaît {count}× — ajoute du contexte"),
                            true,
                        );
                    }
                    record_before(root, path, journal);
                    let updated = content.replacen(old, new, 1);
                    match crate::commands::fs::write_file_inner(root, path, &updated) {
                        Ok(n) => (format!("edited {path} ({n} bytes)"), false),
                        Err(e) => (e, true),
                    }
                }
                Err(e) => (e, true),
            }
        }
        other => (format!("unknown or disabled tool: {other}"), true),
    }
}

fn getstr<'a>(args: &'a Value, k: &str) -> &'a str {
    args[k].as_str().unwrap_or("")
}

fn string_or_err(r: Result<String, String>) -> (String, bool) {
    match r {
        Ok(s) => (s, false),
        Err(e) => (e, true),
    }
}

/// Capture le contenu actuel (ou None si absent) une seule fois par path.
/// Idempotent : si un record existe déjà pour ce path (ex. write puis edit dans
/// le même tour), on garde le PREMIER `before` — l'annulation restaure l'état
/// d'avant le tour, pas l'état intermédiaire.
fn record_before(root: &Path, path: &str, journal: &mut Vec<ChatWriteRecord>) {
    if journal.iter().any(|r| r.path == path) {
        return;
    }
    let before = crate::commands::fs::read_file_inner(root, path, None).ok();
    journal.push(ChatWriteRecord {
        path: path.to_string(),
        before,
    });
}

// ---------------------------------------------------------------------------
// Annulation d'un tour (Task 13)
// ---------------------------------------------------------------------------

/// Annule les écritures d'un tour de chat.
///
/// Restaure chaque fichier à son contenu d'AVANT le tour, en parcourant le
/// journal en ordre INVERSE. Pour chaque enregistrement :
///   * `before = Some(content)` → le fichier existait avant le tour : on
///     réécrit son contenu d'origine via `write_file_inner` (path-guard
///     `safe_resolve_for_write`).
///   * `before = None` → le fichier a été CRÉÉ pendant le tour : on le supprime
///     via `delete_file_inner` (best-effort — `let _ =`), qui réutilise EXACTEMENT
///     le même path-guard que l'écriture qu'on annule. Best-effort car le
///     fichier peut déjà avoir été retiré (l'utilisateur, un autre outil…) ;
///     l'annulation ne doit pas échouer pour autant.
///
/// L'ordre inverse est cohérent même si un path apparaît plusieurs fois (ce qui
/// ne devrait pas arriver — `record_before` déduplique par path), car le tout
/// premier `before` capturé est l'état d'avant le tour.
#[tauri::command]
pub async fn chat_revert_writes(
    app: tauri::AppHandle,
    records: Vec<ChatWriteRecord>,
) -> Result<(), String> {
    let root = crate::commands::fs::restore_workspace_root(&app)
        .ok_or_else(|| "aucun projet ouvert".to_string())?;
    for r in records.iter().rev() {
        match &r.before {
            Some(content) => {
                crate::commands::fs::write_file_inner(&root, &r.path, content)?;
            }
            None => {
                // Fichier créé pendant le tour → suppression best-effort.
                let _ = crate::commands::fs::delete_file_inner(&root, &r.path);
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_read_only_excludes_writes() {
        let v = chat_tools_json_openai(false); // write_enabled = false
        let names: Vec<String> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"fs_read_file".to_string()));
        assert!(names.contains(&"fs_search".to_string()));
        assert!(!names.contains(&"fs_write_file".to_string()));
        assert!(!names.contains(&"run_command".to_string()));
    }

    #[test]
    fn renderer_with_writes_includes_edit() {
        let v = chat_tools_json_openai(true);
        let names: Vec<String> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"fs_write_file".to_string()));
        assert!(names.contains(&"fs_edit".to_string()));
        assert!(!names.contains(&"run_command".to_string()));
    }
}
