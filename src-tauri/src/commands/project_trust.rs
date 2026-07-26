//! Per-workspace trust gate.
//!
//! Project-owned instructions and executable contributions are untrusted until
//! the user explicitly approves the canonical workspace path. The decision is
//! local-only and fail-closed: a missing row, a database error, or a different
//! canonical path never grants trust.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

const TRUST_TABLE: &str = "
CREATE TABLE IF NOT EXISTS project_trust (
  root_path  TEXT PRIMARY KEY,
  state      TEXT    NOT NULL CHECK (state IN ('read_only', 'trusted')),
  updated_at INTEGER NOT NULL
);
";

static TRUST_CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectTrustState {
    Unknown,
    ReadOnly,
    Trusted,
}

impl ProjectTrustState {
    fn from_db(value: &str) -> Self {
        match value {
            "trusted" => Self::Trusted,
            "read_only" => Self::ReadOnly,
            _ => Self::Unknown,
        }
    }

    fn parse_input(value: &str) -> Result<Self, String> {
        match value {
            "trusted" => Ok(Self::Trusted),
            "readOnly" | "read_only" => Ok(Self::ReadOnly),
            _ => Err("état de confiance invalide (attendu: trusted ou readOnly)".to_string()),
        }
    }

    fn as_db(self) -> Option<&'static str> {
        match self {
            Self::Unknown => None,
            Self::ReadOnly => Some("read_only"),
            Self::Trusted => Some("trusted"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrustStatus {
    pub root_path: Option<String>,
    pub state: ProjectTrustState,
    pub project_features_enabled: bool,
    pub mutations_allowed: bool,
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn canonical_key(path: &Path) -> String {
    let normalized = crate::commands::pathutil::norm_display(path);
    if normalized == "/"
        || (normalized.len() == 3
            && normalized.as_bytes().get(1) == Some(&b':')
            && normalized.ends_with('/'))
    {
        normalized
    } else {
        normalized.trim_end_matches('/').to_string()
    }
}

fn open_connection(app: &AppHandle) -> Result<Connection, String> {
    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("project trust app config dir: {error}"))?
        .join("shugu.db");
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("project trust create config dir: {error}"))?;
    }
    let conn = Connection::open(&db_path)
        .map_err(|error| format!("project trust open {}: {error}", db_path.display()))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|error| format!("project trust busy timeout: {error}"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|error| format!("project trust pragmas: {error}"))?;
    conn.execute_batch(TRUST_TABLE)
        .map_err(|error| format!("project trust schema: {error}"))?;
    Ok(conn)
}

fn get_conn(app: &AppHandle) -> Result<&'static Mutex<Connection>, String> {
    if let Some(conn) = TRUST_CONN.get() {
        return Ok(conn);
    }
    let conn = open_connection(app)?;
    let _ = TRUST_CONN.set(Mutex::new(conn));
    TRUST_CONN
        .get()
        .ok_or_else(|| "project trust connection unavailable".to_string())
}

fn read_state_on_conn(conn: &Connection, root: &Path) -> Result<ProjectTrustState, String> {
    let key = canonical_key(root);
    conn.query_row(
        "SELECT state FROM project_trust WHERE root_path = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map(|state| {
        state
            .as_deref()
            .map(ProjectTrustState::from_db)
            .unwrap_or(ProjectTrustState::Unknown)
    })
    .map_err(|error| format!("lecture confiance projet: {error}"))
}

fn write_state_on_conn(
    conn: &Connection,
    root: &Path,
    state: ProjectTrustState,
    updated_at: i64,
) -> Result<(), String> {
    let db_state = state
        .as_db()
        .ok_or_else(|| "l'état unknown ne peut pas être persisté".to_string())?;
    conn.execute(
        "INSERT INTO project_trust (root_path, state, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(root_path) DO UPDATE
           SET state = excluded.state, updated_at = excluded.updated_at",
        params![canonical_key(root), db_state, updated_at],
    )
    .map_err(|error| format!("écriture confiance projet: {error}"))?;
    Ok(())
}

fn current_workspace(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<Mutex<Option<PathBuf>>>();
    let root = state.lock().ok()?.clone();
    root
}

fn status_for(app: &AppHandle, root: Option<&Path>) -> Result<ProjectTrustStatus, String> {
    let Some(root) = root else {
        return Ok(ProjectTrustStatus {
            root_path: None,
            state: ProjectTrustState::Unknown,
            project_features_enabled: false,
            mutations_allowed: false,
        });
    };
    let conn = get_conn(app)?;
    let conn = conn
        .lock()
        .map_err(|error| format!("project trust lock: {error}"))?;
    let state = read_state_on_conn(&conn, root)?;
    Ok(ProjectTrustStatus {
        root_path: Some(canonical_key(root)),
        state,
        project_features_enabled: state == ProjectTrustState::Trusted,
        mutations_allowed: state == ProjectTrustState::Trusted,
    })
}

