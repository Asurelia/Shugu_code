//! Outils réseau de l'agent : recherche web hybride + récupération de page.
//!
//! ## `web_search` — cascade de moteurs (fiabilité d'abord)
//!
//! 1. **Brave Search API** si une clé est présente dans le keychain
//!    (`provider.brave.apiKey`) — recherche générale robuste, 2000 req/mois
//!    gratuites. Header `X-Subscription-Token`.
//! 2. **Tavily** sinon si `provider.tavily.apiKey` est présent — API optimisée
//!    LLM (renvoie aussi un extrait de contenu par résultat).
//! 3. **DuckDuckGo sans clé** sinon — best-effort : on tente `html.duckduckgo.com`
//!    puis on retombe sur `lite.duckduckgo.com` (HTML plus stable au parsing).
//!    Migré depuis `agents::runner` (déduplication — un seul moteur sans-clé).
//!
//! Si une API à clé échoue (quota, réseau), on **retombe** sur DuckDuckGo plutôt
//! que de rendre une erreur sèche : l'agent obtient quand même des résultats.
//!
//! ## `web_fetch` — lire une page entière
//!
//! Comble la lacune « web_search ne donne que des extraits ». GET de l'URL,
//! retrait de `<script>`/`<style>`, conversion HTML→texte, cap configurable
//! avec sentinelle de troncature. Accepte n'importe quelle URL http(s) — même
//! portée réseau que `run_command` (qui peut déjà `curl`), y compris localhost
//! (l'agent veut parfois lire son propre serveur de dev).
//!
//! ## Secrets
//!
//! Lecture directe du keychain OS (même store `shugu-forge` que
//! `commands::credentials`), convention de compte `provider.<id>.<field>` —
//! identique à ce que le front écrit via `setSecret`. Pas de clé en clair.

use std::time::Duration;

use regex::Regex;
use reqwest::header::USER_AGENT;

/// Même service keychain que `commands::credentials` (audit OS unifié).
const KEYRING_SERVICE: &str = "shugu-forge";

/// User-Agent navigateur — certains moteurs/serveurs renvoient une page vide ou
/// un 403 à un UA non-navigateur.
const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// Lit un secret du keychain OS. `account` suit la convention front
/// `provider.<id>.<field>` (ex. `provider.brave.apiKey`). Renvoie `None` si
/// absent, vide, ou sur toute erreur d'accès (dégrade vers le moteur suivant).
fn read_secret(account: &str) -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, account).ok()?;
    let pw = entry.get_password().ok()?;
    let trimmed = pw.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

// ────────────────────────────────────────────────────────────────────
// web_search — point d'entrée (cascade)
// ────────────────────────────────────────────────────────────────────

/// Recherche web hybride. Retourne `(texte, is_error)` — jamais une panique.
/// `max` est borné [1,20] par l'appelant côté outil ; on re-clamp par sécurité.
pub(crate) async fn web_search(
    client: &reqwest::Client,
    query: &str,
    max: usize,
) -> (String, bool) {
    let max = max.clamp(1, 20);

    if let Some(key) = read_secret("provider.brave.apiKey") {
        let (text, is_error) = brave_search(client, &key, query, max).await;
        if !is_error {
            return (text, false);
        }
        // L'API a échoué (quota/réseau) → repli sans clé, en gardant la cause.
        let (ddg, ddg_err) = ddg_search(client, query, max).await;
        return (format!("{text}\n\n— repli DuckDuckGo —\n{ddg}"), ddg_err);
    }

    if let Some(key) = read_secret("provider.tavily.apiKey") {
        let (text, is_error) = tavily_search(client, &key, query, max).await;
        if !is_error {
            return (text, false);
        }
        let (ddg, ddg_err) = ddg_search(client, query, max).await;
        return (format!("{text}\n\n— repli DuckDuckGo —\n{ddg}"), ddg_err);
    }

    ddg_search(client, query, max).await
}

// ────────────────────────────────────────────────────────────────────
// Brave Search API
// ────────────────────────────────────────────────────────────────────

