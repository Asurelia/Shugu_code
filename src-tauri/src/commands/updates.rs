//! Safe application-update channel.
//!
//! Shugu does not silently execute downloaded installers. Until a Tauri
//! updater signing key is provisioned, the safe contract is:
//!   1. ask GitHub Releases whether a newer stable version exists;
//!   2. select the installer for the current OS in Rust;
//!   3. download it into Shugu's managed cache, with a hard size cap;
//!   4. verify GitHub's SHA-256 digest when the API supplies one;
//!   5. reveal the file so the user remains in control of installation.
//!
//! The frontend supplies only an opaque GitHub asset id. URLs and paths are
//! always re-fetched and validated here, which keeps SSRF and path traversal
//! out of the IPC surface.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const LATEST_RELEASE_API: &str = "https://api.github.com/repos/Asurelia/Shugu_code/releases/latest";
const RELEASES_URL: &str = "https://github.com/Asurelia/Shugu_code/releases";
const MAX_INSTALLER_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubAsset {
    id: u64,
    name: String,
    browser_download_url: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    /// GitHub ids are 64-bit integers. They cross IPC as strings so JavaScript
    /// can never silently round a future id above Number.MAX_SAFE_INTEGER.
    id: String,
    name: String,
    bytes: u64,
    digest: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    /// `available`, `upToDate`, or `channelUnavailable`.
    state: &'static str,
    latest_version: Option<String>,
    release_name: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    release_url: String,
    asset: Option<UpdateAsset>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadResult {
    path: String,
    bytes: u64,
    verified: bool,
    digest: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    received: u64,
    total: u64,
}

#[derive(Default)]
pub struct UpdateDownloadState {
    busy: AtomicBool,
    downloaded: Mutex<Option<PathBuf>>,
}

struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn parse_version(raw: &str) -> Option<Version> {
    Version::parse(raw.trim().trim_start_matches(['v', 'V'])).ok()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(latest), Some(current)) => latest > current,
        _ => false,
    }
}

fn installer_rank(name: &str, os: &str) -> Option<u8> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".sig")
        || lower.ends_with(".sha256")
        || lower.ends_with(".sha256sum")
        || lower.contains("checksum")
    {
        return None;
    }
    match os {
        "windows" if lower.ends_with("-setup.exe") => Some(0),
        "windows" if lower.ends_with(".msi") => Some(1),
        "windows" if lower.ends_with(".exe") => Some(2),
        "macos" if lower.ends_with(".dmg") => Some(0),
        "macos" if lower.ends_with(".pkg") => Some(1),
        "linux" if lower.ends_with(".appimage") => Some(0),
        "linux" if lower.ends_with(".deb") => Some(1),
        "linux" if lower.ends_with(".rpm") => Some(2),
        _ => None,
    }
}

fn select_installer<'a>(assets: &'a [GitHubAsset], os: &str) -> Option<&'a GitHubAsset> {
    assets
        .iter()
        .filter_map(|asset| installer_rank(&asset.name, os).map(|rank| (rank, asset)))
        .min_by_key(|(rank, _)| *rank)
        .map(|(_, asset)| asset)
}

fn validate_asset_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || Path::new(name).file_name().and_then(|part| part.to_str()) != Some(name)
    {
        return Err("nom d’installeur GitHub invalide".to_string());
    }
    Ok(())
}

fn validate_download_url(raw: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "URL de Release invalide".to_string())?;
    let expected_prefix = "/Asurelia/Shugu_code/releases/download/";
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.path().starts_with(expected_prefix)
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("l’installeur ne vient pas de la Release GitHub Shugu".to_string());
    }
    Ok(())
}

fn expected_sha256(digest: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = digest else {
        return Ok(None);
    };
    let Some(hex) = raw.strip_prefix("sha256:") else {
        return Err("format de digest GitHub non pris en charge".to_string());
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("digest SHA-256 GitHub invalide".to_string());
    }
    Ok(Some(hex.to_ascii_lowercase()))
}

fn update_client(
    current_version: &str,
    total_timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("trop de redirections GitHub");
            }
            match attempt.url().host_str() {
                Some("github.com")
                | Some("api.github.com")
                | Some("release-assets.githubusercontent.com")
                | Some("objects.githubusercontent.com") => attempt.follow(),
                _ => attempt.stop(),
            }
        }))
        .user_agent(format!("Shugu-Forge/{current_version}"));
    if let Some(timeout) = total_timeout {
        builder = builder.timeout(timeout);
    }
    builder
        .build()
        .map_err(|error| format!("initialisation du canal de mise à jour : {error}"))
}

