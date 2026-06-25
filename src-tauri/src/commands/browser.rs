//! Outil agent `browser_test` — l'agent lance un navigateur **headless**, ouvre
//! l'app web de l'utilisateur (serveur de dev / preview), exécute des actions,
//! vérifie des assertions, collecte la **console** + les **erreurs de page**, et
//! prend une **capture**. C'est l'équivalent de l'« outil navigateur natif qui
//! teste son propre travail » de Cursor 2.0 : l'agent peut *voir* si ce qu'il
//! vient de coder fonctionne réellement dans un vrai moteur de rendu, puis itérer.
//!
//! ## Backends (abstraction [`BrowserBackend`])
//! * **Playwright-shell** (ICI) — pilote un petit script Node (`playwright`).
//!   Éprouvé, **aucune dépendance Rust lourde** ; exige que `playwright` soit
//!   installé côté projet (`npm i -D playwright && npx playwright install chromium`).
//! * **chromiumoxide** (Phase 1b) — CDP 100 % Rust ; exige un Chrome/Chromium.
//!   Ajouté dans un commit suivant ; l'`enum` `engine` du schéma d'outil sera
//!   alors étendu à `"chromiumoxide"`.
//!
//! ## Sécurité
//! La sortie (texte de console, DOM) est du **contenu externe non fiable** : le
//! `runner` la clôt via `wrap_untrusted("browser", …)` (contrat AM-3), comme
//! `web_fetch`. Le process navigateur tourne avec `kill_on_drop` — un abandon
//! d'agent ou un timeout tue l'arbre. Les artefacts (captures) vont sous
//! `app_data_dir/browser-tests/`, jamais dans le dépôt git de l'utilisateur.