/// Runtime gate for project-owned configuration. Database errors are denied.
pub(crate) fn is_trusted(app: &AppHandle, root: &Path) -> bool {
    let Ok(conn) = get_conn(app) else {
        return false;
    };
    let Ok(conn) = conn.lock() else {
        return false;
    };
    read_state_on_conn(&conn, root).ok() == Some(ProjectTrustState::Trusted)
}

pub(crate) fn require_trusted_workspace(app: &AppHandle) -> Result<PathBuf, String> {
    let root = current_workspace(app)
        .ok_or_else(|| "aucun projet ouvert : ouvre un dossier".to_string())?;
    if !is_trusted(app, &root) {
        return Err(
            "Ce projet est en lecture seule tant qu'il n'a pas été approuvé. Utilise le badge de confiance dans la barre d'état."
                .to_string(),
        );
    }
    Ok(root)
}

pub(crate) fn require_current_trusted_root(
    app: &AppHandle,
    expected_root: &Path,
) -> Result<(), String> {
    let current = current_workspace(app)
        .ok_or_else(|| "aucun projet ouvert : ouvre un dossier".to_string())?;
    if canonical_key(&current) != canonical_key(expected_root) {
        return Err(
            "Le projet ouvert a changé pendant l'opération ; action interrompue.".to_string(),
        );
    }
    if !is_trusted(app, expected_root) {
        return Err(
            "Ce projet est en lecture seule tant qu'il n'a pas été approuvé. Utilise le badge de confiance dans la barre d'état."
                .to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
pub fn project_trust_status(app: AppHandle) -> Result<ProjectTrustStatus, String> {
    status_for(&app, current_workspace(&app).as_deref())
}

#[tauri::command]
pub fn project_trust_set(
    app: AppHandle,
    state: String,
    expected_root_path: String,
) -> Result<ProjectTrustStatus, String> {
    let root = current_workspace(&app).ok_or_else(|| "aucun projet ouvert".to_string())?;
    if canonical_key(&root) != canonical_key(Path::new(&expected_root_path)) {
        return Err(
            "Le projet ouvert a changé depuis l'affichage de cette décision ; recommence sur le projet courant."
                .to_string(),
        );
    }
    let state = ProjectTrustState::parse_input(&state)?;
    {
        let conn = get_conn(&app)?;
        let conn = conn
            .lock()
            .map_err(|error| format!("project trust lock: {error}"))?;
        write_state_on_conn(&conn, &root, state, now_ms())?;
    }
    if state != ProjectTrustState::Trusted {
        let lsp = app.state::<crate::commands::lsp::LspServerRegistry>();
        crate::commands::lsp::kill_all(&lsp);
        crate::commands::agents::processes::kill_workspace_backgrounds(&app, &root);
    }
    crate::commands::mcp::invalidate_connections(&app);
    let status = status_for(&app, Some(&root))?;
    let _ = app.emit("workspace://trust-changed", status.clone());
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(TRUST_TABLE).unwrap();
        conn
    }

    #[test]
    fn missing_decision_is_unknown_and_fail_closed() {
        let conn = test_conn();
        let state = read_state_on_conn(&conn, Path::new(r"C:\Dev\project")).unwrap();
        assert_eq!(state, ProjectTrustState::Unknown);
    }

    #[test]
    fn decision_is_keyed_by_normalized_canonical_display_path() {
        let conn = test_conn();
        write_state_on_conn(
            &conn,
            Path::new(r"\\?\C:\Dev\project"),
            ProjectTrustState::Trusted,
            10,
        )
        .unwrap();
        assert_eq!(
            read_state_on_conn(&conn, Path::new("C:/Dev/project")).unwrap(),
            ProjectTrustState::Trusted
        );
        assert_eq!(
            read_state_on_conn(&conn, Path::new("C:/Dev/other")).unwrap(),
            ProjectTrustState::Unknown
        );
    }

    #[test]
    fn filesystem_roots_are_not_collapsed_to_empty_or_drive_relative_paths() {
        assert_eq!(canonical_key(Path::new("/")), "/");
        assert_eq!(canonical_key(Path::new("C:/")), "C:/");
        assert_eq!(
            canonical_key(Path::new("C:/Dev/project/")),
            "C:/Dev/project"
        );
    }

    #[test]
    fn revocation_replaces_trusted_state() {
        let conn = test_conn();
        let root = Path::new("C:/Dev/project");
        write_state_on_conn(&conn, root, ProjectTrustState::Trusted, 10).unwrap();
        write_state_on_conn(&conn, root, ProjectTrustState::ReadOnly, 20).unwrap();
        assert_eq!(
            read_state_on_conn(&conn, root).unwrap(),
            ProjectTrustState::ReadOnly
        );
        let updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM project_trust WHERE root_path = ?1",
                params![canonical_key(root)],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(updated_at, 20);
    }

    #[test]
    fn invalid_state_never_degrades_to_trusted() {
        assert!(ProjectTrustState::parse_input("unknown").is_err());
        assert!(ProjectTrustState::parse_input("yes").is_err());
        assert_eq!(
            ProjectTrustState::parse_input("readOnly").unwrap(),
            ProjectTrustState::ReadOnly
        );
    }
}
