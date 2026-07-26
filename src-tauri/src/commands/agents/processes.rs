//! Sessions shell persistantes + processus d'arrière-plan (P6.9).
//!
//! ## Sessions (`run_command` avec `session_id`)
//!
//! Une session = un shell `cmd /d /q /k` persistant, clé `run_id + session_id`,
//! qui conserve cwd et variables d'environnement entre les commandes. Spawn :
//! Full Access → processus direct (`std::process`, Job Object pour le kill
//! d'arbre) ; Auto → spawn confiné LOW de `sandbox.rs` (même confinement que
//! `run_command`, fail-closed si le sandbox ne s'arme pas). Pas de ConPTY :
//! le token LOW exige le spawn Win32 (portable_pty ne sait pas le faire), et
//! les pipes gardent la détection de complétion triviale (pas d'ANSI à
//! décoder) — cwd/env se comportent pareil dans les deux mondes.
//!
//! ## Détection de complétion (sentinel)
//!
//! Pour chaque commande on écrit DEUX lignes dans le shell :
//!   1. la commande de l'utilisateur ;
//!   2. `echo __SHUGU_DONE_<nonce>_%ERRORLEVEL%`.
//! `%ERRORLEVEL%` est évalué quand la LIGNE 2 est parsée — donc APRÈS la fin
//! de la commande 1 (le `&&`/`&` d'une seule ligne évaluerait %ERRORLEVEL%
//! trop tôt). Le lecteur surveille le buffer drainé jusqu'au motif
//! `__SHUGU_DONE_<nonce>_(\d+)` : le code de sortie est capturé, la sortie =
//! tout ce qui précède la ligne sentinelle. Timeout wall-clock → la session
//! est tuée (arbre) et marquée morte ; la commande suivante respawne une
//! session fraîche (documenté, jamais d'entrelacement).
//!
//! ## Processus d'arrière-plan (`run_background`)
//!
//! Processus détaché (même confinement) suivi en SQLite
//! (`agent_background_processes`, V27) + registry en mémoire (buffer de
//! sortie). `read_process_output` lit la queue bornée (registry vivant ou
//! snapshot DB), `stop_process` tue l'arbre (Job Object). Un kill du run tue
//! ses sessions ET ses processus d'arrière-plan. Au boot, les lignes encore
//! `running` sont réconciliées en `interrupted` (jamais prétendues vivantes
//! — le suivi en mémoire est perdu avec le process).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::policy::{classify_with_rules, ExecutionProfile};
use super::{exec, sandbox};

// ────────────────────────────────────────────────────────────────────────
// BoundedBuffer — sortie drainée, bornée, avec compteur total
// ────────────────────────────────────────────────────────────────────────

const BUFFER_CAP: usize = 256 * 1024;
const OUTPUT_SNAPSHOT_CAP: usize = 8 * 1024;

#[derive(Default, Debug)]
pub(crate) struct BoundedBuffer {
    data: Vec<u8>,
    /// Octets cumulés depuis la création (les marqueurs de début de commande
    /// survivent à la troncature du contenu).
    total: u64,
}

impl BoundedBuffer {
    fn append(&mut self, chunk: &[u8]) {
        self.data.extend_from_slice(chunk);
        self.total += chunk.len() as u64;
        if self.data.len() > BUFFER_CAP {
            let excess = self.data.len() - BUFFER_CAP;
            self.data.drain(..excess);
        }
    }

    fn total(&self) -> u64 {
        self.total
    }

    /// Contenu UTF-8 (pertes tolérées) depuis le marqueur `since` (compteur
    /// total). Tronqué au début si le marqueur a déjà défilé hors du buffer.
    fn text_since(&self, since: u64) -> String {
        let keep = self.total.saturating_sub(self.data.len() as u64);
        let start = since.saturating_sub(keep) as usize;
        let start = start.min(self.data.len());
        String::from_utf8_lossy(&self.data[start..]).to_string()
    }

    fn tail(&self, max: usize) -> String {
        let start = self.data.len().saturating_sub(max);
        String::from_utf8_lossy(&self.data[start..]).to_string()
    }
}

fn spawn_drain(mut file: impl Read + Send + 'static, buf: Arc<Mutex<BoundedBuffer>>) {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match file.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut g) = buf.lock() {
                        g.append(&chunk[..n]);
                    }
                }
            }
        }
    });
}

// ────────────────────────────────────────────────────────────────────────
// ShellSession — cmd /q /k persistant (direct Full Access ou confiné Auto)
// ────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
type JobGuard = Option<exec::ProcessTree>;
#[cfg(not(windows))]
type JobGuard = Option<()>;

#[cfg(windows)]
fn new_job() -> JobGuard {
    exec::ProcessTree::create()
}
#[cfg(not(windows))]
fn new_job() -> JobGuard {
    None
}

struct DirectShell {
    child: Mutex<std::process::Child>,
    job: JobGuard,
}

enum ShellKind {
    Direct(DirectShell),
    #[cfg(windows)]
    Confined(sandbox::windows_impl::ConfinedShellHandle),
    #[cfg(not(windows))]
    Confined,
}

