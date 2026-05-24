//! Measurement bench (banc de mesure) for the self-evolving harness.
//!
//! Replays a FIXED suite of tasks against a PINNED harness generation, on a
//! COPIED fixture workspace (never the user's real project), judges each run
//! with a NON-executing verifier, and records the verdict in `bench_runs`. A
//! later generation can then be A/B-compared against gen 0 on the SAME suite —
//! the legibility spine that lets a human SEE whether self-evolution helped.
//!
//! ## v1 scope (deliberate)
//! Verifiers do NOT execute agent-generated code — `files` checks file presence
//! and substring content only. Executing produced code needs a real sandbox
//! (a later lot); running it here would be the exact unsupervised-execution risk
//! the safety doctrine (axis 1) forbids.
//!
//! ## Why a dedicated run path
//! The bench calls [`tool_use_loop`] directly (not `run_agent_task`) so it can
//! pin a generation + redirect the workspace WITHOUT the agent-lifecycle
//! ceremony, and crucially it records into `bench_runs` only — it never writes
//! `agent_outcomes`, so the bench never pollutes the real per-generation metrics.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use super::runner::{
    get_workspace_root, load_active_harness, load_harness_generation, tool_use_loop, AgentMessage,
    LoopMetrics,
};
use super::{get_conn, now_ms};

