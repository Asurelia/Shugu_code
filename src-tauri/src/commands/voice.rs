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

/// Émotions acceptées par `voice_setting.emotion` (API T2A v2). Une valeur
/// hors de cet ensemble (ou « auto », ou vide) est IGNORÉE : le champ est alors
/// omis et MiniMax auto-sélectionne d'après le texte. Réf : platform.minimax.io
/// /docs/api-reference/speech-t2a-http.
///
/// ⚠ SYNCHRO : doit rester identique à `MINIMAX_EMOTIONS` dans
/// src/features/mascot/affect.ts (côté TS). Toute divergence = une émotion
/// choisie côté TS mais droppée ici en silence.
const VALID_EMOTIONS: [&str; 9] = [
    "happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent", "whisper",
];

fn is_valid_emotion(e: &str) -> bool {
    VALID_EMOTIONS.contains(&e)
}

/// speed ∈ [0.5, 2.0], défaut 1.0.
fn clamp_speed(s: Option<f64>) -> f64 {
    s.unwrap_or(1.0).clamp(0.5, 2.0)
}

/// vol ∈ (0, 10], défaut 1.0 (0 exclu par l'API → on ramène à 1.0).
fn clamp_vol(v: Option<f64>) -> f64 {
    let v = v.unwrap_or(1.0);
    if v <= 0.0 {
        1.0
    } else {
        v.min(10.0)
    }
}

/// pitch ∈ [-12, 12], ENTIER (piège de sérialisation : jamais f32/f64), défaut 0.
fn clamp_pitch(p: Option<i64>) -> i64 {
    p.unwrap_or(0).clamp(-12, 12)
}

pub(crate) fn decode_hex_or_b64(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    // Hex (défaut t2a_v2). Décodage manuel — pas la peine d'une crate `hex`
    // pour 16 symboles. AMBIGUÏTÉ assumée : une chaîne base64 composée
    // UNIQUEMENT de [0-9a-fA-F] passerait par la branche hex — probabilité
    // nulle en pratique pour un MP3 base64 de plusieurs Ko, et on demande
    // explicitement `output_format: "hex"` dans le body.
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
#[allow(clippy::too_many_arguments)]
pub async fn voice_tts(
    text: String,
    voice_id: Option<String>,
    model: Option<String>,
    // Couche affective (Palier 1) : émotion + prosodie. Tous optionnels et
    // rétro-compatibles — un appelant qui n'en passe aucun retombe sur le
    // comportement historique (voix plate, émotion auto-sélectionnée).
    emotion: Option<String>,
    speed: Option<f64>,
    pitch: Option<i64>,
    vol: Option<f64>,
    language_boost: Option<String>,
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

    // voice_setting construit dynamiquement : l'émotion n'est ajoutée QUE si
    // elle est valide (jamais « auto » ni une valeur inventée par le LLM) — sinon
    // le champ reste absent et MiniMax auto-sélectionne d'après le texte.
    let mut voice_setting = serde_json::json!({
        "voice_id": voice_id.as_deref().filter(|v| !v.trim().is_empty()).unwrap_or("female-shaonv"),
        "speed": clamp_speed(speed),
        "vol": clamp_vol(vol),
        "pitch": clamp_pitch(pitch),
    });
    if let Some(e) = emotion.as_deref().map(str::trim).filter(|e| is_valid_emotion(e)) {
        voice_setting["emotion"] = serde_json::Value::String(e.to_string());
    }

    let mut body = serde_json::json!({
        // Défaut bumpé speech-02-turbo → speech-2.6-turbo (génération récente,
        // bon compromis latence/qualité pour la voix interactive de la mascotte ;
        // dispo dès le tier Plus). Surchargeable via l'argument `model`.
        "model": model.as_deref().filter(|m| !m.trim().is_empty()).unwrap_or("speech-2.6-turbo"),
        "text": text,
        "stream": false,
        "output_format": "hex",
        "voice_setting": voice_setting,
        "audio_setting": { "format": "mp3", "sample_rate": 32000, "bitrate": 128000 }
    });
    // language_boost optionnel (ex. "French") : améliore la prononciation d'une
    // langue cible. Absent → l'API reste en détection automatique.
    if let Some(lb) = language_boost.as_deref().map(str::trim).filter(|lb| !lb.is_empty()) {
        body["language_boost"] = serde_json::Value::String(lb.to_string());
    }

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
    use super::{clamp_pitch, clamp_speed, clamp_vol, decode_hex_or_b64, is_valid_emotion};

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

    #[test]
    fn emotion_enum_gate() {
        // Les 9 valeurs MiniMax passent ; « auto », vide et inventé sont rejetés.
        assert!(is_valid_emotion("happy"));
        assert!(is_valid_emotion("whisper"));
        assert!(!is_valid_emotion("auto"));
        assert!(!is_valid_emotion(""));
        assert!(!is_valid_emotion("excited"));
    }

    #[test]
    fn prosody_clamps() {
        assert_eq!(clamp_speed(None), 1.0);
        assert_eq!(clamp_speed(Some(5.0)), 2.0); // borne haute
        assert_eq!(clamp_speed(Some(0.1)), 0.5); // borne basse
        assert_eq!(clamp_pitch(None), 0);
        assert_eq!(clamp_pitch(Some(99)), 12);
        assert_eq!(clamp_pitch(Some(-99)), -12);
        assert_eq!(clamp_vol(None), 1.0);
        assert_eq!(clamp_vol(Some(0.0)), 1.0); // 0 exclu → défaut
        assert_eq!(clamp_vol(Some(50.0)), 10.0);
    }
}