use std::io::Cursor;
use std::path::Path;
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Miniature de timeline — aligne capture.rs (512 px, JPEG q70, persistée en
/// data URL dans l'event `Screenshot` → survit au reload sans protocole asset).
const THUMB_EDGE: u32 = 512;
const THUMB_QUALITY: u8 = 70;
/// Garde-fou dur au-dessus du timeout par-test : couvre le démarrage de node +
/// du navigateur. Le timeout fonctionnel (navigation/sélecteurs) vit dans le
/// driver via `spec.timeoutMs`.
const HARD_KILL_SECS: u64 = 120;

// ────────────────────────────────────────────────────────────────────
// Résultat structuré rendu par le driver (JSON sur disque)
// ────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct DriverResult {
    #[serde(default)]
    passed: bool,
    #[serde(default)]
    console: Vec<ConsoleMsg>,
    #[serde(default)]
    errors: Vec<String>,
    #[serde(default)]
    assertions: Vec<AssertionResult>,
    #[serde(default)]
    screenshot: Option<String>,
    #[serde(default, rename = "finalUrl")]
    final_url: Option<String>,
    /// Présent quand le driver n'a même pas pu démarrer (playwright absent,
    /// navigateur non installé) — distinct d'un échec d'assertion.
    #[serde(default, rename = "infraError")]
    infra_error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct ConsoleMsg {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct AssertionResult {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    ok: bool,
}

/// Ce que le runner consomme : le texte à renvoyer au modèle, le flag d'erreur
/// (réservé aux pannes d'INFRA, pas aux échecs d'assertion — voir
/// [`browser_test_run`]), et les captures `(chemin, miniature data URL)` à
/// émettre comme events `Screenshot` pour la timeline.
pub struct BrowserOutcome {
    pub summary: String,
    pub is_error: bool,
    pub screenshots: Vec<(String, String)>,
}

// ────────────────────────────────────────────────────────────────────
// Abstraction backend
// ────────────────────────────────────────────────────────────────────

/// Un moteur capable d'exécuter un test navigateur. `spec` est le JSON déjà
/// normalisé (clés camelCase attendues par le driver) ; `artifact_png` est le
/// chemin absolu où écrire la capture.
#[allow(async_fn_in_trait)]
trait BrowserBackend {
    async fn run(&self, spec: &Value, artifact_png: &Path) -> Result<DriverResult, String>;
}

// ────────────────────────────────────────────────────────────────────
// Backend Playwright via sous-process Node
// ────────────────────────────────────────────────────────────────────

/// Driver CommonJS — `require('playwright')` consulte `NODE_PATH` (≠ les
/// imports ESM), donc on peut résoudre `playwright` depuis le `node_modules`
/// du projet de l'utilisateur sans installation globale. Wrappé dans une IIFE
/// async (pas de top-level await en CJS).
const PLAYWRIGHT_DRIVER_CJS: &str = r#"
const { writeFileSync, readFileSync } = require('node:fs');
const [, , specPath, resultPath] = process.argv;
function write(obj) { try { writeFileSync(resultPath, JSON.stringify(obj)); } catch (_) {} }
(async () => {
  const result = { passed: false, console: [], errors: [], assertions: [], screenshot: null, finalUrl: null };
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) { write({ infraError: 'playwright-missing', message: String((e && e.message) || e) }); return; }
  let spec;
  try { spec = JSON.parse(readFileSync(specPath, 'utf8')); }
  catch (e) { write({ infraError: 'bad-spec', message: String((e && e.message) || e) }); return; }
  const timeout = spec.timeoutMs || 30000;
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', (m) => { try { result.console.push({ type: m.type(), text: m.text() }); } catch (_) {} });
    page.on('pageerror', (e) => { result.errors.push(String((e && e.stack) || e)); });
    await page.goto(spec.url, { waitUntil: 'load', timeout });
    if (spec.waitSelector) await page.waitForSelector(spec.waitSelector, { timeout });
    if (spec.waitMs) await page.waitForTimeout(Math.min(spec.waitMs, 10000));
    for (const a of (spec.actions || [])) {
      if (a.type === 'click') await page.click(a.selector, { timeout });
      else if (a.type === 'fill') await page.fill(a.selector, a.text == null ? '' : String(a.text), { timeout });
      else if (a.type === 'waitSelector') await page.waitForSelector(a.selector, { timeout });
      else if (a.type === 'wait') await page.waitForTimeout(Math.min(a.ms || 500, 10000));
    }
    result.finalUrl = page.url();
    if (spec.assertSelector) {
      const el = await page.$(spec.assertSelector);
      result.assertions.push({ kind: 'selector', target: spec.assertSelector, ok: !!el });
    }
    if (spec.assertText) {
      let body = '';
      try { body = (await page.textContent('body')) || ''; } catch (_) {}
      result.assertions.push({ kind: 'text', target: spec.assertText, ok: body.includes(spec.assertText) });
    }
    if (spec.screenshotPath) {
      try { await page.screenshot({ path: spec.screenshotPath, fullPage: false }); result.screenshot = spec.screenshotPath; } catch (_) {}
    }
    const noErrors = result.errors.length === 0 && !result.console.some((c) => c.type === 'error');
    const assertionsOk = result.assertions.every((a) => a.ok);
    result.passed = assertionsOk && (spec.requireNoErrors ? noErrors : true);
  } catch (e) {
    result.errors.push(String((e && e.stack) || e));
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    write(result);
  }
})();
"#;

struct PlaywrightShellBackend {
    /// `node_modules` du projet (pour `NODE_PATH`) quand un workspace est ouvert.
    project_root: Option<std::path::PathBuf>,
}

