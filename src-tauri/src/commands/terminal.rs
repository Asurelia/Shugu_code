/// Stub: echoes the command. Phase-4 will spawn a real PTY via `tauri-plugin-shell`.
#[tauri::command]
pub fn term_run(command: String) -> Result<String, String> {
    Ok(format!("(stub) would run: {}", command))
}
