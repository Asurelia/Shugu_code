//! Language Server Protocol bridge (LOT 3).
//!
//! ## Architecture
//!
//! Le frontend (@codemirror/lsp-client) parle un Transport simple
//! `{ send, subscribe, unsubscribe }` qui échange des messages JSON-RPC
//! STRING déjà sérialisés. Ce module fait l'adapter entre ce Transport et
//! le LSP server natif :
//!
//! - **Spawn** : tokio::process::Command (PAS tauri-plugin-shell.sidecar)
//!   parce qu'on a besoin de byte-level I/O — le framing LSP utilise
//!   `Content-Length: N\r\n\r\n<JSON>` et les CommandEvent::Stdout du
//!   shell plugin sont line-based, ce qui casse les payloads contenant
//!   des newlines.
//!
//! - **Framing** :
//!   * Entrée (stdin → LSP) : `lsp_send(lang_id, message)` préfixe le
//!     header Content-Length puis écrit sur le stdin du child.
//!   * Sortie (LSP → stdout → frontend) : une task background lit les
//!     headers byte-par-byte jusqu'au `\r\n\r\n`, parse `Content-Length`,
//!     read_exact des N bytes du JSON, puis emit `lsp://msg` côté front.
//!
//! - **Hybrid binary resolution (LOT 3 MVP)** :
//!   * D'abord `which::which(binary_name)` (LSP installé manuellement par
//!     l'utilisateur via npm/cargo/winget/brew).
//!   * Si absent : sidecar bundlé via `src-tauri/binaries/` (à brancher
//!     plus tard — pour LOT 3 MVP, retourne Err et l'UI affiche un
//!     onboarding install).
//!
//! - **Lifecycle** :
//!   * Un LspSession par langue stocké dans `LspServerRegistry`
//!     (`Mutex<HashMap<lang_id, Arc<LspSession>>>`).
//!   * `lsp_init` est idempotent : si une session existe déjà pour ce
//!     langage, on la réutilise (un seul LSP par langue par workspace).
//!   * `lsp_shutdown(lang_id)` envoie `shutdown`+`exit` JSON-RPC via stdin
//!     puis `start_kill` après 500ms (graceful + safety net).
//!   * Kill all on `RunEvent::Exit` (voir lib.rs) — pattern identique à
//!     llama-server pour ne pas leak des process node.exe / rust-analyzer.exe.
//!
//! ## Sécurité
//!
//! - Le binaire LSP est résolu via `which::which` (PATH système). On ne
//!   prend JAMAIS un chemin user comme entrée — pas de path injection.
//! - Le workspace URI est passé par le frontend mais transite uniquement
//!   vers le LSP server (qui le valide lui-même via son rootUri).
//! - Les messages JSON-RPC sont transparents : on ne les parse pas côté
//!   Rust (juste le framing). Aucune surface d'injection JSON à ce niveau.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Une session LSP active : process + canal d'écriture stdin + handle de kill.
pub struct LspSession {
    /// Canal vers la task qui sérialise les messages sur stdin.
    /// Drop ce sender → la task termine, stdin se ferme, le LSP server voit
    /// EOF (mécanisme de fin propre alternatif à `shutdown` JSON-RPC).
    stdin_tx: mpsc::UnboundedSender<String>,
    /// Child handle dans une Mutex pour pouvoir le killer depuis un thread
    /// arbitraire (e.g. RunEvent::Exit). On utilise std::sync::Mutex (sync)
    /// car `Child::start_kill()` est synchrone.
    child: Mutex<Option<Child>>,
}

impl LspSession {
    /// Tue le child sans attendre — utilisé par RunEvent::Exit et lsp_shutdown.
    pub fn force_kill(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.start_kill();
            }
        }
    }
}

/// Registry app-wide des sessions LSP, une par langage.
pub struct LspServerRegistry(pub Mutex<HashMap<String, Arc<LspSession>>>);

