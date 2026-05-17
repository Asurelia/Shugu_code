//! Local GGUF model bundle — catalog, download, status.
//!
//! This module owns the lifecycle of the **local LLM weight files** that
//! Shugu ships with (or downloads at first run). It is intentionally
//! separate from `models.rs` (which only enumerates remote API providers
//! for the chat picker) because the concerns are orthogonal:
//!   - `models.rs`  → "what API endpoints can the user talk to?"
//!   - this module  → "what .gguf files do we have on disk locally?"
//!
//! Storage layout:
//!   %LOCALAPPDATA%\dev.shugu.forge\models\<id>.gguf
//!
//! We use `app_local_data_dir()` (NOT `app_config_dir()`) because GGUF
//! files are large (1+ GB), platform-conventional storage for big mutable
//! data is the per-machine LocalAppData on Windows. Config dir is for
//! Roaming-friendly small settings — putting a 1 GB blob there would
//! drag the user's roaming profile across the network on every login at
//! a corporate Windows shop.
//!
//! Download protocol:
//!   * HTTPS only — the URL is validated against an allowlist of trusted
//!     hostnames (huggingface.co for now). User-supplied URLs are NOT
//!     accepted; the catalog is hardcoded.
//!   * Resumable: a `.partial` file is kept across interrupted downloads
//!     and resumed with an HTTP `Range` request on the next call.
//!   * SHA256 verified at the end. Mismatch → file deleted, error
//!     returned. The user can then either retry (transient corruption)
//!     or bump the expected hash if upstream legitimately changed.
//!   * Progress events emitted on `bundle-download://progress` so the
//!     React onboarding panel can render a progress bar.
//!
//! Security:
//!   * `model_id` from the frontend is matched against the catalog
//!     before any filesystem touch — there is no user-controlled path
//!     concatenation. SSRF is moot (no user-controlled URL), path
//!     traversal is moot (no user-controlled filename).
//!   * SHA256 mismatch causes immediate deletion — a tampered file
//!     never lingers on disk where a future code path might trust it.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use futures_util::StreamExt;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/// One downloadable model bundle entry.
///
/// The fields are deliberately frontend-friendly (camelCase via serde rename,
/// human-friendly strings, byte sizes as u64) so the onboarding UI can
/// render a card without an additional translation layer.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelBundleEntry {
    /// Stable identifier used both as the on-disk filename stem and as the
    /// argument to `model_bundle_download`. ASCII, no spaces, no slashes.
    pub id: &'static str,
    /// Human-friendly name shown in the onboarding panel.
    pub display_name: &'static str,
    /// Short tagline ("Persona + router unifie, Apache 2.0").
    pub tagline: &'static str,
    /// HTTPS URL to fetch the file from. MUST point to an allowlisted host.
    pub url: &'static str,
    /// Expected SHA256, lowercase hex. Empty string `""` means "not yet
    /// pinned" — the first download will succeed with a warning and the
    /// computed hash will be emitted to the UI for the dev to copy into
    /// the catalog as a follow-up commit.
    pub sha256: &'static str,
    /// Expected file size in bytes. Used for the progress bar denominator
    /// when the server doesn't send a Content-Length header (rare on HF,
    /// but possible behind caching proxies). 0 = unknown.
    pub size_bytes: u64,
    /// SPDX license identifier of the model weights (e.g. "Apache-2.0").
    /// Surfaced in the onboarding UI so the user knows what they're
    /// installing.
    pub license: &'static str,
    /// Quantization tag for display only ("Q4_K_M", "Q5_K_M", ...). Not
    /// used by the code.
    pub quant: &'static str,
}

/// Hardcoded catalog of bundle models Shugu offers at first run.
///
/// Bumping a version here = a deliberate, reviewable commit. The SHA256
/// MUST be re-validated against an independent source (the HF model page
/// "Use in Transformers" → file inspector, or `huggingface-cli` locally)
/// before any new entry is committed with a non-empty hash.
///
/// Keep this list SHORT — the onboarding UI works best with one primary
/// choice (the default). Additional models can be exposed through a
/// future "Advanced" Settings page that calls the same `model_bundle_*`
/// commands.
pub const CATALOG: &[ModelBundleEntry] = &[
    ModelBundleEntry {
        id: "qwen3.5-2b-q4_k_m",
        display_name: "Qwen 3.5 2B",
        tagline: "Persona + router unifie, multilingue, 262K context, Apache 2.0",
        // unsloth republishes the official Qwen weights in GGUF format
        // (Apache 2.0 preserved). Their repo is the most reliably reachable
        // source for the Q4_K_M quant at this scale; Qwen's own GGUF repo
        // for the 2B variant returns 401 as of May 2026.
        // `resolve/main/` is the raw-file download endpoint (vs `/blob/main/`
        // which serves the HTML viewer).
        url: "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf",
        // SHA256 deliberately left empty for first-run discovery. The first
        // successful download will print the computed hash; the dev pins it
        // here in a follow-up commit, and from then on every install
        // validates strictly against this value.
        sha256: "",
        // 1.28 GiB per the upstream HF model card. Used as the progress bar
        // denominator if the server doesn't send Content-Length (rare on HF
        // but possible behind a caching proxy).
        size_bytes: 1_280_000_000,
        license: "Apache-2.0",
        quant: "Q4_K_M",
    },
];

