// Shugu Forge — media.rs : helpers partagés pour les médias génératifs
// (vidéo, musique). Sauvegarde d'assets locaux, normalisation de base URL
// MiniMax et lecture du `base_resp` commun.
//
// Volontairement séparé d'`image.rs` (dont les helpers privés restent internes) :
// `image.rs` est déjà éprouvé en live, on ne le refactore pas pour mutualiser —
// le léger recouvrement avec ses helpers internes est un compromis assumé pour
// garder un blast radius minimal sur du code qui fonctionne.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

pub const MEDIA_CANCELLED: &str = "media job cancelled";

#[derive(Default)]
pub struct MediaJobRegistry(pub Mutex<HashMap<String, Arc<MediaJobControl>>>);

pub struct MediaJobControl {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl MediaJobControl {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_one();
    }

    pub async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaJobEvent {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub phase: String,
    pub progress: u8,
    pub message: Option<String>,
    pub result_url: Option<String>,
    pub error: Option<String>,
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn open_jobs_db(app: &AppHandle) -> Result<rusqlite::Connection, String> {
    let path = crate::commands::backup::live_db_path(app)?;
    let conn = rusqlite::Connection::open(path).map_err(|e| format!("open media jobs DB: {e}"))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("media jobs busy timeout: {e}"))?;
    Ok(conn)
}

fn persist_new_job(app: &AppHandle, event: &MediaJobEvent, payload: &Value) -> Result<(), String> {
    let conn = open_jobs_db(app)?;
    conn.execute(
        "INSERT INTO jobs (id, kind, status, payload, result, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, status=excluded.status, payload=excluded.payload,
           result=excluded.result, updated_at=excluded.updated_at",
        rusqlite::params![
            event.id,
            event.kind,
            event.status,
            payload.to_string(),
            serde_json::to_string(event).unwrap_or_default(),
            event.updated_at,
        ],
    )
    .map_err(|e| format!("persist media job {}: {e}", event.id))?;
    Ok(())
}

fn persist_job_event(app: &AppHandle, event: &MediaJobEvent) -> Result<(), String> {
    let conn = open_jobs_db(app)?;
    conn.execute(
        "UPDATE jobs SET status=?1, result=?2, updated_at=?3 WHERE id=?4",
        rusqlite::params![
            event.status,
            serde_json::to_string(event).unwrap_or_default(),
            event.updated_at,
            event.id,
        ],
    )
    .map_err(|e| format!("update media job {}: {e}", event.id))?;
    Ok(())
}

fn publish(app: &AppHandle, event: &MediaJobEvent, is_new: Option<&Value>) {
    let persisted = match is_new {
        Some(payload) => persist_new_job(app, event, payload),
        None => persist_job_event(app, event),
    };
    if let Err(error) = persisted {
        eprintln!("[media-job] {error}");
    }
    let _ = app.emit("media://progress", event);
}

pub fn begin_job(
    app: &AppHandle,
    id: &str,
    kind: &str,
    payload: Value,
) -> Result<Arc<MediaJobControl>, String> {
    let state = app.state::<MediaJobRegistry>();
    let mut registry = state
        .0
        .lock()
        .map_err(|_| "media job registry poisoned".to_string())?;
    if registry.contains_key(id) {
        return Err(format!("media job `{id}` is already running"));
    }
    let control = Arc::new(MediaJobControl::new());
    registry.insert(id.to_string(), control.clone());
    drop(registry);

    publish(
        app,
        &MediaJobEvent {
            id: id.to_string(),
            kind: kind.to_string(),
            status: "running".to_string(),
            phase: "starting".to_string(),
            progress: 1,
            message: Some("Démarrage".to_string()),
            result_url: None,
            error: None,
            updated_at: now_ms(),
        },
        Some(&payload),
    );
    Ok(control)
}

pub fn progress(
    app: &AppHandle,
    id: &str,
    kind: &str,
    phase: &str,
    percent: u8,
    message: impl Into<String>,
) {
    publish(
        app,
        &MediaJobEvent {
            id: id.to_string(),
            kind: kind.to_string(),
            status: "running".to_string(),
            phase: phase.to_string(),
            progress: percent.min(99),
            message: Some(message.into()),
            result_url: None,
            error: None,
            updated_at: now_ms(),
        },
        None,
    );
}

pub fn finish_job(app: &AppHandle, id: &str, kind: &str, result: Result<Option<String>, String>) {
    let (status, phase, progress, message, result_url, error) = match result {
        Ok(url) => ("done", "done", 100, Some("Terminé".to_string()), url, None),
        Err(error) if error == MEDIA_CANCELLED => (
            "cancelled",
            "cancelled",
            0,
            Some("Annulé".to_string()),
            None,
            None,
        ),
        Err(error) => (
            "error",
            "error",
            0,
            Some("Échec".to_string()),
            None,
            Some(error),
        ),
    };
    publish(
        app,
        &MediaJobEvent {
            id: id.to_string(),
            kind: kind.to_string(),
            status: status.to_string(),
            phase: phase.to_string(),
            progress,
            message,
            result_url,
            error,
            updated_at: now_ms(),
        },
        None,
    );
    if let Ok(mut registry) = app.state::<MediaJobRegistry>().0.lock() {
        registry.remove(id);
    }
}

#[tauri::command]
pub fn media_job_cancel(app: AppHandle, id: String) -> bool {
    let control = app
        .state::<MediaJobRegistry>()
        .0
        .lock()
        .ok()
        .and_then(|registry| registry.get(&id).cloned());
    if let Some(control) = control {
        control.cancel();
        true
    } else {
        false
    }
}

/// Reconcile durable jobs after a process restart. Provider credentials are
/// never stored in `jobs.payload`, so an interrupted remote request cannot be
/// resumed safely without the user re-running it. Marking it explicitly avoids
/// the previous permanent "running" lie and gives the UI a retryable record.
#[tauri::command]
pub fn media_jobs_recover(app: AppHandle) -> Result<u64, String> {
    let conn = open_jobs_db(&app)?;
    let at = now_ms();
    let result = json_event_for_recovery(at);
    let count = conn
        .execute(
            "UPDATE jobs SET status='interrupted', result=?1, updated_at=?2
             WHERE kind LIKE 'media:%' AND status IN ('queued','running','cancel_requested')",
            rusqlite::params![result, at],
        )
        .map_err(|e| format!("recover media jobs: {e}"))?;
    Ok(count as u64)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetState {
    pub id: String,
    pub local: bool,
    pub exists: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAssetDeleteResult {
    pub id: String,
    pub record_deleted: bool,
    pub file_deleted: bool,
}

const MANAGED_MEDIA_DIRS: [&str; 3] = ["image-assets", "video-assets", "music-assets"];

fn managed_asset_path_in_root(root: &Path, raw: &str) -> Result<Option<PathBuf>, String> {
    let value = raw.trim();
    if value.is_empty()
        || value.starts_with("http://")
        || value.starts_with("https://")
        || value.starts_with("data:")
        || value.starts_with("asset:")
        || value.starts_with("blob:")
    {
        return Ok(None);
    }

    let candidate = PathBuf::from(value);
    if !candidate.is_absolute() {
        return Ok(None);
    }
    if candidate
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("media asset path contains a parent traversal".to_string());
    }

    for subdir in MANAGED_MEDIA_DIRS {
        let managed_root = root.join(subdir);
        if candidate.starts_with(&managed_root) {
            return Ok(Some(candidate));
        }
        // Existing paths may differ only by Windows casing or an extended-path
        // prefix. Canonicalization gives the final containment verdict without
        // ever following a user-controlled path for deletion first.
        if candidate.exists() && managed_root.exists() {
            let canonical_candidate = candidate
                .canonicalize()
                .map_err(|e| format!("canonicalize media asset: {e}"))?;
            let canonical_root = managed_root
                .canonicalize()
                .map_err(|e| format!("canonicalize media root: {e}"))?;
            if canonical_candidate.starts_with(canonical_root) {
                return Ok(Some(candidate));
            }
        }
    }
    Err("path is outside Shugu managed media directories".to_string())
}

fn managed_asset_path(app: &AppHandle, raw: &str) -> Result<Option<PathBuf>, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    managed_asset_path_in_root(&root, raw)
}

/// Reconcile local generation records against the filesystem. Missing files
/// are persisted as `missing`; a file restored by the user becomes `done`
/// again. Remote/data URLs are reported as non-local and never touched.
#[tauri::command]
pub fn media_assets_reconcile(app: AppHandle) -> Result<Vec<MediaAssetState>, String> {
    let conn = open_jobs_db(&app)?;
    let records = {
        let mut stmt = conn
            .prepare("SELECT id, COALESCE(result_url, ''), COALESCE(status, '') FROM generations")
            .map_err(|e| format!("prepare media reconciliation: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("query media reconciliation: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read media reconciliation: {e}"))?
    };

    let mut states = Vec::with_capacity(records.len());
    for (id, result_url, stored_status) in records {
        match managed_asset_path(&app, &result_url) {
            Ok(Some(path)) => {
                let exists = path.is_file();
                let status = if exists {
                    if stored_status == "missing" {
                        "done".to_string()
                    } else {
                        stored_status.clone()
                    }
                } else {
                    "missing".to_string()
                };
                if status != stored_status {
                    conn.execute(
                        "UPDATE generations SET status=?1 WHERE id=?2",
                        rusqlite::params![status, id],
                    )
                    .map_err(|e| format!("update media asset {id}: {e}"))?;
                }
                states.push(MediaAssetState {
                    id,
                    local: true,
                    exists,
                    status,
                });
            }
            Ok(None) | Err(_) => states.push(MediaAssetState {
                id,
                local: false,
                exists: !result_url.trim().is_empty(),
                status: stored_status,
            }),
        }
    }
    Ok(states)
}

fn generation_result_url(conn: &rusqlite::Connection, id: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT COALESCE(result_url, '') FROM generations WHERE id=?1",
        [id],
        |row| row.get(0),
    )
    .map_err(|e| format!("generation {id} not found: {e}"))
}

#[tauri::command]
pub fn media_asset_reveal(app: AppHandle, id: String) -> Result<(), String> {
    let conn = open_jobs_db(&app)?;
    let raw = generation_result_url(&conn, &id)?;
    let path = managed_asset_path(&app, &raw)?
        .ok_or_else(|| "this generation has no revealable local file".to_string())?;
    if !path.is_file() {
        return Err("the local media file is missing".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        command.arg(format!("/select,{}", path.display()));
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg("-R").arg(&path);
        command
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path.parent().unwrap_or(&path));
        command
    };

    command
        .spawn()
        .map_err(|e| format!("reveal media asset: {e}"))?;
    Ok(())
}

/// Delete a generation record and, when requested, its exact managed local
/// file. The path is always read from SQLite by id; callers cannot submit an
/// arbitrary filesystem target.
#[tauri::command]
pub fn media_asset_delete(
    app: AppHandle,
    id: String,
    delete_file: bool,
) -> Result<MediaAssetDeleteResult, String> {
    let conn = open_jobs_db(&app)?;
    let raw = generation_result_url(&conn, &id)?;
    let mut file_deleted = false;
    if delete_file {
        if let Some(path) = managed_asset_path(&app, &raw)? {
            if path.exists() {
                fs::remove_file(&path)
                    .map_err(|e| format!("delete media file {}: {e}", path.display()))?;
                file_deleted = true;
            }
        }
    }
    let record_deleted = conn
        .execute("DELETE FROM generations WHERE id=?1", [&id])
        .map_err(|e| format!("delete generation {id}: {e}"))?
        > 0;
    Ok(MediaAssetDeleteResult {
        id,
        record_deleted,
        file_deleted,
    })
}

fn json_event_for_recovery(at: i64) -> String {
    serde_json::json!({
        "status":"interrupted",
        "phase":"interrupted",
        "progress":0,
        "message":"Interrompu par la fermeture de Shugu — relance la génération",
        "updatedAt":at,
    })
    .to_string()
}

/// Normalise une base URL MiniMax : retire le slash final et un éventuel
/// suffixe `/v1`, de sorte que les appelants composent `{base}/v1/...` sans
/// risque de doubler le segment. Une base vide retombe sur l'hôte global `.io`.
pub fn normalize_minimax_base(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = base.strip_suffix("/v1").unwrap_or(base);
    if base.is_empty() {
        "https://api.minimax.io".to_string()
    } else {
        base.to_string()
    }
}

/// Identifiant de repli basé sur l'horloge (assets sans id serveur).
pub fn fallback_id(prefix: &str) -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{prefix}-{ms}")
}

/// Réduit un id arbitraire à des caractères de nom de fichier sûrs.
pub fn safe_asset_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "asset".to_string()
    } else {
        trimmed
    }
}

