//! Application-window lifecycle commands.
//!
//! The custom titlebar hides the main window, but Windows can still destroy it
//! through Alt+F4, automation, or a WebView2 failure. The tray must therefore
//! be able to recreate `main`, not merely call `show()` on an existing handle.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window("main") {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("Shugu Forge")
            .inner_size(1280.0, 800.0)
            .min_inner_size(720.0, 480.0)
            .decorations(false)
            .resizable(true)
            // Recreating a destroyed WebView must not rip focus away from a
            // fullscreen game/video while WebView2 boots. The explicit tray
            // action below focuses only after the window is fully available.
            .focused(false)
            .build()
            .map_err(|error| format!("recreate main window: {error}"))?,
    };

    window
        .show()
        .map_err(|error| format!("show main window: {error}"))?;
    let _ = window.unminimize();
    window
        .set_focus()
        .map_err(|error| format!("focus main window: {error}"))
}

#[tauri::command]
pub fn app_show_main(app: AppHandle) -> Result<(), String> {
    show_main_window(&app)
}