// ---------------------------------------------------------------------------
// URL allowlist
// ---------------------------------------------------------------------------

/// Hostnames we accept as model download sources.
///
/// HuggingFace is the only one for now. If a future entry needs a different
/// source (e.g. ModelScope, Ollama Hub), it must be added here AS A NEW
/// COMMIT — the allowlist is the gatekeeper against catalog-poisoning.
const URL_ALLOWLIST: &[&str] = &["huggingface.co"];

/// Returns true iff `url` is an https:// URL whose host is in the allowlist.
///
/// Rejects: http://, file://, data:, javascript:, ftp://, hosts off the
/// allowlist, or anything we can't parse. Conservative by design.
fn is_url_allowed(url: &str) -> bool {
    // The `url` crate isn't a dep here; we do a minimal parse by hand.
    // This is fine because the catalog is hardcoded — the function only
    // ever sees URLs we wrote ourselves. Still defensive in case a future
    // contributor adds a typo'd URL.
    let stripped = match url.strip_prefix("https://") {
        Some(s) => s,
        None => return false,
    };
    // Take everything up to the first '/', ':' or end. That's the host.
    let host_end = stripped
        .find(|c: char| c == '/' || c == ':' || c == '?' || c == '#')
        .unwrap_or(stripped.len());
    let host = &stripped[..host_end];
    URL_ALLOWLIST.iter().any(|&allowed| host == allowed)
}

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

/// Resolve the directory where bundle models are stored. Created on demand.
///
/// Cached after the first lookup — the AppHandle's path resolver does FS
/// work each call, no point in re-running it.
fn bundle_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    static CACHED: OnceLock<PathBuf> = OnceLock::new();
    if let Some(p) = CACHED.get() {
        return Ok(p.clone());
    }
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("cannot resolve app local data dir: {e}"))?
        .join("models");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create models dir {}: {e}", dir.display()))?;
    let _ = CACHED.set(dir.clone());
    Ok(dir)
}

/// Compute the final on-disk path for a given catalog entry.
fn model_path(app: &tauri::AppHandle, entry: &ModelBundleEntry) -> Result<PathBuf, String> {
    Ok(bundle_dir(app)?.join(format!("{}.gguf", entry.id)))
}

/// Compute the partial-download path used during streaming. Renamed to the
/// final path only after SHA256 validation succeeds.
fn partial_path(app: &tauri::AppHandle, entry: &ModelBundleEntry) -> Result<PathBuf, String> {
    Ok(bundle_dir(app)?.join(format!("{}.gguf.partial", entry.id)))
}

// ---------------------------------------------------------------------------
// Catalog lookup
// ---------------------------------------------------------------------------

fn lookup(model_id: &str) -> Result<&'static ModelBundleEntry, String> {
    CATALOG
        .iter()
        .find(|e| e.id == model_id)
        .ok_or_else(|| format!("unknown model id: {model_id}"))
}

// ---------------------------------------------------------------------------
// Public Tauri commands
// ---------------------------------------------------------------------------

/// Return the full catalog of bundle models. Used by the onboarding UI to
/// render the welcome screen.
#[tauri::command]
pub fn model_bundle_catalog() -> Vec<ModelBundleEntry> {
    CATALOG.to_vec()
}

/// Status of every entry in the catalog: present on disk? expected size?
/// matching SHA256?
///
/// `sha256Matches` is `None` when the catalog entry has an empty expected
/// hash (first-run discovery mode) — the UI should treat that as "not
/// verified, but trusted on this machine" with a soft warning.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelBundleStatus {
    pub id: &'static str,
    pub installed: bool,
    pub bytes_on_disk: u64,
    /// Computed SHA256 of the on-disk file. `None` if not installed. We
    /// recompute every call — for a 1 GB file this is ~3-5 seconds on a
    /// modern CPU. Acceptable because this command is called once at app
    /// boot, not on every render.
    pub sha256_actual: Option<String>,
    pub sha256_expected: &'static str,
    pub sha256_matches: Option<bool>,
}

