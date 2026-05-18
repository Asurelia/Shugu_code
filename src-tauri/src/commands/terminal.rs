use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};
use serde::Serialize;

// Ring-buffer size per PTY for the snapshot/replay system. xterm.js + ANSI
// escape sequences reconstruct full visual state from a stream of bytes,
// so when a frontend DockTerminal mounts against an existing PTY it can
// replay the last N KB of output and recover the cursor / colors /
// scrollback the user expects. 256 KB is the same default vscode's
// integrated terminal uses for backscroll persistence and is enough for
// ~5000 lines of typical shell output.
const SNAPSHOT_MAX_BYTES: usize = 256 * 1024;

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    shutdown: Arc<AtomicBool>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    // Ring buffer of recent output bytes. The read thread pushes every
    // chunk here before emitting the event; term_snapshot reads it. We
    // store as raw bytes (not String) so partial multi-byte UTF-8
    // sequences at the trim boundary stay byte-exact — they get
    // lossily decoded only at snapshot-read time, where xterm.js can
    // safely render the � replacement char.
    buffer: Arc<Mutex<VecDeque<u8>>>,
}

#[derive(Default)]
pub struct PtyRegistry(pub Mutex<HashMap<String, PtyHandle>>);

#[derive(Clone, Serialize)]
struct TermOutput { data: String }

fn resolve_shell(explicit: Option<String>) -> String {
    if let Some(s) = explicit { return s; }
    #[cfg(target_os = "windows")] {
        for c in ["pwsh.exe", "powershell.exe"] {
            if which::which(c).is_ok() { return c.to_string(); }
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(target_os = "windows"))] {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

fn resolve_cwd(
    explicit: Option<String>,
    workspace_root: &State<'_, Mutex<Option<PathBuf>>>,
) -> PathBuf {
    if let Some(p) = explicit { return PathBuf::from(p); }
    if let Ok(g) = workspace_root.lock() {
        if let Some(p) = g.as_ref() { return p.clone(); }
    }
    if let Ok(h) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        return PathBuf::from(h);
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Normalize Windows extended-length path (`\\?\X:\...`) to a regular
/// Windows path (`X:\...`) before passing it to the PTY shell.
///
/// **Pourquoi** : sur Windows, `fs::canonicalize()` (utilisé par fs.rs
/// au boot du workspace) retourne TOUJOURS un extended-length path
/// préfixé par `\\?\` (e.g. `\\?\F:\Dev\shugu_code`). Le filesystem Rust
/// l'accepte parfaitement, mais quand on le passe à PowerShell via
/// `CommandBuilder::cwd()`, PowerShell le voit comme un chemin UNC
/// non-standard et l'expose à l'utilisateur comme
/// `Microsoft.PowerShell.Core\FileSystem::\\?\F:\Dev\shugu_code` —
/// chaîne sur laquelle Node.js (`lstat 'F:'`) et pnpm cassent avec
/// `EISDIR: illegal operation on a directory`.
///
/// Cette normalisation est PUREMENT cosmétique côté process child :
/// elle change la représentation du cwd visible au shell sans changer
/// le filesystem mappé. Le `workspace_root` du Mutex Tauri conserve la
/// forme `\\?\` (utile pour la canonicalisation interne et le containment).
///
/// Couvre `C:`, `D:`, `F:`, chemins avec espaces / accents / parenthèses —
/// rien n'est hardcodé : on strip uniquement le préfixe `\\?\`.
fn normalize_cwd_for_shell(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        // strip_prefix conserve le reste tel quel (drive letter + path).
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
        // Sécurité défensive — au cas où Tauri normalise déjà les
        // backslashes en forward slashes lors de la sérialisation IPC.
        if let Some(rest) = s.strip_prefix("//?/") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn is_cmd_basename(shell: &str) -> bool {
    let lower = shell.to_lowercase();
    lower.ends_with("cmd.exe") || lower == "cmd"
}

#[tauri::command]
pub fn term_spawn(
    app: AppHandle,
    tab_id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    registry: State<'_, PtyRegistry>,
    workspace_root: State<'_, Mutex<Option<PathBuf>>>,
) -> Result<(), String> {
    // Idempotent: if PTY already exists for this tab_id, return Ok without
    // recreating. The frontend DockTerminal component re-mounts whenever the
    // dock or its containing route unmounts (page navigation /chat → /code,
    // dock side changes, React 18 strict-mode double-mount). On re-mount it
    // calls term_spawn again — we MUST not error here, otherwise every
    // route round-trip would surface "[term_spawn error]" in the terminal.
    // Instead we keep the existing PTY alive; the caller will simply
    // re-attach its listeners on `term://output/{tab_id}` and pick up
    // output from that point. Any output that arrived while the listener
    // was detached is lost (acceptable v1). PTYs are killed only by the
    // explicit term_kill command (called from the dock's closeTab handler).
    {
        let g = registry.0.lock().map_err(|e| e.to_string())?;
        if g.contains_key(&tab_id) {
            return Ok(());
        }
    }

    let shell_path = resolve_shell(shell);
    // Normalize extended-length path (`\\?\X:\...`) → `X:\...` AVANT de
    // passer au shell. Voir normalize_cwd_for_shell pour le pourquoi
    // (PowerShell + Node casseraient autrement).
    let cwd_path = normalize_cwd_for_shell(resolve_cwd(cwd, &workspace_root));

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut builder = CommandBuilder::new(&shell_path);
    // AutoRun bypass: cmd /d disables HKCU's Command Processor\AutoRun
    // which launches a vault + Shugu CLI on every cmd.exe invocation.
    // Without /d, every new dock terminal re-spawns those background
    // processes. Harmless on shells other than cmd.exe.
    if is_cmd_basename(&shell_path) {
        builder.arg("/d");
    }
    builder.cwd(&cwd_path);

    let child = pair.slave.spawn_command(builder).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let buffer: Arc<Mutex<VecDeque<u8>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(SNAPSHOT_MAX_BYTES)));

    // Read loop on a dedicated OS thread. portable-pty's reader does
    // blocking std::io::Read; running it on tokio would starve the
    // runtime. The thread:
    //   1. pushes each chunk into the ring buffer (drops oldest bytes
    //      to stay under SNAPSHOT_MAX_BYTES), so term_snapshot can
    //      replay state to a future re-mounted DockTerminal.
    //   2. emits term://output/{tab_id} with the lossily-decoded
    //      String for any currently-attached frontend listener.
    {
        let app = app.clone();
        let tab_id = tab_id.clone();
        let shutdown = shutdown.clone();
        let buffer = buffer.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let chan = format!("term://output/{}", tab_id);
            loop {
                if shutdown.load(Ordering::Relaxed) { break; }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Push to ring buffer first (so even if no
                        // listener is attached, the bytes are kept).
                        if let Ok(mut b) = buffer.lock() {
                            let want_room = (b.len() + n).saturating_sub(SNAPSHOT_MAX_BYTES);
                            for _ in 0..want_room { b.pop_front(); }
                            b.extend(buf[..n].iter().copied());
                        }
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app.emit(&chan, TermOutput { data });
                    }
                    Err(_) => break,
                }
            }
            let _ = app.emit(&format!("term://exit/{}", tab_id), ());
        });
    }

    let mut g = registry.0.lock().map_err(|e| e.to_string())?;
    g.insert(tab_id, PtyHandle { writer, master: pair.master, shutdown, child, buffer });
    Ok(())
}