impl Default for LspServerRegistry {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// Payload émis vers le frontend pour chaque message reçu du LSP server.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspIncomingMessage {
    lang_id: String,
    message: String,
}

/// Payload émis vers le frontend en cas d'erreur du transport ou du child.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspErrorEvent {
    lang_id: String,
    message: String,
}

/// Payload reçu côté frontend pour l'init — pour l'instant on n'a besoin
/// que de `langId`. Le workspaceUri est CALCULÉ côté Rust (le frontend
/// n'a pas le chemin absolu du workspace, seul le Rust le stocke dans
/// le Mutex<Option<PathBuf>> géré au boot) et renvoyé dans LspInitResult.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LspInitArgs {
    pub lang_id: String,
}

/// Résultat de `lsp_init` : le workspaceUri sera utilisé par le LSPClient
/// frontend comme rootUri (champ requis du protocole LSP `initialize`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspInitResult {
    pub workspace_uri: String,
}

/// Convertit un chemin absolu OS en URI `file://` percent-encoded.
/// Windows : `file:///C:/Users/Jean%20C%C3%B4t%C3%A9/...` ; Unix idem
/// (le préfixe `file:///` est le même : sur Unix, le path commence par `/`
/// donc on a `file:///` + `home/...` = `file:///home/...`).
///
/// Percent-encoding requis car rust-analyzer / pylsp / typescript-language-server
/// récents refusent les URI non-RFC3986 (espaces, accents, etc.) reçues dans
/// `textDocument/didOpen`. Avant ce fix, un workspace dans `C:\Users\Jean Côté`
/// faisait silencieusement crasher le `initialize` LSP.
///
/// **Smoke test fix (LSP)** : on STRIP le préfixe Windows extended-length
/// `\\?\` AVANT de percent-encode. Sans ça :
///   - `\\?\F:\Dev\shugu_code` → replace \ → `//?/F:/Dev/shugu_code`
///   - trim leading / → `?/F:/Dev/shugu_code`
///   - encode : `?` est dans PATH_SET → `%3F/F:/Dev/shugu_code`
///   - URI envoyée : `file:///%3F/F:/Dev/shugu_code`
///   - typescript-language-server décode → path `?/F:/Dev/shugu_code`
///   - Node tente `stat` → reconstruit en `F:\?\F:\Dev\shugu_code`
///     → ENOENT, l'initialize LSP échoue avec -32603.
/// Même normalisation que `normalize_cwd_for_shell` dans terminal.rs ;
/// pourrait être centralisé dans une util/path.rs si on en ajoute d'autres.
///
/// On utilise PATH_SEGMENT (RFC 3986) qui encode tout sauf les unreserved
/// + `/` (qu'on veut garder comme séparateur). Le `:` du drive Windows
/// (`C:`) est aussi préservé (pas dans le set).
fn path_to_file_uri(path: &std::path::Path) -> String {
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    // Encode tout SAUF : alphanumeric, unreserved (-_.~), et / : (séparateurs).
    const PATH_SET: &AsciiSet = &CONTROLS
        .add(b' ').add(b'"').add(b'<').add(b'>').add(b'\\').add(b'^')
        .add(b'`').add(b'{').add(b'|').add(b'}').add(b'?').add(b'#')
        .add(b'%').add(b'[').add(b']');

    // Strip Windows extended-length prefix BEFORE encoding ; sinon le `?`
    // serait percent-encodé en `%3F` et le LSP server reconstruirait un
    // path corrompu type `F:\?\F:\Dev\...` (vérifié au smoke test).
    let s_raw = path.to_string_lossy();
    let s_no_prefix: &str = if let Some(rest) = s_raw.strip_prefix(r"\\?\") {
        rest
    } else if let Some(rest) = s_raw.strip_prefix("//?/") {
        rest
    } else {
        &s_raw
    };

    let s = s_no_prefix.replace('\\', "/");
    let stripped = s.trim_start_matches('/');
    let encoded: String = utf8_percent_encode(stripped, PATH_SET).collect();
    format!("file:///{encoded}")
}

