// Shugu Forge — music.rs : génération musicale via l'API MiniMax (music-2.6).
//
// Appel SYNCHRONE (stream:false) : la réponse contient directement l'audio
// encodé en HEX dans data.audio — exactement le même encodage que le TTS
// `t2a_v2` (voir voice.rs). On RÉUTILISE donc `voice::decode_hex_or_b64` plutôt
// que de redupliquer le décodeur, puis on sauve un .mp3 en asset local.
//
// Paroles requises pour une chanson chantée ; `instrumental:true` produit un
// morceau sans paroles. Réf : platform.minimax.io/docs/api-reference/music-generation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::media;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicGenerateArgs {
    #[serde(default)]
    pub request_id: Option<String>,
    /// Description du style / de l'ambiance (requis, ≤ 2000 caractères).
    pub prompt: String,
    /// Paroles (≤ 3500 caractères). Requis pour une chanson chantée
    /// non-instrumentale ; ignoré si `instrumental` est vrai.
    #[serde(default)]
    pub lyrics: Option<String>,
    /// ex. "music-2.6" (défaut) ou "music-2.6-free".
    #[serde(default)]
    pub model: Option<String>,
    /// true → morceau instrumental, sans paroles.
    #[serde(default)]
    pub instrumental: Option<bool>,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicJob {
    pub id: String,
    pub status: String,
    pub result_url: Option<String>,
}

/// Génération musicale MiniMax → chemin d'un .mp3 local prêt pour `<audio src=…>`.
async fn music_generate_inner(
    app: AppHandle,
    args: MusicGenerateArgs,
    job_id: &str,
) -> Result<MusicJob, String> {
    let prompt = args.prompt.trim();
    if prompt.is_empty() {
        return Err("music: prompt (style/ambiance) vide".to_string());
    }
    if args.api_key.trim().is_empty() {
        return Err(
            "music: clé API MiniMax absente — configure-la dans Réglages → Connexions".to_string(),
        );
    }

    let instrumental = args.instrumental.unwrap_or(false);
    let lyrics = args.lyrics.as_deref().map(str::trim).unwrap_or("");
    if !instrumental && lyrics.is_empty() {
        return Err(
            "music: paroles requises pour une chanson chantée — fournis des paroles ou active le mode instrumental"
                .to_string(),
        );
    }

    let base = media::normalize_minimax_base(&args.base_url);
    let model = args
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or("music-2.6");

    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "output_format": "hex",
        "audio_setting": { "sample_rate": 44100, "bitrate": 256000, "format": "mp3" },
    });
    if instrumental {
        body["is_instrumental"] = Value::Bool(true);
    } else {
        body["lyrics"] = Value::String(lyrics.to_string());
    }

    let url = format!("{base}/v1/music_generation");
    // La génération d'une chanson complète peut prendre ~30–60 s en synchrone.
    let client = crate::commands::chat::request_client(180)?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", args.api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("minimax music: requête {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(media::http_error("music", resp).await);
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("minimax music: réponse JSON invalide: {e}"))?;
    media::check_base_resp(&v, "music")?;
    media::progress(
        &app,
        job_id,
        "media:music",
        "saving",
        85,
        "Sauvegarde locale du morceau",
    );

    // Robuste aux deux schémas de réponse : output_format "hex" → data.audio
    // (encodé HEX, comme le TTS), "url" (ou repli serveur) → data.audio_url (24 h).
    let id = media::fallback_id("music");
    let result_url = if let Some(audio) = v
        .pointer("/data/audio")
        .and_then(|a| a.as_str())
        .filter(|a| !a.trim().is_empty())
    {
        let bytes = crate::commands::voice::decode_hex_or_b64(audio)?;
        media::save_bytes(&app, "music-assets", &id, "mp3", &bytes)?
    } else if let Some(url) = v
        .pointer("/data/audio_url")
        .and_then(|a| a.as_str())
        .filter(|a| !a.trim().is_empty())
    {
        media::download_to_asset(&client, &app, "music-assets", &id, "mp3", url).await?
    } else {
        return Err(
            "minimax music: la réponse ne contient ni data.audio ni data.audio_url".to_string(),
        );
    };

    Ok(MusicJob {
        id,
        status: "done".into(),
        result_url: Some(result_url),
    })
}

#[tauri::command]
pub async fn music_generate(app: AppHandle, args: MusicGenerateArgs) -> Result<MusicJob, String> {
    let job_id = args
        .request_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| media::fallback_id("media-music"));
    let payload = serde_json::json!({
        "prompt": args.prompt,
        "model": args.model,
        "instrumental": args.instrumental,
        "hasLyrics": args.lyrics.as_deref().is_some_and(|value| !value.trim().is_empty()),
    });
    let control = media::begin_job(&app, &job_id, "media:music", payload)?;
    media::progress(
        &app,
        &job_id,
        "media:music",
        "generating",
        10,
        "Composition MiniMax",
    );

    let app_for_inner = app.clone();
    let outcome = tokio::select! {
        biased;
        _ = control.cancelled() => Err(media::MEDIA_CANCELLED.to_string()),
        result = music_generate_inner(app_for_inner, args, &job_id) => result,
    };
    match &outcome {
        Ok(job) => media::finish_job(&app, &job_id, "media:music", Ok(job.result_url.clone())),
        Err(error) => media::finish_job(&app, &job_id, "media:music", Err(error.clone())),
    }
    outcome
}