#[tauri::command]
pub fn model_bundle_status(app: tauri::AppHandle) -> Result<Vec<ModelBundleStatus>, String> {
    CATALOG
        .iter()
        .map(|entry| {
            let path = model_path(&app, entry)?;
            if !path.exists() {
                return Ok(ModelBundleStatus {
                    id: entry.id,
                    installed: false,
                    bytes_on_disk: 0,
                    sha256_actual: None,
                    sha256_expected: entry.sha256,
                    sha256_matches: None,
                });
            }

            let metadata = std::fs::metadata(&path)
                .map_err(|e| format!("stat {}: {e}", path.display()))?;
            let bytes_on_disk = metadata.len();

            // Compute the on-disk hash. Stream the file in 1 MB chunks so we
            // don't load a multi-GB file into RAM at once.
            let mut file = std::fs::File::open(&path)
                .map_err(|e| format!("open {}: {e}", path.display()))?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 1024 * 1024];
            loop {
                use std::io::Read;
                let n = file
                    .read(&mut buf)
                    .map_err(|e| format!("read {}: {e}", path.display()))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            let actual = format!("{:x}", hasher.finalize());

            let matches = if entry.sha256.is_empty() {
                None
            } else {
                Some(actual == entry.sha256)
            };

            Ok(ModelBundleStatus {
                id: entry.id,
                installed: true,
                bytes_on_disk,
                sha256_actual: Some(actual),
                sha256_expected: entry.sha256,
                sha256_matches: matches,
            })
        })
        .collect()
}

/// Progress event payload streamed during a download. The frontend
/// subscribes to `bundle-download://progress` to render the progress bar.
///
/// Phases:
///   * `downloading` — chunks landing, bytesDone < bytesTotal
///   * `verifying`   — file complete, SHA256 being computed (no more bytes,
///                     just CPU time)
///   * `done`        — verification passed, file renamed to final path
///   * `error`       — anything failed; `error` is the human-readable msg
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct BundleProgress {
    id: String,
    phase: &'static str,
    bytes_done: u64,
    bytes_total: u64,
    /// Computed hash; only populated in the "done" phase.
    sha256_actual: Option<String>,
    /// Set on the "error" phase only.
    error: Option<String>,
}

fn emit(app: &tauri::AppHandle, payload: BundleProgress) {
    let _ = app.emit("bundle-download://progress", payload);
}

