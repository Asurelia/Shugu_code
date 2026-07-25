//! Moteur de règles de permission allow / ask / deny (P6.10).
//!
//! ## Grammaire des motifs (source unique — utilisée partout)
//!
//! ```text
//! motif          := nu | appel
//! nu             := token+ ("*")?                    → run_command(nu) — rétro-compat
//! appel          := outil "(" arg ")"
//! outil          := "run_command" | "web_fetch" | <outil natif avec arg path>
//!                 | "mcp__" <serveur> "__" (<outil> | "*")
//! arg run_command := glob de commande (tokens préfixe + "*" final optionnel,
//!                    mêmes règles que policy::command_matches)
//! arg web_fetch  := "domain:" <hôte>   (hôte exact OU sous-domaine)
//!                 | glob d'URL        (préfixe + "*" final optionnel)
//! arg <outil path> := "path:" <glob de chemin> (préfixe + "*" final ; les
//!                    séparateurs \ sont normalisés en /) — pour
//!                    fs_write_file / fs_edit / fs_read_file et tout outil
//!                    natif portant un argument `path`.
//! ```
//!
//! Exemples : `git push *` (nu), `run_command(git diff:*)`,
//! `web_fetch(domain:example.com)` (matche aussi `api.example.com`),
//! `mcp__github__create_issue`, `mcp__github__*`.
//!
//! Note : `run_command(git diff:*)` — le glob est APPLIQUÉ À LA LIGNE DE
//! COMMANDE ENTIÈRE (`args.command`) ; le `:` fait partie du glob comme tout
//! autre caractère.
//!
//! ## Précédence
//!
//! `deny > ask > allow > classifieur statique`. À liste égale, la règle la
//! plus SPÉCIFIQUE gagne (motif le plus long) ; à spécificité égale, une
//! règle PROJET (scope = workspace courant) gagne sur une règle GLOBALE
//! (scope vide). Tout est pur et testé — aucun matching ad hoc ailleurs.
//!
//! ## Sémantique `ask`
//!
//! En profil mutant (Auto / Full Access), un appel d'outil qui matche une
//! règle `ask` devient une question HITL (pipeline `ask_user` existant) :
//! le run se termine proprement, l'utilisateur répond via la carte, et la
//! réponse est enregistrée dans `agent_interactions` (déjà l'infra
//! d'idempotence). À la relance, le verdict est retrouvé pour le seul run de
//! continuation concerné puis consommé exactement une fois.
//! verdict pour la MÊME signature d'appel : approuvé une fois ⇒ exécution ;
//! refusé une fois ⇒ ToolResult d'erreur (jamais de refus silencieux).
//! « Toujours … » écrit une vraie règle allow/deny (côté frontend) — la
//! prochaine évaluation la matche avant d'en arriver à `ask`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Digest;

use super::policy::command_matches;

// ────────────────────────────────────────────────────────────────────────
// Modèle
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Allow,
    Ask,
    Deny,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "allow" => Some(Self::Allow),
            "ask" => Some(Self::Ask),
            "deny" => Some(Self::Deny),
            _ => None,
        }
    }
}

/// Une règle de permission persistée (table `agent_permission_rules`, V28).
/// `scope` vide = GLOBAL ; sinon le chemin du workspace concerné (les règles
/// projet gagnent à spécificité égale).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub pattern: String,
    pub decision: Decision,
    pub scope: String,
    pub detail: Option<String>,
    pub created_at: i64,
}

// ────────────────────────────────────────────────────────────────────────
// Parsing des motifs (formes pures)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Pattern {
    /// Glob de commande HÉRITÉ (forme `nu`) — matcher par tokens de
    /// `policy::command_matches` (rétro-compat stricte).
    Command(String),
    /// Glob de commande forme `run_command(...)` — préfixe de CHAÎNE avec
    /// borne de token (le `*` final seul est wildcard ; « git diff:* » exige
    /// le préfixe avec ':' — cf. doc du module).
    CommandPrefix(String),
    /// `web_fetch(domain:<hôte>)` — hôte exact ou sous-domaine.
    FetchDomain(String),
    /// `web_fetch(<glob d'URL>)`.
    FetchUrlGlob(String),
    /// `mcp__<serveur>__*` — tout un serveur MCP.
    McpServerWildcard(String),
    /// `mcp__<serveur>__<outil>` — un outil MCP exact.
    McpExact(String),
    /// `<outil natif>(path:<glob>)` — motif sur l'argument `path` d'un outil
    /// natif (fs_write_file, fs_edit, fs_read_file…).
    PathArg { tool: String, glob: String },
}

