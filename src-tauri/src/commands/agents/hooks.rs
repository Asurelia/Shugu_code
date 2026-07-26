//! Hooks de cycle de vie utilisateur (P6.4 — modèle Claude Code).
//!
//! ## Fichiers de configuration + sémantique de merge
//!
//!   * utilisateur : `~/.shugu/hooks.json`
//!   * projet      : `<workspace>/.shugu/hooks.json`
//!
//! MERGE = **concaténation ordonnée, utilisateur d'abord, projet ensuite** :
//! le projet ÉTEND la config utilisateur (les deux tirent, dans cet ordre) —
//! le schéma n'a pas d'`id`/`name`, il n'y a donc PAS d'override par nom. Un
//! hook identique déclaré des deux côtés tire deux fois (choix documenté :
//! dédupliquer silencieusement cacherait une intention explicite). Chaque hook
//! reçoit un `id` stable (SHA-256 tronqué de source|event|matcher|command)
//! pour l'enable/disable en Settings — stocké dans la table `settings`
//! (`hooks.disabled`, JSON array d'ids) : on NE RÉÉCRIT JAMAIS le JSON de
//! l'utilisateur.
//!
//! ## Confinement
//!
//! Les hooks n'existent QUE dans les profils mutants (Auto / Full Access) :
//! en Chat/Plan, `hooks_enabled_for_profile` est faux et AUCUN processus hook
//! n'est jamais spawné. L'exécution réutilise `exec::run_command_direct` :
//! Auto → sandbox Windows LOW (même chemin que `run_command`), Full Access →
//! direct. Timeout → kill de tout l'arbre de processus (Job Object existant).
//!
//! ## Contrat stdout / codes de sortie
//!
//! Le hook reçoit son input en JSON **sur stdin** (`"version": 1`). Il peut
//! imprimer une ligne JSON `{ "additionalContext": "…", "decision":
//! "block"|"allow", "reason": "…" }` — `decision` n'est honorée que pour
//! PreToolUse et Stop ; `additionalContext` est injecté comme contexte
//! (sauf hooks `async`, dont on n'attend pas la sortie). Une sortie non-JSON
//! est ignorée côté contexte mais loguée (event `hookFired`).
//!
//!   * PreToolUse : exit != 0 OU timeout OU decision:block ⇒ l'outil est
//!     REFUSÉ (**fail-closed**) et le refus est renvoyé au modèle comme
//!     résultat d'outil.
//!   * autres events : exit != 0 / timeout ⇒ loggué, la boucle continue
//!     (**fail-open**). Seule une `decision: "block"` explicite peut bloquer
//!     un Stop (bornée à [`MAX_STOP_BLOCKS`] blocs consécutifs).

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;

use super::exec;
use super::policy::ExecutionProfile;
use super::{persist_and_emit, AgentEvent};

// ────────────────────────────────────────────────────────────────────────
// Events
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HookEvent {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    PreCompact,
    Stop,
}

impl HookEvent {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::SessionStart => "SessionStart",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::PreCompact => "PreCompact",
            Self::Stop => "Stop",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "SessionStart" => Some(Self::SessionStart),
            "UserPromptSubmit" => Some(Self::UserPromptSubmit),
            "PreToolUse" => Some(Self::PreToolUse),
            "PostToolUse" => Some(Self::PostToolUse),
            "PreCompact" => Some(Self::PreCompact),
            "Stop" => Some(Self::Stop),
            _ => None,
        }
    }

    /// Seuls ces events peuvent REFUSER quelque chose à la boucle.
    fn may_block(self) -> bool {
        matches!(self, Self::PreToolUse | Self::Stop)
    }

    /// `async: true` n'a de sens que pour les events non bloquants (on n'a
    /// pas besoin de leur verdict pour continuer). Ignoré sinon (documenté).
    fn async_allowed(self) -> bool {
        matches!(
            self,
            Self::SessionStart | Self::PostToolUse | Self::PreCompact
        )
    }
}

/// Borne de blocs Stop consécutifs honorés : au-delà, le run se termine
/// quand même et le dépassement est tracé (jamais de boucle infinie imposée
/// par un hook).
pub(crate) const MAX_STOP_BLOCKS: u32 = 3;

