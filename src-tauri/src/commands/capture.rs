// Shugu Forge — capture.rs : capture d'écran (socle des lots « vision »).
//
// Cœur partagé entre :
//   • `capture_screen` (command) — bouton 📷 du composer (chat principal +
//     mascotte) : l'image part au modèle vision via le flux `attachedImage`
//     existant de chat_send → lecture d'écran / OCR instantanés (MiniMax M3,
//     Claude, tout modèle vision).
//   • `capture_for_agent` (lot suivant) — outil agent de vérification
//     visuelle (« tests réels »).
//
// Choix de crate : `xcap` (successeur maintenu de `screenshots`, même auteur ;
// multi-moniteurs, DPI géré). La capture est synchrone → spawn_blocking.
//
// Fenêtre mascotte : always-on-top + transparente, elle apparaîtrait dans
// toute capture. On la MASQUE pendant la prise (hide → ~80 ms pour laisser le
// compositeur rafraîchir → capture → show). Flicker bref accepté.
// TODO raffinement : SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) sur le
// HWND mascotte (zéro flicker, Win10 2004+) via la crate `windows`.

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::io::Cursor;
use tauri::{AppHandle, Manager};

/// Grand côté max de l'image envoyée au modèle vision — 1568 px est le point
/// d'équilibre documenté pour la vision (détail suffisant pour lire du texte
/// d'écran, payload base64 raisonnable : ~200-600 Ko en JPEG q80).
const MAX_EDGE: u32 = 1568;
const JPEG_QUALITY: u8 = 80;

/// Délai après le hide de la mascotte pour que le compositeur Windows ait
/// réellement retiré la fenêtre de l'écran avant la capture.
const MASCOT_HIDE_SETTLE_MS: u64 = 80;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    /// `data:image/jpeg;base64,...` — prêt pour le flux attachedImage du chat.
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
}

fn pick_monitor(idx: Option<usize>) -> Result<xcap::Monitor, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("list monitors: {e}"))?;
    if monitors.is_empty() {
        return Err("no monitor detected".to_string());
    }
    let pos = match idx {
        Some(i) => {
            if i >= monitors.len() {
                return Err(format!(
                    "monitor index {i} out of range (0..{})",
                    monitors.len() - 1
                ));
            }
            i
        }
        // Défaut : le moniteur principal (repli : le premier).
        None => monitors
            .iter()
            .position(|m| m.is_primary().unwrap_or(false))
            .unwrap_or(0),
    };
    monitors
        .into_iter()
        .nth(pos)
        .ok_or_else(|| "monitor disappeared during enumeration".to_string())
}

/// Capture le moniteur choisi, redimensionne (grand côté ≤ max_edge),
/// encode en JPEG. Synchrone — à appeler dans spawn_blocking.
fn capture_and_encode(monitor: Option<usize>, max_edge: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let mon = pick_monitor(monitor)?;
    let rgba = mon
        .capture_image()
        .map_err(|e| format!("capture monitor: {e}"))?;
    let mut img = image::DynamicImage::ImageRgba8(rgba);
    if img.width().max(img.height()) > max_edge {
        img = img.resize(max_edge, max_edge, image::imageops::FilterType::Triangle);
    }
    // JPEG ne supporte pas l'alpha → RGB8 obligatoire avant encodage.
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let (w, h) = (rgb.width(), rgb.height());
    let mut buf = Vec::new();
    rgb.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
        Cursor::new(&mut buf),
        JPEG_QUALITY,
    ))
    .map_err(|e| format!("encode jpeg: {e}"))?;
    Ok((buf, w, h))
}

/// Cœur partagé (bouton composer + futur outil agent). `hide_mascot` masque
/// la fenêtre mascotte le temps de la prise pour qu'elle n'apparaisse pas
/// dans l'image — toujours ré-affichée même si la capture échoue.
pub(crate) async fn capture_inner(
    app: &AppHandle,
    monitor: Option<usize>,
    max_edge: u32,
    hide_mascot: bool,
) -> Result<(Vec<u8>, u32, u32), String> {
    let mascot = if hide_mascot {
        app.get_webview_window("mascot")
            .filter(|w| w.is_visible().unwrap_or(false))
    } else {
        None
    };
    if let Some(w) = &mascot {
        let _ = w.hide();
        tokio::time::sleep(std::time::Duration::from_millis(MASCOT_HIDE_SETTLE_MS)).await;
    }
    // Le show() s'exécute AVANT la propagation d'erreur (`result?` en bas) :
    // la mascotte réapparaît même si la capture échoue ou si le thread
    // bloquant panique (JoinError → Err). Seule une annulation de la future
    // elle-même sauterait le show — impossible avec les commands Tauri 2
    // (non annulables depuis le frontend).
    let result = tokio::task::spawn_blocking(move || capture_and_encode(monitor, max_edge))
        .await
        .map_err(|e| format!("capture task join: {e}"));
    if let Some(w) = &mascot {
        let _ = w.show();
    }
    result?
}