/// Download the model identified by `model_id`. Resumes a previous partial
/// download if `<id>.gguf.partial` exists.
///
/// This is the long-running command. It MUST be invoked from a non-blocking
/// path on the frontend (i.e. the React side awaits the promise but doesn't
/// block UI rendering — it subscribes to the progress events for incremental
/// feedback).
#[tauri::command]
pub async fn model_bundle_download(
    app: tauri::AppHandle,
    model_id: String,
) -> Result<String, String> {
    let entry = lookup(&model_id)?;

    if !is_url_allowed(entry.url) {
        return Err(format!("URL not in allowlist: {}", entry.url));
    }

    let final_path = model_path(&app, entry)?;
    let tmp_path = partial_path(&app, entry)?;

    // If the final file already exists with the right hash, short-circuit.
    if final_path.exists() && !entry.sha256.is_empty() {
        // Cheap check: matching size first, full hash only if size matches.
        let len = std::fs::metadata(&final_path)
            .map_err(|e| format!("stat existing: {e}"))?
            .len();
        if entry.size_bytes == 0 || len == entry.size_bytes {
            // Caller wants the canonical path back. The status command
            // does the strict hash check on next render — no need to
            // hash again here.
            return Ok(final_path.to_string_lossy().into_owned());
        }
    }

    // Determine resume offset by looking at any existing .partial.
    let resume_from: u64 = if tmp_path.exists() {
        std::fs::metadata(&tmp_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    // Build the request. If we have a resume offset, ask for the rest with
    // a Range header. The server is expected to honour it (HF does; raw S3
    // does). If it doesn't, we'll get a 200 with the FULL body — we detect
    // that below and truncate our partial file before writing.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        // Allow long-running streaming reads (no per-read timeout)
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("reqwest client: {e}"))?;

    let mut req = client.get(entry.url);
    if resume_from > 0 {
        req = req.header("Range", format!("bytes={resume_from}-"));
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            emit(&app, BundleProgress {
                id: entry.id.to_string(),
                phase: "error",
                bytes_done: resume_from,
                bytes_total: entry.size_bytes,
                sha256_actual: None,
                error: Some(format!("HTTP send failed: {e}")),
            });
            return Err(format!("HTTP send failed: {e}"));
        }
    };

    let status = response.status();
    if !status.is_success() {
        let msg = format!("HTTP {} from {}", status, entry.url);
        emit(&app, BundleProgress {
            id: entry.id.to_string(),
            phase: "error",
            bytes_done: resume_from,
            bytes_total: entry.size_bytes,
            sha256_actual: None,
            error: Some(msg.clone()),
        });
        return Err(msg);
    }

    // If we asked for a Range and got 200 OK instead of 206 Partial Content,
    // the server is sending the full body — discard our previous partial.
    let resuming = resume_from > 0 && status.as_u16() == 206;
    let effective_resume = if resuming { resume_from } else { 0 };

    // Content-Length, when present, gives us the REMAINING bytes after
    // resume_from. We use this to recompute the total target size.
    let content_length = response
        .content_length()
        .or_else(|| {
            response
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
        });

    let bytes_total: u64 = match content_length {
        Some(len) => effective_resume + len,
        None if entry.size_bytes > 0 => entry.size_bytes,
        None => 0,
    };

    // Open the partial file. Truncate if NOT resuming; append otherwise.
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .append(resuming)
        .truncate(!resuming)
        .open(&tmp_path)
        .await
        .map_err(|e| format!("open {}: {e}", tmp_path.display()))?;

    // SHA256 hasher must replay the resumed bytes — for simplicity we
    // re-read the existing partial when resuming, then continue with the
    // streamed bytes. This costs an extra disk read on resume but keeps
    // the on-disk file as the single source of truth for the hash.
    let mut hasher = Sha256::new();
    if resuming {
        let mut existing = tokio::fs::File::open(&tmp_path)
            .await
            .map_err(|e| format!("re-open partial for hashing: {e}"))?;
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 1024 * 1024];
        loop {
            let n = existing
                .read(&mut buf)
                .await
                .map_err(|e| format!("read partial: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    }

    let mut bytes_done = effective_resume;
    let mut stream = response.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    // Initial progress beacon so the UI shows the bar immediately.
    emit(&app, BundleProgress {
        id: entry.id.to_string(),
        phase: "downloading",
        bytes_done,
        bytes_total,
        sha256_actual: None,
        error: None,
    });

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let msg = format!("stream chunk: {e}");
            emit(&app, BundleProgress {
                id: entry.id.to_string(),
                phase: "error",
                bytes_done,
                bytes_total,
                sha256_actual: None,
                error: Some(msg.clone()),
            });
            msg
        })?;

        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| {
            let msg = format!("write {}: {e}", tmp_path.display());
            // Emit synchronously - we are at the await frontier already.
            let _ = app.emit("bundle-download://progress", BundleProgress {
                id: entry.id.to_string(),
                phase: "error",
                bytes_done,
                bytes_total,
                sha256_actual: None,
                error: Some(msg.clone()),
            });
            msg
        })?;

        bytes_done += chunk.len() as u64;

        // Throttle progress events to ~10 per second to avoid drowning the
        // webview event loop on fast downloads.
        if last_emit.elapsed() >= std::time::Duration::from_millis(100) {
            emit(&app, BundleProgress {
                id: entry.id.to_string(),
                phase: "downloading",
                bytes_done,
                bytes_total,
                sha256_actual: None,
                error: None,
            });
            last_emit = std::time::Instant::now();
        }
    }

    // Flush + close before renaming.
    file.flush()
        .await
        .map_err(|e| format!("flush {}: {e}", tmp_path.display()))?;
    drop(file);

    // ---- Verify SHA256 ----
    emit(&app, BundleProgress {
        id: entry.id.to_string(),
        phase: "verifying",
        bytes_done,
        bytes_total,
        sha256_actual: None,
        error: None,
    });

    let actual_hash = format!("{:x}", hasher.finalize());

    if !entry.sha256.is_empty() && actual_hash != entry.sha256 {
        // Hard fail: delete the bad file so a future code path can't
        // accidentally trust it.
        let _ = std::fs::remove_file(&tmp_path);
        let msg = format!(
            "SHA256 mismatch for {}: expected {}, got {}",
            entry.id, entry.sha256, actual_hash
        );
        emit(&app, BundleProgress {
            id: entry.id.to_string(),
            phase: "error",
            bytes_done,
            bytes_total,
            sha256_actual: Some(actual_hash),
            error: Some(msg.clone()),
        });
        return Err(msg);
    }

    // Rename .partial -> final. Atomic on the same filesystem.
    std::fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp_path.display(), final_path.display()))?;

    emit(&app, BundleProgress {
        id: entry.id.to_string(),
        phase: "done",
        bytes_done,
        bytes_total,
        sha256_actual: Some(actual_hash),
        error: None,
    });

    Ok(final_path.to_string_lossy().into_owned())
}

