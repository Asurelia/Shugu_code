//! Lane OPÉRABILITÉ — Diagnostics Center : bundle de diagnostic REDACTÉ.
//!
//! Module autonome. Agrège un instantané de l'état système/config de Shugu dans
//! un texte copiable (pour coller dans un rapport de bug / un ticket), en
//! **redactant systématiquement les secrets**. Aucune mutation d'état existant.
//!
//! ## Pourquoi la redaction est centrale
//!
//! Un bundle de diagnostic est destiné à être PARTAGÉ (collé dans un chat, un
//! issue GitHub…). Il ne doit JAMAIS contenir de secret. Trois vecteurs de
//! fuite sont neutralisés ici :
//!   1. La table `settings` peut contenir des valeurs sensibles (base_url avec
//!      token en query, etc.) → toute valeur dont la CLÉ est secrète, ou dont la
//!      VALEUR ressemble à un secret/URL avec credentials, est masquée.
//!   2. Les états de sous-systèmes que le front passe (`subsystems_json`) :
//!      providers/MCP/LSP peuvent embarquer des `env` (tokens), des URL avec
//!      `user:pass@`, des Bearer… → on parcourt récursivement le JSON et on
//!      masque par clé ET par motif de valeur.
//!   3. Les chemins absolus contiennent le nom d'utilisateur OS → on remplace le
//!      home dir par `~` pour ne pas divulguer l'identité.
//!
//! La fonction de redaction est PUBLIQUE et testée unitairement (c'est la pièce
//! qu'il ne faut surtout pas casser).

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{command, AppHandle, Manager};

// Réutilise la détection de clé secrète déjà éprouvée côté MCP (segments
// TOKEN/SECRET/KEY/PAT/AUTH…). Source unique de vérité — pas de divergence.
use super::mcp_sources::is_secret_env_key;

// ---------------------------------------------------------------------------
// Constante de remplacement
// ---------------------------------------------------------------------------

const REDACTED: &str = "«redacted»";

// ---------------------------------------------------------------------------
// Modèle
// ---------------------------------------------------------------------------

/// Un fait système (paire clé→valeur) pour l'en-tête du bundle.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagFact {
    pub label: String,
    pub value: String,
}

/// Le bundle de diagnostic complet, prêt pour l'UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagBundle {
    /// Texte final copiable (Markdown) — déjà redacté. C'est ce que le bouton
    /// « Copier » met dans le presse-papier.
    pub text: String,
    /// Faits système structurés (pour un rendu UI riche, en plus du texte).
    pub facts: Vec<DiagFact>,
    /// La table `settings` redactée (clé → valeur masquée si secrète).
    pub settings: BTreeMap<String, String>,
    /// Nombre de valeurs `settings` qui ont été masquées.
    pub redacted_count: usize,
    /// Horodatage de génération, unix millis.
    pub generated_at: i64,
}