pub(crate) struct ShellSession {
    kind: ShellKind,
    stdin: Mutex<Box<dyn Write + Send>>,
    buf: Arc<Mutex<BoundedBuffer>>,
    dead: AtomicBool,
}

impl ShellSession {
    fn spawn(ws: &Path, profile: ExecutionProfile) -> Result<ShellSession, String> {
        #[cfg(windows)]
        if matches!(profile, ExecutionProfile::Auto) {
            let buf = Arc::new(Mutex::new(BoundedBuffer::default()));
            // Même fail-closed que run_command en Auto : pas de sandbox, pas de
            // session (jamais de repli direct silencieux).
            let (pid, stdin, stdout, stderr, handle) = sandbox::spawn_confined_shell(ws)
                .ok_or_else(|| {
                    "sandbox Auto indisponible : session shell non démarrée. Active Full Access explicitement pour un shell direct".to_string()
                })?
                .into_parts();
            let _ = pid;
            spawn_drain(stdout, buf.clone());
            spawn_drain(stderr, buf.clone());
            return Ok(ShellSession {
                kind: ShellKind::Confined(handle),
                stdin: Mutex::new(Box::new(stdin)),
                buf,
                dead: AtomicBool::new(false),
            });
        }
        // Full Access (ou non-Windows) : cmd /q /k direct + Job Object.
        let buf = Arc::new(Mutex::new(BoundedBuffer::default()));
        let job = new_job();
        let mut cmd = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        #[cfg(windows)]
        cmd.args(["/d", "/q", "/k"]);
        #[cfg(not(windows))]
        cmd.arg("-i");
        let mut child = cmd
            .current_dir(ws)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn session shell: {e}"))?;
        #[cfg(windows)]
        if let Some(ref j) = job {
            j.assign(&child);
        }
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "session shell sans stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "session shell sans stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "session shell sans stderr".to_string())?;
        spawn_drain(stdout, buf.clone());
        spawn_drain(stderr, buf.clone());
        Ok(ShellSession {
            kind: ShellKind::Direct(DirectShell {
                child: Mutex::new(child),
                job,
            }),
            stdin: Mutex::new(Box::new(stdin)),
            buf,
            dead: AtomicBool::new(false),
        })
    }

    fn is_dead(&self) -> bool {
        if self.dead.load(Ordering::SeqCst) {
            return true;
        }
        match &self.kind {
            ShellKind::Direct(d) => d
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok().flatten())
                .is_some(),
            #[cfg(windows)]
            ShellKind::Confined(sh) => sh.exited().is_some(),
            #[cfg(not(windows))]
            ShellKind::Confined => true,
        }
    }

    fn kill(&self) {
        if self.dead.swap(true, Ordering::SeqCst) {
            return;
        }
        match &self.kind {
            ShellKind::Direct(d) => {
                #[cfg(windows)]
                if let Some(ref j) = d.job {
                    j.terminate();
                }
                if let Ok(mut c) = d.child.lock() {
                    let _ = c.kill();
                }
            }
            #[cfg(windows)]
            ShellKind::Confined(sh) => sh.terminate(),
            #[cfg(not(windows))]
            ShellKind::Confined => {}
        }
    }

    /// Exécute `command` dans la session (sentinel de complétion, timeout
    /// wall-clock). BLOQUANT — appeler depuis un contexte spawn_blocking.
    fn exec(&self, command: &str, timeout_secs: u64) -> SessionExecResult {
        let nonce = format!("{:x}", uuid::Uuid::new_v4().as_simple());
        let sentinel = format!("__SHUGU_DONE_{nonce}_");
        let start = self.buf.lock().map(|b| b.total()).unwrap_or(0);
        {
            let Ok(mut stdin) = self.stdin.lock() else {
                return SessionExecResult {
                    exit_code: -1,
                    output: "session shell : lock stdin empoisonné".to_string(),
                    timed_out: false,
                    session_alive: true,
                };
            };
            // Deux lignes : la commande, PUIS le sentinel (%ERRORLEVEL% évalué
            // APRÈS la commande — cf. doc du module).
            let payload = format!("{command}\r\necho {sentinel}%ERRORLEVEL%\r\n");
            if let Err(e) = stdin
                .write_all(payload.as_bytes())
                .and_then(|_| stdin.flush())
            {
                self.dead.store(true, Ordering::SeqCst);
                return SessionExecResult {
                    exit_code: -1,
                    output: format!("session shell mort (écriture stdin : {e})"),
                    timed_out: false,
                    session_alive: false,
                };
            }
        }

        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            let text = self
                .buf
                .lock()
                .map(|b| b.text_since(start))
                .unwrap_or_default();
            if let Some(pos) = text.find(&sentinel) {
                let after = &text[pos + sentinel.len()..];
                let code: i32 = after
                    .trim_start()
                    .chars()
                    .take_while(|c| c.is_ascii_digit() || *c == '-')
                    .collect::<String>()
                    .parse()
                    .unwrap_or(-1);
                // Sortie = tout avant la ligne sentinelle (la commande elle-même
                // n'est pas échouée par cmd /q).
                let output = text[..pos].trim_end_matches(['\r', '\n']).to_string();
                return SessionExecResult {
                    exit_code: code,
                    output,
                    timed_out: false,
                    session_alive: true,
                };
            }
            if Instant::now() >= deadline {
                // Timeout : on TUE la session (arbre) — la suivante respawne une
                // session fraîche au lieu d'entrelacer deux commandes.
                self.kill();
                return SessionExecResult {
                    exit_code: 124,
                    output: text,
                    timed_out: true,
                    session_alive: false,
                };
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    }
}