/// Parse un motif. `None` = motif vide ou structurellement invalide (les
/// motifs invalides ne matchent JAMAIS — fail-safe).
pub(crate) fn parse_pattern(raw: &str) -> Option<Pattern> {
    let p = raw.trim();
    if p.is_empty() {
        return None;
    }
    if let Some(inner) = p
        .strip_prefix("run_command(")
        .and_then(|s| s.strip_suffix(')'))
    {
        let glob = inner.trim();
        return (!glob.is_empty()).then(|| Pattern::CommandPrefix(glob.to_string()));
    }
    if let Some(inner) = p
        .strip_prefix("web_fetch(")
        .and_then(|s| s.strip_suffix(')'))
    {
        let arg = inner.trim();
        if arg.is_empty() {
            return None;
        }
        if let Some(host) = arg.strip_prefix("domain:") {
            let host = host.trim().trim_start_matches("*.").to_string();
            return (!host.is_empty()).then(|| Pattern::FetchDomain(host.to_lowercase()));
        }
        return Some(Pattern::FetchUrlGlob(arg.to_string()));
    }
    // Forme générique <outil>(path:<glob>) pour les outils natifs à argument
    // `path` (fs_write_file, fs_edit, fs_read_file…).
    if let Some(inner) = p.strip_suffix(')') {
        if let Some((tool, arg)) = inner.split_once('(') {
            if !tool.is_empty() && !tool.contains("__") {
                if let Some(glob) = arg.strip_prefix("path:") {
                    let glob = normalize_permission_path_glob(glob.trim())?;
                    if !glob.is_empty() {
                        return Some(Pattern::PathArg {
                            tool: tool.to_string(),
                            glob,
                        });
                    }
                }
            }
        }
    }
    if p.starts_with("mcp__") {
        if p.ends_with("__*") {
            let server = p.strip_prefix("mcp__")?.strip_suffix("__*")?;
            return (!server.is_empty()).then(|| Pattern::McpServerWildcard(server.to_string()));
        }
        // Forme exacte : mcp__<serveur>__<outil> (le <outil> peut contenir __).
        let rest = p.strip_prefix("mcp__")?;
        let idx = rest.find("__")?;
        let (server, tool) = (&rest[..idx], &rest[idx + 2..]);
        return (!server.is_empty() && !tool.is_empty()).then(|| Pattern::McpExact(p.to_string()));
    }
    // Nu : glob de commande historique (rétro-compat stricte).
    Some(Pattern::Command(p.to_string()))
}

// ────────────────────────────────────────────────────────────────────────
// Matching contre un appel d'outil (name + args JSON)
// ────────────────────────────────────────────────────────────────────────

fn host_of(url: &str) -> String {
    let no_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    no_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn url_glob_matches(url: &str, glob: &str) -> bool {
    if let Some(prefix) = glob.strip_suffix('*') {
        url.starts_with(prefix)
    } else {
        url == glob
    }
}

/// Normalise lexicalement un chemin relatif avant de le comparer à une règle.
/// La résolution réelle reste faite par `fs::safe_resolve`, mais cette étape
/// empêche qu'un motif `src/*` autorise textuellement `src/../secret`.
fn normalize_permission_path(raw: &str) -> Option<String> {
    let replaced = raw.trim().replace('\\', "/");
    if replaced.is_empty()
        || replaced.starts_with('/')
        || replaced.starts_with("//")
        || replaced
            .as_bytes()
            .get(1)
            .is_some_and(|separator| *separator == b':')
    {
        return None;
    }

    let preserve_trailing_slash = replaced.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in replaced.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return None;
    }
    let mut normalized = parts.join("/");
    if preserve_trailing_slash {
        normalized.push('/');
    }
    #[cfg(windows)]
    {
        normalized.make_ascii_lowercase();
    }
    Some(normalized)
}