/// Dossier d'assets sous `app_data_dir/<sub>`, créé si besoin.
pub fn asset_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join(sub);
    fs::create_dir_all(&dir).map_err(|e| format!("create asset dir {sub}: {e}"))?;
    Ok(dir)
}

/// Écrit des octets dans `app_data_dir/<sub>/<id>.<ext>` ; renvoie le chemin absolu.
pub fn save_bytes(
    app: &AppHandle,
    sub: &str,
    id: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let dir = asset_dir(app, sub)?;
    save_bytes_in_dir(&dir, id, ext, bytes)
}

fn save_bytes_in_dir(
    dir: &std::path::Path,
    id: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let stem = safe_asset_id(id);
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let path = dir.join(format!("{stem}.{ext}"));
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    let part = dir.join(format!(".{stem}.{ext}.{}.part", fallback_id("write")));
    if let Err(error) = fs::write(&part, bytes) {
        let _ = fs::remove_file(&part);
        return Err(format!("write partial asset: {error}"));
    }
    if let Err(error) = fs::rename(&part, &path) {
        let _ = fs::remove_file(&part);
        return Err(format!("finalize asset: {error}"));
    }
    Ok(path.to_string_lossy().to_string())
}

/// Télécharge une URL et la sauve en asset local ; renvoie le chemin local.
pub async fn download_to_asset(
    client: &reqwest::Client,
    app: &AppHandle,
    sub: &str,
    id: &str,
    ext: &str,
    url: &str,
) -> Result<String, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download {url}: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read download {url}: {e}"))?;
    save_bytes(app, sub, id, ext, &bytes)
}