impl BrowserBackend for PlaywrightShellBackend {
    async fn run(&self, spec: &Value, artifact_png: &Path) -> Result<DriverResult, String> {
        let node = which::which("node")
            .map_err(|_| "node introuvable sur le PATH — installe Node.js pour utiliser browser_test".to_string())?;

        // Dossier de travail jetable du driver (script + spec + result), hors
        // dépôt utilisateur. On y écrit le driver CJS et le spec normalisé.
        let work = std::env::temp_dir().join(format!("shugu-browser-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&work).map_err(|e| format!("create work dir: {e}"))?;
        let driver_path = work.join("driver.cjs");
        let spec_path = work.join("spec.json");
        let result_path = work.join("result.json");
        std::fs::write(&driver_path, PLAYWRIGHT_DRIVER_CJS).map_err(|e| format!("write driver: {e}"))?;
        std::fs::write(
            &spec_path,
            serde_json::to_vec(spec).map_err(|e| format!("serialize spec: {e}"))?,
        )
        .map_err(|e| format!("write spec: {e}"))?;

        let mut cmd = tokio::process::Command::new(&node);
        cmd.arg(&driver_path).arg(&spec_path).arg(&result_path);
        cmd.kill_on_drop(true);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        // `require('playwright')` résout depuis NODE_PATH (CJS) → le node_modules
        // du projet quand un workspace est ouvert ; sinon installation globale.
        if let Some(root) = &self.project_root {
            cmd.current_dir(root);
            cmd.env("NODE_PATH", root.join("node_modules"));
        }

        let child = cmd.spawn().map_err(|e| format!("spawn node: {e}"))?;
        let out = match tokio::time::timeout(
            Duration::from_secs(HARD_KILL_SECS),
            child.wait_with_output(),
        )
        .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => {
                let _ = std::fs::remove_dir_all(&work);
                return Err(format!("node wait: {e}"));
            }
            Err(_) => {
                // child a `kill_on_drop` → drop ici tue le process navigateur.
                let _ = std::fs::remove_dir_all(&work);
                return Err(format!(
                    "browser_test: délai dépassé ({HARD_KILL_SECS}s) — le navigateur ou la page n'a pas répondu"
                ));
            }
        };

        // Le driver écrit TOUJOURS result.json (succès, échec ou infraError).
        // Son absence = node a planté avant (ex. introuvable / OOM) → on remonte
        // stderr pour diagnostic.
        let parsed: Result<DriverResult, String> = match std::fs::read(&result_path) {
            Ok(bytes) => serde_json::from_slice::<DriverResult>(&bytes)
                .map_err(|e| format!("parse result.json: {e}")),
            Err(_) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let tail: String = stderr.chars().rev().take(800).collect::<String>().chars().rev().collect();
                Err(format!(
                    "browser_test: le driver n'a produit aucun résultat (node exit {}). stderr:\n{}",
                    out.status.code().unwrap_or(-1),
                    tail.trim()
                ))
            }
        };
        let _ = std::fs::remove_dir_all(&work);
        let _ = artifact_png; // le driver écrit directement à screenshotPath
        parsed
    }
}

// ────────────────────────────────────────────────────────────────────
// Backend chromiumoxide (CDP, 100 % Rust — exige un Chrome/Chromium installé)
// ────────────────────────────────────────────────────────────────────

/// Shim injecté AVANT tout script de page (`evaluate_on_new_document`) : il
/// capture `console.error/warn`, les erreurs non interceptées et les rejets de
/// promesse dans `window.__shugu`, qu'on relit ensuite via `evaluate`. Bien
/// plus robuste (et stable entre versions de chromiumoxide) que l'abonnement
/// aux events CDP `Runtime.consoleAPICalled`.
const CDP_SHIM: &str = r#"(() => {
  if (window.__shugu) return;
  window.__shugu = { console: [], errors: [] };
  const fmt = (a) => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (_) { return String(a); } };
  const wrap = (type, orig) => function (...a) { try { window.__shugu.console.push({ type, text: a.map(fmt).join(' ') }); } catch (_) {} return orig.apply(this, a); };
  console.error = wrap('error', console.error);
  console.warn = wrap('warning', console.warn);
  window.addEventListener('error', (e) => { try { window.__shugu.errors.push(String((e && e.message) || e)); } catch (_) {} });
  window.addEventListener('unhandledrejection', (e) => { try { window.__shugu.errors.push('unhandledrejection: ' + String(e && e.reason)); } catch (_) {} });
})();"#;