/// Timeout par défaut d'un hook (secondes) quand la config ne le précise pas.
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Borne haute du timeout configurable (un hook n'est pas un démon).
const MAX_TIMEOUT_SECS: u64 = 120;
/// Borne de l'input outil embarqué dans le payload stdin (reste petit, v1).
const MAX_TOOL_INPUT_CHARS: usize = 4000;

/// Les hooks ne tournent QUE dans les profils mutants (jamais en Chat/Plan).
pub(crate) fn hooks_enabled_for_profile(profile: ExecutionProfile) -> bool {
    !profile.is_read_only()
}

// ────────────────────────────────────────────────────────────────────────
// Config — parsing, merge, chargement
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HookSource {
    User,
    Project,
    /// P6.7 — hook fourni par le `hooks/hooks.json` d'un plugin (scope
    /// "plugin:<name>"). Un plugin désactivé retire ses hooks atomiquement.
    Plugin(String),
}

impl HookSource {
    pub(crate) fn as_str(&self) -> String {
        match self {
            Self::User => "user".to_string(),
            Self::Project => "project".to_string(),
            Self::Plugin(name) => format!("plugin:{name}"),
        }
    }
}

/// Rend `parse_hooks_file` capable de taguer une source plugin (P6.7).
pub(crate) fn parse_hooks_file_scoped(path: &Path, source: HookSource) -> Vec<HookDef> {
    parse_hooks_file(path, source)
}

#[derive(Debug, Clone)]
pub(crate) struct HookDef {
    /// Id stable (SHA-256 tronqué) — clé de l'enable/disable en Settings.
    pub id: String,
    pub event: HookEvent,
    pub matcher: Option<String>,
    matcher_re: Option<Regex>,
    pub command: String,
    pub timeout_secs: u64,
    pub async_: bool,
    pub source: HookSource,
}

/// Id stable d'un hook : 12 hex de SHA-256(source|event|matcher|command).
/// Pas de secret ici — c'est une clé d'identité pour le toggle Settings.
fn hook_id(source: &HookSource, event: HookEvent, matcher: Option<&str>, command: &str) -> String {
    let mut h = sha2::Sha256::new();
    h.update(source.as_str().as_bytes());
    h.update(b"|");
    h.update(event.as_str().as_bytes());
    h.update(b"|");
    h.update(matcher.unwrap_or("").as_bytes());
    h.update(b"|");
    h.update(command.as_bytes());
    let digest = h.finalize();
    digest[..6].iter().map(|b| format!("{b:02x}")).collect()
}

/// Parse un fichier hooks.json (schéma laxiste : les entrées invalides sont
/// ignorées avec un log, jamais fatales). `None` → vec vide.
fn parse_hooks_file(path: &Path, source: HookSource) -> Vec<HookDef> {
    let source = &source;
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new(); // fichier absent = pas de hooks (cas nominal)
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        eprintln!("[hooks] {} : JSON invalide — ignoré", path.display());
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in json["hooks"].as_array().into_iter().flatten() {
        let Some(event) = entry["event"].as_str().and_then(HookEvent::from_str) else {
            eprintln!(
                "[hooks] {} : event inconnu — entrée ignorée",
                path.display()
            );
            continue;
        };
        let command = entry["command"].as_str().unwrap_or("").trim().to_string();
        if command.is_empty() {
            eprintln!(
                "[hooks] {} : commande vide — entrée ignorée",
                path.display()
            );
            continue;
        }
        let matcher = entry["matcher"]
            .as_str()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_string);
        let matcher_re = matcher.as_deref().and_then(|m| match Regex::new(m) {
            Ok(re) => Some(re),
            Err(e) => {
                eprintln!(
                    "[hooks] {} : matcher regex invalide ({e}) — entrée ignorée",
                    path.display()
                );
                None
            }
        });
        if matcher.is_some() && matcher_re.is_none() {
            continue; // regex demandé mais invalide → hook ignoré (fail-safe)
        }
        let timeout_secs = entry["timeout"]
            .as_u64()
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(1, MAX_TIMEOUT_SECS);
        let mut async_ = entry["async"].as_bool().unwrap_or(false);
        if async_ && !event.async_allowed() {
            // async sur un event bloquant n'a pas de sens (on a besoin du
            // verdict) — rétrogradé en sync, documenté dans le module doc.
            async_ = false;
        }
        out.push(HookDef {
            id: hook_id(source, event, matcher.as_deref(), &command),
            event,
            matcher,
            matcher_re,
            command,
            timeout_secs,
            async_,
            source: source.clone(),
        });
    }
    out
}

/// Merge user + projet : concaténation ordonnée (user d'abord). Voir le
/// module doc pour la sémantique (pas d'override, les deux tirent).
pub(crate) fn merge_hooks(mut user: Vec<HookDef>, project: Vec<HookDef>) -> Vec<HookDef> {
    user.extend(project);
    user
}

fn user_hooks_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|home| home.join(".shugu").join("hooks.json"))
}

/// Charge les deux fichiers + les hooks des PLUGINS actifs (P6.7, source
/// "plugin:<name>") et les merge — SANS filtrer les disabled (le Settings a
/// besoin de la liste complète annotée). Ordre : user → projet → plugins.
fn load_all_hooks_with_project_trust(
    app: &AppHandle,
    workspace: Option<&Path>,
    allow_project: bool,
) -> Vec<HookDef> {
    let user = user_hooks_path()
        .map(|p| parse_hooks_file(&p, HookSource::User))
        .unwrap_or_default();
    let project = workspace
        .filter(|_| allow_project)
        .map(|ws| parse_hooks_file(&ws.join(".shugu").join("hooks.json"), HookSource::Project))
        .unwrap_or_default();
    let mut merged = merge_hooks(user, project);
    merged.extend(super::plugins::enabled_plugins_hooks_with_project_trust(
        app,
        workspace,
        allow_project,
    ));
    merged
}

fn load_all_hooks(app: &AppHandle, workspace: Option<&Path>) -> Vec<HookDef> {
    let allow_project =
        workspace.is_some_and(|root| crate::commands::project_trust::is_trusted(app, root));
    load_all_hooks_with_project_trust(app, workspace, allow_project)
}

/// Ids des hooks désactivés (table `settings`, clé `hooks.disabled` = JSON
/// array). Jamais fatale : illisible ⇒ rien n'est désactivé.
pub(crate) fn disabled_hook_ids(app: &AppHandle) -> Vec<String> {
    crate::commands::mcp::read_setting(app, "hooks.disabled")
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn load_hooks_with_project_trust(
    app: &AppHandle,
    workspace: Option<&Path>,
    allow_project: bool,
) -> Vec<HookDef> {
    let disabled = disabled_hook_ids(app);
    load_all_hooks_with_project_trust(app, workspace, allow_project)
        .into_iter()
        .filter(|d| !disabled.contains(&d.id))
        .collect()
}

// ────────────────────────────────────────────────────────────────────────
// Payload stdin (version 1)
// ────────────────────────────────────────────────────────────────────────

/// Construit le payload JSON stdin d'un hook (helper pur — testable).
/// `tool_input` est tronqué à [`MAX_TOOL_INPUT_CHARS`] : le payload reste
/// petit par contrat (v1), le hook n'a pas besoin du contenu de fichier
/// complet pour décider.
pub(crate) fn build_payload(
    event: HookEvent,
    run_id: &str,
    workspace: Option<&Path>,
    profile: ExecutionProfile,
    tool: Option<&str>,
    tool_input: Option<&serde_json::Value>,
    tool_result_summary: Option<&str>,
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "version": 1,
        "event": event.as_str(),
        "runId": run_id,
        "workspace": workspace.map(|p| p.to_string_lossy().to_string()),
        "profile": profile.as_str(),
    });
    if let Some(tool) = tool {
        payload["tool"] = serde_json::Value::String(tool.to_string());
    }
    if let Some(input) = tool_input {
        let raw = input.to_string();
        payload["toolInput"] = if raw.chars().count() > MAX_TOOL_INPUT_CHARS {
            let preview: String = raw.chars().take(MAX_TOOL_INPUT_CHARS).collect();
            serde_json::json!({ "_truncated": true, "preview": preview })
        } else {
            input.clone()
        };
    }
    if let Some(summary) = tool_result_summary {
        payload["toolResultSummary"] = serde_json::Value::String(summary.to_string());
    }
    payload
}

