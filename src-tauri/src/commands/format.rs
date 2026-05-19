//! Format command — wraps external formatters via tokio::process::Command.
//!
//! ## Design
//!
//! Uses `tokio::process::Command` (NOT `tauri-plugin-shell`) for byte-level
//! stdin/stdout I/O. The shell plugin streams stdout line-by-line, which
//! would corrupt binary or multi-line output from formatters like prettier
//! that write JSON or multi-line output in one shot.
//!
//! ## Formatters
//!
//! | Language         | Binary    | Key flags                         |
//! |------------------|-----------|-----------------------------------|
//! | rust             | rustfmt   | --edition 2021                    |
//! | go               | gofmt     | (stdin mode by default)           |
//! | python           | black     | - --quiet --stdin-filename <file> |
//! | js/ts/jsx/tsx    | prettier  | --parser <parser> --stdin-filepath|
//! | json/css/html/…  | prettier  | --stdin-filepath <file>           |
//!
//! ## Workspace root
//!
//! Formatters are spawned with `current_dir(workspace_root)` so they
//! discover their config files (rustfmt.toml, .prettierrc, pyproject.toml…).
//!
//! ## Error handling
//!
//! Non-zero exit → return Err with the first 3 lines of stderr.
//! If no formatter is found (binary missing from PATH), return a specific
//! error so the frontend can populate its `noCliFormatter` cache.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use tauri::{command, AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

// ---------------------------------------------------------------------------
// Formatter resolution
// ---------------------------------------------------------------------------

/// Maps a language ID to `(binary, args_before_stdin)`.
/// Returns None if no CLI formatter is registered for this language.
fn formatter_for_lang(lang: &str, file_path: Option<&str>) -> Option<(String, Vec<String>)> {
    match lang {
        "rust" => Some((
            "rustfmt".into(),
            vec!["--edition".into(), "2021".into()],
        )),
        "go" => Some(("gofmt".into(), vec![])),
        "python" => {
            let fp = file_path.unwrap_or("file.py");
            Some((
                "black".into(),
                vec![
                    "-".into(),
                    "--quiet".into(),
                    "--stdin-filename".into(),
                    fp.into(),
                ],
            ))
        }
        "javascript" | "javascriptreact" => {
            let fp = file_path.unwrap_or("file.js");
            Some((
                "prettier".into(),
                vec!["--stdin-filepath".into(), fp.into()],
            ))
        }
        "typescript" | "typescriptreact" => {
            let fp = file_path.unwrap_or("file.ts");
            Some((
                "prettier".into(),
                vec!["--stdin-filepath".into(), fp.into()],
            ))
        }
        "json" => {
            let fp = file_path.unwrap_or("file.json");
            Some((
                "prettier".into(),
                vec!["--stdin-filepath".into(), fp.into()],
            ))
        }
        "css" => {
            let fp = file_path.unwrap_or("file.css");
            Some((
                "prettier".into(),
                vec!["--stdin-filepath".into(), fp.into()],
            ))
        }
        "html" => {
            let fp = file_path.unwrap_or("file.html");
            Some((
                "prettier".into(),
                vec!["--stdin-filepath".into(), fp.into()],
            ))
        }
        "markdown" => {
            let fp = file_path.unwrap_or("file.md");
            Some((
                "prettier".into(),
                vec!["--stdin-filepath".into(), fp.into()],
            ))
        }
        "yaml" => {
            let fp = file_path.unwrap_or("file.yaml");
            Some((
                "prettier".into(),
                vec!["--stdin-filepath".into(), fp.into()],
            ))
        }
        "vue" => {
            let fp = file_path.unwrap_or("file.vue");
            Some((
                "prettier".into(),
                vec!["--stdin-filepath".into(), fp.into()],
            ))
        }
        "svelte" => {
            let fp = file_path.unwrap_or("file.svelte");
            Some((
                "prettier".into(),
                vec!["--stdin-filepath".into(), fp.into()],
            ))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Format `code` using the appropriate CLI formatter for `lang`.
///
/// Arguments:
/// - `lang`: language ID (e.g. "rust", "typescript", "python")
/// - `code`: source code to format (UTF-8)
/// - `file_path`: optional absolute path of the file — used as stdin-filepath
///   for prettier (config discovery) and as a hint for synthetic filenames
///
/// Returns the formatted code string, or an error message.
///
/// Errors:
/// - `"no formatter for lang: <lang>"` — frontend should add to noCliFormatter
/// - `"formatter not found: <binary>"` — binary not in PATH
/// - `"format error: <first 3 stderr lines>"` — formatter returned non-zero
#[command]
pub async fn format_code(
    app: AppHandle,
    lang: String,
    code: String,
    file_path: Option<String>,
) -> Result<String, String> {
    // Resolve workspace root (clone before .await to release the lock)
    let workspace_root: PathBuf = {
        let ws_state = app.state::<Mutex<Option<PathBuf>>>();
        let guard = ws_state
            .lock()
            .map_err(|e| format!("workspace lock: {e}"))?;
        // Fall back to temp dir if no workspace is open (e.g. scratch file)
        guard.clone().unwrap_or_else(|| std::env::temp_dir())
    };

    // Find formatter for this language
    let (binary, args) =
        formatter_for_lang(&lang, file_path.as_deref()).ok_or_else(|| {
            format!("no formatter for lang: {lang}")
        })?;

    // Check that the binary is in PATH
    if which::which(&binary).is_err() {
        return Err(format!("formatter not found: {binary}"));
    }

    // Spawn the formatter child process
    let mut child = Command::new(&binary)
        .args(&args)
        .current_dir(&workspace_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {binary}: {e}"))?;

    // Write source to stdin, then close it (EOF signals end of input)
    {
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let mut stdin = tokio::io::BufWriter::new(stdin);
        stdin
            .write_all(code.as_bytes())
            .await
            .map_err(|e| format!("stdin write: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("stdin flush: {e}"))?;
        // stdin drops here, sending EOF to the child
    }

    // Wait for the process and collect stdout + stderr concurrently
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("wait {binary}: {e}"))?;

    if !output.status.success() {
        // Extract first 3 non-empty stderr lines for the error message
        let stderr = String::from_utf8_lossy(&output.stderr);
        let first_lines: String = stderr
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(3)
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("format error: {first_lines}"));
    }

    let formatted =
        String::from_utf8(output.stdout).map_err(|e| format!("output utf8: {e}"))?;

    Ok(formatted)
}