/// État capturé par le shim, relu via `evaluate`.
#[derive(Deserialize, Default)]
struct Captured {
    #[serde(default)]
    console: Vec<ConsoleMsg>,
    #[serde(default)]
    errors: Vec<String>,
}

struct ChromiumoxideBackend;

impl BrowserBackend for ChromiumoxideBackend {
    async fn run(&self, spec: &Value, png_path: &Path) -> Result<DriverResult, String> {
        use chromiumoxide::browser::{Browser, BrowserConfig};
        use futures_util::StreamExt;

        // Headless par défaut dans chromiumoxide. `LAUNCH_FAILED` est le sentinel
        // que `browser_test_run` reconnaît pour basculer sur Playwright en "auto".
        let config = BrowserConfig::builder()
            .build()
            .map_err(|e| format!("LAUNCH_FAILED: config navigateur: {e}"))?;
        let (mut browser, mut handler) = Browser::launch(config)
            .await
            .map_err(|e| format!("LAUNCH_FAILED: lancement de Chrome impossible (installé ?) : {e}"))?;
        // Le Handler doit être pompé en continu, sinon le CDP se fige.
        let handler_task = tokio::spawn(async move {
            while let Some(h) = handler.next().await {
                if h.is_err() {
                    break;
                }
            }
        });

        let outcome = cdp_inner(&browser, spec, png_path).await;
        let _ = browser.close().await;
        handler_task.abort();
        outcome
    }
}

/// Corps du test CDP, isolé pour garantir `browser.close()` même en erreur.
async fn cdp_inner(
    browser: &chromiumoxide::Browser,
    spec: &Value,
    png_path: &Path,
) -> Result<DriverResult, String> {
    use chromiumoxide::page::ScreenshotParams;

    let mut result = DriverResult::default();
    let url = spec["url"].as_str().unwrap_or("about:blank");
    let timeout_ms = spec["timeoutMs"].as_u64().unwrap_or(30_000);
    let require_no_errors = spec["requireNoErrors"].as_bool().unwrap_or(true);

    let page = browser
        .new_page("about:blank")
        .await
        .map_err(|e| format!("new_page: {e}"))?;
    page.evaluate_on_new_document(CDP_SHIM.to_string())
        .await
        .map_err(|e| format!("inject shim: {e}"))?;
    page.goto(url).await.map_err(|e| format!("goto {url}: {e}"))?;
    page.wait_for_navigation()
        .await
        .map_err(|e| format!("wait navigation: {e}"))?;

    if let Some(sel) = spec["waitSelector"].as_str() {
        // Tolère un selector jamais présent (timeout) sans tuer le test —
        // l'assertion correspondante tranchera ensuite.
        let _ = tokio::time::timeout(Duration::from_millis(timeout_ms), page.find_element(sel)).await;
    }
    if let Some(ms) = spec["waitMs"].as_u64() {
        tokio::time::sleep(Duration::from_millis(ms.min(10_000))).await;
    }
    if let Some(actions) = spec["actions"].as_array() {
        for a in actions {
            match a["type"].as_str().unwrap_or("") {
                "click" => {
                    if let Some(sel) = a["selector"].as_str() {
                        if let Ok(el) = page.find_element(sel).await {
                            let _ = el.click().await;
                        }
                    }
                }
                "fill" => {
                    if let Some(sel) = a["selector"].as_str() {
                        if let Ok(el) = page.find_element(sel).await {
                            let _ = el.click().await;
                            let _ = el.type_str(a["text"].as_str().unwrap_or("")).await;
                        }
                    }
                }
                "waitSelector" => {
                    if let Some(sel) = a["selector"].as_str() {
                        let _ = tokio::time::timeout(
                            Duration::from_millis(timeout_ms),
                            page.find_element(sel),
                        )
                        .await;
                    }
                }
                "wait" => {
                    let ms = a["ms"].as_u64().unwrap_or(500).min(10_000);
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                }
                _ => {}
            }
        }
    }

    result.final_url = page.url().await.ok().flatten();

    if let Some(sel) = spec["assertSelector"].as_str() {
        result.assertions.push(AssertionResult {
            kind: "selector".to_string(),
            target: sel.to_string(),
            ok: page.find_element(sel).await.is_ok(),
        });
    }
    if let Some(txt) = spec["assertText"].as_str() {
        let body = page
            .evaluate("document.body ? document.body.innerText : ''")
            .await
            .ok()
            .and_then(|e| e.into_value::<String>().ok())
            .unwrap_or_default();
        result.assertions.push(AssertionResult {
            kind: "text".to_string(),
            target: txt.to_string(),
            ok: body.contains(txt),
        });
    }

    // Console + erreurs capturées par le shim, relues d'un coup.
    if let Ok(ev) = page
        .evaluate("JSON.stringify(window.__shugu || {console:[],errors:[]})")
        .await
    {
        if let Ok(s) = ev.into_value::<String>() {
            if let Ok(cap) = serde_json::from_str::<Captured>(&s) {
                result.console = cap.console;
                result.errors = cap.errors;
            }
        }
    }

    if spec.get("screenshotPath").is_some() {
        if page
            .save_screenshot(ScreenshotParams::builder().build(), png_path)
            .await
            .is_ok()
        {
            result.screenshot = Some(png_path.to_string_lossy().into_owned());
        }
    }

    let no_errors = result.errors.is_empty() && !result.console.iter().any(|c| c.kind == "error");
    let assertions_ok = result.assertions.iter().all(|a| a.ok);
    result.passed = assertions_ok && (if require_no_errors { no_errors } else { true });
    Ok(result)
}