// ---------------------------------------------------------------------------
// Helpers chemins / temps
// ---------------------------------------------------------------------------

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Strip du préfixe Windows extended-length (`\\?\`) : helper CENTRAL
// (ex-copie locale migrée).
use super::pathutil::strip_extended_prefix;

fn norm(p: &Path) -> String {
    strip_extended_prefix(p.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

/// Remplace le home dir de l'utilisateur par `~` dans un chemin/texte, pour ne
/// pas divulguer le nom d'utilisateur OS. Comparaison insensible à la casse sur
/// Windows ; on normalise les backslashes au préalable.
fn anonymize_home(text: &str, home: Option<&str>) -> String {
    let Some(home) = home else {
        return text.to_string();
    };
    let home_n = home.replace('\\', "/");
    if home_n.is_empty() {
        return text.to_string();
    }
    let text_n = text.replace('\\', "/");
    if cfg!(windows) {
        // Remplacement insensible à la casse, manuel (pas de regex).
        let hay = text_n.to_lowercase();
        let needle = home_n.to_lowercase();
        if let Some(idx) = hay.find(&needle) {
            let mut out = String::with_capacity(text_n.len());
            out.push_str(&text_n[..idx]);
            out.push('~');
            out.push_str(&text_n[idx + home_n.len()..]);
            return out;
        }
        text_n
    } else {
        text_n.replace(&home_n, "~")
    }
}

// ---------------------------------------------------------------------------
// Redaction — cœur sécurité
// ---------------------------------------------------------------------------

/// Une VALEUR ressemble-t-elle à un secret indépendamment de sa clé ?
/// Heuristique conservatrice (vise les faux négatifs faibles sans masquer tout) :
///   - URL avec credentials inline `scheme://user:pass@host` ;
///   - jeton de type `Bearer <…>` ;
///   - préfixes de clés d'API connus (sk-, ghp_, gho_, xoxb-, AIza, etc.) ;
///   - longue chaîne « token-like » (≥ 24 car., alnum/_-/. sans espace).
pub fn value_looks_secret(value: &str) -> bool {
    let v = value.trim();
    if v.is_empty() {
        return false;
    }
    // URL avec user:pass@
    if let Some(rest) = v
        .split_once("://")
        .map(|(_, r)| r)
    {
        if let Some((authority, _)) = rest.split_once('/') {
            if authority.contains('@') && authority.contains(':') {
                return true;
            }
        } else if rest.contains('@') && rest.contains(':') {
            return true;
        }
    }
    let lower = v.to_ascii_lowercase();
    if lower.starts_with("bearer ") || lower.starts_with("basic ") {
        return true;
    }
    const KNOWN_PREFIXES: [&str; 9] = [
        "sk-", "sk_", "ghp_", "gho_", "ghs_", "xoxb-", "xoxp-", "aiza", "pk-",
    ];
    if KNOWN_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    // Longue chaîne token-like, sans espace, charset clé.
    if v.len() >= 24
        && !v.contains(' ')
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '+' | '/' | '='))
    {
        // Évite de masquer un simple chemin/host : exiger un minimum d'entropie
        // (au moins un chiffre ET une lettre).
        let has_digit = v.chars().any(|c| c.is_ascii_digit());
        let has_alpha = v.chars().any(|c| c.is_ascii_alphabetic());
        if has_digit && has_alpha {
            return true;
        }
    }
    false
}

/// Faut-il masquer cette paire (clé, valeur) ? Masqué si la clé est secrète
/// (réutilise `is_secret_env_key`) OU si la valeur ressemble à un secret.
pub fn should_redact(key: &str, value: &str) -> bool {
    is_secret_env_key(key) || value_looks_secret(value)
}

/// Redacte récursivement une valeur JSON IN PLACE : toute string sous une clé
/// secrète, ou toute string qui ressemble à un secret, devient `REDACTED`. Les
/// clés `env`/`environment`/`headers` sont traitées comme des maps de secrets
/// potentiels (chaque entrée évaluée par `should_redact`). Renvoie le nombre de
/// masquages effectués.
pub fn redact_json(value: &mut Value) -> usize {
    redact_json_inner(value, None)
}

fn redact_json_inner(value: &mut Value, key_context: Option<&str>) -> usize {
    let mut count = 0;
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                match v {
                    Value::String(s) => {
                        if should_redact(k, s) {
                            *s = REDACTED.to_string();
                            count += 1;
                        }
                    }
                    other => {
                        count += redact_json_inner(other, Some(k));
                    }
                }
            }
        }
        Value::Array(arr) => {
            for v in arr.iter_mut() {
                // Une string nue dans un array hérite du contexte de clé parent
                // (ex: une liste d'args contenant un token sous une clé "env").
                match v {
                    Value::String(s) => {
                        if let Some(k) = key_context {
                            if should_redact(k, s) {
                                *s = REDACTED.to_string();
                                count += 1;
                                continue;
                            }
                        }
                        if value_looks_secret(s) {
                            *s = REDACTED.to_string();
                            count += 1;
                        }
                    }
                    other => count += redact_json_inner(other, key_context),
                }
            }
        }
        _ => {}
    }
    count
}

// ---------------------------------------------------------------------------
// Lecture de la table settings (redactée)
// ---------------------------------------------------------------------------

/// Lit la table `settings` de `shugu.db` et renvoie (map redactée, nb masqués).
fn read_settings_redacted(db: &Path) -> (BTreeMap<String, String>, usize) {
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    let mut redacted = 0usize;
    let Ok(conn) = Connection::open(db) else {
        return (out, redacted);
    };
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return (out, redacted);
    }
    let Ok(mut stmt) = conn.prepare("SELECT key, value FROM settings ORDER BY key") else {
        return (out, redacted);
    };
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    });
    if let Ok(rows) = rows {
        for r in rows.flatten() {
            let (k, v) = r;
            if should_redact(&k, &v) {
                out.insert(k, REDACTED.to_string());
                redacted += 1;
            } else {
                out.insert(k, v);
            }
        }
    }
    (out, redacted)
}