/// Vérifie le `base_resp` commun MiniMax : une erreur logique arrive en HTTP 200
/// avec `base_resp.status_code != 0`.
pub fn check_base_resp(v: &Value, step: &str) -> Result<(), String> {
    if let Some(code) = v.pointer("/base_resp/status_code").and_then(|c| c.as_i64()) {
        if code != 0 {
            let msg = v
                .pointer("/base_resp/status_msg")
                .and_then(|m| m.as_str())
                .unwrap_or("erreur inconnue");
            return Err(format!("minimax {step}: status {code}: {msg}"));
        }
    }
    Ok(())
}

/// Construit un message d'erreur HTTP compact (sans retours ligne, tronqué).
pub async fn http_error(label: &str, resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let clean: String = text
        .trim()
        .replace(['\r', '\n', '\t'], " ")
        .chars()
        .take(500)
        .collect();
    if clean.is_empty() {
        format!("minimax {label}: HTTP {status}")
    } else {
        format!("minimax {label}: HTTP {status}: {clean}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_base_url() {
        assert_eq!(
            normalize_minimax_base("https://api.minimax.io"),
            "https://api.minimax.io"
        );
        assert_eq!(
            normalize_minimax_base("https://api.minimax.io/"),
            "https://api.minimax.io"
        );
        assert_eq!(
            normalize_minimax_base("https://api.minimax.io/v1"),
            "https://api.minimax.io"
        );
        assert_eq!(
            normalize_minimax_base("https://api.minimax.io/v1/"),
            "https://api.minimax.io"
        );
        assert_eq!(normalize_minimax_base("  "), "https://api.minimax.io");
    }

    #[test]
    fn sanitizes_asset_id() {
        assert_eq!(safe_asset_id("abc-123"), "abc-123");
        assert_eq!(safe_asset_id("a/b\\c?d"), "a-b-c-d");
        assert_eq!(safe_asset_id("///"), "asset");
        assert_eq!(safe_asset_id(""), "asset");
    }

    #[test]
    fn base_resp_zero_is_ok() {
        assert!(check_base_resp(&json!({ "base_resp": { "status_code": 0 } }), "test").is_ok());
        assert!(check_base_resp(&json!({ "task_id": "x" }), "test").is_ok());
    }

    #[test]
    fn base_resp_nonzero_is_err() {
        let v =
            json!({ "base_resp": { "status_code": 1008, "status_msg": "insufficient balance" } });
        let err = check_base_resp(&v, "soumission").unwrap_err();
        assert!(err.contains("1008"));
        assert!(err.contains("insufficient balance"));
    }

    #[tokio::test]
    async fn cancellation_wakes_waiter_and_is_sticky() {
        let control = Arc::new(MediaJobControl::new());
        let waiter = {
            let control = control.clone();
            tokio::spawn(async move { control.cancelled().await })
        };
        control.cancel();
        waiter.await.unwrap();
        assert!(control.is_cancelled());
        control.cancelled().await;
    }

    #[test]
    fn asset_write_is_atomic_and_leaves_no_partial_file() {
        let dir = std::env::temp_dir().join(format!(
            "shugu-media-atomic-{}-{}",
            std::process::id(),
            fallback_id("test")
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = save_bytes_in_dir(&dir, "asset/id", ".MP3", b"media").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"media");
        assert!(!fs::read_dir(&dir).unwrap().any(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "part")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn managed_asset_paths_are_confined_to_media_directories() {
        let root = std::env::temp_dir().join(format!("shugu-media-root-{}", fallback_id("test")));
        let valid = root.join("image-assets").join("asset.png");
        assert_eq!(
            managed_asset_path_in_root(&root, &valid.to_string_lossy()).unwrap(),
            Some(valid)
        );

        let outside = root.join("other").join("asset.png");
        assert!(managed_asset_path_in_root(&root, &outside.to_string_lossy()).is_err());
    }

    #[test]
    fn remote_media_references_are_never_local_delete_targets() {
        let root = std::env::temp_dir();
        for value in [
            "https://example.com/image.png",
            "data:image/png;base64,AA==",
            "asset://localhost/file.png",
            "blob:http://localhost/id",
            "",
        ] {
            assert_eq!(managed_asset_path_in_root(&root, value).unwrap(), None);
        }
    }

    #[test]
    fn managed_asset_paths_reject_parent_traversal() {
        let root = std::env::temp_dir().join(format!("shugu-media-root-{}", fallback_id("test")));
        let traversal = root.join("image-assets").join("..").join("outside.png");
        assert!(managed_asset_path_in_root(&root, &traversal.to_string_lossy()).is_err());
    }
}