async fn brave_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
    max: usize,
) -> (String, bool) {
    let count = max.to_string();
    let resp = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query), ("count", count.as_str())])
        .header("Accept", "application/json")
        .header("X-Subscription-Token", key)
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => return (format!("Brave Search: échec réseau ({e})."), true),
    };
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let hint = if code.as_u16() == 401 || code.as_u16() == 403 {
            " (clé Brave invalide ?)"
        } else if code.as_u16() == 429 {
            " (quota Brave dépassé)"
        } else {
            ""
        };
        let snippet: String = body.chars().take(200).collect();
        return (format!("Brave Search: HTTP {code}{hint}. {snippet}"), true);
    }
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return (format!("Brave Search: réponse illisible ({e})."), true),
    };
    let items: Vec<(String, String, String)> = json["web"]["results"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .take(max)
                .map(|r| {
                    (
                        r["title"].as_str().unwrap_or("").to_string(),
                        r["url"].as_str().unwrap_or("").to_string(),
                        r["description"].as_str().unwrap_or("").to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if items.is_empty() {
        return (
            format!("Brave Search: aucun résultat pour « {query} »."),
            false,
        );
    }
    (format_results(query, "Brave", &items), false)
}

// ────────────────────────────────────────────────────────────────────
// Tavily API (optimisée LLM)
// ────────────────────────────────────────────────────────────────────

async fn tavily_search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
    max: usize,
) -> (String, bool) {
    let body = serde_json::json!({
        "api_key": key,
        "query": query,
        "max_results": max,
        "search_depth": "basic",
    });
    let resp = client
        .post("https://api.tavily.com/search")
        .header("content-type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => return (format!("Tavily: échec réseau ({e})."), true),
    };
    if !resp.status().is_success() {
        let code = resp.status();
        let snippet: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        let hint = if code.as_u16() == 401 {
            " (clé Tavily invalide ?)"
        } else {
            ""
        };
        return (format!("Tavily: HTTP {code}{hint}. {snippet}"), true);
    }
    let json: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return (format!("Tavily: réponse illisible ({e})."), true),
    };
    let items: Vec<(String, String, String)> = json["results"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .take(max)
                .map(|r| {
                    (
                        r["title"].as_str().unwrap_or("").to_string(),
                        r["url"].as_str().unwrap_or("").to_string(),
                        r["content"].as_str().unwrap_or("").to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    // Tavily peut fournir une réponse synthétique directe.
    let answer = json["answer"].as_str().unwrap_or("").trim().to_string();
    if items.is_empty() && answer.is_empty() {
        return (format!("Tavily: aucun résultat pour « {query} »."), false);
    }
    let mut out = format_results(query, "Tavily", &items);
    if !answer.is_empty() {
        out = format!("Réponse Tavily: {answer}\n\n{out}");
    }
    (out, false)
}

// ────────────────────────────────────────────────────────────────────
// DuckDuckGo sans clé (best-effort, deux endpoints)
// ────────────────────────────────────────────────────────────────────

/// Tente `html.duckduckgo.com` puis `lite.duckduckgo.com`. Le second a un HTML
/// plus simple et plus stable au parsing — bon filet quand le premier change.
async fn ddg_search(client: &reqwest::Client, query: &str, max: usize) -> (String, bool) {
    // 1) endpoint HTML classique
    if let Some(items) = ddg_fetch_and_parse(
        client,
        "https://html.duckduckgo.com/html/",
        query,
        max,
        false,
    )
    .await
    {
        if !items.is_empty() {
            return (format_results(query, "DuckDuckGo", &items), false);
        }
    }
    // 2) repli endpoint lite
    if let Some(items) = ddg_fetch_and_parse(
        client,
        "https://lite.duckduckgo.com/lite/",
        query,
        max,
        true,
    )
    .await
    {
        if !items.is_empty() {
            return (format_results(query, "DuckDuckGo (lite)", &items), false);
        }
    }
    (
        format!(
            "web_search: aucun résultat pour « {query} » (DuckDuckGo a pu bloquer la requête ou \
             changer son HTML). Astuce : configure une clé Brave/Tavily dans Réglages → Connexions \
             pour une recherche fiable, ou récupère une URL précise avec web_fetch."
        ),
        false,
    )
}

/// GET + parse un endpoint DDG. `lite` choisit le parseur (table) vs HTML riche.
async fn ddg_fetch_and_parse(
    client: &reqwest::Client,
    url: &str,
    query: &str,
    max: usize,
    lite: bool,
) -> Option<Vec<(String, String, String)>> {
    let resp = client
        .get(url)
        .query(&[("q", query)])
        .header(USER_AGENT, BROWSER_UA)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    let html = resp.text().await.ok()?;
    Some(if lite {
        parse_ddg_lite(&html, max)
    } else {
        parse_ddg_html(&html, max)
    })
}

/// Parse `html.duckduckgo.com` : `result__a` (href+titre) + `result__snippet`.
fn parse_ddg_html(html: &str, max: usize) -> Vec<(String, String, String)> {
    let link_re =
        match Regex::new(r#"(?s)<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#) {
            Ok(re) => re,
            Err(_) => return Vec::new(),
        };
    let snippet_re = Regex::new(r#"(?s)<a[^>]*class="result__snippet"[^>]*>(.*?)</a>"#).ok();
    let snippets: Vec<String> = snippet_re
        .map(|re| {
            re.captures_iter(html)
                .take(max)
                .map(|c| strip_html(&c[1]))
                .collect()
        })
        .unwrap_or_default();
    link_re
        .captures_iter(html)
        .take(max)
        .enumerate()
        .map(|(i, c)| {
            (
                strip_html(&c[2]),
                decode_ddg_url(&c[1]),
                snippets.get(i).cloned().unwrap_or_default(),
            )
        })
        .collect()
}

/// Parse `lite.duckduckgo.com` : liens `result-link` dans des cellules de table.
/// Les snippets sont dans la ligne suivante (`result-snippet`).
fn parse_ddg_lite(html: &str, max: usize) -> Vec<(String, String, String)> {
    let link_re =
        match Regex::new(r#"(?s)<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#) {
            Ok(re) => re,
            Err(_) => return Vec::new(),
        };
    let snippet_re = Regex::new(r#"(?s)<td[^>]*class="result-snippet"[^>]*>(.*?)</td>"#).ok();
    let snippets: Vec<String> = snippet_re
        .map(|re| {
            re.captures_iter(html)
                .take(max)
                .map(|c| strip_html(&c[1]))
                .collect()
        })
        .unwrap_or_default();
    link_re
        .captures_iter(html)
        .take(max)
        .enumerate()
        .map(|(i, c)| {
            (
                strip_html(&c[2]),
                decode_ddg_url(&c[1]),
                snippets.get(i).cloned().unwrap_or_default(),
            )
        })
        .collect()
}

/// Décode l'URL réelle depuis un lien de redirection DDG `…/l/?uddg=<enc>&…`.
fn decode_ddg_url(href: &str) -> String {
    if let Some(idx) = href.find("uddg=") {
        let rest = &href[idx + 5..];
        let enc = rest.split('&').next().unwrap_or(rest);
        if let Ok(dec) = percent_encoding::percent_decode_str(enc).decode_utf8() {
            return dec.into_owned();
        }
    }
    href.strip_prefix("//")
        .map(|s| format!("https://{s}"))
        .unwrap_or_else(|| href.to_string())
}

// ────────────────────────────────────────────────────────────────────
// web_fetch — récupère une page et la rend en texte lisible
// ────────────────────────────────────────────────────────────────────

/// Récupère `url` et renvoie son contenu textuel (HTML→texte). `max_chars`
/// borne la sortie (sentinelle de troncature). Retourne `(texte, is_error)`.
pub(crate) async fn web_fetch(
    client: &reqwest::Client,
    url: &str,
    max_chars: usize,
) -> (String, bool) {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return (
            format!(
                "web_fetch: URL invalide « {url} » — elle doit commencer par http:// ou https://."
            ),
            true,
        );
    }
    let resp = client
        .get(url)
        .header(USER_AGENT, BROWSER_UA)
        .timeout(Duration::from_secs(20))
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => return (format!("web_fetch: échec réseau pour {url} ({e})."), true),
    };
    if !resp.status().is_success() {
        return (
            format!("web_fetch: HTTP {} pour {url}.", resp.status()),
            true,
        );
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            return (
                format!("web_fetch: lecture du corps impossible ({e})."),
                true,
            )
        }
    };
    // Texte/JSON : renvoyer brut (pas de strip HTML). Sinon : HTML→texte.
    let is_plain = content_type.contains("text/plain")
        || content_type.contains("application/json")
        || content_type.contains("text/markdown");
    let text = if is_plain { body } else { html_to_text(&body) };
    let text = text.trim();
    if text.is_empty() {
        return (
            format!("web_fetch: {url} n'a renvoyé aucun texte exploitable."),
            false,
        );
    }
    let (clipped, truncated) = clip(text, max_chars);
    let mut out = format!("Contenu de {url} :\n\n{clipped}");
    if truncated {
        out.push_str(&format!(
            "\n\n[… tronqué à {max_chars} caractères — récupère une autre section si besoin]"
        ));
    }
    (out, false)
}

/// HTML → texte lisible : retire `<script>`/`<style>`/commentaires, convertit
/// quelques blocs en sauts de ligne, strip le reste des balises, compacte les
/// lignes vides. Best-effort (pas un vrai moteur de rendu).
fn html_to_text(html: &str) -> String {
    let mut s = html.to_string();
    // Retire script/style/head/noscript (contenu inutile au modèle).
    for tag in ["script", "style", "noscript", "head", "svg"] {
        if let Ok(re) = Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>")) {
            s = re.replace_all(&s, " ").into_owned();
        }
    }
    // Commentaires HTML.
    if let Ok(re) = Regex::new(r"(?s)<!--.*?-->") {
        s = re.replace_all(&s, " ").into_owned();
    }
    // Sauts de ligne sur les fermetures de blocs courants.
    if let Ok(re) =
        Regex::new(r"(?i)</(p|div|li|tr|h[1-6]|br|section|article|header|footer|ul|ol)\s*>")
    {
        s = re.replace_all(&s, "\n").into_owned();
    }
    if let Ok(re) = Regex::new(r"(?i)<br\s*/?>") {
        s = re.replace_all(&s, "\n").into_owned();
    }
    let text = strip_html(&s);
    // Compacte : pas plus d'une ligne vide consécutive, trim par ligne.
    let mut out = String::new();
    let mut blank = false;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            if !blank {
                out.push('\n');
            }
            blank = true;
        } else {
            out.push_str(t);
            out.push('\n');
            blank = false;
        }
    }
    out.trim().to_string()
}

// ────────────────────────────────────────────────────────────────────
// Helpers partagés
// ────────────────────────────────────────────────────────────────────

/// Formate une liste `(titre, url, extrait)` en bloc numéroté lisible.
fn format_results(query: &str, source: &str, items: &[(String, String, String)]) -> String {
    let mut out = format!("Résultats web ({source}) pour « {query} » :\n\n");
    for (i, (title, url, snippet)) in items.iter().enumerate() {
        let title = if title.trim().is_empty() {
            "(sans titre)"
        } else {
            title.trim()
        };
        out.push_str(&format!("{}. {}\n   {}\n", i + 1, title, url.trim()));
        let snip = snippet.trim();
        if !snip.is_empty() {
            let (clipped, _) = clip(snip, 300);
            out.push_str(&format!("   {clipped}\n"));
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

/// Tronque sur une frontière de caractère (jamais au milieu d'un codepoint).
/// Retourne `(texte, tronqué?)`.
fn clip(s: &str, max_chars: usize) -> (String, bool) {
    if s.chars().count() <= max_chars {
        (s.to_string(), false)
    } else {
        (s.chars().take(max_chars).collect(), true)
    }
}

/// Retire les balises HTML + décode quelques entités courantes (best-effort).
/// Migré depuis `agents::runner` (source unique).
fn strip_html(s: &str) -> String {
    let no_tags = Regex::new(r"<[^>]+>")
        .map(|re| re.replace_all(s, "").into_owned())
        .unwrap_or_else(|_| s.to_string());
    no_tags
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&#x2F;", "/")
        .trim()
        .to_string()
}

// ────────────────────────────────────────────────────────────────────
// Recherche NATIVE des providers (outils serveur exécutés côté provider)
// ────────────────────────────────────────────────────────────────────

/// Le provider/modèle actif expose-t-il une recherche web SERVEUR qu'on préfère
/// à notre recherche client ? Aujourd'hui :
///   * Anthropic 1ʳᵉ partie sur les modèles Claude récents (4.x / Fable) →
///     outil serveur `web_search_20260209` (filtrage dynamique intégré).
///   * OpenAI sur les modèles `*-search-preview` → champ `web_search_options`.
/// Gate volontairement conservateur (nom de modèle) pour ne JAMAIS envoyer
/// l'outil serveur à un modèle qui le refuserait (400). Sinon, on retombe sur
/// notre recherche client (Brave/Tavily/DDG), qui marche partout.
pub fn model_supports_native_search(protocol: &str, model: &str) -> bool {
    match protocol {
        "anthropic" => is_current_claude(model),
        "openai" => openai_model_has_native_search(model),
        _ => false,
    }
}

/// Heuristique : modèle Claude assez récent pour accepter l'outil serveur
/// `web_search` (familles 4.x et Fable). Volontairement strict.
fn is_current_claude(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    m.contains("opus-4")
        || m.contains("sonnet-4")
        || m.contains("haiku-4")
        || m.contains("claude-4")
        || m.contains("fable")
}

/// Modèle OpenAI à recherche web intégrée (`gpt-4o-search-preview`, etc.).
pub fn openai_model_has_native_search(model: &str) -> bool {
    model.to_ascii_lowercase().contains("search")
}

/// Outil SERVEUR Anthropic de recherche web (exécuté côté Anthropic). Version
/// `_20260209` : filtrage dynamique intégré, aucun header beta requis sur les
/// modèles Claude récents. Format `tools` Anthropic : `{type, name}`. On
/// n'ajoute QUE `web_search` (pas `web_fetch` serveur) : le modèle cherche côté
/// Anthropic puis lit les pages avec NOTRE `web_fetch` client — hybride sûr.
pub fn anthropic_server_web_tools() -> Vec<serde_json::Value> {
    vec![serde_json::json!({ "type": "web_search_20260209", "name": "web_search" })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_search_gating_is_conservative() {
        assert!(model_supports_native_search("anthropic", "claude-opus-4-8"));
        assert!(model_supports_native_search(
            "anthropic",
            "claude-sonnet-4-6"
        ));
        assert!(model_supports_native_search("anthropic", "claude-fable-5"));
        assert!(!model_supports_native_search(
            "anthropic",
            "claude-3-5-sonnet"
        ));
        assert!(!model_supports_native_search("ollama", "llama3"));
        assert!(model_supports_native_search(
            "openai",
            "gpt-4o-search-preview"
        ));
        assert!(!model_supports_native_search("openai", "gpt-4o"));
    }

    #[test]
    fn strip_html_removes_tags_and_entities() {
        assert_eq!(strip_html("<b>Hello</b> &amp; bye"), "Hello & bye");
    }

    #[test]
    fn clip_respects_char_boundary() {
        let (s, t) = clip("héllo", 3);
        assert_eq!(s, "hél");
        assert!(t);
        let (s2, t2) = clip("hi", 5);
        assert_eq!(s2, "hi");
        assert!(!t2);
    }

    #[test]
    fn html_to_text_drops_script_and_keeps_text() {
        let html = "<html><head><title>x</title></head><body><script>var a=1;</script><p>Bonjour</p><p>monde</p></body></html>";
        let text = html_to_text(html);
        assert!(text.contains("Bonjour"));
        assert!(text.contains("monde"));
        assert!(!text.contains("var a"));
    }

    #[test]
    fn decode_ddg_url_extracts_target() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x";
        assert_eq!(decode_ddg_url(href), "https://example.com/a");
    }

    #[test]
    fn format_results_numbers_items() {
        let items = vec![(
            "T1".to_string(),
            "https://a".to_string(),
            "snip".to_string(),
        )];
        let out = format_results("q", "Brave", &items);
        assert!(out.contains("1. T1"));
        assert!(out.contains("https://a"));
        assert!(out.contains("snip"));
    }
}