// ────────────────────────────────────────────────────────────────────────
// Exécution (BLOQUANTE — appeler sous spawn_blocking)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub(crate) struct HookOutcome {
    /// "ok" | "context" | "block" | "timeout" | "error"
    pub outcome: &'static str,
    pub exit_code: i32,
    pub reason: Option<String>,
    pub additional_context: Option<String>,
    pub duration_ms: u64,
    /// Sorties bornées (logs + action « tester »).
    pub stdout: String,
    pub stderr: String,
}

/// Parse la première ligne stdout qui est un objet JSON avec au moins une clé
/// du contrat. Le reste de la sortie est ignoré côté contexte (logué ailleurs).
fn parse_hook_stdout(stdout: &str) -> Option<serde_json::Value> {
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.is_object()
            && (v.get("additionalContext").is_some()
                || v.get("decision").is_some()
                || v.get("reason").is_some())
        {
            return Some(v);
        }
    }
    None
}

fn quote_hook_input_path(raw: &str, windows: bool) -> String {
    if windows {
        // `"` est interdit dans un nom de fichier Windows. `%` reste expansé
        // même entre guillemets par cmd.exe, donc on le double.
        format!("\"{}\"", raw.replace('"', "").replace('%', "%%"))
    } else {
        // Quote POSIX littéral : ferme la quote, émet une apostrophe, rouvre.
        format!("'{}'", raw.replace('\'', "'\"'\"'"))
    }
}

/// Exécute UN hook. Réutilise `exec::run_command_direct` (sandbox LOW en Auto,
/// direct en Full Access, timeout = kill de l'arbre). Le payload JSON part sur
/// stdin via un fichier temporaire pipé (`type <file> | <command>` /
/// `cat <file> | <command>`) — le fichier vit sous
/// `<ws>/.shugu/agent-runtime/hooks/` (zone inscriptible du sandbox) et est
/// supprimé après coup.
pub(crate) fn run_hook(
    def: &HookDef,
    payload: &serde_json::Value,
    ws: &Path,
    profile: ExecutionProfile,
) -> HookOutcome {
    run_hook_cancellable(def, payload, ws, profile, None)
}

fn run_hook_cancellable(
    def: &HookDef,
    payload: &serde_json::Value,
    ws: &Path,
    profile: ExecutionProfile,
    cancelled: Option<&AtomicBool>,
) -> HookOutcome {
    let started = std::time::Instant::now();
    let hooks_dir = ws.join(".shugu").join("agent-runtime").join("hooks");
    let payload_file = hooks_dir.join(format!("input-{}.json", uuid::Uuid::new_v4()));
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = -1;
    let mut timed_out = false;

    let result = (|| -> Result<(), String> {
        std::fs::create_dir_all(&hooks_dir).map_err(|e| format!("create hooks dir: {e}"))?;
        std::fs::write(&payload_file, payload.to_string())
            .map_err(|e| format!("write hook payload: {e}"))?;
        let file_display = quote_hook_input_path(&payload_file.to_string_lossy(), cfg!(windows));
        let wrapped = if cfg!(windows) {
            format!("type {file_display} | {}", def.command)
        } else {
            format!("cat {file_display} | {}", def.command)
        };
        let res = exec::run_command_governed(
            ws,
            &wrapped,
            def.timeout_secs,
            profile.policy(),
            &[], // les hooks sont de la config utilisateur de confiance — pas de classification
            cancelled,
        );
        exit_code = res.exit_code;
        timed_out = res.timed_out;
        stdout = res.stdout;
        stderr = res.stderr;
        Ok(())
    })();
    let _ = std::fs::remove_file(&payload_file);
    let duration_ms = started.elapsed().as_millis() as u64;

    if let Err(e) = result {
        return HookOutcome {
            outcome: "error",
            exit_code,
            reason: Some(e),
            additional_context: None,
            duration_ms,
            stdout,
            stderr,
        };
    }

    let parsed = parse_hook_stdout(&stdout);
    let additional_context = parsed
        .as_ref()
        .and_then(|v| v["additionalContext"].as_str())
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    let decision = parsed
        .as_ref()
        .and_then(|v| v["decision"].as_str())
        .unwrap_or("");
    let reason = parsed
        .as_ref()
        .and_then(|v| v["reason"].as_str())
        .map(str::to_string);

    // Verdict, dans l'ordre de sévérité :
    //   1. timeout   — PreToolUse ⇒ block (fail-closed) ; ailleurs fail-open.
    //   2. exit != 0 — idem.
    //   3. decision:"block" — honorée seulement pour les events qui peuvent
    //      bloquer (PreToolUse / Stop).
    if timed_out {
        return HookOutcome {
            outcome: if def.event.may_block() {
                "block"
            } else {
                "timeout"
            },
            exit_code,
            reason: Some(reason.unwrap_or_else(|| format!("hook timeout ({}s)", def.timeout_secs))),
            additional_context,
            duration_ms,
            stdout,
            stderr,
        };
    }
    if exit_code != 0 {
        return HookOutcome {
            outcome: if def.event.may_block() {
                "block"
            } else {
                "error"
            },
            exit_code,
            reason: Some(reason.unwrap_or_else(|| format!("hook exit {exit_code} (fail-closed)"))),
            additional_context,
            duration_ms,
            stdout,
            stderr,
        };
    }
    if decision == "block" && def.event.may_block() {
        return HookOutcome {
            outcome: "block",
            exit_code,
            reason: Some(reason.unwrap_or_else(|| "bloqué par le hook".to_string())),
            additional_context,
            duration_ms,
            stdout,
            stderr,
        };
    }
    HookOutcome {
        outcome: if additional_context.is_some() {
            "context"
        } else {
            "ok"
        },
        exit_code,
        reason,
        additional_context,
        duration_ms,
        stdout,
        stderr,
    }
}