/// Capture l'écran et retourne une data URL JPEG prête pour le chat vision.
/// `monitor` : index dans capture_list_monitors ; omis = moniteur principal.
#[tauri::command]
pub async fn capture_screen(
    app: AppHandle,
    monitor: Option<usize>,
) -> Result<CaptureResult, String> {
    let (jpeg, width, height) = capture_inner(&app, monitor, MAX_EDGE, true).await?;
    Ok(CaptureResult {
        data_url: format!(
            "data:image/jpeg;base64,{}",
            general_purpose::STANDARD.encode(&jpeg)
        ),
        width,
        height,
    })
}

// ────────────────────────────────────────────────────────────────────
// Capture pour l'outil agent (vérification visuelle — « tests réels »)
// ────────────────────────────────────────────────────────────────────

/// Miniature pour la timeline du fil — 512 px de grand côté, q70 (~50-120 Ko,
/// persistée dans agent_events → survit au reload sans protocole asset).
const THUMB_EDGE: u32 = 512;
const THUMB_QUALITY: u8 = 70;

// Windows : `canonicalize()` préfixe `\\?\` — retiré systématiquement avant
// stockage/affichage (helper CENTRAL pathutil, variante &str).
use super::pathutil::strip_extended_prefix_str as strip_extended_prefix;

fn captures_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("captures");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create captures dir: {e}"))?;
    Ok(dir)
}

/// Capture SYNCHRONE pour l'outil agent `capture_screen` — le dispatcher
/// d'outils tourne déjà dans un `spawn_blocking`, donc pas d'async ici (les
/// hide/show de fenêtre Tauri sont thread-safe, dispatchés vers le thread
/// principal en interne). Sauve le JPEG plein format (grand côté ≤ 1568 px)
/// dans `app_data_dir/captures/` et retourne :
///   (chemin absolu SANS préfixe \\?\, miniature 512 px en data URL).
/// Le chemin part dans le tool result (marqueur `SCREENSHOT_SAVED:`) ; la
/// miniature part dans l'event `Screenshot` affiché par la timeline du fil.
pub(crate) fn capture_for_agent_blocking(
    app: &AppHandle,
    agent_id: &str,
    monitor: Option<usize>,
    delay_ms: u64,
) -> Result<(String, String), String> {
    // Laisser à l'UI fraîchement lancée/rafraîchie le temps de peindre.
    if delay_ms > 0 {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms.min(5_000)));
    }
    let mascot = app
        .get_webview_window("mascot")
        .filter(|w| w.is_visible().unwrap_or(false));
    if let Some(w) = &mascot {
        let _ = w.hide();
        std::thread::sleep(std::time::Duration::from_millis(MASCOT_HIDE_SETTLE_MS));
    }
    let result = capture_and_encode(monitor, MAX_EDGE);
    // Ré-affichage AVANT la propagation d'erreur — la mascotte revient
    // toujours, même si la capture a échoué.
    if let Some(w) = &mascot {
        let _ = w.show();
    }
    let (jpeg, _, _) = result?;

    let dir = captures_dir(app)?;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let safe_agent: String = agent_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let path = dir.join(format!("{safe_agent}-{ms}.jpg"));
    std::fs::write(&path, &jpeg).map_err(|e| format!("write screenshot: {e}"))?;

    let img = image::load_from_memory(&jpeg).map_err(|e| format!("decode for thumb: {e}"))?;
    let thumb = img.resize(THUMB_EDGE, THUMB_EDGE, image::imageops::FilterType::Triangle);
    let thumb_rgb = image::DynamicImage::ImageRgb8(thumb.to_rgb8());
    let mut buf = Vec::new();
    thumb_rgb
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            Cursor::new(&mut buf),
            THUMB_QUALITY,
        ))
        .map_err(|e| format!("encode thumb: {e}"))?;
    let thumb_url = format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(&buf)
    );

    Ok((strip_extended_prefix(&path.to_string_lossy()), thumb_url))
}

/// Liste les moniteurs (pour le choix dans le composer quand il y en a > 1).
#[tauri::command]
pub fn capture_list_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("list monitors: {e}"))?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(i, m)| MonitorInfo {
            index: i,
            name: m.name().unwrap_or_else(|_| format!("Moniteur {}", i + 1)),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
            is_primary: m.is_primary().unwrap_or(false),
        })
        .collect())
}
