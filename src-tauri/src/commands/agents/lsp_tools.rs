//! Outils LSP pour les agents (P6.12) : `lsp_diagnostics`, `lsp_definition`,
//! `lsp_references` — effet LECTURE (Auto-safe, shared_read), confinement
//! workspace identique à `fs_read_file` (`fs::safe_resolve`), résultats
//! bornés (jamais de succès vide fabriqué : langue inconnue, serveur absent,
//! crash ou timeout = erreur honnête et la boucle continue).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;
use tauri::AppHandle;

use crate::commands::{fs as cmd_fs, lsp as cmd_lsp};

/// Bornes de sortie (budget contexte du modèle).
const MAX_DIAGNOSTICS: usize = 50;
const MAX_LOCATIONS: usize = 50;
const MAX_FILE_CHARS: usize = 256 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(12);

/// langId LSP depuis l'extension du fichier (même mapping que `resolve_lsp_binary`
/// côté bridge — les inconnues retournent None : résultat honnête, pas d'invention).
pub(crate) fn lang_id_for_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("ts" | "tsx" | "mts" | "cts") => Some("typescript"),
        Some("js" | "jsx" | "mjs" | "cjs") => Some("javascript"),
        Some("rs") => Some("rust"),
        Some("py" | "pyi") => Some("python"),
        Some("go") => Some("go"),
        Some("c" | "h") => Some("c"),
        Some("cpp" | "cc" | "cxx" | "c++" | "hpp" | "hh" | "hxx") => Some("cpp"),
        Some("java") => Some("java"),
        _ => None,
    }
}

/// Résout le fichier côté workspace (confinement fs) + le langId LSP, ou une
/// erreur honnête (« pas de serveur LSP pour ce langage »).
fn resolve_target(root: &Path, rel: &str) -> Result<(PathBuf, &'static str), String> {
    let resolved = cmd_fs::safe_resolve(root, rel)?;
    let lang = lang_id_for_path(&resolved).ok_or_else(|| {
        format!(
            "pas de serveur LSP pour ce langage (extension inconnue de « {rel} » — \
             supportés : ts/js/rs/py/go/c/cpp/java)"
        )
    })?;
    Ok((resolved, lang))
}

fn file_uri(path: &Path) -> String {
    cmd_lsp::file_uri_for(path)
}

/// Emplacement LSP (Location | LocationLink) → "path:ligne:col" lisible.
fn format_location(loc: &serde_json::Value) -> Option<String> {
    let (uri, range) = if loc["uri"].is_string() {
        (loc["uri"].as_str()?, &loc["range"])
    } else if loc["targetUri"].is_string() {
        (loc["targetUri"].as_str()?, &loc["targetSelectionRange"])
    } else {
        return None;
    };
    let line = range["start"]["line"].as_u64()? + 1;
    let character = range["start"]["character"].as_u64()? + 1;
    Some(format!("{}:{}:{}", uri_display(uri), line, character))
}

/// Affichage compact d'une URI (décodée ; préfixe file:/// retiré).
fn uri_display(uri: &str) -> String {
    let stripped = uri.strip_prefix("file:///").unwrap_or(uri);
    percent_encoding::percent_decode_str(stripped)
        .decode_utf8()
        .map(|s| s.to_string())
        .unwrap_or_else(|_| stripped.to_string())
}

fn bounded_locations(value: &serde_json::Value, what: &str) -> String {
    let locations: Vec<String> = match &value["result"] {
        serde_json::Value::Null => Vec::new(),
        one @ serde_json::Value::Object(_) => format_location(one).into_iter().collect(),
        serde_json::Value::Array(items) => items.iter().filter_map(format_location).collect(),
        _ => Vec::new(),
    };
    if locations.is_empty() {
        return format!("aucun emplacement trouvé pour {what}");
    }
    let total = locations.len();
    let shown: Vec<&String> = locations.iter().take(MAX_LOCATIONS).collect();
    let mut out = format!("{total} emplacement(s) pour {what} :\n");
    for l in &shown {
        out.push_str(&format!("- {l}\n"));
    }
    if total > MAX_LOCATIONS {
        out.push_str(&format!("(tronqué à {MAX_LOCATIONS})\n"));
    }
    out
}