#[tauri::command]
pub fn term_write(
    tab_id: String,
    data: String,
    registry: State<'_, PtyRegistry>,
) -> Result<(), String> {
    let mut g = registry.0.lock().map_err(|e| e.to_string())?;
    let handle = g.get_mut(&tab_id).ok_or_else(|| format!("no pty {}", tab_id))?;
    handle.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    handle.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn term_resize(
    tab_id: String,
    cols: u16,
    rows: u16,
    registry: State<'_, PtyRegistry>,
) -> Result<(), String> {
    let g = registry.0.lock().map_err(|e| e.to_string())?;
    let handle = g.get(&tab_id).ok_or_else(|| format!("no pty {}", tab_id))?;
    handle.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn term_kill(
    tab_id: String,
    registry: State<'_, PtyRegistry>,
) -> Result<(), String> {
    let mut g = registry.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut handle) = g.remove(&tab_id) {
        handle.shutdown.store(true, Ordering::Relaxed);
        let _ = handle.child.kill();
    }
    Ok(())
}

/// Replay the recent output buffer for an existing PTY. Called by a
/// re-mounted DockTerminal so it can paint the same visual state the
/// previous mount had (last ~256 KB of bytes). The frontend writes the
/// returned string directly to xterm.write(); xterm interprets the
/// embedded ANSI escape codes and reconstructs cursor, colors,
/// scrollback, screen mode. Returns empty string if the tab has no
/// PTY (or was just freshly spawned with no output yet).
#[tauri::command]
pub fn term_snapshot(
    tab_id: String,
    registry: State<'_, PtyRegistry>,
) -> Result<String, String> {
    let g = registry.0.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = g.get(&tab_id) {
        let b = handle.buffer.lock().map_err(|e| e.to_string())?;
        // Copy out to a contiguous Vec then lossy-decode. Multi-byte
        // sequences trimmed mid-codepoint become � on render —
        // acceptable since the ring buffer's trim boundary advances
        // and the artifact is at most 3 bytes wide.
        let bytes: Vec<u8> = b.iter().copied().collect();
        Ok(String::from_utf8_lossy(&bytes).to_string())
    } else {
        Ok(String::new())
    }
}