async fn latest_release(current_version: &str) -> Result<Option<GitHubRelease>, String> {
    let response = update_client(current_version, Some(Duration::from_secs(20)))?
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("canal de mise à jour indisponible : {error}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "GitHub Releases a répondu HTTP {}",
            response.status()
        ));
    }
    let release = response
        .json::<GitHubRelease>()
        .await
        .map_err(|error| format!("réponse GitHub Release invalide : {error}"))?;
    if release.draft || release.prerelease {
        return Ok(None);
    }
    Ok(Some(release))
}

fn public_asset(asset: &GitHubAsset) -> UpdateAsset {
    UpdateAsset {
        id: asset.id.to_string(),
        name: asset.name.clone(),
        bytes: asset.size,
        digest: asset.digest.clone(),
    }
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let Some(release) = latest_release(&current_version).await? else {
        return Ok(UpdateStatus {
            current_version,
            state: "channelUnavailable",
            latest_version: None,
            release_name: None,
            notes: None,
            published_at: None,
            release_url: RELEASES_URL.to_string(),
            asset: None,
        });
    };

    let newer = is_newer_version(&release.tag_name, &current_version);
    let selected = select_installer(&release.assets, std::env::consts::OS);
    let state = if newer {
        if selected.is_some() {
            "available"
        } else {
            "channelUnavailable"
        }
    } else {
        "upToDate"
    };
    Ok(UpdateStatus {
        current_version,
        state,
        latest_version: Some(
            parse_version(&release.tag_name)
                .map(|version| version.to_string())
                .unwrap_or(release.tag_name),
        ),
        release_name: release.name,
        notes: release.body.map(|body| body.chars().take(4_000).collect()),
        published_at: release.published_at,
        release_url: release.html_url,
        asset: if newer {
            selected.map(public_asset)
        } else {
            None
        },
    })
}

#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
    asset_id: String,
) -> Result<UpdateDownloadResult, String> {
    state
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "un téléchargement de mise à jour est déjà en cours".to_string())?;
    let _busy = BusyGuard(&state.busy);

    let asset_id = asset_id
        .parse::<u64>()
        .map_err(|_| "identifiant d’installeur GitHub invalide".to_string())?;
    let current_version = app.package_info().version.to_string();
    let release = latest_release(&current_version)
        .await?
        .ok_or_else(|| "aucune Release stable n’est publiée".to_string())?;
    if !is_newer_version(&release.tag_name, &current_version) {
        return Err("Shugu est déjà à jour".to_string());
    }

    let selected = select_installer(&release.assets, std::env::consts::OS)
        .ok_or_else(|| "aucun installeur compatible avec cette plateforme".to_string())?;
    if selected.id != asset_id {
        return Err("la Release a changé ; relance la vérification".to_string());
    }
    validate_asset_name(&selected.name)?;
    validate_download_url(&selected.browser_download_url)?;
    if selected.size == 0 || selected.size > MAX_INSTALLER_BYTES {
        return Err("taille d’installeur GitHub invalide ou excessive".to_string());
    }
    let expected_hash = expected_sha256(selected.digest.as_deref())?;

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("cache de mise à jour indisponible : {error}"))?
        .join("updates");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("création du cache de mise à jour : {error}"))?;
    let final_path = cache_dir.join(&selected.name);
    let partial_path = cache_dir.join(format!(".{}.{}.part", selected.id, uuid::Uuid::new_v4()));

    let result = download_asset(
        &app,
        selected,
        &partial_path,
        &final_path,
        expected_hash.as_deref(),
        &current_version,
    )
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial_path).await;
    }
    let result = result?;

    let mut downloaded = state
        .downloaded
        .lock()
        .map_err(|_| "état de mise à jour indisponible".to_string())?;
    *downloaded = Some(final_path);
    Ok(result)
}