/// Delete the on-disk bundle file (and its `.partial`, if any). Idempotent.
#[tauri::command]
pub fn model_bundle_delete(app: tauri::AppHandle, model_id: String) -> Result<(), String> {
    let entry = lookup(&model_id)?;
    let final_path = model_path(&app, entry)?;
    let tmp_path = partial_path(&app, entry)?;
    if final_path.exists() {
        std::fs::remove_file(&final_path)
            .map_err(|e| format!("delete {}: {e}", final_path.display()))?;
    }
    if tmp_path.exists() {
        std::fs::remove_file(&tmp_path)
            .map_err(|e| format!("delete {}: {e}", tmp_path.display()))?;
    }
    Ok(())
}

/// Return the absolute path of the on-disk model file for `model_id`,
/// regardless of whether it is currently installed. Used by the auto-start
/// hook in `lib.rs` to feed `llama-server -m <path>` when the bundle is
/// present.
#[tauri::command]
pub fn model_bundle_path(app: tauri::AppHandle, model_id: String) -> Result<String, String> {
    let entry = lookup(&model_id)?;
    Ok(model_path(&app, entry)?.to_string_lossy().into_owned())
}

/// Cheap "what's on disk?" probe — returns the list of catalog ids whose
/// `.gguf` file exists, **without computing any hash**. Unlike
/// `model_bundle_status`, this never reads file contents — just a stat per
/// entry. O(catalog size) syscalls; negligible cost.
///
/// Use this from any hot path (discovery, picker hydration, boot probes)
/// that only needs to know whether the bundle exists. Reserve
/// `model_bundle_status` for the onboarding integrity flow where the
/// SHA256 is actually consumed.
///
/// Why a separate command: `model_bundle_status` hashes a 1+ GB file
/// (3-5s of synchronous IO) — calling it from a 60s-TTL discovery refresh
/// stalled the webview every boot and on every save/disconnect, which is
/// the root cause of the "Not Responding" freeze that surfaced after the
/// force-refresh-on-first-mount change.
#[tauri::command]
pub fn model_bundle_installed_ids(app: tauri::AppHandle) -> Result<Vec<&'static str>, String> {
    let mut out = Vec::new();
    for entry in CATALOG.iter() {
        let path = model_path(&app, entry)?;
        if path.exists() {
            out.push(entry.id);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Internal helpers (used by other Rust modules, NOT exposed as commands)
// ---------------------------------------------------------------------------

/// True iff the default bundle model is installed on this machine.
///
/// Used by the auto-start hook in `lib.rs` setup. If false, no auto-start
/// is attempted and the onboarding UI on the frontend will offer to
/// download.
#[allow(dead_code)]
pub fn default_model_installed(app: &tauri::AppHandle) -> bool {
    CATALOG
        .first()
        .and_then(|e| model_path(app, e).ok())
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// Path to the default bundle model file (whether or not it's installed).
#[allow(dead_code)]
pub fn default_model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    CATALOG.first().and_then(|e| model_path(app, e).ok())
}

// ---------------------------------------------------------------------------
// Tests for the URL allowlist (the only piece of pure logic in this file)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::is_url_allowed;

    #[test]
    fn allows_huggingface_https() {
        assert!(is_url_allowed("https://huggingface.co/foo/bar"));
        assert!(is_url_allowed("https://huggingface.co/Qwen/Qwen3.5-2B-Instruct-GGUF/resolve/main/x.gguf"));
    }

    #[test]
    fn rejects_http() {
        assert!(!is_url_allowed("http://huggingface.co/foo"));
    }

    #[test]
    fn rejects_off_allowlist_host() {
        assert!(!is_url_allowed("https://evil.example/x.gguf"));
        assert!(!is_url_allowed("https://huggingface.co.evil.example/x.gguf"));
    }

    #[test]
    fn rejects_non_url_schemes() {
        assert!(!is_url_allowed("file:///etc/passwd"));
        assert!(!is_url_allowed("javascript:alert(1)"));
        assert!(!is_url_allowed(""));
    }
}