/// `lsp_diagnostics(path)` — diagnostics (erreurs/warnings) du fichier.
pub(crate) async fn lsp_diagnostics_tool(
    app: &AppHandle,
    ws_root: &Path,
    rel: &str,
) -> Result<String, String> {
    let (resolved, lang) = resolve_target(ws_root, rel)?;
    let text = cmd_fs::read_file_inner(ws_root, rel, Some(MAX_FILE_CHARS))?;
    let uri = file_uri(&resolved);
    let diagnostics =
        cmd_lsp::agent_lsp_diagnostics(app, lang, &uri, &text, lang, DIAGNOSTICS_TIMEOUT).await?;
    if diagnostics.is_empty() {
        return Ok(format!(
            "[lsp {lang}] aucun diagnostic pour {rel} (le serveur a répondu — fichier sain)"
        ));
    }
    let total = diagnostics.len();
    let mut out = format!("[lsp {lang}] {total} diagnostic(s) pour {rel} :\n");
    for d in diagnostics.iter().take(MAX_DIAGNOSTICS) {
        let severity = match d["severity"].as_u64() {
            Some(1) => "erreur",
            Some(2) => "avertissement",
            Some(3) => "info",
            Some(4) => "hint",
            _ => "info",
        };
        let line = d["range"]["start"]["line"].as_u64().unwrap_or(0) + 1;
        let col = d["range"]["start"]["character"].as_u64().unwrap_or(0) + 1;
        let code = d["code"]
            .as_str()
            .map(str::to_string)
            .or_else(|| d["code"].as_i64().map(|c| c.to_string()))
            .map(|c| format!(" ({c})"))
            .unwrap_or_default();
        let message = d["message"].as_str().unwrap_or("").replace('\n', " ");
        let source = d["source"].as_str().unwrap_or("");
        let source = if source.is_empty() {
            String::new()
        } else {
            format!(" [{source}]")
        };
        out.push_str(&format!(
            "- [{severity}] ligne {line}, col {col} : {message}{code}{source}\n"
        ));
    }
    if total > MAX_DIAGNOSTICS {
        out.push_str(&format!("(tronqué à {MAX_DIAGNOSTICS})\n"));
    }
    Ok(out)
}

/// `lsp_definition(path, line, character)` — emplacement(s) de définition
/// (coordonnées LSP 0-based, documentées dans le manifest).
pub(crate) async fn lsp_definition_tool(
    app: &AppHandle,
    ws_root: &Path,
    rel: &str,
    line: u64,
    character: u64,
) -> Result<String, String> {
    let (resolved, lang) = resolve_target(ws_root, rel)?;
    // Le document doit être ouvert pour que la définition resolve — même
    // confinement de lecture que fs_read_file.
    let text = cmd_fs::read_file_inner(ws_root, rel, Some(MAX_FILE_CHARS))?;
    let uri = file_uri(&resolved);
    open_document_if_needed(app, lang, &uri, &text, lang).await?;
    let resp = cmd_lsp::agent_lsp_request(
        app,
        lang,
        "textDocument/definition",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
        }),
        REQUEST_TIMEOUT,
    )
    .await?;
    if resp["error"].is_object() {
        return Err(format!(
            "definition LSP refusée : {}",
            resp["error"]["message"]
        ));
    }
    Ok(bounded_locations(
        &resp,
        &format!("définition de {rel}:{line}:{character}"),
    ))
}

/// `lsp_references(path, line, character)` — emplacements des références.
pub(crate) async fn lsp_references_tool(
    app: &AppHandle,
    ws_root: &Path,
    rel: &str,
    line: u64,
    character: u64,
) -> Result<String, String> {
    let (resolved, lang) = resolve_target(ws_root, rel)?;
    let text = cmd_fs::read_file_inner(ws_root, rel, Some(MAX_FILE_CHARS))?;
    let uri = file_uri(&resolved);
    open_document_if_needed(app, lang, &uri, &text, lang).await?;
    let resp = cmd_lsp::agent_lsp_request(
        app,
        lang,
        "textDocument/references",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": line, "character": character },
            "context": { "includeDeclaration": true },
        }),
        REQUEST_TIMEOUT,
    )
    .await?;
    if resp["error"].is_object() {
        return Err(format!(
            "references LSP refusées : {}",
            resp["error"]["message"]
        ));
    }
    Ok(bounded_locations(
        &resp,
        &format!("références de {rel}:{line}:{character}"),
    ))
}

/// Ouvre ou synchronise le document dans la session — le bridge envoie
/// `didOpen` une fois puis `didChange` avec une version croissante.
async fn open_document_if_needed(
    app: &AppHandle,
    lang: &str,
    uri: &str,
    text: &str,
    language: &str,
) -> Result<(), String> {
    cmd_lsp::agent_lsp_open_document(app, lang, uri, text, language).await
}