// ────────────────────────────────────────────────────────────────────
// Serializable shapes returned to the frontend
// ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchTaskRow {
    pub id: String,
    pub role: String,
    pub domain: String,
    pub title: String,
    pub prompt: String,
    pub verifier_kind: String,
    pub enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchRunSummary {
    pub task_id: String,
    pub title: String,
    pub passed: bool,
    pub detail: String,
    pub ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchSuiteResult {
    pub suite_run_id: String,
    pub role: String,
    pub generation: i64,
    pub total: usize,
    pub passed: usize,
    pub results: Vec<BenchRunSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchTaskCompare {
    pub task_id: String,
    pub title: String,
    /// `None` = that generation has no recorded run for this task yet.
    pub passed_a: Option<bool>,
    pub passed_b: Option<bool>,
    /// Passed in A but fails in B — the signal that self-evolution regressed.
    pub regression: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchComparison {
    pub role: String,
    pub generation_a: i64,
    pub generation_b: i64,
    pub a_passed: usize,
    pub b_passed: usize,
    pub total: usize,
    pub regressions: usize,
    pub tasks: Vec<BenchTaskCompare>,
}

/// Live per-task progress, broadcast on the `bench://progress` channel while a
/// suite runs so the panel is never a dark room: each task fires `running` when
/// it starts and `done` (with the verdict) when it finishes. Deliberately
/// per-TASK, not per-tool-call — each task is minutes of a reasoning model, and
/// streaming every tool call would bury the only signal that matters (which
/// task, pass or fail) under noise.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BenchProgress {
    suite_run_id: String,
    index: usize,
    total: usize,
    task_id: String,
    title: String,
    /// "running" | "done"
    phase: String,
    passed: Option<bool>,
    detail: Option<String>,
    ms: Option<i64>,
}

/// Best-effort emit — a dropped progress event must never fail a bench run.
fn emit_progress(app: &AppHandle, p: &BenchProgress) {
    let _ = app.emit("bench://progress", p);
}

// ────────────────────────────────────────────────────────────────────
// Internal: a task loaded from `bench_tasks`
// ────────────────────────────────────────────────────────────────────

struct LoadedTask {
    id: String,
    role: String,
    title: String,
    prompt: String,
    fixture_dir: Option<String>,
    verifier_kind: String,
    verifier_spec: String,
}

fn load_tasks(app: &AppHandle, role: &str) -> Result<Vec<LoadedTask>, String> {
    let conn_mutex = get_conn(app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, role, title, prompt, fixture_dir, verifier_kind, verifier_spec
               FROM bench_tasks
              WHERE role = ?1 AND enabled = 1
              ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![role], |r| {
            Ok(LoadedTask {
                id: r.get(0)?,
                role: r.get(1)?,
                title: r.get(2)?,
                prompt: r.get(3)?,
                fixture_dir: r.get(4)?,
                verifier_kind: r.get(5)?,
                verifier_spec: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ────────────────────────────────────────────────────────────────────
// Fixture copy + verifiers (NON-executing in v1)
// ────────────────────────────────────────────────────────────────────

/// Recursively copy a fixture (or a project snapshot) into a throwaway
/// workspace, PRUNING version-control, dependency caches and build outputs.
/// Skipping these is what makes mirroring a real project viable — a raw copy of
/// `node_modules/` or `target/` would be gigabytes — and it keeps `.git` (and
/// thus history) entirely out of the agent's reach. Uses the `walkdir` crate
/// already vendored for find-in-files.
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    const SKIP_DIRS: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        "out",
        ".next",
        ".turbo",
        ".svelte-kit",
        ".cache",
        "coverage",
        ".venv",
    ];
    let walker = walkdir::WalkDir::new(src).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true; // never prune the root itself
        }
        if e.file_type().is_dir() {
            return e
                .file_name()
                .to_str()
                .map(|n| !SKIP_DIRS.contains(&n))
                .unwrap_or(true);
        }
        true
    });
    for entry in walker {
        let entry = entry.map_err(std::io::Error::other)?;
        let rel = entry
            .path()
            .strip_prefix(src)
            .map_err(std::io::Error::other)?;
        let target = dst.join(rel);
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn run_verifier(kind: &str, ws: &Path, spec_json: &str) -> (bool, String) {
    let spec: Value = serde_json::from_str(spec_json).unwrap_or(Value::Null);
    match kind {
        "files" => verify_files(ws, &spec),
        other => (
            false,
            format!("unknown verifier kind '{other}' (v1 supports: files)"),
        ),
    }
}

/// `files` verifier — fully static, never executes anything. Spec shape:
/// `{ "required": ["a.ts"], "contains": [{"path": "a.ts", "substring": "foo"}] }`.
/// Refuses to pass when NO checks are defined — a measurement instrument must
/// never report a vacuous green.
fn verify_files(ws: &Path, spec: &Value) -> (bool, String) {
    let required = spec.get("required").and_then(|v| v.as_array());
    let contains = spec.get("contains").and_then(|v| v.as_array());
    if required.map_or(true, |a| a.is_empty()) && contains.map_or(true, |a| a.is_empty()) {
        return (
            false,
            "verifier 'files' has no checks (need 'required' and/or 'contains')".to_string(),
        );
    }
    let mut failures: Vec<String> = Vec::new();
    if let Some(req) = required {
        for f in req {
            if let Some(rel) = f.as_str() {
                if !ws.join(rel).is_file() {
                    failures.push(format!("missing file: {rel}"));
                }
            }
        }
    }
    if let Some(cs) = contains {
        for c in cs {
            let path = c.get("path").and_then(|v| v.as_str()).unwrap_or_default();
            let needle = c.get("substring").and_then(|v| v.as_str()).unwrap_or_default();
            match std::fs::read_to_string(ws.join(path)) {
                Ok(content) if content.contains(needle) => {}
                Ok(_) => failures.push(format!("{path} lacks substring {needle:?}")),
                Err(_) => failures.push(format!("cannot read {path}")),
            }
        }
    }
    if failures.is_empty() {
        (true, "ok".to_string())
    } else {
        (false, failures.join("; "))
    }
}

// ────────────────────────────────────────────────────────────────────
// Run one task against a pinned generation
// ────────────────────────────────────────────────────────────────────

fn record_bench_run(
    app: &AppHandle,
    suite_run_id: &str,
    task_id: &str,
    role: &str,
    generation: i64,
    agent_id: &str,
    passed: bool,
    detail: &str,
    ms: i64,
) {
    if let Ok(conn_mutex) = get_conn(app) {
        if let Ok(conn) = conn_mutex.lock() {
            let _ = conn.execute(
                "INSERT INTO bench_runs
                    (run_id, suite_run_id, task_id, role, generation, agent_id,
                     passed, score, detail, ms, ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10)",
                params![
                    Uuid::new_v4().to_string(),
                    suite_run_id,
                    task_id,
                    role,
                    generation,
                    agent_id,
                    passed as i64,
                    detail,
                    ms,
                    now_ms(),
                ],
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_one(
    app: &AppHandle,
    task: &LoadedTask,
    suite_run_id: &str,
    generation: i64,
    model: &str,
    protocol: &str,
    base_url: &str,
    api_key: &str,
) -> BenchRunSummary {
    let start = std::time::Instant::now();
    let agent_id = format!("bench-{}", Uuid::new_v4());
    let (passed, detail) =
        run_one_inner(app, task, generation, model, protocol, base_url, api_key, &agent_id).await;
    let ms = start.elapsed().as_millis() as i64;
    record_bench_run(
        app, suite_run_id, &task.id, &task.role, generation, &agent_id, passed, &detail, ms,
    );
    BenchRunSummary {
        task_id: task.id.clone(),
        title: task.title.clone(),
        passed,
        detail,
        ms,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_one_inner(
    app: &AppHandle,
    task: &LoadedTask,
    generation: i64,
    model: &str,
    protocol: &str,
    base_url: &str,
    api_key: &str,
    agent_id: &str,
) -> (bool, String) {
    let harness = match load_harness_generation(app, &task.role, generation) {
        Some(h) => h,
        None => {
            return (
                false,
                format!("generation {generation} not found for role {}", task.role),
            )
        }
    };

    // Throwaway workspace under the OS temp dir — the agent never touches the
    // user's real project (axis 1 containment).
    let ws_raw: PathBuf = std::env::temp_dir().join(format!("shugu_bench_{}", Uuid::new_v4()));
    if let Err(e) = std::fs::create_dir_all(&ws_raw) {
        return (false, format!("cannot create fixture workspace: {e}"));
    }
    // CRITICAL: the path guard (`safe_resolve` / `safe_resolve_for_write`)
    // requires a PRE-CANONICALIZED root, exactly like `fs_open_folder`. Without
    // this, on Windows the agent's canonicalized write targets (`\\?\C:\…`) fail
    // the `starts_with(root)` check against a raw temp path → EVERY file tool
    // errors with "outside the workspace" → every task fails. Canonicalize after
    // creation (canonicalize requires the path to already exist).
    let ws = match std::fs::canonicalize(&ws_raw) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&ws_raw);
            return (false, format!("cannot canonicalize fixture workspace: {e}"));
        }
    };
    if let Some(raw) = task.fixture_dir.as_deref().filter(|s| !s.trim().is_empty()) {
        // "@project" = mirror the user's CURRENTLY OPEN project: snapshot-copy it
        // into the throwaway workspace so the agent practises on REAL code without
        // ever being able to touch the real project. Any other value is a literal
        // fixture directory. Either way the real source is only READ (copied out);
        // the agent works exclusively in `ws`, which is deleted after the run.
        let src: PathBuf = if raw == "@project" {
            match get_workspace_root(app) {
                Some(root) => root,
                None => {
                    let _ = std::fs::remove_dir_all(&ws);
                    return (
                        false,
                        "no project open to mirror — open a project, then run the @project task"
                            .to_string(),
                    );
                }
            }
        } else {
            PathBuf::from(raw)
        };
        if let Err(e) = copy_dir(&src, &ws) {
            let _ = std::fs::remove_dir_all(&ws);
            return (
                false,
                format!("project mirror copy failed from {}: {e}", src.display()),
            );
        }
    }

    let mut history = vec![
        AgentMessage::Text {
            role: "system".to_string(),
            content: harness.system_prompt,
        },
        AgentMessage::Text {
            role: "user".to_string(),
            content: task.prompt.clone(),
        },
    ];
    let client = reqwest::Client::new();
    let mut metrics = LoopMetrics::default();

    let loop_result = tool_use_loop(
        app,
        &client,
        protocol,
        base_url,
        model,
        api_key,
        &None,
        agent_id,
        &task.role,
        &mut history,
        &mut metrics,
        Some(ws.clone()),
    )
    .await;

    let verdict = match loop_result {
        Ok(_) => {
            let (passed, detail) = run_verifier(&task.verifier_kind, &ws, &task.verifier_spec);
            // Legibility: if the run hit a stall (stuck_reason set) and STILL
            // failed the verifier — even after the agent tried to self-evolve —
            // surface WHY next to the verdict. "stuck:repeat — missing file
            // foo.ts" reads very differently from a bare "missing file foo.ts"
            // (which looks like the verifier is wrong, rather than the agent
            // being genuinely weak on this task).
            match (&metrics.stuck_reason, passed) {
                (Some(reason), false) => (passed, format!("stuck:{reason} — {detail}")),
                _ => (passed, detail),
            }
        }
        Err(e) => (false, format!("agent run error: {e}")),
    };

    let _ = std::fs::remove_dir_all(&ws);
    verdict
}

/// Resolve the API key for a bench run WITHOUT a key ever crossing the
/// frontend: OS keychain (where Connections saves `provider.<id>.apiKey`) →
/// env-var fallback (`resolve_key`) → empty (the LLM call then fails cleanly and
/// the task is reported as a provider error, never a false pass). Mirrors the
/// Refiner's `resolve_refiner_key`.
fn resolve_bench_key(provider_id: &str, protocol: &str) -> String {
    if !provider_id.is_empty() {
        if let Ok(Some(k)) =
            crate::commands::credentials::cred_get(format!("provider.{provider_id}.apiKey"))
        {
            if !k.is_empty() {
                return k;
            }
        }
    }
    if let Ok(k) = crate::commands::chat::resolve_key(protocol, &None) {
        if !k.is_empty() {
            return k;
        }
    }
    String::new()
}

// ────────────────────────────────────────────────────────────────────
// Tauri commands
// ────────────────────────────────────────────────────────────────────

/// Run the whole enabled suite for `role` against a single pinned `generation`.
/// Each task runs on its own copied fixture; results land in `bench_runs` under
/// one `suite_run_id`. Provider params mirror `agent_spawn` so the bench runs
/// the agent exactly as it runs for real.
#[tauri::command]
pub async fn bench_run_suite(
    app: AppHandle,
    role: String,
    generation: i64,
    model: String,
    provider_id: String,
    protocol: Option<String>,
    base_url: Option<String>,
) -> Result<BenchSuiteResult, String> {
    let tasks = load_tasks(&app, &role)?;
    // Ensure generation 0 exists for this role. Gen 0 is seeded LAZILY on the
    // first real agent run (via load_active_harness); a user may open the bench
    // before any agent of this role has run. Calling it here makes the bench
    // self-bootstrapping so "run suite on gen 0" never fails with
    // "generation not found" on a fresh install — the #1 first-run footgun.
    let _ = load_active_harness(&app, &role);
    let suite_run_id = Uuid::new_v4().to_string();
    let protocol = protocol.unwrap_or_else(|| "openai".to_string());
    let base_url = base_url.unwrap_or_default();
    // Key resolved Rust-side from the keychain by provider — never crosses the FE.
    let api_key = resolve_bench_key(&provider_id, &protocol);

    let total = tasks.len();
    let mut results = Vec::with_capacity(total);
    for (idx, task) in tasks.iter().enumerate() {
        // "running" — light up the current task BEFORE its (minutes-long) agent
        // run so the panel shows motion instead of a frozen "Exécution…" button.
        emit_progress(
            &app,
            &BenchProgress {
                suite_run_id: suite_run_id.clone(),
                index: idx + 1,
                total,
                task_id: task.id.clone(),
                title: task.title.clone(),
                phase: "running".to_string(),
                passed: None,
                detail: None,
                ms: None,
            },
        );
        let summary = run_one(
            &app,
            task,
            &suite_run_id,
            generation,
            &model,
            &protocol,
            &base_url,
            &api_key,
        )
        .await;
        // "done" — carries the verdict so the row flips to ✓/✗ the instant the
        // task finishes, without waiting for the whole suite to return.
        emit_progress(
            &app,
            &BenchProgress {
                suite_run_id: suite_run_id.clone(),
                index: idx + 1,
                total,
                task_id: task.id.clone(),
                title: task.title.clone(),
                phase: "done".to_string(),
                passed: Some(summary.passed),
                detail: Some(summary.detail.clone()),
                ms: Some(summary.ms),
            },
        );
        results.push(summary);
    }
    let passed = results.iter().filter(|r| r.passed).count();
    Ok(BenchSuiteResult {
        suite_run_id,
        role,
        generation,
        total: results.len(),
        passed,
        results,
    })
}

/// Latest pass/fail per task for a (role, generation), folded so the most
/// recent run wins.
fn latest_per_task(
    conn: &rusqlite::Connection,
    role: &str,
    generation: i64,
) -> Result<HashMap<String, bool>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT task_id, passed
               FROM bench_runs
              WHERE role = ?1 AND generation = ?2
              ORDER BY ts ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![role, generation], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0))
        })
        .map_err(|e| e.to_string())?;
    let mut map: HashMap<String, bool> = HashMap::new();
    for row in rows {
        let (task_id, passed) = row.map_err(|e| e.to_string())?;
        map.insert(task_id, passed); // later ts overwrites → latest wins
    }
    Ok(map)
}

fn task_titles(conn: &rusqlite::Connection, role: &str) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT id, title FROM bench_tasks WHERE role = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![role], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut map: HashMap<String, String> = HashMap::new();
    for row in rows {
        let (id, title) = row.map_err(|e| e.to_string())?;
        map.insert(id, title);
    }
    Ok(map)
}

/// A/B two generations on the same suite. A regression = a task that passed in
/// `generation_a` but fails in `generation_b` — the anti-regression signal the
/// harness must respect before a new generation is trusted.
#[tauri::command]
pub async fn bench_compare_generations(
    app: AppHandle,
    role: String,
    generation_a: i64,
    generation_b: i64,
) -> Result<BenchComparison, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let map_a = latest_per_task(&conn, &role, generation_a)?;
    let map_b = latest_per_task(&conn, &role, generation_b)?;
    let titles = task_titles(&conn, &role)?;

    let mut ids: BTreeSet<String> = BTreeSet::new();
    ids.extend(map_a.keys().cloned());
    ids.extend(map_b.keys().cloned());

    let mut tasks = Vec::with_capacity(ids.len());
    let (mut a_passed, mut b_passed, mut regressions) = (0usize, 0usize, 0usize);
    for id in &ids {
        let pa = map_a.get(id).copied();
        let pb = map_b.get(id).copied();
        if pa == Some(true) {
            a_passed += 1;
        }
        if pb == Some(true) {
            b_passed += 1;
        }
        let regression = pa == Some(true) && pb == Some(false);
        if regression {
            regressions += 1;
        }
        tasks.push(BenchTaskCompare {
            task_id: id.clone(),
            title: titles.get(id).cloned().unwrap_or_default(),
            passed_a: pa,
            passed_b: pb,
            regression,
        });
    }

    Ok(BenchComparison {
        role,
        generation_a,
        generation_b,
        a_passed,
        b_passed,
        total: ids.len(),
        regressions,
        tasks,
    })
}