pub(crate) struct SessionExecResult {
    pub exit_code: i32,
    pub output: String,
    pub timed_out: bool,
    pub session_alive: bool,
}

// ────────────────────────────────────────────────────────────────────────
// Registries (Tauri-managed state)
// ────────────────────────────────────────────────────────────────────────

/// Sessions persistantes, clé `{run_id}:{session_id}`. Meurent avec leur run.
#[derive(Default)]
pub struct SessionRegistry(pub Arc<Mutex<HashMap<String, Arc<ShellSession>>>>);

/// Processus d'arrière-plan vivants (suivi en mémoire ; la vérité durable est
/// la table `agent_background_processes`).
#[derive(Default)]
pub struct BackgroundRegistry(pub Arc<Mutex<HashMap<String, Arc<BackgroundProc>>>>);

pub(crate) struct BackgroundProc {
    /// Conservé pour l'affichage (pid du détaché) et le debug — le kill passe
    /// par le Job Object / try_wait, pas par pid.
    #[allow(dead_code)]
    pub pid: u32,
    pub buf: Arc<Mutex<BoundedBuffer>>,
    pub exited: AtomicI64, // i64::MIN = encore vivant
    kind: BgKind,
}

pub(crate) enum BgKind {
    Direct(Mutex<std::process::Child>, JobGuard),
    #[cfg(windows)]
    Confined(sandbox::windows_impl::ConfinedShellHandle),
    #[cfg(not(windows))]
    Confined,
}

