// Shugu Forge — voice.rs : synthèse vocale (TTS) via l'API MiniMax T2A v2.
//
// Lot voix, bloc A. Pattern clé API identique à image.rs : le FRONT résout la
// clé via le keychain (`loadProviderConfig("minimax")`) et la passe en
// argument — jamais de clé en clair côté Rust, et pas de CORS côté webview.
//
// Endpoint : POST {base}/v1/t2a_v2 (Bearer). Réponse non-stream : le MP3
// arrive dans `data.audio` encodé en HEX (défaut `output_format: "hex"`) ;
// les erreurs logiques arrivent en HTTP 200 avec `base_resp.status_code ≠ 0`.
// Réf : platform.minimax.io/docs/api-reference/speech-t2a-http.
//
// Le STT (bloc B) viendra à part : l'ASR MiniMax est un job asynchrone
// (`/v1/stt/create` + polling) — différé tant que le besoin n'est pas mûr.

use base64::{engine::general_purpose, Engine as _};

/// Borne dure côté Rust (défense en profondeur — l'appelant tronque déjà à
/// ~400 caractères) : la bulle de la mascotte parle court, pas un audiobook.
const MAX_TTS_CHARS: usize = 600;

fn decode_hex_or_b64(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    // Hex (défaut t2a_v2). Décodage manuel — pas la peine d'une crate `hex`
    // pour 16 symboles.
    if !s.is_empty() && s.len() % 2 == 0 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        let bytes = s.as_bytes();
        let mut out = Vec::with_capacity(s.len() / 2);
        for i in (0..bytes.len()).step_by(2) {
            let hi = (bytes[i] as char).to_digit(16).unwrap_or(0) as u8;
            let lo = (bytes[i + 1] as char).to_digit(16).unwrap_or(0) as u8;
            out.push((hi << 4) | lo);
        }
        return Ok(out);
    }
    // Repli : certains modes/versions renvoient du base64.
    general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("minimax tts: audio ni hex ni base64: {e}"))
}

/// Synthèse vocale MiniMax → data URL `data:audio/mp3;base64,…` prête pour
/// `new Audio(url).play()` côté webview (zéro crate audio Rust).
#[tauri::command]
pub async fn voice_tts(
    text: String,
    voice_id: Option<String>,
    model: Option<String>,
    base_url: String,
    api_key: String,
) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("voice_tts: texte vide".to_string());
    }
    if api_key.trim().is_empty() {
        return Err(
            "voice_tts: clé API MiniMax absente — configure-la dans Settings → Connections"
                .to_string(),
        );
    }
    let text: String = text.chars().take(MAX_TTS_CHARS).collect();

    let base = base_url.trim().trim_end_matches('/');
    let base = if base.is_empty() { "https://api.minimax.io" } else { base };
    let url = if base.ends_with("/v1") {
        format!("{base}/t2a_v2")
    } else {
        format!("{base}/v1/t2a_v2")
    };

    let body = serde_json::json!({
        "model": model.as_deref().filter(|m| !m.trim().is_empty()).unwrap_or("speech-02-turbo"),
        "text": text,
        "stream": false,
        "output_format": "hex",
        "voice_setting": {
            "voice_id": voice_id.as_deref().filter(|v| !v.trim().is_empty()).unwrap_or("female-shaonv"),
            "speed": 1.0,
            "vol": 1.0,
            "pitch": 0
        },
        "audio_setting": { "format": "mp3", "sample_rate": 32000, "bitrate": 128000 }
    });

    let client = crate::commands::chat::request_client(60)?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("minimax tts: requête {url}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let t = resp.text().await.unwrap_or_default();
        let t: String = t.trim().chars().take(400).collect();
        return Err(format!("minimax tts: HTTP {status}: {t}"));
    }

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("minimax tts: réponse JSON invalide: {e}"))?;

    // MiniMax signale les erreurs logiques en 200 + base_resp.status_code ≠ 0.
    if let Some(code) = v.pointer("/base_resp/status_code").and_then(|c| c.as_i64()) {
        if code != 0 {
            let msg = v
                .pointer("/base_resp/status_msg")
                .and_then(|m| m.as_str())
                .unwrap_or("erreur inconnue");
            return Err(format!("minimax tts: status {code}: {msg}"));
        }
    }

    let audio = v
        .pointer("/data/audio")
        .and_then(|a| a.as_str())
        .filter(|a| !a.trim().is_empty())
        .ok_or_else(|| "minimax tts: la réponse ne contient pas data.audio".to_string())?;

    let bytes = decode_hex_or_b64(audio)?;
    Ok(format!(
        "data:audio/mp3;base64,{}",
        general_purpose::STANDARD.encode(&bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::decode_hex_or_b64;

    #[test]
    fn decodes_hex() {
        assert_eq!(decode_hex_or_b64("48656c6c6f").unwrap(), b"Hello");
    }

    #[test]
    fn falls_back_to_base64() {
        // "SGVsbG8h" = "Hello!" — contient 'S'/'G' etc., non-hex → branche base64.
        assert_eq!(decode_hex_or_b64("SGVsbG8h").unwrap(), b"Hello!");
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_hex_or_b64("not valid !!!").is_err());
    }
}