/// List the enabled tasks for a role (the suite the user/Claude can run).
#[tauri::command]
pub async fn bench_list(app: AppHandle, role: String) -> Result<Vec<BenchTaskRow>, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, role, domain, title, prompt, verifier_kind, enabled
               FROM bench_tasks
              WHERE role = ?1
              ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![role], |r| {
            Ok(BenchTaskRow {
                id: r.get(0)?,
                role: r.get(1)?,
                domain: r.get(2)?,
                title: r.get(3)?,
                prompt: r.get(4)?,
                verifier_kind: r.get(5)?,
                enabled: r.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Register (or replace) a bench task. `verifier_spec` must be valid JSON for
/// the chosen `verifier_kind`.
#[tauri::command]
pub async fn bench_add_task(
    app: AppHandle,
    id: String,
    role: String,
    domain: String,
    title: String,
    prompt: String,
    fixture_dir: Option<String>,
    verifier_kind: String,
    verifier_spec: String,
) -> Result<(), String> {
    serde_json::from_str::<Value>(&verifier_spec)
        .map_err(|e| format!("verifier_spec must be valid JSON: {e}"))?;
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO bench_tasks
            (id, role, domain, title, prompt, fixture_dir, verifier_kind,
             verifier_spec, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)",
        params![
            id,
            role,
            domain,
            title,
            prompt,
            fixture_dir,
            verifier_kind,
            verifier_spec,
            now_ms(),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
