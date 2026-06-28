// Shugu Forge — media.rs : helpers partagés pour les médias génératifs
// (vidéo, musique). Sauvegarde d'assets locaux, normalisation de base URL
// MiniMax et lecture du `base_resp` commun.
//
// Volontairement séparé d'`image.rs` (dont les helpers privés restent internes) :
// `image.rs` est déjà éprouvé en live, on ne le refactore pas pour mutualiser —
// le léger recouvrement avec ses helpers internes est un compromis assumé pour
// garder un blast radius minimal sur du code qui fonctionne.

use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

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
    let stem = safe_asset_id(id);
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    let path = dir.join(format!("{stem}.{ext}"));
    fs::write(&path, bytes).map_err(|e| format!("write asset {sub}: {e}"))?;
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
        assert_eq!(normalize_minimax_base("https://api.minimax.io"), "https://api.minimax.io");
        assert_eq!(normalize_minimax_base("https://api.minimax.io/"), "https://api.minimax.io");
        assert_eq!(normalize_minimax_base("https://api.minimax.io/v1"), "https://api.minimax.io");
        assert_eq!(normalize_minimax_base("https://api.minimax.io/v1/"), "https://api.minimax.io");
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
        let v = json!({ "base_resp": { "status_code": 1008, "status_msg": "insufficient balance" } });
        let err = check_base_resp(&v, "soumission").unwrap_err();
        assert!(err.contains("1008"));
        assert!(err.contains("insufficient balance"));
    }
}