// ────────────────────────────────────────────────────────────────────
// Entrée publique (appelée depuis le fork async du runner)
// ────────────────────────────────────────────────────────────────────

/// Dossier des artefacts navigateur — sous app_data_dir, jamais dans le dépôt.
fn browser_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("browser-tests");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create browser-tests dir: {e}"))?;
    Ok(dir)
}

/// Windows : retire le préfixe `\\?\` de `canonicalize` avant stockage/affichage.
fn strip_extended_prefix(p: &str) -> String {
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

/// Construit une miniature JPEG (data URL) depuis le PNG de capture, pour
/// l'event `Screenshot` de la timeline (même pipeline que capture.rs).
fn thumb_from_png(png_path: &Path) -> Option<String> {
    let img = image::open(png_path).ok()?;
    let thumb = img.resize(THUMB_EDGE, THUMB_EDGE, image::imageops::FilterType::Triangle);
    let rgb = image::DynamicImage::ImageRgb8(thumb.to_rgb8());
    let mut buf = Vec::new();
    rgb.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
        Cursor::new(&mut buf),
        THUMB_QUALITY,
    ))
    .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(&buf)
    ))
}

/// Normalise les arguments d'outil en spec driver (clés camelCase, valeurs
/// bornées). Rejette une URL manquante/non http(s) ou localhost-only invalide.
fn build_spec(args: &Value, screenshot_path: &Path) -> Result<Value, String> {
    let url = args["url"]
        .as_str()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .ok_or_else(|| "browser_test: champ requis manquant: url".to_string())?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!(
            "browser_test: url doit être http(s) absolu (ex. http://localhost:5173) — reçu: {url:?}"
        ));
    }
    let timeout_ms = args["timeoutMs"].as_u64().unwrap_or(30_000).clamp(1_000, 60_000);
    let require_no_errors = args["requireNoErrors"].as_bool().unwrap_or(true);
    let want_shot = args["screenshot"].as_bool().unwrap_or(true);

    let mut spec = json!({
        "url": url,
        "timeoutMs": timeout_ms,
        "requireNoErrors": require_no_errors,
    });
    if want_shot {
        spec["screenshotPath"] = Value::String(screenshot_path.to_string_lossy().into_owned());
    }
    for key in ["waitSelector", "assertSelector", "assertText"] {
        if let Some(v) = args[key].as_str() {
            if !v.trim().is_empty() {
                spec[key] = json!(v);
            }
        }
    }
    if let Some(ms) = args["waitMs"].as_u64() {
        spec["waitMs"] = json!(ms.min(10_000));
    }
    if let Some(actions) = args["actions"].as_array() {
        spec["actions"] = Value::Array(actions.clone());
    }
    Ok(spec)
}

