use serde::Serialize;

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Stub: returns an empty listing. Phase-4 will use `std::fs::read_dir` + Tauri allowlist.
#[tauri::command]
pub fn fs_read_dir(path: String) -> Result<Vec<Entry>, String> {
    let _ = path;
    Ok(vec![])
}

/// Stub: returns "(stub)".
#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    Ok(format!("(stub) would read {}", path))
}

/// Stub: succeeds silently.
#[tauri::command]
pub fn fs_write_file(path: String, content: String) -> Result<(), String> {
    let _ = (path, content);
    Ok(())
}