impl BackgroundProc {
    fn terminate(&self) {
        match &self.kind {
            BgKind::Direct(child, job) => {
                #[cfg(windows)]
                if let Some(j) = job {
                    j.terminate();
                }
                let _ = job;
                if let Ok(mut c) = child.lock() {
                    let _ = c.kill();
                }
            }
            #[cfg(windows)]
            BgKind::Confined(sh) => sh.terminate(),
            #[cfg(not(windows))]
            BgKind::Confined => {}
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// DB — agent_background_processes (V27), helpers `_on_conn` testables
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRow {
    pub id: String,
    pub run_id: String,
    pub command: String,
    pub cwd: String,
    pub pid: i64,
    pub status: String,
    pub exit_code: Option<i64>,
    pub created_at: i64,
    pub ended_at: Option<i64>,
    pub output_tail: String,
}

fn row_to_bg(row: &rusqlite::Row) -> rusqlite::Result<BackgroundRow> {
    Ok(BackgroundRow {
        id: row.get(0)?,
        run_id: row.get(1)?,
        command: row.get(2)?,
        cwd: row.get(3)?,
        pid: row.get(4)?,
        status: row.get(5)?,
        exit_code: row.get(6)?,
        created_at: row.get(7)?,
        ended_at: row.get(8)?,
        output_tail: row.get(9)?,
    })
}

const BG_SELECT: &str = "SELECT id, run_id, command, cwd, pid, status, exit_code,
    created_at, ended_at, output_tail FROM agent_background_processes";

pub(crate) fn insert_bg_on_conn(conn: &Connection, row: &BackgroundRow) -> Result<(), String> {
    conn.execute(
        "INSERT INTO agent_background_processes
            (id, run_id, command, cwd, pid, status, exit_code, created_at, ended_at, output_tail)
         VALUES (?1, ?2, ?3, ?4, ?5, 'running', NULL, ?6, NULL, '')",
        params![
            row.id,
            row.run_id,
            row.command,
            row.cwd,
            row.pid,
            row.created_at
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("insert background process: {e}"))
}

/// Marque une fin (exited/killed/interrupted) avec code + snapshot borné.
pub(crate) fn finish_bg_on_conn(
    conn: &Connection,
    id: &str,
    status: &str,
    exit_code: Option<i64>,
    output_tail: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE agent_background_processes
            SET status = ?1, exit_code = ?2, ended_at = ?3, output_tail = ?4
          WHERE id = ?5 AND status = 'running'",
        params![status, exit_code, now, output_tail, id],
    )
    .map(|_| ())
    .map_err(|e| format!("finish background process: {e}"))
}

pub(crate) fn get_bg_on_conn(conn: &Connection, id: &str) -> Result<Option<BackgroundRow>, String> {
    conn.query_row(
        &format!("{BG_SELECT} WHERE id = ?1"),
        params![id],
        row_to_bg,
    )
    .optional()
    .map_err(|e| format!("get background process: {e}"))
}

pub(crate) fn list_bg_for_run_on_conn(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<BackgroundRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{BG_SELECT} WHERE run_id = ?1 ORDER BY created_at ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![run_id], row_to_bg)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Boot recovery (P6.9) : les lignes encore `running` après un redémarrage ne
/// sont plus suivies (registry perdu avec le process) — réconciliées en
/// `interrupted`, honnêtement (jamais prétendues vivantes).
pub(crate) fn recover_bg_on_conn(conn: &Connection, now: i64) -> Result<usize, String> {
    conn.execute(
        "UPDATE agent_background_processes
            SET status = 'interrupted', ended_at = COALESCE(ended_at, ?1)
          WHERE status = 'running'",
        params![now],
    )
    .map_err(|e| format!("recover background processes: {e}"))
}

// ────────────────────────────────────────────────────────────────────────
// Sessions — exécution dans une session persistante (outil run_command)
// ────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub(crate) fn exec_in_session(
    app: &AppHandle,
    ws: &Path,
    agent_id: &str,
    session_id: &str,
    command: &str,
    timeout_secs: u64,
    profile: ExecutionProfile,
    rules: &[super::policy::CommandRule],
) -> Result<SessionExecResult, String> {
    // Même classification que run_command : une règle `deny` bloque avant spawn.
    let risk = classify_with_rules(command, profile.policy(), rules);
    if risk.blocked {
        return Err(format!(
            "commande non exécutée : {}",
            risk.detail
                .clone()
                .unwrap_or_else(|| "commande refusée par une règle utilisateur".to_string())
        ));
    }
    let registry = app.state::<SessionRegistry>();
    let key = format!("{agent_id}:{session_id}");
    let session = {
        let mut map = registry.0.lock().map_err(|e| e.to_string())?;
        match map.get(&key) {
            Some(s) if !s.is_dead() => s.clone(),
            _ => {
                let s = Arc::new(ShellSession::spawn(ws, profile)?);
                map.insert(key, s.clone());
                s
            }
        }
    };
    Ok(session.exec(command, timeout_secs))
}

/// Tue toutes les sessions d'un run (fin normale OU kill — une session meurt
/// avec son run, jamais de fuite inter-runs).
pub(crate) fn kill_run_sessions(app: &AppHandle, agent_id: &str) {
    let Some(registry) = app.try_state::<SessionRegistry>() else {
        return;
    };
    let prefix = format!("{agent_id}:");
    let dead: Vec<Arc<ShellSession>> = {
        let Ok(mut map) = registry.0.lock() else {
            return;
        };
        let keys: Vec<String> = map
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        keys.into_iter().filter_map(|k| map.remove(&k)).collect()
    };
    for s in dead {
        s.kill();
    }
}

// ────────────────────────────────────────────────────────────────────────
// Background — spawn / watch / read / stop
// ────────────────────────────────────────────────────────────────────────

/// Spawn un processus d'arrière-plan (même confinement que run_command) :
/// INSERT la ligne SQLite, retourne l'id immédiatement ; le watcher met la
/// ligne à jour à la sortie (exit code + snapshot borné de la sortie).
pub(crate) fn run_background(
    app: &AppHandle,
    ws: &Path,
    agent_id: &str,
    command: &str,
    profile: ExecutionProfile,
    rules: &[super::policy::CommandRule],
) -> Result<BackgroundRow, String> {
    let risk = classify_with_rules(command, profile.policy(), rules);
    if risk.blocked {
        return Err(format!(
            "commande non exécutée : {}",
            risk.detail
                .clone()
                .unwrap_or_else(|| "commande refusée par une règle utilisateur".to_string())
        ));
    }

    let id = format!("bg-{}", uuid::Uuid::new_v4());
    let (pid, kind, buf) = spawn_detached_process(ws, command, profile)?;
    let proc = Arc::new(BackgroundProc {
        pid,
        buf: buf.clone(),
        exited: AtomicI64::new(i64::MIN),
        kind,
    });

    let now = super::now_ms();
    let row = BackgroundRow {
        id: id.clone(),
        run_id: agent_id.to_string(),
        command: command.to_string(),
        cwd: ws.to_string_lossy().to_string(),
        pid: pid as i64,
        status: "running".to_string(),
        exit_code: None,
        created_at: now,
        ended_at: None,
        output_tail: String::new(),
    };
    if let Err(error) = (|| -> Result<(), String> {
        let conn_mutex = super::get_conn(app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        insert_bg_on_conn(&conn, &row)
    })() {
        // Le process existe déjà : une panne de persistance ne doit jamais
        // créer un orphelin invisible.
        proc.terminate();
        proc.exited.store(-1, Ordering::SeqCst);
        return Err(error);
    }

    match app.state::<BackgroundRegistry>().0.lock() {
        Ok(mut registry) => {
            registry.insert(id.clone(), proc.clone());
        }
        Err(e) => {
            proc.terminate();
            proc.exited.store(-1, Ordering::SeqCst);
            if let Ok(conn_mutex) = super::get_conn(app) {
                if let Ok(conn) = conn_mutex.lock() {
                    let _ = finish_bg_on_conn(&conn, &id, "killed", Some(-1), "", super::now_ms());
                }
            }
            return Err(format!("background registry lock: {e}"));
        }
    }

    // Watcher : met la ligne à jour à la sortie (honnêteté durable), retire du
    // registry. Best-effort — un échec DB ne tue pas le suivi en mémoire.
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let exit_code: i64 = loop {
            match &proc.kind {
                BgKind::Direct(child, _) => {
                    let done = child
                        .lock()
                        .ok()
                        .and_then(|mut c| c.try_wait().ok().flatten());
                    if let Some(status) = done {
                        break status.code().unwrap_or(-1) as i64;
                    }
                }
                #[cfg(windows)]
                BgKind::Confined(sh) => {
                    if let Some(code) = sh.exited() {
                        break code as i64;
                    }
                }
                #[cfg(not(windows))]
                BgKind::Confined => break -1,
            }
            std::thread::sleep(Duration::from_millis(120));
        };
        proc.exited.store(exit_code, Ordering::SeqCst);
        let tail = buf
            .lock()
            .map(|b| b.tail(OUTPUT_SNAPSHOT_CAP))
            .unwrap_or_default();
        if let Ok(conn_mutex) = super::get_conn(&app2) {
            if let Ok(conn) = conn_mutex.lock() {
                let _ = finish_bg_on_conn(
                    &conn,
                    &id2,
                    "exited",
                    Some(exit_code),
                    &tail,
                    super::now_ms(),
                );
            }
        }
        if let Ok(mut map) = app2.state::<BackgroundRegistry>().0.lock() {
            map.remove(&id2);
        }
    });

    Ok(row)
}

/// Spawn détaché pur (testable sans AppHandle) : (pid, kind, buffer drainé).
/// Même confinement que run_command (Auto → sandbox LOW, fail-closed).
pub(crate) fn spawn_detached_process(
    ws: &Path,
    command: &str,
    profile: ExecutionProfile,
) -> Result<(u32, BgKind, Arc<Mutex<BoundedBuffer>>), String> {
    let buf = Arc::new(Mutex::new(BoundedBuffer::default()));

    #[cfg(windows)]
    let confined = matches!(profile, ExecutionProfile::Auto);
    #[cfg(not(windows))]
    let confined = false;

    let (pid, kind) = if confined {
        #[cfg(windows)]
        {
            let (pid, stdin, stdout, stderr, handle) =
                sandbox::spawn_confined_detached(ws, command)
                    .ok_or_else(|| {
                        "sandbox Auto indisponible : processus d'arrière-plan non démarré. Active Full Access explicitement".to_string()
                    })?
                    .into_parts();
            drop(stdin); // un détaché n'a pas besoin de stdin
            spawn_drain(stdout, buf.clone());
            spawn_drain(stderr, buf.clone());
            (pid, BgKind::Confined(handle))
        }
        #[cfg(not(windows))]
        unreachable!()
    } else {
        let job = new_job();
        let mut cmd = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        #[cfg(windows)]
        cmd.args(["/d", "/s", "/c", command]);
        #[cfg(not(windows))]
        cmd.args(["-c", command]);
        let mut child = cmd
            .current_dir(ws)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn background process: {e}"))?;
        #[cfg(windows)]
        if let Some(ref j) = job {
            j.assign(&child);
        }
        let pid = child.id();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "background sans stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "background sans stderr".to_string())?;
        spawn_drain(stdout, buf.clone());
        spawn_drain(stderr, buf.clone());
        (pid, BgKind::Direct(Mutex::new(child), job))
    };

    Ok((pid, kind, buf))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutputView {
    pub id: String,
    pub status: String,
    pub exit_code: Option<i64>,
    pub tail: String,
}

/// Lit la queue bornée d'un processus (registry vivant prioritaire, snapshot
/// DB sinon — honnête après la fin et après reload).
pub(crate) fn read_process_output(app: &AppHandle, id: &str) -> Result<ProcessOutputView, String> {
    if let Some(proc) = app
        .state::<BackgroundRegistry>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
    {
        let exited = proc.exited.load(Ordering::SeqCst);
        return Ok(ProcessOutputView {
            id: id.to_string(),
            status: if exited == i64::MIN {
                "running"
            } else {
                "exited"
            }
            .to_string(),
            exit_code: (exited != i64::MIN).then_some(exited),
            tail: proc
                .buf
                .lock()
                .map(|b| b.tail(OUTPUT_SNAPSHOT_CAP))
                .unwrap_or_default(),
        });
    }
    let conn_mutex = super::get_conn(app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let row = get_bg_on_conn(&conn, id)?.ok_or_else(|| format!("processus introuvable: {id}"))?;
    Ok(ProcessOutputView {
        id: row.id,
        status: row.status,
        exit_code: row.exit_code,
        tail: row.output_tail,
    })
}

/// Tue un processus d'arrière-plan (Job Object / kill). `false` = déjà
/// terminal ou introuvable (rien tué — honnête).
pub(crate) fn stop_process(app: &AppHandle, id: &str) -> Result<bool, String> {
    let proc = app
        .state::<BackgroundRegistry>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned();
    if let Some(proc) = proc {
        if proc.exited.load(Ordering::SeqCst) != i64::MIN {
            return Ok(false); // déjà sorti — rien à tuer
        }
        proc.terminate();
        proc.exited.store(-1, Ordering::SeqCst);
        let tail = proc
            .buf
            .lock()
            .map(|b| b.tail(OUTPUT_SNAPSHOT_CAP))
            .unwrap_or_default();
        let conn_mutex = super::get_conn(app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        finish_bg_on_conn(&conn, id, "killed", Some(-1), &tail, super::now_ms())?;
        if let Ok(mut map) = app.state::<BackgroundRegistry>().0.lock() {
            map.remove(id);
        }
        return Ok(true);
    }
    // Hors registry : CAS honnête (un process déjà terminal n'est pas « tué »).
    let conn_mutex = super::get_conn(app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            "UPDATE agent_background_processes
                SET status = 'killed', ended_at = ?1
              WHERE id = ?2 AND status = 'running'",
            params![super::now_ms(), id],
        )
        .map_err(|e| format!("stop background process: {e}"))?;
    Ok(changed == 1)
}

/// Kill d'un run : tue ses sessions ET ses processus d'arrière-plan
/// (miroir de la sémantique kill de agent_kill — les lignes passent 'killed',
/// jamais de zombie).
pub(crate) fn kill_run_all(app: &AppHandle, agent_id: &str) {
    kill_run_sessions(app, agent_id);
    let victims: Vec<(String, Arc<BackgroundProc>)> = {
        let conn_rows = super::get_conn(app)
            .ok()
            .and_then(|m| {
                m.lock()
                    .ok()
                    .map(|c| list_bg_for_run_on_conn(&c, agent_id).unwrap_or_default())
            })
            .unwrap_or_default();
        let registry = app.state::<BackgroundRegistry>();
        let map = registry.0.lock().ok();
        conn_rows
            .into_iter()
            .filter(|r| r.status == "running")
            .filter_map(|r| {
                map.as_ref()
                    .and_then(|m| m.get(&r.id).cloned())
                    .map(|p| (r.id, p))
            })
            .collect()
    };
    for (id, proc) in victims {
        proc.terminate();
        proc.exited.store(-1, Ordering::SeqCst);
        let tail = proc
            .buf
            .lock()
            .map(|b| b.tail(OUTPUT_SNAPSHOT_CAP))
            .unwrap_or_default();
        if let Ok(conn_mutex) = super::get_conn(app) {
            if let Ok(conn) = conn_mutex.lock() {
                let _ = finish_bg_on_conn(&conn, &id, "killed", Some(-1), &tail, super::now_ms());
            }
        }
        if let Ok(mut map) = app.state::<BackgroundRegistry>().0.lock() {
            map.remove(&id);
        }
    }
}

/// Tue les processus persistants dont le cwd appartient à un workspace.
/// Contrairement aux sessions (liées à la vie du run), `run_background` peut
/// légitimement survivre à une fin normale ; une révocation ou un changement
/// de projet doit toutefois l'arrêter immédiatement.
pub(crate) fn kill_workspace_backgrounds(app: &AppHandle, workspace_root: &Path) {
    let canonical_root =
        std::fs::canonicalize(workspace_root).unwrap_or_else(|_| workspace_root.to_path_buf());
    let rows: Vec<BackgroundRow> = super::get_conn(app)
        .ok()
        .and_then(|m| {
            let conn = m.lock().ok()?;
            let mut stmt = conn
                .prepare(&format!("{BG_SELECT} WHERE status = 'running'"))
                .ok()?;
            let rows = stmt
                .query_map([], row_to_bg)
                .ok()?
                .collect::<Result<Vec<_>, _>>()
                .ok()?;
            Some(rows)
        })
        .unwrap_or_default();

    let victims: Vec<(String, Arc<BackgroundProc>)> = {
        let registry = app.state::<BackgroundRegistry>();
        let Ok(map) = registry.0.lock() else {
            return;
        };
        rows.into_iter()
            .filter(|row| {
                let cwd = std::path::PathBuf::from(&row.cwd);
                let canonical_cwd = std::fs::canonicalize(&cwd).unwrap_or(cwd);
                canonical_cwd.starts_with(&canonical_root)
            })
            .filter_map(|row| map.get(&row.id).cloned().map(|proc| (row.id, proc)))
            .collect()
    };

    for (id, proc) in victims {
        proc.terminate();
        proc.exited.store(-1, Ordering::SeqCst);
        let tail = proc
            .buf
            .lock()
            .map(|buffer| buffer.tail(OUTPUT_SNAPSHOT_CAP))
            .unwrap_or_default();
        if let Ok(conn_mutex) = super::get_conn(app) {
            if let Ok(conn) = conn_mutex.lock() {
                let _ = finish_bg_on_conn(&conn, &id, "killed", Some(-1), &tail, super::now_ms());
            }
        }
        if let Ok(mut map) = app.state::<BackgroundRegistry>().0.lock() {
            map.remove(&id);
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Commandes Tauri (AgentsPanel « Terminaux »)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub alive: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessesOverview {
    pub sessions: Vec<SessionInfo>,
    pub processes: Vec<BackgroundRow>,
}

/// Sessions + processus d'arrière-plan d'un run (statuts honnêtes — les
/// processus terminés viennent de SQLite, survivent au reload).
#[tauri::command]
pub async fn agent_process_list(
    app: AppHandle,
    run_id: String,
) -> Result<ProcessesOverview, String> {
    let prefix = format!("{run_id}:");
    let session_registry = app.state::<SessionRegistry>();
    let session_map = &session_registry.0;
    let sessions: Vec<SessionInfo> = session_map
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .filter(|(k, _)| k.starts_with(&prefix))
        .map(|(k, s)| SessionInfo {
            id: k[prefix.len()..].to_string(),
            alive: !s.is_dead(),
        })
        .collect();
    let conn_mutex = super::get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let processes = list_bg_for_run_on_conn(&conn, &run_id)?;
    Ok(ProcessesOverview {
        sessions,
        processes,
    })
}

/// Queue bornée d'un processus d'arrière-plan.
#[tauri::command]
pub async fn agent_process_output(app: AppHandle, id: String) -> Result<ProcessOutputView, String> {
    read_process_output(&app, &id)
}

/// Tue un processus d'arrière-plan (même kill d'arbre que les sessions).
#[tauri::command]
pub async fn agent_process_stop(app: AppHandle, id: String) -> Result<bool, String> {
    stop_process(&app, &id)
}

// ────────────────────────────────────────────────────────────────────────
// Tests — sessions persistantes (cwd/env, isolation, timeout), background
// (cycle de vie, kill, recovery, CAS) et buffer borné.
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_ws(tag: &str) -> std::path::PathBuf {
        let seq = TEMP_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "shugu-proc-test-{tag}-{}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp ws");
        dir
    }

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        // Schéma = MIGRATION_V27 (calque exact, voir lib.rs).
        conn.execute_batch(
            "CREATE TABLE agent_background_processes (
              id          TEXT    PRIMARY KEY,
              run_id      TEXT    NOT NULL,
              command     TEXT    NOT NULL,
              cwd         TEXT    NOT NULL,
              pid         INTEGER NOT NULL,
              status      TEXT    NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'exited', 'interrupted', 'killed')),
              exit_code   INTEGER,
              created_at  INTEGER NOT NULL,
              ended_at    INTEGER,
              output_tail TEXT    NOT NULL DEFAULT ''
            );",
        )
        .expect("create V27 schema");
        conn
    }

    #[test]
    fn bounded_buffer_caps_and_marks() {
        let mut b = BoundedBuffer::default();
        b.append(b"hello ");
        b.append(b"world");
        assert_eq!(b.total(), 11);
        assert_eq!(b.text_since(0), "hello world");
        assert_eq!(b.text_since(6), "world");
        assert_eq!(b.tail(5), "world");
        // Cap : le contenu est tronqué mais le compteur total survit.
        let big = vec![b'x'; BUFFER_CAP + 1000];
        b.append(&big);
        assert!(b.data.len() <= BUFFER_CAP);
        assert_eq!(b.total(), 11 + BUFFER_CAP as u64 + 1000);
        // Marqueur défilé hors du buffer → texte tronqué au début, pas de panic.
        let _ = b.text_since(0);
    }

    #[test]
    fn session_keeps_cwd_and_env_between_commands() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("session");
        std::fs::create_dir_all(ws.join("subdir")).unwrap();
        let session =
            ShellSession::spawn(&ws, ExecutionProfile::FullAccess).expect("spawn session");

        let r1 = session.exec("cd subdir", 10);
        assert_eq!(r1.exit_code, 0, "cd subdir: {}", r1.output);
        let r2 = session.exec("cd", 10);
        assert_eq!(r2.exit_code, 0);
        assert!(
            r2.output.to_lowercase().contains("subdir"),
            "le cwd persiste entre deux commandes : {}",
            r2.output
        );

        let r3 = session.exec("set SHUGU_TEST_VAR=bar42", 10);
        assert_eq!(r3.exit_code, 0);
        let r4 = session.exec("echo %SHUGU_TEST_VAR%", 10);
        assert!(
            r4.output.contains("bar42"),
            "l'env persiste : {}",
            r4.output
        );

        session.kill();
        assert!(session.is_dead());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn sessions_are_isolated() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("isolation");
        std::fs::create_dir_all(ws.join("aa")).unwrap();
        let s1 = ShellSession::spawn(&ws, ExecutionProfile::FullAccess).expect("s1");
        let s2 = ShellSession::spawn(&ws, ExecutionProfile::FullAccess).expect("s2");
        let _ = s1.exec("cd aa", 10);
        let r1 = s1.exec("cd", 10);
        let r2 = s2.exec("cd", 10);
        assert!(r1.output.to_lowercase().contains("aa"));
        assert!(
            !r2.output.to_lowercase().contains("\\aa"),
            "la session 2 n'hérite pas du cwd de la session 1 : {}",
            r2.output
        );
        s1.kill();
        s2.kill();
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn session_timeout_kills_session_and_next_respawns() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("timeout");
        let session = ShellSession::spawn(&ws, ExecutionProfile::FullAccess).expect("spawn");
        let r = session.exec("ping -n 10 127.0.0.1 >nul", 1);
        assert!(r.timed_out, "timeout wall-clock");
        assert!(!r.session_alive, "la session est tuée au timeout");
        assert!(session.is_dead());
        // Une session fraîche respawn sans problème.
        let s2 = ShellSession::spawn(&ws, ExecutionProfile::FullAccess).expect("respawn");
        let r2 = s2.exec("echo apres-timeout", 10);
        assert!(r2.output.contains("apres-timeout"));
        s2.kill();
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn background_output_and_exit_code_captured() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("bg");
        let (_pid, kind, buf) =
            spawn_detached_process(&ws, "echo hello-bg-42", ExecutionProfile::FullAccess)
                .expect("spawn background");
        // Attend la sortie du process (poll try_wait / exited).
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let code = loop {
            let done = match &kind {
                BgKind::Direct(child, _) => child
                    .lock()
                    .ok()
                    .and_then(|mut c| c.try_wait().ok().flatten())
                    .map(|s| s.code().unwrap_or(-1)),
                #[cfg(windows)]
                BgKind::Confined(sh) => sh.exited(),
                #[cfg(not(windows))]
                BgKind::Confined => Some(-1),
            };
            if let Some(c) = done {
                break c;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "background n'a pas terminé"
            );
            std::thread::sleep(Duration::from_millis(60));
        };
        assert_eq!(code, 0);
        // Le drain thread a eu le temps d'écrire (poll du buffer).
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let tail = buf
                .lock()
                .map(|b| b.tail(OUTPUT_SNAPSHOT_CAP))
                .unwrap_or_default();
            if tail.contains("hello-bg-42") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "sortie non drainée : {tail}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn background_tree_kill() {
        if !cfg!(windows) {
            return;
        }
        let ws = temp_ws("bgkill");
        let (_pid, kind, _buf) = spawn_detached_process(
            &ws,
            "ping -n 60 127.0.0.1 >nul",
            ExecutionProfile::FullAccess,
        )
        .expect("spawn long background");
        match &kind {
            BgKind::Direct(child, job) => {
                #[cfg(windows)]
                if let Some(j) = job {
                    j.terminate();
                }
                let _ = job;
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                loop {
                    let done = child
                        .lock()
                        .ok()
                        .and_then(|mut c| c.try_wait().ok().flatten());
                    if done.is_some() {
                        break;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "kill n'a pas terminé le process"
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            #[cfg(windows)]
            BgKind::Confined(sh) => {
                sh.terminate();
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                while sh.exited().is_none() {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            #[cfg(not(windows))]
            BgKind::Confined => {}
        }
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn db_lifecycle_and_recovery_are_honest() {
        let conn = test_conn();
        let row = BackgroundRow {
            id: "bg-1".to_string(),
            run_id: "run-1".to_string(),
            command: "ping x".to_string(),
            cwd: "C:\\tmp".to_string(),
            pid: 1234,
            status: "running".to_string(),
            exit_code: None,
            created_at: 100,
            ended_at: None,
            output_tail: String::new(),
        };
        insert_bg_on_conn(&conn, &row).unwrap();
        // Fin normale.
        finish_bg_on_conn(&conn, "bg-1", "exited", Some(0), "sortie bornée", 200).unwrap();
        let got = get_bg_on_conn(&conn, "bg-1").unwrap().unwrap();
        assert_eq!(got.status, "exited");
        assert_eq!(got.exit_code, Some(0));
        assert_eq!(got.output_tail, "sortie bornée");
        // CAS : une seconde fin ne réécrit pas (status n'est plus 'running').
        finish_bg_on_conn(&conn, "bg-1", "killed", Some(-1), "autre", 300).unwrap();
        let got = get_bg_on_conn(&conn, "bg-1").unwrap().unwrap();
        assert_eq!(got.status, "exited", "déjà terminal : pas de réécriture");
        assert_eq!(got.ended_at, Some(200));

        // Recovery : une ligne restée 'running' → 'interrupted' au boot.
        insert_bg_on_conn(
            &conn,
            &BackgroundRow {
                id: "bg-2".to_string(),
                ended_at: None,
                ..row.clone()
            },
        )
        .unwrap();
        let n = recover_bg_on_conn(&conn, 500).unwrap();
        assert_eq!(n, 1);
        let got = get_bg_on_conn(&conn, "bg-2").unwrap().unwrap();
        assert_eq!(got.status, "interrupted");
        assert_eq!(got.ended_at, Some(500));
        // La ligne terminée n'est PAS touchée par le recovery.
        let got = get_bg_on_conn(&conn, "bg-1").unwrap().unwrap();
        assert_eq!(got.status, "exited");
        // Listing par run.
        let rows = list_bg_for_run_on_conn(&conn, "run-1").unwrap();
        assert_eq!(rows.len(), 2);
    }
}