/// Exécute un test navigateur et formate le compte rendu pour le modèle.
///
/// `is_error` est réservé aux **pannes d'infra** (node/playwright absent,
/// navigateur non installé, timeout, crash du driver) — un **échec d'assertion**
/// renvoie `is_error: false` avec un résumé `FAILED`, comme `run_command` rend
/// un exit non-nul en DONNÉES que l'agent doit lire et corriger.
pub async fn browser_test_run(
    app: &AppHandle,
    root: Option<&Path>,
    agent_id: &str,
    args: &Value,
) -> BrowserOutcome {
    // Chemin de capture unique sous app_data_dir.
    let png_path = match browser_dir(app) {
        Ok(dir) => {
            let safe: String = agent_id
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect();
            dir.join(format!("{safe}-{}.png", uuid::Uuid::new_v4()))
        }
        Err(e) => {
            return BrowserOutcome { summary: e, is_error: true, screenshots: vec![] };
        }
    };

    let spec = match build_spec(args, &png_path) {
        Ok(s) => s,
        Err(e) => return BrowserOutcome { summary: e, is_error: true, screenshots: vec![] },
    };

    // Sélection backend :
    //   "chromiumoxide" → CDP Rust pur (exige Chrome).
    //   "playwright"    → driver Node (exige `playwright` côté projet).
    //   "auto" (défaut) → chromiumoxide d'abord (aucun Node requis), repli
    //                     Playwright si Chrome est introuvable (LAUNCH_FAILED).
    let engine = args["engine"].as_str().unwrap_or("auto");
    let pw = || PlaywrightShellBackend {
        project_root: root.map(|p| p.to_path_buf()),
    };
    let result: Result<DriverResult, String> = match engine {
        "playwright" => pw().run(&spec, &png_path).await,
        "chromiumoxide" => ChromiumoxideBackend.run(&spec, &png_path).await,
        "auto" => match ChromiumoxideBackend.run(&spec, &png_path).await {
            Err(e) if e.contains("LAUNCH_FAILED") => pw().run(&spec, &png_path).await,
            other => other,
        },
        other => {
            return BrowserOutcome {
                summary: format!(
                    "browser_test: engine inconnu {other:?} — disponibles: \"auto\", \"chromiumoxide\", \"playwright\""
                ),
                is_error: true,
                screenshots: vec![],
            }
        }
    };

    match result {
        Ok(res) => render_outcome(res, &png_path),
        Err(e) => BrowserOutcome { summary: e, is_error: true, screenshots: vec![] },
    }
}