fn normalize_permission_path_glob(raw: &str) -> Option<String> {
    if raw == "*" {
        return Some(raw.to_string());
    }
    if let Some(prefix) = raw.strip_suffix('*') {
        return normalize_permission_path(prefix).map(|p| format!("{p}*"));
    }
    normalize_permission_path(raw)
}

/// Glob de CHAÎNE pour la forme `run_command(...)` : préfixe avec borne de
/// token (le caractère après le préfixe est la fin ou un espace), sauf si le
/// préfixe se termine par ':' (forme « git diff:* » — tout suffixe accepté,
/// c'est le sens du spec : le `:` fait partie du glob).
pub(crate) fn string_glob_matches(command: &str, glob: &str) -> bool {
    let cmd = command.trim();
    let glob = glob.trim();
    match glob.strip_suffix('*') {
        None => cmd == glob,
        Some(prefix) => {
            let prefix = prefix.trim_end();
            if prefix.is_empty() {
                return false;
            }
            if prefix.ends_with(':') {
                return cmd.starts_with(prefix);
            }
            if cmd == prefix {
                return true;
            }
            cmd.starts_with(prefix) && cmd[prefix.len()..].starts_with(char::is_whitespace)
        }
    }
}

/// Le motif matche-t-il CET appel d'outil ? (pur)
pub(crate) fn pattern_matches_tool(
    pattern: &Pattern,
    tool: &str,
    args: &serde_json::Value,
) -> bool {
    match pattern {
        Pattern::Command(glob) => {
            tool == "run_command" && command_matches(args["command"].as_str().unwrap_or(""), glob)
        }
        Pattern::CommandPrefix(glob) => {
            tool == "run_command"
                && string_glob_matches(args["command"].as_str().unwrap_or(""), glob)
        }
        Pattern::FetchDomain(host) => {
            if tool != "web_fetch" {
                return false;
            }
            let url_host = host_of(args["url"].as_str().unwrap_or(""));
            !url_host.is_empty() && (url_host == *host || url_host.ends_with(&format!(".{host}")))
        }
        Pattern::FetchUrlGlob(glob) => {
            tool == "web_fetch" && url_glob_matches(args["url"].as_str().unwrap_or(""), glob)
        }
        Pattern::McpServerWildcard(server) => {
            tool == format!("mcp__{server}__") || tool.starts_with(&format!("mcp__{server}__"))
        }
        Pattern::McpExact(name) => tool == name,
        Pattern::PathArg {
            tool: want_tool,
            glob,
        } => {
            if tool != want_tool {
                return false;
            }
            let Some(path) = normalize_permission_path(args["path"].as_str().unwrap_or("")) else {
                return false;
            };
            if glob == "*" {
                return true;
            }
            if let Some(prefix) = glob.strip_suffix('*') {
                path.starts_with(prefix)
            } else {
                path == *glob
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Résolution (précédence + spécificité + scope)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Règle `allow` matchée (la plus spécifique) — exécution autorisée.
    Allow { pattern: String },
    /// Règle `ask` matchée — question HITL requise (ou verdict déjà répondu
    /// pour cette signature, via l'interaction HITL de la continuation).
    Ask { pattern: String },
    /// Règle `deny` matchée — refus avec raison.
    Deny { pattern: String, reason: String },
    /// Aucune règle ne matche → classifieur statique (comportement historique).
    NoRule,
}

fn specificity(rule: &PermissionRule, current_scope: &str) -> (usize, bool) {
    // (longueur du motif, règle projet ?) — tri décroissant : le plus
    // spécifique d'abord, le projet avant le global à longueur égale.
    (
        rule.pattern.len(),
        !rule.scope.is_empty() && rule.scope == current_scope,
    )
}

/// Résout la décision pour un appel d'outil contre la liste de règles.
/// `current_scope` = workspace courant (chaîne vide si aucun — seules les
/// règles GLOBALES s'appliquent alors).
pub(crate) fn resolve(
    tool: &str,
    args: &serde_json::Value,
    rules: &[PermissionRule],
    current_scope: &str,
) -> Outcome {
    let mut matching: Vec<&PermissionRule> = rules
        .iter()
        .filter(|r| {
            (r.scope.is_empty() || r.scope == current_scope)
                && parse_pattern(&r.pattern).is_some_and(|p| pattern_matches_tool(&p, tool, args))
        })
        .collect();
    matching.sort_by_key(|r| std::cmp::Reverse(specificity(r, current_scope)));

    if let Some(r) = matching.iter().find(|r| r.decision == Decision::Deny) {
        return Outcome::Deny {
            pattern: r.pattern.clone(),
            reason: r
                .detail
                .clone()
                .unwrap_or_else(|| format!("refusé par la règle « {} »", r.pattern)),
        };
    }
    if let Some(r) = matching.iter().find(|r| r.decision == Decision::Ask) {
        return Outcome::Ask {
            pattern: r.pattern.clone(),
        };
    }
    if let Some(r) = matching.iter().find(|r| r.decision == Decision::Allow) {
        return Outcome::Allow {
            pattern: r.pattern.clone(),
        };
    }
    Outcome::NoRule
}

// ────────────────────────────────────────────────────────────────────────
// Signature d'appel + verdict HITL durable (agent_interactions)
// ────────────────────────────────────────────────────────────────────────

/// Signature stable d'un appel d'outil (sha256 du nom + args JSON) — clé du
/// verdict « une fois » dans `agent_interactions` (interaction_id =
/// `<agentId>:perm-<hash>`).
pub(crate) fn call_signature(tool: &str, args: &serde_json::Value) -> String {
    let mut h = sha2::Sha256::new();
    h.update(tool.as_bytes());
    h.update(b"|");
    h.update(args.to_string().as_bytes());
    let digest = h.finalize();
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Consomme le verdict « cette fois » associé à CE run de continuation.
/// L'association `continuation_agent_id` est écrite atomiquement par
/// `agent_continue`; `permission_consumed_at` garantit qu'un deuxième appel de
/// même signature, même dans ce run, reposera la question.
fn answered_permission_for_continuation_on_conn(
    conn: &Connection,
    hash: &str,
    continuation_agent_id: &str,
) -> Result<Option<(String, bool)>, String> {
    let pattern = format!("%:perm-{hash}");
    let row: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT interaction_id, response, verdict FROM agent_interactions
              WHERE interaction_id LIKE ?1
                AND answered_at IS NOT NULL
                AND continuation_agent_id = ?2
                AND permission_consumed_at IS NULL
              ORDER BY answered_at DESC LIMIT 1",
            params![pattern, continuation_agent_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("permission answer lookup: {e}"))?;
    let Some((interaction_id, response, verdict)) = row else {
        return Ok(None);
    };
    let text = format!(
        "{}\n{}",
        response.unwrap_or_default(),
        verdict.unwrap_or_default()
    );
    // Fail-closed : seule une réponse explicitement préfixée AUTORISÉ compte
    // comme approbation. Une ligne vide, tronquée ou provenant d'un ancien
    // client est refusée pour cette tentative puis consommée.
    let normalized = text.trim_start();
    let allowed = normalized.starts_with("AUTORISÉ") || normalized.starts_with("AUTORISE");
    Ok(Some((interaction_id, allowed)))
}

pub(crate) fn take_answered_permission_on_conn(
    conn: &Connection,
    hash: &str,
    continuation_agent_id: &str,
    now: i64,
) -> Result<Option<bool>, String> {
    let Some((interaction_id, allowed)) =
        answered_permission_for_continuation_on_conn(conn, hash, continuation_agent_id)?
    else {
        return Ok(None);
    };
    let consumed = conn
        .execute(
            "UPDATE agent_interactions
                SET permission_consumed_at = ?1
              WHERE interaction_id = ?2 AND permission_consumed_at IS NULL",
            params![now, interaction_id],
        )
        .map_err(|e| format!("permission answer consume: {e}"))?;
    Ok((consumed == 1).then_some(allowed))
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(pattern: &str, decision: Decision, scope: &str) -> PermissionRule {
        PermissionRule {
            pattern: pattern.to_string(),
            decision,
            scope: scope.to_string(),
            detail: None,
            created_at: 1,
        }
    }

    fn cmd(c: &str) -> serde_json::Value {
        json!({"command": c})
    }

    #[test]
    fn pattern_grammar_all_forms() {
        // Nu (rétro-compat) — glob de tokens préfixe + '*' final.
        let p = parse_pattern("git push *").unwrap();
        assert!(pattern_matches_tool(
            &p,
            "run_command",
            &cmd("git push --force origin main")
        ));
        assert!(!pattern_matches_tool(&p, "run_command", &cmd("git pull")));
        assert!(!pattern_matches_tool(&p, "fs_write_file", &json!({})));

        // Exact nu (sans wildcard) — séquence exacte requise.
        let p = parse_pattern("npm run build").unwrap();
        assert!(pattern_matches_tool(
            &p,
            "run_command",
            &cmd("npm run build")
        ));
        assert!(!pattern_matches_tool(
            &p,
            "run_command",
            &cmd("npm run build --watch")
        ));

        // run_command(...) — le glob s'applique à la ligne entière.
        let p = parse_pattern("run_command(git diff:*)").unwrap();
        assert!(pattern_matches_tool(
            &p,
            "run_command",
            &cmd("git diff:cached")
        ));
        assert!(pattern_matches_tool(
            &p,
            "run_command",
            &cmd("git diff:cached --stat")
        ));
        assert!(!pattern_matches_tool(&p, "run_command", &cmd("git diff")));

        // web_fetch(domain:) — hôte exact ET sous-domaines.
        let p = parse_pattern("web_fetch(domain:example.com)").unwrap();
        for url in [
            "https://example.com/a",
            "https://api.example.com/x?y=1",
            "http://deep.api.example.com",
        ] {
            assert!(
                pattern_matches_tool(&p, "web_fetch", &json!({"url": url})),
                "{url}"
            );
        }
        assert!(!pattern_matches_tool(
            &p,
            "web_fetch",
            &json!({"url": "https://notexample.com"})
        ));
        assert!(!pattern_matches_tool(
            &p,
            "web_fetch",
            &json!({"url": "https://example.com.evil.io"})
        ));
        assert!(!pattern_matches_tool(
            &p,
            "run_command",
            &cmd("curl https://example.com")
        ));

        // web_fetch(glob d'URL).
        let p = parse_pattern("web_fetch(https://example.com/docs/*)").unwrap();
        assert!(pattern_matches_tool(
            &p,
            "web_fetch",
            &json!({"url": "https://example.com/docs/a/b"})
        ));
        assert!(!pattern_matches_tool(
            &p,
            "web_fetch",
            &json!({"url": "https://example.com/other"})
        ));

        // fs_write_file(path:...) — glob de chemin (séparateurs normalisés).
        let p = parse_pattern("fs_write_file(path:src/secrets/*)").unwrap();
        assert!(pattern_matches_tool(
            &p,
            "fs_write_file",
            &json!({"path": "src/secrets/key.pem"})
        ));
        assert!(pattern_matches_tool(
            &p,
            "fs_write_file",
            &json!({"path": "src\\secrets\\key.pem"})
        ));
        assert!(!pattern_matches_tool(
            &p,
            "fs_write_file",
            &json!({"path": "src/main.ts"})
        ));
        assert!(
            !pattern_matches_tool(
                &p,
                "fs_write_file",
                &json!({"path": "src/secrets/../public.txt"})
            ),
            "le matching porte sur le chemin lexical normalisé"
        );
        assert!(
            parse_pattern("fs_write_file(path:src/../../*)").is_none(),
            "un motif qui remonte hors du workspace est invalide"
        );
        assert!(!pattern_matches_tool(
            &p,
            "run_command",
            &json!({"command": "cat src/secrets/key.pem"})
        ));
        let p = parse_pattern("fs_edit(path:Cargo.toml)").unwrap();
        assert!(pattern_matches_tool(
            &p,
            "fs_edit",
            &json!({"path": "Cargo.toml"})
        ));
        assert!(!pattern_matches_tool(
            &p,
            "fs_edit",
            &json!({"path": "src/Cargo.toml"})
        ));

        // mcp__<serveur>__<outil> exact + <serveur>__*.
        let p = parse_pattern("mcp__github__create_issue").unwrap();
        assert!(pattern_matches_tool(
            &p,
            "mcp__github__create_issue",
            &json!({})
        ));
        assert!(!pattern_matches_tool(
            &p,
            "mcp__github__delete_repo",
            &json!({})
        ));
        let p = parse_pattern("mcp__github__*").unwrap();
        assert!(pattern_matches_tool(
            &p,
            "mcp__github__create_issue",
            &json!({})
        ));
        assert!(pattern_matches_tool(
            &p,
            "mcp__github__delete_repo",
            &json!({})
        ));
        assert!(!pattern_matches_tool(&p, "mcp__fs__read", &json!({})));

        // Motifs invalides → jamais de match (fail-safe).
        assert!(parse_pattern("run_command()").is_none());
        assert!(parse_pattern("web_fetch(domain:)").is_none());
        assert!(parse_pattern("mcp____*").is_none());
        assert!(parse_pattern("").is_none());
    }

    #[test]
    fn precedence_deny_over_ask_over_allow_over_static() {
        let rules = vec![
            rule("git *", Decision::Allow, ""),
            rule("git push *", Decision::Ask, ""),
            rule("git push --force *", Decision::Deny, ""),
        ];
        let out = resolve(
            "run_command",
            &cmd("git push --force origin main"),
            &rules,
            "ws",
        );
        assert!(
            matches!(out, Outcome::Deny { .. }),
            "deny gagne sur ask et allow"
        );

        let out = resolve("run_command", &cmd("git push origin main"), &rules, "ws");
        assert!(matches!(out, Outcome::Ask { .. }), "ask gagne sur allow");

        let out = resolve("run_command", &cmd("git status"), &rules, "ws");
        assert!(matches!(out, Outcome::Allow { .. }), "allow seul");

        let out = resolve("run_command", &cmd("cargo test"), &rules, "ws");
        assert_eq!(
            out,
            Outcome::NoRule,
            "rien ne matche → classifieur statique"
        );
    }

    #[test]
    fn specificity_longest_pattern_wins_within_same_list() {
        let rules = vec![
            rule("git *", Decision::Deny, ""),
            rule("git push --force-with-lease *", Decision::Ask, ""),
        ];
        let out = resolve(
            "run_command",
            &cmd("git push --force-with-lease origin main"),
            &rules,
            "ws",
        );
        assert!(
            matches!(out, Outcome::Deny { .. }),
            "deny gagne toujours sur ask"
        );
        // DANS la même liste (deux deny), le motif le plus long est cité.
        let rules = vec![
            rule("git *", Decision::Deny, ""),
            rule("git push --force *", Decision::Deny, ""),
        ];
        match resolve(
            "run_command",
            &cmd("git push --force origin main"),
            &rules,
            "ws",
        ) {
            Outcome::Deny { pattern, .. } => {
                assert_eq!(
                    pattern, "git push --force *",
                    "le plus spécifique gagne à liste égale"
                );
            }
            other => panic!("attendu Deny, reçu {other:?}"),
        }
    }

    #[test]
    fn project_scope_wins_at_equal_specificity_and_scoping_is_enforced() {
        let rules = vec![
            rule("git push *", Decision::Deny, ""),
            rule("git push *", Decision::Allow, "C:/proj"),
        ];
        let out = resolve(
            "run_command",
            &cmd("git push origin main"),
            &rules,
            "C:/proj",
        );
        assert!(
            matches!(out, Outcome::Deny { .. }),
            "deny global gagne même contre allow projet"
        );
        // Hors scope projet : la règle projet est ignorée, le deny global s'applique.
        let rules = vec![
            rule("cargo *", Decision::Deny, ""),
            rule("cargo *", Decision::Allow, "C:/proj"),
        ];
        let out = resolve("run_command", &cmd("cargo test"), &rules, "C:/autre");
        assert!(
            matches!(out, Outcome::Deny { .. }),
            "hors scope, le projet est ignoré"
        );
        // À DÉCISION ÉGALE (deux allows, même motif) : le projet gagne.
        let rules = vec![
            rule("cargo *", Decision::Allow, ""),
            rule("cargo *", Decision::Allow, "C:/proj"),
        ];
        match resolve("run_command", &cmd("cargo test"), &rules, "C:/proj") {
            Outcome::Allow { pattern } => {
                assert_eq!(pattern, "cargo *");
            }
            other => panic!("attendu Allow, reçu {other:?}"),
        }
    }

    #[test]
    fn permission_answer_is_scoped_to_continuation_and_single_use() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_interactions (
                interaction_id TEXT PRIMARY KEY,
                response TEXT, verdict TEXT, created_at INTEGER NOT NULL, answered_at INTEGER,
                continuation_agent_id TEXT, permission_consumed_at INTEGER
            );",
        )
        .unwrap();
        let hash = call_signature("run_command", &cmd("git push --force"));
        assert_eq!(
            take_answered_permission_on_conn(&conn, &hash, "continuation-1", 10).unwrap(),
            None
        );

        // Approuvé une fois (carte frontend : réponse préfixée AUTORISÉ).
        conn.execute(
            "INSERT INTO agent_interactions
                (interaction_id, response, created_at, answered_at, continuation_agent_id)
             VALUES (?1, 'AUTORISÉ par l''utilisateur : exécute', 1, 2, 'continuation-1')",
            params![format!("run-1:perm-{hash}")],
        )
        .unwrap();
        assert_eq!(
            take_answered_permission_on_conn(&conn, &hash, "other-run", 11).unwrap(),
            None,
            "un autre run ne peut pas reprendre cette autorisation"
        );
        assert_eq!(
            take_answered_permission_on_conn(&conn, &hash, "continuation-1", 12).unwrap(),
            Some(true)
        );
        assert_eq!(
            take_answered_permission_on_conn(&conn, &hash, "continuation-1", 13).unwrap(),
            None,
            "le verdict est consommé exactement une fois"
        );

        // Un AUTRE appel (autre signature) n'a pas de verdict.
        let other = call_signature("run_command", &cmd("git push"));
        assert_eq!(
            take_answered_permission_on_conn(&conn, &other, "continuation-1", 14).unwrap(),
            None
        );

        // Refusé une fois.
        let h2 = call_signature("web_fetch", &json!({"url": "https://example.com"}));
        conn.execute(
            "INSERT INTO agent_interactions
                (interaction_id, response, created_at, answered_at, continuation_agent_id)
             VALUES (?1, 'REFUSÉ par l''utilisateur : n''exécute pas', 1, 2, 'continuation-1')",
            params![format!("run-1:perm-{h2}")],
        )
        .unwrap();
        assert_eq!(
            take_answered_permission_on_conn(&conn, &h2, "continuation-1", 15).unwrap(),
            Some(false)
        );

        // Une réponse vide/inconnue n'est jamais une autorisation implicite.
        let h3 = call_signature("fs_write_file", &json!({"path": "src/a.ts"}));
        conn.execute(
            "INSERT INTO agent_interactions
                (interaction_id, response, created_at, answered_at, continuation_agent_id)
             VALUES (?1, '', 1, 2, 'continuation-1')",
            params![format!("run-1:perm-{h3}")],
        )
        .unwrap();
        assert_eq!(
            take_answered_permission_on_conn(&conn, &h3, "continuation-1", 16).unwrap(),
            Some(false),
            "fail-closed si le contrat de réponse est illisible"
        );
    }

    #[test]
    fn call_signature_is_stable_and_arg_sensitive() {
        let a = call_signature("run_command", &cmd("git push"));
        assert_eq!(a, call_signature("run_command", &cmd("git push")));
        assert_ne!(a, call_signature("run_command", &cmd("git pull")));
        assert_ne!(a, call_signature("web_fetch", &cmd("git push")));
        assert_eq!(a.len(), 16);
    }
}

// ────────────────────────────────────────────────────────────────────────
// Orchestration pour le dispatch du runner (évaluation + pause HITL)
// ────────────────────────────────────────────────────────────────────────

/// Verdict de l'évaluation d'un appel d'outil avant exécution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolPermission {
    /// Exécuter (règle allow, verdict approuvé antérieur, ou aucune règle).
    Proceed,
    /// ToolResult d'erreur, rien d'exécuté (règle deny ou refus HITL antérieur).
    Blocked(String),
    /// Pause HITL : poser la question (carte) et terminer le tour.
    Ask { pattern: String },
}

/// Évalue un appel d'outil contre les règles (pur + lookup du verdict durable
/// « une fois » dans `agent_interactions`). Appelé par le dispatch du runner
/// pour les profils MUTANTS uniquement (en lecture seule, les outils mutants
/// sont déjà refusés plus haut — `ask` n'y change rien).
pub(crate) fn evaluate_tool_call(
    app: &tauri::AppHandle,
    agent_id: &str,
    tool: &str,
    args: &serde_json::Value,
    rules: &[PermissionRule],
    current_scope: &str,
    consume_once: bool,
) -> Result<ToolPermission, String> {
    match resolve(tool, args, rules, current_scope) {
        Outcome::NoRule | Outcome::Allow { .. } => Ok(ToolPermission::Proceed),
        Outcome::Deny { reason, .. } => Ok(ToolPermission::Blocked(reason)),
        Outcome::Ask { pattern } => {
            let hash = call_signature(tool, args);
            let conn_mutex = super::get_conn(app)?;
            let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
            let answered = if consume_once {
                take_answered_permission_on_conn(&conn, &hash, agent_id, super::now_ms())?
            } else {
                answered_permission_for_continuation_on_conn(&conn, &hash, agent_id)?
                    .map(|(_, allowed)| allowed)
            };
            match answered {
                Some(true) => Ok(ToolPermission::Proceed),
                Some(false) => Ok(ToolPermission::Blocked(
                    "refusé par l'utilisateur lors d'une demande précédente".to_string(),
                )),
                None => Ok(ToolPermission::Ask { pattern }),
            }
        }
    }
}

/// Construit la pause HITL d'une règle `ask` : enregistre l'interaction
/// (idempotence, pipeline existant), émet la carte `QuestionAsked` (avec le
/// marqueur `permissionAsk` lu par PermissionAskCard côté frontend) et
/// renvoie le ToolResult sentinelle qui termine proprement le tour — le
/// modèle ne voit PAS l'appel comme exécuté, il est relancé avec la réponse.
pub(crate) fn pause_for_permission_ask(
    app: &tauri::AppHandle,
    agent_id: &str,
    call: &super::tools::ToolCall,
    args: &serde_json::Value,
    pattern: &str,
) -> super::tools::ToolResult {
    let hash = call_signature(&call.name, args);
    let tool_call_id = format!("perm-{hash}");
    let args_summary = summarize_args(&call.name, args);
    let question =
        format!("Autoriser « {args_summary} » ? (règle « {pattern} » demande confirmation)");
    let questions = serde_json::json!({
        "permissionAsk": true,
        "tool": call.name,
        "pattern": pattern,
        "argsSummary": args_summary,
        "questions": [{
            "id": "perm",
            "question": question,
            "options": [
                {"label": "Autoriser", "description": "Exécute cette fois uniquement"},
                {"label": "Refuser", "description": "N'exécute pas cette fois"},
                {"label": "Toujours autoriser", "description": "Écrit une règle « allow » pour ce motif"},
                {"label": "Toujours refuser", "description": "Écrit une règle « deny » pour ce motif"},
            ],
        }],
    });
    if let Err(e) =
        super::tools::register_hitl_interaction(app, agent_id, &tool_call_id, "permission_ask")
    {
        return super::tools::ToolResult {
            id: call.id.clone(),
            name: call.name.clone(),
            is_error: true,
            content: e,
        };
    }
    let _ = super::persist_and_emit(
        app,
        &super::AgentEvent::QuestionAsked {
            agent_id: agent_id.to_string(),
            tool_call_id: tool_call_id,
            questions,
        },
    );
    super::tools::ToolResult {
        id: call.id.clone(),
        name: call.name.clone(),
        is_error: false,
        content: format!(
            "{}:permission_ask — confirmation utilisateur requise par la règle « {pattern} ». \
             Ton tour se termine ici ; tu seras relancé avec sa décision.",
            super::tools::AGENT_PAUSE_SENTINEL
        ),
    }
}

/// Résumé lisible de l'appel pour la carte (borné, honnête).
fn summarize_args(tool: &str, args: &serde_json::Value) -> String {
    let raw = match tool {
        "run_command" => args["command"].as_str().unwrap_or("").to_string(),
        "web_fetch" => args["url"].as_str().unwrap_or("").to_string(),
        _ => args.to_string(),
    };
    let trimmed = raw.trim();
    if trimmed.chars().count() > 160 {
        format!("{}…", trimmed.chars().take(160).collect::<String>())
    } else {
        trimmed.to_string()
    }
}
