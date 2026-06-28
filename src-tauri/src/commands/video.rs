// Shugu Forge — video.rs : génération vidéo (text-to-video / image-to-video)
// via l'API MiniMax (Hailuo). Service ASYNCHRONE en 3 temps :
//   1. POST {base}/v1/video_generation         → task_id
//   2. GET  {base}/v1/query/video_generation   → polling jusqu'à status=="Success" → file_id
//   3. GET  {base}/v1/files/retrieve           → download_url → on télécharge le .mp4 en asset local
//
// Pattern clé API identique à image.rs / voice.rs : le FRONT résout la clé via
// le keychain (loadProviderConfig("minimax")) et la passe en argument — jamais
// de clé en clair côté Rust. MiniMax signale les erreurs logiques en HTTP 200 +
// base_resp.status_code != 0. Réf : platform.minimax.io/docs/guides/video-generation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

use crate::commands::media;

/// Nombre de cycles de polling × intervalle = budget total d'attente.
/// 60 × 10 s = 10 minutes (la génération Hailuo prend typiquement 1–5 min).
const POLL_ATTEMPTS: usize = 60;
const POLL_INTERVAL_SECS: u64 = 10;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoGenerateArgs {
    pub prompt: String,
    /// ex. "MiniMax-Hailuo-02", "MiniMax-Hailuo-2.3", "T2V-01-Director"…
    pub model: String,
    /// Image de première frame (URL http(s) ou data:image/…;base64,…) → image-to-video.
    #[serde(default)]
    pub first_frame_image: Option<String>,
    /// Durée en secondes (6 ou 10 selon le modèle).
    #[serde(default)]
    pub duration: Option<u32>,
    /// "768P" | "1080P" | "720P" selon le modèle.
    #[serde(default)]
    pub resolution: Option<String>,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoJob {
    pub id: String,
    pub status: String,
    pub result_url: Option<String>,
}

/// Génération vidéo MiniMax → chemin d'un .mp4 local prêt pour `<video src=…>`.
#[tauri::command]
pub async fn video_generate(app: AppHandle, args: VideoGenerateArgs) -> Result<VideoJob, String> {
    let prompt = args.prompt.trim();
    let has_first_frame = args
        .first_frame_image
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if prompt.is_empty() && !has_first_frame {
        return Err("video: prompt vide (ou fournis une image de première frame)".to_string());
    }
    if args.api_key.trim().is_empty() {
        return Err(
            "video: clé API MiniMax absente — configure-la dans Réglages → Connexions".to_string(),
        );
    }

    let base = media::normalize_minimax_base(&args.base_url);
    // Une seule requête HTTP peut être lente (soumission + download) mais le
    // polling fait des requêtes courtes — 120 s par requête suffit largement.
    let client = crate::commands::chat::request_client(120)?;

    // 1. Soumission de la tâche.
    let model = if args.model.trim().is_empty() {
        "MiniMax-Hailuo-02"
    } else {
        args.model.trim()
    };
    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
    });
    if let Some(img) = args.first_frame_image.as_deref().filter(|s| !s.trim().is_empty()) {
        body["first_frame_image"] = Value::String(img.trim().to_string());
    }
    if let Some(d) = args.duration {
        body["duration"] = Value::from(d);
    }
    if let Some(r) = args.resolution.as_deref().filter(|s| !s.trim().is_empty()) {
        body["resolution"] = Value::String(r.trim().to_string());
    }

    let submit_url = format!("{base}/v1/video_generation");
    let resp = client
        .post(&submit_url)
        .header("Authorization", format!("Bearer {}", args.api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("minimax video: requête {submit_url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(media::http_error("video soumission", resp).await);
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("minimax video: JSON de soumission invalide: {e}"))?;
    media::check_base_resp(&v, "video soumission")?;
    let task_id = v
        .get("task_id")
        .and_then(|t| t.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "minimax video: réponse de soumission sans task_id".to_string())?
        .to_string();

    // 2. Polling du statut jusqu'à Success/Fail.
    let query_url = format!("{base}/v1/query/video_generation?task_id={task_id}");
    let mut file_id = String::new();
    for _ in 0..POLL_ATTEMPTS {
        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        let resp = match client
            .get(&query_url)
            .header("Authorization", format!("Bearer {}", args.api_key))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => continue, // erreur réseau transitoire → on retente
        };
        let v: Value = match resp.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v.get("status").and_then(|s| s.as_str()).unwrap_or("") {
            "Success" => {
                file_id = v
                    .get("file_id")
                    .and_then(|f| f.as_str())
                    .unwrap_or("")
                    .to_string();
                break;
            }
            "Fail" => {
                let msg = v
                    .pointer("/base_resp/status_msg")
                    .and_then(|m| m.as_str())
                    .unwrap_or("échec de génération");
                return Err(format!("minimax video: tâche {task_id} échouée: {msg}"));
            }
            // Preparing / Queueing / Processing / "" → on continue d'attendre.
            _ => {}
        }
    }
    if file_id.trim().is_empty() {
        return Err(format!(
            "minimax video: tâche {task_id} non terminée dans le délai imparti (~10 min)"
        ));
    }

    // 3. Récupération du lien de téléchargement (valable ~9 h) puis download local.
    let retrieve_url = format!("{base}/v1/files/retrieve?file_id={file_id}");
    let resp = client
        .get(&retrieve_url)
        .header("Authorization", format!("Bearer {}", args.api_key))
        .send()
        .await
        .map_err(|e| format!("minimax video: requête retrieve: {e}"))?;
    if !resp.status().is_success() {
        return Err(media::http_error("video retrieve", resp).await);
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("minimax video: JSON retrieve invalide: {e}"))?;
    media::check_base_resp(&v, "video retrieve")?;
    let download_url = v
        .pointer("/file/download_url")
        .and_then(|u| u.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "minimax video: réponse retrieve sans download_url".to_string())?
        .to_string();

    let result_url =
        media::download_to_asset(&client, &app, "video-assets", &task_id, "mp4", &download_url)
            .await?;

    Ok(VideoJob {
        id: task_id,
        status: "done".into(),
        result_url: Some(result_url),
    })
}