/// Compte les lignes d'une table (best-effort, 0 si absente).
fn count_rows(conn: &Connection, table: &str) -> i64 {
    // `table` est une constante interne (jamais user-supplied) — pas d'injection.
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Commande
// ---------------------------------------------------------------------------

/// Génère le bundle de diagnostic redacté.
///
/// `subsystems_json` : un JSON (string) produit par le front agrégeant l'état
/// des sous-systèmes (providers, MCP, LSP, llama, agents…) tel que l'UI le
/// connaît déjà via ses queries. Il est parsé, REDACTÉ récursivement, puis
/// pretty-printé dans le bundle. `None`/vide → section omise.
#[command(rename_all = "camelCase")]
pub async fn shugu_diag_bundle(
    app: AppHandle,
    subsystems_json: Option<String>,
) -> Result<DiagBundle, String> {
    let home = app
        .path()
        .home_dir()
        .ok()
        .map(|p| norm(&p));
    let home_ref = home.as_deref();

    // --- Faits système ---
    let pkg = app.package_info();
    let mut facts: Vec<DiagFact> = Vec::new();
    facts.push(DiagFact {
        label: "App".to_string(),
        value: format!("{} v{}", pkg.name, pkg.version),
    });
    facts.push(DiagFact {
        label: "OS".to_string(),
        value: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
    });
    facts.push(DiagFact {
        label: "Tauri".to_string(),
        value: tauri::VERSION.to_string(),
    });
    if let Ok(cfg) = app.path().app_config_dir() {
        facts.push(DiagFact {
            label: "Config dir".to_string(),
            value: anonymize_home(&norm(&cfg), home_ref),
        });
    }

    // --- Base : présence, taille, version de schéma, comptes ---
    let db = super::backup::live_db_path(&app)?;
    let mut db_facts: Vec<String> = Vec::new();
    if db.exists() {
        let bytes = std::fs::metadata(&db).map(|m| m.len()).unwrap_or(0);
        db_facts.push(format!("- fichier : présent ({bytes} octets)"));
        if let Ok(conn) = Connection::open(&db) {
            let sv: Option<i64> = conn
                .query_row("SELECT MAX(version) FROM _sqlx_migrations", [], |r| r.get(0))
                .ok()
                .flatten();
            db_facts.push(format!(
                "- version de schéma : {}",
                sv.map(|v| v.to_string()).unwrap_or_else(|| "?".into())
            ));
            for t in ["conversations", "messages", "agents", "agent_skills"] {
                db_facts.push(format!("- {t} : {} lignes", count_rows(&conn, t)));
            }
        }
        // Intégrité (réutilise le check du module backup pour cohérence).
        match crate::commands::backup::integrity_summary(&db) {
            Ok(ok) => db_facts.push(format!(
                "- integrity_check : {}",
                if ok { "ok" } else { "ÉCHEC" }
            )),
            Err(e) => db_facts.push(format!("- integrity_check : erreur ({e})")),
        }
    } else {
        db_facts.push("- fichier : ABSENT (installation fraîche ?)".to_string());
    }

    // --- Settings redactés ---
    let (settings, redacted_count) = read_settings_redacted(&db);

    // --- Sous-systèmes (JSON front) redactés ---
    let subsystems_section: Option<String> = match subsystems_json
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => {
            let mut parsed: Value =
                serde_json::from_str(raw).map_err(|e| format!("subsystems JSON invalide : {e}"))?;
            redact_json(&mut parsed);
            let pretty = serde_json::to_string_pretty(&parsed)
                .map_err(|e| format!("encode subsystems : {e}"))?;
            // Anonymiser les chemins absolus restants (cwd, binaires…).
            Some(anonymize_home(&pretty, home_ref))
        }
        None => None,
    };

    // --- Assemblage du texte Markdown ---
    let mut text = String::new();
    text.push_str("# Diagnostic Shugu Forge\n\n");
    text.push_str("> Bundle généré localement. Les secrets sont masqués (`«redacted»`).\n\n");
    text.push_str("## Système\n");
    for f in &facts {
        text.push_str(&format!("- **{}** : {}\n", f.label, anonymize_home(&f.value, home_ref)));
    }
    text.push_str("\n## Base de données\n");
    for line in &db_facts {
        text.push_str(line);
        text.push('\n');
    }
    text.push_str(&format!(
        "\n## Settings ({} entrées, {} masquées)\n",
        settings.len(),
        redacted_count
    ));
    for (k, v) in &settings {
        text.push_str(&format!("- `{k}` = {}\n", anonymize_home(v, home_ref)));
    }
    if let Some(sub) = &subsystems_section {
        text.push_str("\n## Sous-systèmes\n```json\n");
        text.push_str(sub);
        text.push_str("\n```\n");
    }
    text.push_str(&format!("\n_généré à {} (unix ms)_\n", now_millis()));

    Ok(DiagBundle {
        text,
        facts,
        settings,
        redacted_count,
        generated_at: now_millis(),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn value_secret_detection() {
        assert!(value_looks_secret("Bearer abc123def"));
        assert!(value_looks_secret("sk-proj-ABCdef1234567890ABCdef12"));
        assert!(value_looks_secret("ghp_0123456789abcdefABCDEF0123"));
        assert!(value_looks_secret("https://user:p4ss@host.com/path"));
        assert!(value_looks_secret("AIzaSyA1234567890_abcDEF-ghiJKL"));
        // Long token-like with entropy.
        assert!(value_looks_secret("a1b2c3d4e5f6g7h8i9j0k1l2m3n4"));
        // Non-secrets.
        assert!(!value_looks_secret("http://localhost:11434"));
        assert!(!value_looks_secret("C:/Dev/shugu"));
        assert!(!value_looks_secret("veil-dark"));
        assert!(!value_looks_secret(""));
        assert!(!value_looks_secret("a short string"));
    }

    #[test]
    fn should_redact_by_key_or_value() {
        // By key.
        assert!(should_redact("ANTHROPIC_API_KEY", "anything"));
        assert!(should_redact("github_token", "x"));
        // By value.
        assert!(should_redact("base_url", "https://u:p@h.co/x"));
        // Neither.
        assert!(!should_redact("base_url", "http://localhost:11434"));
        assert!(!should_redact("theme", "veil-dark"));
    }

    #[test]
    fn redact_json_masks_nested_secrets() {
        let mut v = json!({
            "providers": [
                { "id": "anthropic", "apiKey": "sk-ABCdef1234567890ABCDEF12", "baseUrl": "http://localhost" }
            ],
            "mcp": {
                "github": {
                    "command": "npx",
                    "env": { "GITHUB_TOKEN": "ghp_realtoken0123456789ABCDEF", "PORT": "3000" }
                }
            },
            "harmless": "veil-dark"
        });
        let n = redact_json(&mut v);
        // apiKey (by key) + GITHUB_TOKEN (by key) → at least 2. The baseUrl
        // localhost and PORT stay; harmless stays.
        assert!(n >= 2, "expected >=2 redactions, got {n}");
        assert_eq!(v["providers"][0]["apiKey"], REDACTED);
        assert_eq!(v["mcp"]["github"]["env"]["GITHUB_TOKEN"], REDACTED);
        assert_eq!(v["mcp"]["github"]["env"]["PORT"], "3000");
        assert_eq!(v["providers"][0]["baseUrl"], "http://localhost");
        assert_eq!(v["harmless"], "veil-dark");
    }

    #[test]
    fn redact_json_masks_array_of_secret_under_env_key() {
        // A token value inside an args array that itself looks secret is caught
        // by the value heuristic even without a key context.
        let mut v = json!({ "args": ["--token", "ghp_realtoken0123456789ABCDEF"] });
        let n = redact_json(&mut v);
        assert_eq!(n, 1);
        assert_eq!(v["args"][1], REDACTED);
        assert_eq!(v["args"][0], "--token");
    }

    #[test]
    fn anonymize_home_replaces_prefix() {
        let home = "C:/Users/jean";
        let got = anonymize_home("C:/Users/jean/AppData/Roaming/x", Some(home));
        assert_eq!(got, "~/AppData/Roaming/x");
        // No home → untouched (slash-normalized).
        assert_eq!(anonymize_home("C:\\x", None), "C:\\x");
    }
}