// ---------------------------------------------------------------------------
// Binary resolution (hybride)
// ---------------------------------------------------------------------------

/// Résout le binaire LSP pour un langId. Retourne (path, args) ou None
/// si le binaire n'est pas installé sur la machine (et qu'on n'a pas de
/// sidecar bundlé pour ce langage).
fn resolve_lsp_binary(lang_id: &str) -> Option<(PathBuf, Vec<String>)> {
    // Note : seuls les langIds que `langFromPath` (src/lib/fs.ts) produit
    // sont matchés ici. Les `typescriptreact`/`javascriptreact` LSP-standard
    // ne sont pas traités séparément car `.tsx`/`.jsx` mappent à
    // "typescript"/"javascript" côté front (cf. langFromPath LANG_MAP).
    let (binary_name, args): (&str, Vec<&str>) = match lang_id {
        "typescript" | "javascript" => ("typescript-language-server", vec!["--stdio"]),
        "rust" => ("rust-analyzer", vec![]),
        "python" => ("pylsp", vec![]),
        _ => return None,
    };
    // detect-installed : PATH system
    let path = which::which(binary_name).ok()?;
    Some((path, args.into_iter().map(String::from).collect()))
}

/// Construit la Command à spawn, avec wrapping cmd.exe sur Windows pour
/// les .cmd/.bat (e.g. typescript-language-server installé via npm crée un
/// .cmd shim qui n'est PAS exécutable directement par CreateProcess).
///
/// Utilise `cmd.exe /d /c` (cf. mémoire feedback_dev_cmd_conflict : /d
/// skip le AutoRun de l'utilisateur qui lance vault + Shugu CLI).
fn build_command(path: PathBuf, args: Vec<String>) -> Command {
    let is_script = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false);

    if cfg!(windows) && is_script {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/d").arg("/c").arg(path);
        for a in args {
            cmd.arg(a);
        }
        cmd
    } else {
        let mut cmd = Command::new(path);
        for a in args {
            cmd.arg(a);
        }
        cmd
    }
}

// ---------------------------------------------------------------------------
// LSP framing — Content-Length headers + JSON payload
// ---------------------------------------------------------------------------

/// Lit un message LSP framé depuis le stdout du child. Format :
/// ```text
/// Content-Length: N\r\n
/// (optional other headers)\r\n
/// \r\n
/// <N bytes of JSON>
/// ```
/// Returns Ok(None) on EOF (child closed stdout).
async fn read_one_lsp_message(
    reader: &mut BufReader<ChildStdout>,
) -> std::io::Result<Option<String>> {
    // Read headers until blank line (\r\n\r\n).
    let mut content_length: Option<usize> = None;
    let mut header_line = String::new();
    loop {
        header_line.clear();
        let n = reader.read_line(&mut header_line).await?;
        if n == 0 {
            return Ok(None); // EOF
        }
        let trimmed = header_line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            // End of headers.
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = rest.trim().parse::<usize>().ok();
        }
        // Other headers (Content-Type, etc.) are valid but ignored — LSP
        // standard says we only need Content-Length.
    }
    let n = content_length.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "missing Content-Length")
    })?;
    // Safeguard contre un Content-Length absurde (qui allouerait des GBs).
    // LSP typique : quelques KB par message ; 16 MB est très large.
    if n > 16 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Content-Length too large: {n}"),
        ));
    }
    let mut payload = vec![0u8; n];
    reader.read_exact(&mut payload).await?;
    let message = String::from_utf8(payload).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
    })?;
    Ok(Some(message))
}