fn trust_revoked_outcome() -> HookOutcome {
    HookOutcome {
        outcome: "error",
        exit_code: 130,
        reason: Some("hook interrompu : workspace changé ou confiance révoquée".to_string()),
        additional_context: None,
        duration_ms: 0,
        stdout: String::new(),
        stderr: String::new(),
    }
}

/// Exécute un hook sous surveillance de la racine approuvée. Le poll est
/// volontairement court : `run_command_governed` tue tout l'arbre au prochain
/// check de son token, y compris pour un hook `async` détaché.
fn run_hook_guarded(
    app: &AppHandle,
    def: &HookDef,
    payload: &serde_json::Value,
    ws: &Path,
    profile: ExecutionProfile,
    trust_root: Option<&Path>,
) -> HookOutcome {
    let Some(trust_root) = trust_root else {
        return run_hook(def, payload, ws, profile);
    };
    if crate::commands::project_trust::require_current_trusted_root(app, trust_root).is_err() {
        return trust_revoked_outcome();
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let app_for_monitor = app.clone();
    let root_for_monitor = trust_root.to_path_buf();
    let cancelled_for_monitor = cancelled.clone();
    let done_for_monitor = done.clone();
    let monitor = std::thread::spawn(move || {
        while !done_for_monitor.load(Ordering::Acquire) {
            if crate::commands::project_trust::require_current_trusted_root(
                &app_for_monitor,
                &root_for_monitor,
            )
            .is_err()
            {
                cancelled_for_monitor.store(true, Ordering::Release);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    });
    let mut outcome =
        run_hook_cancellable(def, payload, ws, profile, Some(cancelled.as_ref()));
    done.store(true, Ordering::Release);
    let _ = monitor.join();
    if cancelled.load(Ordering::Acquire) {
        outcome.outcome = "error";
        outcome.exit_code = 130;
        outcome.reason =
            Some("hook interrompu : workspace changé ou confiance révoquée".to_string());
        outcome.additional_context = None;
    }
    outcome
}

// ────────────────────────────────────────────────────────────────────────
// Orchestration pour le runner — fire + trace `hookFired`
// ────────────────────────────────────────────────────────────────────────

/// Ce que la boucle récupère après avoir tiré les hooks d'un event.
#[derive(Debug, Default)]
pub(crate) struct FireResult {
    /// Contextes `additionalContext` à injecter (ordre user → projet).
    pub contexts: Vec<String>,
    /// Première raison de bloc (PreToolUse / Stop) — court-circuit.
    pub blocked_reason: Option<String>,
}

/// Rapport complet d'un `fire_core` : le verdict pour la boucle + la liste
/// des exécutions (pour la trace `hookFired`, émise par l'appelant qui, lui,
/// a un AppHandle — `fire_core` reste testable sans AppHandle).
#[derive(Debug, Default)]
pub(crate) struct FireReport {
    pub result: FireResult,
    pub fired: Vec<(HookDef, HookOutcome)>,
}

const MAX_EVENT_COMMAND_CHARS: usize = 200;
const MAX_EVENT_CONTEXT_CHARS: usize = 2000;

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

fn emit_hook_fired(
    app: &AppHandle,
    agent_id: &str,
    def: &HookDef,
    outcome: &HookOutcome,
    tool: Option<&str>,
) {
    let _ = persist_and_emit(
        app,
        &AgentEvent::HookFired {
            agent_id: agent_id.to_string(),
            hook_event: def.event.as_str().to_string(),
            command: truncate(&def.command, MAX_EVENT_COMMAND_CHARS),
            source: def.source.as_str(),
            outcome: outcome.outcome.to_string(),
            duration_ms: outcome.duration_ms,
            reason: outcome.reason.clone(),
            injected_context: outcome
                .additional_context
                .as_deref()
                .map(|c| truncate(c, MAX_EVENT_CONTEXT_CHARS)),
            tool: tool.map(str::to_string),
        },
    );
}

/// Cœur de `fire` — SANS AppHandle ni émission d'events (testable). Renvoie
/// le verdict pour la boucle + les exécutions à tracer. Les hooks async sont
/// EXÉCUTÉS de façon synchrone ici (le détachement est l'affaire de `fire` —
/// voir ci-dessous) : NON — par construction `fire_core` ne traite que les
/// hooks sync ; les async sont filtrés par l'appelant.
#[cfg(test)]
pub(crate) async fn fire_core(
    defs: &[HookDef],
    event: HookEvent,
    payload: serde_json::Value,
    ws: &Path,
    profile: ExecutionProfile,
    tool: Option<&str>,
) -> FireReport {
    let mut report = FireReport::default();
    for def in defs.iter().filter(|d| d.event == event && !d.async_) {
        if let (Some(matcher_tool), Some(re)) = (tool, def.matcher_re.as_ref()) {
            if !re.is_match(matcher_tool) {
                continue;
            }
        }
        let def2 = def.clone();
        let payload2 = payload.clone();
        let ws2 = ws.to_path_buf();
        let outcome =
            tokio::task::spawn_blocking(move || run_hook(&def2, &payload2, &ws2, profile))
                .await
                .unwrap_or_else(|e| HookOutcome {
                    outcome: "error",
                    exit_code: -1,
                    reason: Some(format!("hook join error: {e}")),
                    additional_context: None,
                    duration_ms: 0,
                    stdout: String::new(),
                    stderr: String::new(),
                });
        let is_block = outcome.outcome == "block";
        if is_block {
            report.result.blocked_reason = outcome
                .reason
                .clone()
                .or_else(|| Some("bloqué par un hook".to_string()));
        }
        if let Some(ctx) = outcome.additional_context.clone() {
            report.result.contexts.push(ctx);
        }
        report.fired.push((def.clone(), outcome));
        if is_block {
            break; // premier block gagne — les hooks suivants ne tirent pas
        }
    }
    report
}

/// Tire les hooks d'un event : sync via [`fire_core`] (verdict + trace),
/// async détachés (tracés à leur terminaison, sans contexte collecté).
pub(crate) async fn fire(
    app: &AppHandle,
    defs: &[HookDef],
    event: HookEvent,
    payload: serde_json::Value,
    ws: &Path,
    profile: ExecutionProfile,
    agent_id: &str,
    tool: Option<&str>,
    trust_root: Option<&Path>,
) -> FireResult {
    // Hooks async : détachés, trace à la fin.
    for def in defs.iter().filter(|d| d.event == event && d.async_) {
        if let (Some(matcher_tool), Some(re)) = (tool, def.matcher_re.as_ref()) {
            if !re.is_match(matcher_tool) {
                continue;
            }
        }
        if trust_root.is_some_and(|root| {
            crate::commands::project_trust::require_current_trusted_root(app, root).is_err()
        }) {
            break;
        }
        let app2 = app.clone();
        let def2 = def.clone();
        let payload2 = payload.clone();
        let ws2 = ws.to_path_buf();
        let agent2 = agent_id.to_string();
        let tool2 = tool.map(str::to_string);
        let trust_root2 = trust_root.map(Path::to_path_buf);
        std::thread::spawn(move || {
            let outcome = run_hook_guarded(
                &app2,
                &def2,
                &payload2,
                &ws2,
                profile,
                trust_root2.as_deref(),
            );
            emit_hook_fired(&app2, &agent2, &def2, &outcome, tool2.as_deref());
        });
    }
    let mut report = FireReport::default();
    for def in defs.iter().filter(|d| d.event == event && !d.async_) {
        if let (Some(matcher_tool), Some(re)) = (tool, def.matcher_re.as_ref()) {
            if !re.is_match(matcher_tool) {
                continue;
            }
        }
        if trust_root.is_some_and(|root| {
            crate::commands::project_trust::require_current_trusted_root(app, root).is_err()
        }) {
            break;
        }
        let app2 = app.clone();
        let def2 = def.clone();
        let payload2 = payload.clone();
        let ws2 = ws.to_path_buf();
        let trust_root2 = trust_root.map(Path::to_path_buf);
        let outcome = tokio::task::spawn_blocking(move || {
            run_hook_guarded(
                &app2,
                &def2,
                &payload2,
                &ws2,
                profile,
                trust_root2.as_deref(),
            )
        })
        .await
        .unwrap_or_else(|error| HookOutcome {
            outcome: "error",
            exit_code: -1,
            reason: Some(format!("hook join error: {error}")),
            additional_context: None,
            duration_ms: 0,
            stdout: String::new(),
            stderr: String::new(),
        });
        let is_block = outcome.outcome == "block";
        if is_block {
            report.result.blocked_reason = outcome
                .reason
                .clone()
                .or_else(|| Some("bloqué par un hook".to_string()));
        }
        if let Some(context) = outcome.additional_context.clone() {
            report.result.contexts.push(context);
        }
        report.fired.push((def.clone(), outcome));
        if is_block {
            break;
        }
    }
    for (def, outcome) in &report.fired {
        emit_hook_fired(app, agent_id, def, outcome, tool);
    }
    report.result
}

/// Trace manuelle d'un verdict calculé par la boucle (pas par un hook) —
/// utilisée pour le dépassement de la borne Stop (`block-ignored`).
pub(crate) fn emit_stop_block_ignored(app: &AppHandle, agent_id: &str, reason: &str) {
    let _ = persist_and_emit(
        app,
        &AgentEvent::HookFired {
            agent_id: agent_id.to_string(),
            hook_event: HookEvent::Stop.as_str().to_string(),
            command: String::new(),
            source: String::new(),
            outcome: "block-ignored".to_string(),
            duration_ms: 0,
            reason: Some(reason.to_string()),
            injected_context: None,
            tool: None,
        },
    );
}

/// Décision pure de la borne Stop : honorons-nous encore un bloc ?
pub(crate) fn should_honor_stop_block(consecutive_blocks: u32) -> bool {
    consecutive_blocks < MAX_STOP_BLOCKS
}

// ────────────────────────────────────────────────────────────────────────
// Commandes Tauri (Settings « Hooks »)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    pub id: String,
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    pub timeout_secs: u64,
    pub async_: bool,
    pub source: String,
    pub disabled: bool,
}

fn workspace_root(app: &AppHandle) -> Option<PathBuf> {
    super::runner::get_workspace_root(app)
}

/// Liste complète des hooks (user + projet), annotée disabled — pour la
/// section Settings « Hooks ».
#[tauri::command]
pub async fn hooks_list(app: AppHandle) -> Result<Vec<HookInfo>, String> {
    let ws = workspace_root(&app);
    let disabled = disabled_hook_ids(&app);
    Ok(load_all_hooks(&app, ws.as_deref())
        .into_iter()
        .map(|d| HookInfo {
            id: d.id.clone(),
            event: d.event.as_str().to_string(),
            matcher: d.matcher.clone(),
            command: d.command,
            timeout_secs: d.timeout_secs,
            async_: d.async_,
            source: d.source.as_str(),
            disabled: disabled.contains(&d.id),
        })
        .collect())
}

/// Active/désactive un hook (persisté dans `settings.hooks.disabled` — on ne
/// réécrit JAMAIS le hooks.json de l'utilisateur). Renvoie la liste à jour.
#[tauri::command]
pub async fn hooks_set_disabled(
    app: AppHandle,
    id: String,
    disabled: bool,
) -> Result<Vec<String>, String> {
    let mut ids = disabled_hook_ids(&app);
    if disabled && !ids.contains(&id) {
        ids.push(id.clone());
    } else if !disabled {
        ids.retain(|x| x != &id);
    }
    let raw = serde_json::to_string(&ids).map_err(|e| format!("serialize disabled: {e}"))?;
    let conn_mutex = super::get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('hooks.disabled', ?1, ?2)",
        rusqlite::params![raw, super::now_ms()],
    )
    .map_err(|e| format!("write hooks.disabled: {e}"))?;
    Ok(ids)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookTestResult {
    pub outcome: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

/// « Tester » un hook contre un payload d'exemple (même exécution confinée
/// qu'en production — sandbox Auto). Ne tire AUCUN event de run.
#[tauri::command]
pub async fn hooks_test(app: AppHandle, id: String) -> Result<HookTestResult, String> {
    let ws = workspace_root(&app).ok_or_else(|| "aucun workspace ouvert".to_string())?;
    let def = load_all_hooks(&app, Some(&ws))
        .into_iter()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("hook introuvable: {id}"))?;
    let payload = build_payload(
        def.event,
        "hook-test",
        Some(&ws),
        ExecutionProfile::Auto,
        Some("fs_write_file"),
        Some(&serde_json::json!({"path": "exemple.txt", "content": "exemple"})),
        Some("[exit 0]\nexemple de résultat"),
    );
    let def2 = def.clone();
    let outcome =
        tokio::task::spawn_blocking(move || run_hook(&def2, &payload, &ws, ExecutionProfile::Auto))
            .await
            .map_err(|e| format!("hook test join: {e}"))?;
    Ok(HookTestResult {
        outcome: outcome.outcome.to_string(),
        exit_code: outcome.exit_code,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        duration_ms: outcome.duration_ms,
    })
}

// ────────────────────────────────────────────────────────────────────────
// Tests — config/payload (purs) + fixtures cmd /c (Windows) pour
// l'exécution, le fail-closed/open, le timeout et la livraison stdin.
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_ws(tag: &str) -> PathBuf {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "shugu-hooks-test-{tag}-{}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp ws");
        dir
    }

    fn def(event: HookEvent, command: &str) -> HookDef {
        HookDef {
            id: hook_id(&HookSource::Project, event, None, command),
            event,
            matcher: None,
            matcher_re: None,
            command: command.to_string(),
            timeout_secs: 5,
            async_: false,
            source: HookSource::Project,
        }
    }

    fn def_with_timeout(event: HookEvent, command: &str, timeout: u64) -> HookDef {
        HookDef {
            timeout_secs: timeout,
            ..def(event, command)
        }
    }

    fn payload_for(event: HookEvent, ws: &Path) -> serde_json::Value {
        build_payload(
            event,
            "run-test",
            Some(ws),
            ExecutionProfile::FullAccess,
            None,
            None,
            None,
        )
    }

    #[test]
    fn hook_payload_path_is_quoted_for_each_shell() {
        assert_eq!(
            quote_hook_input_path(r"C:\repo\%TEMP%\input.json", true),
            r#""C:\repo\%%TEMP%%\input.json""#
        );
        assert_eq!(
            quote_hook_input_path("/tmp/a'$(touch pwn)/input.json", false),
            r#"'/tmp/a'"'"'$(touch pwn)/input.json'"#
        );
    }

    // ── Config : parsing, merge, bornes ────────────────────────────────

    #[test]
    fn parse_and_merge_config_user_then_project() {
        let ws = temp_ws("merge");
        let user_dir = ws.join("user");
        let proj_dir = ws.join("proj");
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::create_dir_all(&proj_dir).unwrap();
        let user_path = user_dir.join("hooks.json");
        let proj_path = proj_dir.join("hooks.json");
        std::fs::write(
            &user_path,
            r#"{"hooks":[
                {"event":"PreToolUse","matcher":"fs_write_.*","command":"guard-user","timeout":10},
                {"event":"Bogus","command":"ignored"},
                {"event":"PostToolUse","command":""},
                {"event":"Stop","command":"stop-user","async":true}
            ]}"#,
        )
        .unwrap();
        std::fs::write(
            &proj_path,
            r#"{"hooks":[
                {"event":"PostToolUse","command":"notify-proj","async":true},
                {"event":"PreToolUse","command":"guard-proj","matcher":"not a regex (((","timeout":9999}
            ]}"#,
        )
        .unwrap();

        let user = parse_hooks_file(&user_path, HookSource::User);
        let project = parse_hooks_file(&proj_path, HookSource::Project);

        // User : 2 valides (Bogus ignoré, commande vide ignorée). L'async sur
        // Stop (event bloquant) est rétrogradé en sync.
        assert_eq!(user.len(), 2);
        assert_eq!(user[0].event, HookEvent::PreToolUse);
        assert_eq!(user[0].timeout_secs, 10);
        assert!(user[0].matcher_re.is_some());
        assert_eq!(user[1].event, HookEvent::Stop);
        assert!(!user[1].async_, "async ignoré sur un event bloquant");

        // Projet : 1 valide (regex invalide → entrée écartée ; l'autre valide).
        assert_eq!(project.len(), 1);
        assert_eq!(project[0].event, HookEvent::PostToolUse);
        assert!(
            project[0].async_,
            "async conservé sur un event non bloquant"
        );

        // Merge : user d'abord, projet ensuite (les deux tirent).
        let merged = merge_hooks(user, project);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].source, HookSource::User);
        assert_eq!(merged[2].source, HookSource::Project);

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn timeout_is_clamped_to_bounds() {
        let ws = temp_ws("clamp");
        let p = ws.join("hooks.json");
        std::fs::write(
            &p,
            r#"{"hooks":[
                {"event":"Stop","command":"a","timeout":9999},
                {"event":"Stop","command":"b","timeout":0},
                {"event":"Stop","command":"c"}
            ]}"#,
        )
        .unwrap();
        let defs = parse_hooks_file(&p, HookSource::Project);
        assert_eq!(defs[0].timeout_secs, MAX_TIMEOUT_SECS);
        assert_eq!(defs[1].timeout_secs, 1);
        assert_eq!(defs[2].timeout_secs, DEFAULT_TIMEOUT_SECS);
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn hook_id_is_stable_and_source_scoped() {
        let a = hook_id(&HookSource::User, HookEvent::PreToolUse, None, "cmd");
        let b = hook_id(&HookSource::User, HookEvent::PreToolUse, None, "cmd");
        let c = hook_id(&HookSource::Project, HookEvent::PreToolUse, None, "cmd");
        assert_eq!(a, b, "id déterministe (survit au reload)");
        assert_ne!(a, c, "la source fait partie de l'identité");
        assert_eq!(a.len(), 12);
    }

    // ── Payload ────────────────────────────────────────────────────────

    #[test]
    fn build_payload_is_versioned_small_and_truncated() {
        let ws = temp_ws("payload");
        let big = "x".repeat(MAX_TOOL_INPUT_CHARS * 2);
        let p = build_payload(
            HookEvent::PreToolUse,
            "run-1",
            Some(&ws),
            ExecutionProfile::Auto,
            Some("fs_write_file"),
            Some(&serde_json::json!({"path":"a.txt","content": big})),
            None,
        );
        assert_eq!(p["version"], serde_json::json!(1));
        assert_eq!(p["event"], serde_json::json!("PreToolUse"));
        assert_eq!(p["runId"], serde_json::json!("run-1"));
        assert_eq!(p["profile"], serde_json::json!("auto"));
        assert_eq!(p["tool"], serde_json::json!("fs_write_file"));
        assert_eq!(p["toolInput"]["_truncated"], serde_json::json!(true));
        let preview = p["toolInput"]["preview"].as_str().unwrap();
        assert_eq!(preview.chars().count(), MAX_TOOL_INPUT_CHARS);

        let small = build_payload(
            HookEvent::Stop,
            "run-1",
            None,
            ExecutionProfile::Plan,
            None,
            None,
            None,
        );
        assert_eq!(small["profile"], serde_json::json!("plan"));
        assert!(small.get("tool").is_none());
        let _ = std::fs::remove_dir_all(&ws);
    }

    // ── Gates pures ────────────────────────────────────────────────────

    #[test]
    fn profile_gate_and_stop_bound_are_pure() {
        assert!(!hooks_enabled_for_profile(ExecutionProfile::Chat));
        assert!(!hooks_enabled_for_profile(ExecutionProfile::Plan));
        assert!(hooks_enabled_for_profile(ExecutionProfile::Auto));
        assert!(hooks_enabled_for_profile(ExecutionProfile::FullAccess));

        assert!(should_honor_stop_block(0));
        assert!(should_honor_stop_block(MAX_STOP_BLOCKS - 1));
        assert!(!should_honor_stop_block(MAX_STOP_BLOCKS));
        assert!(!should_honor_stop_block(MAX_STOP_BLOCKS + 1));
    }

    // ── Exécution (fixtures cmd /c — Windows) ──────────────────────────

    #[test]
    fn hook_stdout_json_context_and_block_decision() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("exec1");

        // additionalContext → outcome "context", contexte collecté.
        let d = def(
            HookEvent::PostToolUse,
            "@echo {\"additionalContext\":\"ctx-abc\"}",
        );
        let out = run_hook(
            &d,
            &payload_for(d.event, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(out.outcome, "context");
        assert_eq!(out.additional_context.as_deref(), Some("ctx-abc"));
        assert_eq!(out.exit_code, 0);

        // decision:block honorée pour PreToolUse, avec la raison.
        let d = def(
            HookEvent::PreToolUse,
            "@echo {\"decision\":\"block\",\"reason\":\"interdit ici\"}",
        );
        let out = run_hook(
            &d,
            &payload_for(d.event, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(out.outcome, "block");
        assert_eq!(out.reason.as_deref(), Some("interdit ici"));

        // La MÊME decision sur PostToolUse n'est PAS honorée (fail-open).
        let d = def(HookEvent::PostToolUse, "@echo {\"decision\":\"block\"}");
        let out = run_hook(
            &d,
            &payload_for(d.event, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(
            out.outcome, "ok",
            "decision block ignorée hors PreToolUse/Stop"
        );

        // Stdout non-JSON → pas de contexte, outcome ok (loggé ailleurs).
        let d = def(HookEvent::SessionStart, "@echo bonjour tout le monde");
        let out = run_hook(
            &d,
            &payload_for(d.event, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(out.outcome, "ok");
        assert!(out.additional_context.is_none());

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn hook_exit_code_fail_closed_for_pretooluse_fail_open_elsewhere() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("exec2");

        let d = def(HookEvent::PreToolUse, "@exit 1");
        let out = run_hook(
            &d,
            &payload_for(d.event, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(
            out.outcome, "block",
            "exit!=0 en PreToolUse = block (fail-closed)"
        );
        assert_eq!(out.exit_code, 1);

        let d = def(HookEvent::PostToolUse, "@exit 1");
        let out = run_hook(
            &d,
            &payload_for(d.event, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(
            out.outcome, "error",
            "exit!=0 ailleurs = log, on continue (fail-open)"
        );

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn hook_timeout_fail_closed_for_pretooluse_fail_open_elsewhere() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("exec3");
        // ping -n 4 ≈ 3 s ; timeout 1 s ⇒ kill de l'arbre.
        let slow = "ping -n 4 127.0.0.1 >nul";

        let d = def_with_timeout(HookEvent::PreToolUse, slow, 1);
        let out = run_hook(
            &d,
            &payload_for(d.event, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(
            out.outcome, "block",
            "timeout en PreToolUse = block (fail-closed)"
        );
        assert!(out.reason.unwrap().contains("timeout"));

        let d = def_with_timeout(HookEvent::PostToolUse, slow, 1);
        let out = run_hook(
            &d,
            &payload_for(d.event, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(out.outcome, "timeout", "timeout ailleurs = fail-open");

        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn hook_receives_payload_json_on_stdin() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("stdin");
        // findstr cherche le mot dans stdin : exit 0 si trouvé, 1 sinon.
        let d = def(HookEvent::PreToolUse, "findstr PreToolUse");
        let out = run_hook(
            &d,
            &payload_for(HookEvent::PreToolUse, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(out.exit_code, 0, "le payload JSON arrive bien sur stdin");

        let out2 = run_hook(
            &d,
            &payload_for(HookEvent::SessionStart, &ws),
            &ws,
            ExecutionProfile::FullAccess,
        );
        assert_eq!(
            out2.exit_code, 1,
            "un autre event n'est pas dans le payload"
        );

        // Le fichier payload temporaire est nettoyé après exécution.
        let leftovers = ws.join(".shugu").join("agent-runtime").join("hooks");
        let n = std::fs::read_dir(&leftovers)
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(n, 0, "pas de fichier payload résiduel");

        let _ = std::fs::remove_dir_all(&ws);
    }

    // ── Orchestration (fire_core) + visibilité tour suivant ────────────

    #[tokio::test]
    async fn fire_core_matches_tools_and_short_circuits_on_block() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("fire");
        let mut guard = def(
            HookEvent::PreToolUse,
            "@echo {\"decision\":\"block\",\"reason\":\"stop-ici\"}",
        );
        guard.matcher = Some("fs_write_.*".to_string());
        guard.matcher_re = Some(regex::Regex::new("fs_write_.*").unwrap());
        let second = def(
            HookEvent::PreToolUse,
            "@echo {\"additionalContext\":\"jamais vu\"}",
        );
        let defs = vec![guard, second];

        // Outil matché → block, et le second hook NE TIRE PAS (court-circuit).
        let report = fire_core(
            &defs,
            HookEvent::PreToolUse,
            payload_for(HookEvent::PreToolUse, &ws),
            &ws,
            ExecutionProfile::FullAccess,
            Some("fs_write_file"),
        )
        .await;
        assert_eq!(report.result.blocked_reason.as_deref(), Some("stop-ici"));
        assert_eq!(report.fired.len(), 1, "court-circuit au premier block");

        // Outil NON matché par le guard → seul le hook sans matcher tire.
        let report = fire_core(
            &defs,
            HookEvent::PreToolUse,
            payload_for(HookEvent::PreToolUse, &ws),
            &ws,
            ExecutionProfile::FullAccess,
            Some("run_command"),
        )
        .await;
        assert!(report.result.blocked_reason.is_none());
        assert_eq!(report.fired.len(), 1);
        assert_eq!(
            report.result.contexts,
            vec!["jamais vu".to_string()],
            "le hook sans matcher fournit son contexte"
        );

        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Simule le point 6.5 de la boucle : PostToolUse additionalContext →
    /// message user dans l'historique → VISIBLE dans la requête provider du
    /// tour suivant (harnais loopback, pattern du lot 1).
    #[tokio::test]
    async fn post_tool_context_reaches_next_provider_request() {
        if !cfg!(windows) {
            return;
        }
        use crate::commands::agents::runner::{build_openai_messages, AgentMessage};
        use crate::commands::chat::call_openai_compat_structured;

        let ws = temp_ws("ctxloop");
        let hook = def(
            HookEvent::PostToolUse,
            "@echo {\"additionalContext\":\"contexte-du-hook-42\"}",
        );
        let defs = vec![hook];

        // 1. Fire PostToolUse (comme la boucle après les résultats d'outils).
        let report = fire_core(
            &defs,
            HookEvent::PostToolUse,
            build_payload(
                HookEvent::PostToolUse,
                "run-1",
                Some(&ws),
                ExecutionProfile::FullAccess,
                Some("fs_list_dir"),
                None,
                Some("ok"),
            ),
            &ws,
            ExecutionProfile::FullAccess,
            Some("fs_list_dir"),
        )
        .await;
        assert_eq!(
            report.result.contexts,
            vec!["contexte-du-hook-42".to_string()]
        );

        // 2. Injection dans l'historique (ce que la boucle fait à 6.5).
        let mut history = vec![
            AgentMessage::Text {
                role: "system".into(),
                content: "agent".into(),
            },
            AgentMessage::Text {
                role: "user".into(),
                content: "tâche".into(),
            },
        ];
        for ctx in report.result.contexts {
            history.push(AgentMessage::Text {
                role: "user".to_string(),
                content: format!("[Shugu hook PostToolUse] {ctx}"),
            });
        }

        // 3. Le provider du tour suivant REÇOIT le contexte du hook.
        let (base_url, server) = start_capture_server().await;
        let client = reqwest::Client::new();
        let _ = call_openai_compat_structured(
            &client,
            &base_url,
            "fake-gpt",
            build_openai_messages(&history),
            "test-key",
            "openai",
            &None,
            true,
            None,
            None,
            None,
            &mut |_, _| {},
        )
        .await
        .expect("provider call");
        let request = server.await.expect("server join");
        assert!(
            request.contains("contexte-du-hook-42"),
            "le contexte PostToolUse est visible dans la requête du tour suivant"
        );

        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Petit serveur one-shot : capture la requête brute, répond un SSE minimal.
    async fn start_capture_server() -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = Vec::new();
            let mut tmp = [0u8; 16384];
            let header_end = loop {
                let n = socket.read(&mut tmp).await.expect("read");
                assert!(n > 0);
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break pos + 4;
                }
            };
            let headers = String::from_utf8_lossy(&buf[..header_end]);
            let content_length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().ok())
                        .flatten()
                })
                .expect("content-length");
            while buf.len() < header_end + content_length {
                let n = socket.read(&mut tmp).await.expect("read body");
                assert!(n > 0);
                buf.extend_from_slice(&tmp[..n]);
            }
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.expect("write");
            String::from_utf8_lossy(&buf).to_string()
        });
        (format!("http://{addr}"), server)
    }
}