/// Met en forme le `DriverResult` en compte rendu textuel + collecte la capture.
fn render_outcome(res: DriverResult, png_path: &Path) -> BrowserOutcome {
    // Panne d'infra distincte (playwright/navigateur absent) → message actionnable.
    if let Some(kind) = &res.infra_error {
        let hint = if kind == "playwright-missing" {
            "Playwright n'est pas installé dans ce projet. Lance : \
             `npm i -D playwright && npx playwright install chromium`."
        } else {
            "Le driver navigateur n'a pas pu démarrer."
        };
        let msg = res.message.unwrap_or_default();
        return BrowserOutcome {
            summary: format!("browser_test indisponible ({kind}). {hint}\n{msg}"),
            is_error: true,
            screenshots: vec![],
        };
    }

    let mut lines = Vec::new();
    lines.push(format!(
        "browser_test: {}",
        if res.passed { "PASSED ✅" } else { "FAILED ❌" }
    ));
    if let Some(u) = &res.final_url {
        lines.push(format!("URL finale : {u}"));
    }
    if !res.assertions.is_empty() {
        lines.push("Assertions :".to_string());
        for a in &res.assertions {
            lines.push(format!(
                "  {} {} {}",
                if a.ok { "✓" } else { "✗" },
                a.kind,
                a.target
            ));
        }
    }
    // Erreurs de page + erreurs console (le signal le plus utile à l'agent).
    let console_errors: Vec<&ConsoleMsg> =
        res.console.iter().filter(|c| c.kind == "error").collect();
    if res.errors.is_empty() && console_errors.is_empty() {
        lines.push("Console : aucune erreur.".to_string());
    } else {
        lines.push(format!(
            "Erreurs ({} page, {} console) :",
            res.errors.len(),
            console_errors.len()
        ));
        for e in res.errors.iter().take(10) {
            lines.push(format!("  ⚠ {}", e.lines().next().unwrap_or(e)));
        }
        for c in console_errors.iter().take(10) {
            lines.push(format!("  ⚠ console: {}", c.text));
        }
    }

    // Capture : si présente, miniature pour la timeline + chemin pour le modèle.
    let mut screenshots = Vec::new();
    if res.screenshot.is_some() && png_path.exists() {
        let abs = strip_extended_prefix(&png_path.to_string_lossy());
        if let Some(thumb) = thumb_from_png(png_path) {
            screenshots.push((abs.clone(), thumb));
        }
        lines.push(format!("Capture : {abs}"));
    }

    BrowserOutcome {
        summary: lines.join("\n"),
        is_error: false,
        screenshots,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_spec_rejects_non_http_url() {
        let png = std::path::Path::new("/tmp/x.png");
        assert!(build_spec(&json!({ "url": "ftp://x" }), png).is_err());
        assert!(build_spec(&json!({}), png).is_err());
        assert!(build_spec(&json!({ "url": "" }), png).is_err());
    }

    #[test]
    fn build_spec_normalizes_fields_and_clamps() {
        let png = std::path::Path::new("/tmp/shot.png");
        let spec = build_spec(
            &json!({
                "url": "http://localhost:5173",
                "assertText": "Hello",
                "waitMs": 999_999,
                "timeoutMs": 10,
                "screenshot": true,
                "engine": "auto"
            }),
            png,
        )
        .unwrap();
        assert_eq!(spec["url"], "http://localhost:5173");
        assert_eq!(spec["assertText"], "Hello");
        assert_eq!(spec["waitMs"], 10_000); // clampé
        assert_eq!(spec["timeoutMs"], 1_000); // clampé au plancher
        assert!(spec["screenshotPath"].is_string());
    }

    #[test]
    fn render_outcome_infra_error_is_actionable() {
        let res = DriverResult {
            infra_error: Some("playwright-missing".to_string()),
            message: Some("Cannot find module 'playwright'".to_string()),
            ..Default::default()
        };
        let out = render_outcome(res, std::path::Path::new("/tmp/none.png"));
        assert!(out.is_error);
        assert!(out.summary.contains("npx playwright install"));
    }

    #[test]
    fn render_outcome_failed_assertion_is_data_not_error() {
        let res = DriverResult {
            passed: false,
            assertions: vec![AssertionResult {
                kind: "text".to_string(),
                target: "Hello".to_string(),
                ok: false,
            }],
            final_url: Some("http://localhost:5173/".to_string()),
            ..Default::default()
        };
        let out = render_outcome(res, std::path::Path::new("/tmp/none.png"));
        assert!(!out.is_error, "un échec d'assertion est une DONNÉE, pas une erreur d'outil");
        assert!(out.summary.contains("FAILED"));
        assert!(out.summary.contains("✗ text Hello"));
    }
}