/// Écrit un message LSP avec son header Content-Length sur stdin du child.
async fn write_lsp_message(
    writer: &mut BufWriter<ChildStdin>,
    message: &str,
) -> std::io::Result<()> {
    let header = format!("Content-Length: {}\r\n\r\n", message.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(message.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Session spawning
// ---------------------------------------------------------------------------

async fn spawn_session(
    binary: PathBuf,
    args: Vec<String>,
    lang_id: String,
    app: AppHandle,
) -> Result<LspSession, String> {
    let mut cmd = build_command(binary, args);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // kill_on_drop : safety net si la Child est droppée sans kill explicite.
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("spawn LSP: {e}"))?;

    let stdin = child.stdin.take().ok_or("LSP child: no stdin")?;
    let stdout = child.stdout.take().ok_or("LSP child: no stdout")?;
    let stderr = child.stderr.take().ok_or("LSP child: no stderr")?;

    // ── Writer task : reçoit les messages depuis le channel et les écrit
    //    avec framing sur stdin. Termine quand le sender est drop (Session
    //    drop ou shutdown explicite).
    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        let mut writer = BufWriter::new(stdin);
        while let Some(msg) = stdin_rx.recv().await {
            if let Err(e) = write_lsp_message(&mut writer, &msg).await {
                eprintln!("[lsp:writer] {e}");
                break;
            }
        }
    });

    // ── Reader task : lit les messages framés depuis stdout et les emit
    //    sur "lsp://msg". Termine sur EOF (child exited) ou erreur framing.
    let app_for_reader = app.clone();
    let lang_for_reader = lang_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_one_lsp_message(&mut reader).await {
                Ok(Some(message)) => {
                    let _ = app_for_reader.emit(
                        "lsp://msg",
                        LspIncomingMessage {
                            lang_id: lang_for_reader.clone(),
                            message,
                        },
                    );
                }
                Ok(None) => {
                    // EOF — LSP child closed stdout (crash or graceful exit).
                    // Emit `lsp://exited` pour que le frontend puisse dispose
                    // son LSPClient et clear le cache (autoriser un retry).
                    // Sans ça, le user voit autocomplete/diagnostics se figer
                    // silencieusement sans aucun signal côté UI.
                    eprintln!("[lsp:{lang_for_reader}] reader EOF (child exited)");
                    let _ = app_for_reader.emit(
                        "lsp://exited",
                        LspErrorEvent {
                            lang_id: lang_for_reader.clone(),
                            message: "LSP server exited (EOF on stdout)".to_string(),
                        },
                    );
                    break;
                }
                Err(e) => {
                    eprintln!("[lsp:{lang_for_reader}] reader error: {e}");
                    let _ = app_for_reader.emit(
                        "lsp://error",
                        LspErrorEvent {
                            lang_id: lang_for_reader.clone(),
                            message: e.to_string(),
                        },
                    );
                    break;
                }
            }
        }
    });

    // ── Stderr task : log line-by-line vers stdout Rust (capturé par le
    //    fichier de trace tauri-dev.cmd > trace.log). Utile pour debug LSP.
    let lang_for_stderr = lang_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => eprintln!("[lsp:{lang_for_stderr}:stderr] {}", line.trim_end()),
                Err(_) => break,
            }
        }
    });

    Ok(LspSession {
        stdin_tx,
        child: Mutex::new(Some(child)),
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Spawn (ou réutilise) une session LSP pour `lang_id`. Idempotent : si une
/// session existe déjà, retourne Ok(()) sans rien faire. Si le binaire n'est
/// pas trouvé sur le PATH, retourne Err — le frontend doit gérer cette erreur
/// en affichant un onboarding install au lieu de planter.
#[tauri::command]
pub async fn lsp_init(
    app: AppHandle,
    state: State<'_, LspServerRegistry>,
    args: LspInitArgs,
) -> Result<LspInitResult, String> {
    // Récupère le workspace_uri d'abord — il est requis dans tous les cas
    // (renvoyé même si la session existe déjà).
    let workspace_root: std::path::PathBuf = {
        let ws_state = app.state::<std::sync::Mutex<Option<std::path::PathBuf>>>();
        let guard = ws_state.lock().map_err(|e| format!("workspace lock: {e}"))?;
        guard.clone().ok_or("no workspace open")?
    };
    let workspace_uri = path_to_file_uri(&workspace_root);

    // Check existing session (lock + early return).
    {
        let guard = state.0.lock().map_err(|e| format!("registry lock: {e}"))?;
        if guard.contains_key(&args.lang_id) {
            return Ok(LspInitResult { workspace_uri });
        }
    }

    // Resolve binary (hybride : which-first ; sidecar fallback à wirer
    // plus tard, retourne Err pour MVP).
    let (path, bin_args) = resolve_lsp_binary(&args.lang_id).ok_or_else(|| {
        format!(
            "LSP binary not found for '{}'. Install it: \
             typescript-language-server via npm, rust-analyzer via rustup, \
             pylsp via pip.",
            args.lang_id
        )
    })?;

    let session = spawn_session(path, bin_args, args.lang_id.clone(), app).await?;

    // Insert atomically (last-writer-wins if a race spawned a second one ;
    // the loser's session will be dropped, kill_on_drop kicks in).
    let mut guard = state.0.lock().map_err(|e| format!("registry lock: {e}"))?;
    guard.insert(args.lang_id, Arc::new(session));
    Ok(LspInitResult { workspace_uri })
}

/// Envoie un message JSON-RPC au LSP server du langage donné. Le message
/// est une string JSON déjà sérialisée par @codemirror/lsp-client côté JS ;
/// le Rust ne fait que framing + write.
#[tauri::command]
pub fn lsp_send(
    state: State<'_, LspServerRegistry>,
    lang_id: String,
    message: String,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| format!("registry lock: {e}"))?;
    let session = guard
        .get(&lang_id)
        .ok_or_else(|| format!("no LSP session for '{lang_id}' (call lsp_init first)"))?;
    session
        .stdin_tx
        .send(message)
        .map_err(|e| format!("lsp_send channel: {e}"))?;
    Ok(())
}

/// Arrête proprement la session LSP : on tente d'envoyer `shutdown` + `exit`
/// JSON-RPC via stdin, on attend brièvement, puis on kill par sécurité.
/// La task reader voit EOF et termine ; la session est retirée du registry.
#[tauri::command]
pub async fn lsp_shutdown(
    state: State<'_, LspServerRegistry>,
    lang_id: String,
) -> Result<(), String> {
    // Sortir la session du registry tout de suite (un nouveau lsp_init
    // pourra spawn un nouveau process).
    let session = {
        let mut guard = state.0.lock().map_err(|e| format!("registry lock: {e}"))?;
        guard.remove(&lang_id)
    };
    let Some(session) = session else {
        return Ok(()); // déjà absent — idempotent
    };

    // Tente le graceful shutdown via JSON-RPC. Les ID sont arbitraires
    // mais doivent être uniques dans la session (on n'en a pas envoyé
    // d'autres pour ces ID, donc safe).
    let _ = session.stdin_tx.send(
        r#"{"jsonrpc":"2.0","id":9999,"method":"shutdown"}"#.to_string(),
    );
    let _ = session.stdin_tx.send(
        r#"{"jsonrpc":"2.0","method":"exit"}"#.to_string(),
    );
    // 500 ms pour laisser le LSP server traiter shutdown+exit et fermer
    // proprement avant le SIGKILL via force_kill(). Si le LSP est bloqué
    // (deadlock JSON-RPC), force_kill garantit qu'on libère le process.
    // Le `stdin_tx` ne peut PAS être drop ici (session est dans un Arc),
    // donc le close-stdin path n'est pas disponible — force_kill suffit.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    session.force_kill();
    Ok(())
}

/// Tue toutes les sessions LSP — appelé depuis RunEvent::Exit (lib.rs).
/// Sync car les locks std::sync sont sync, et start_kill est sync.
pub fn kill_all(state: &LspServerRegistry) {
    if let Ok(mut guard) = state.0.lock() {
        for (_, session) in guard.drain() {
            session.force_kill();
        }
    }
}