async fn download_asset(
    app: &AppHandle,
    asset: &GitHubAsset,
    partial_path: &Path,
    final_path: &Path,
    expected_hash: Option<&str>,
    current_version: &str,
) -> Result<UpdateDownloadResult, String> {
    // No total request timeout here: installer downloads may legitimately take
    // minutes. Connect and per-read timeouts above still detect a dead channel.
    let response = update_client(current_version, None)?
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|error| format!("téléchargement de l’installeur : {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "téléchargement de l’installeur : HTTP {}",
            response.status()
        ));
    }
    if let Some(length) = response.content_length() {
        if length == 0 || length > MAX_INSTALLER_BYTES || length != asset.size {
            return Err(
                "la taille HTTP de l’installeur ne correspond pas à la Release".to_string(),
            );
        }
    }

    let mut file = tokio::fs::File::create(partial_path)
        .await
        .map_err(|error| format!("création du fichier temporaire : {error}"))?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_emit = Instant::now() - Duration::from_millis(200);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("lecture du téléchargement : {error}"))?;
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "taille de téléchargement invalide".to_string())?;
        if received > asset.size || received > MAX_INSTALLER_BYTES {
            return Err("le téléchargement dépasse la taille annoncée".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("écriture de l’installeur : {error}"))?;
        if last_emit.elapsed() >= Duration::from_millis(100) {
            let _ = app.emit(
                "update://download-progress",
                UpdateDownloadProgress {
                    received,
                    total: asset.size,
                },
            );
            last_emit = Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("finalisation de l’installeur : {error}"))?;
    drop(file);

    if received != asset.size {
        return Err(format!(
            "téléchargement incomplet : {received} octets reçus sur {}",
            asset.size
        ));
    }
    let actual_hash = format!("{:x}", hasher.finalize());
    if let Some(expected) = expected_hash {
        if actual_hash != expected {
            return Err("le SHA-256 de l’installeur ne correspond pas à GitHub".to_string());
        }
    }

    if final_path.exists() {
        tokio::fs::remove_file(final_path)
            .await
            .map_err(|error| format!("remplacement de l’ancien installeur : {error}"))?;
    }
    tokio::fs::rename(partial_path, final_path)
        .await
        .map_err(|error| format!("publication locale de l’installeur : {error}"))?;
    let _ = app.emit(
        "update://download-progress",
        UpdateDownloadProgress {
            received,
            total: asset.size,
        },
    );

    Ok(UpdateDownloadResult {
        path: final_path.to_string_lossy().into_owned(),
        bytes: received,
        verified: expected_hash.is_some(),
        digest: actual_hash,
    })
}

#[tauri::command]
pub fn update_reveal_download(state: State<'_, UpdateDownloadState>) -> Result<(), String> {
    let path = state
        .downloaded
        .lock()
        .map_err(|_| "état de mise à jour indisponible".to_string())?
        .clone()
        .ok_or_else(|| "aucun installeur téléchargé dans cette session".to_string())?;
    if !path.is_file() {
        return Err("le fichier d’installation téléchargé est introuvable".to_string());
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
        .map_err(|error| format!("affichage de l’installeur : {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(id: u64, name: &str) -> GitHubAsset {
        GitHubAsset {
            id,
            name: name.to_string(),
            browser_download_url: format!(
                "https://github.com/Asurelia/Shugu_code/releases/download/v1.2.3/{name}"
            ),
            size: 42,
            digest: None,
        }
    }

    #[test]
    fn compares_semver_and_accepts_v_prefix() {
        assert!(is_newer_version("v1.2.0", "1.1.9"));
        assert!(!is_newer_version("v1.2.0", "1.2.0"));
        assert!(!is_newer_version("not-a-version", "1.2.0"));
    }

    #[test]
    fn chooses_native_installer_by_priority() {
        let assets = vec![
            asset(1, "Shugu.exe"),
            asset(2, "Shugu.msi"),
            asset(3, "Shugu-setup.exe"),
            asset(4, "Shugu-setup.exe.sig"),
        ];
        assert_eq!(select_installer(&assets, "windows").unwrap().id, 3);
        assert_eq!(public_asset(&assets[2]).id, "3");
        assert!(select_installer(&assets, "linux").is_none());
    }

    #[test]
    fn rejects_path_traversal_and_foreign_downloads() {
        assert!(validate_asset_name("../Shugu-setup.exe").is_err());
        assert!(validate_asset_name(r"..\Shugu-setup.exe").is_err());
        assert!(validate_asset_name("Shugu-setup.exe").is_ok());
        assert!(validate_download_url(
            "https://github.com/Asurelia/Shugu_code/releases/download/v1/Shugu-setup.exe"
        )
        .is_ok());
        assert!(validate_download_url(
            "https://evil.example/Asurelia/Shugu_code/releases/download/v1/Shugu.exe"
        )
        .is_err());
    }

    #[test]
    fn parses_only_sha256_digests() {
        let hash = "A".repeat(64);
        assert_eq!(
            expected_sha256(Some(&format!("sha256:{hash}"))).unwrap(),
            Some("a".repeat(64))
        );
        assert!(expected_sha256(Some("sha512:abc")).is_err());
        assert!(expected_sha256(Some("sha256:abc")).is_err());
        assert_eq!(expected_sha256(None).unwrap(), None);
    }
}
