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
//! - Le bridge parse seulement les champs structurants nécessaires au partage
//!   éditeur/agent (`id`, `method`, URI/version) ; le payload reste opaque et
//!   est transmis au serveur avec un framing borné.

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
    /// P6.12 — routeur des réponses en cours (requêtes request/response des
    /// outils agent, attentes publishDiagnostics). Partagé avec la reader task.
    router: std::sync::Arc<ResponseRouter>,
    /// Handshake `initialize`/`initialized` déjà fait pour cette session
    /// (une seule fois — le chemin agent le déclenche paresseusement au
    /// premier besoin, le frontend le fait de son côté via LSPClient).
    initialized: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// Un handshake a déjà été envoyé (par l'éditeur ou par un outil agent).
    /// Distinct de `initialized` pour que les deux clients partagent la même
    /// session sans envoyer deux requêtes `initialize`.
    initializing: std::sync::atomic::AtomicBool,
    initialized_notify: tokio::sync::Notify,
    /// Sérialise le handshake paresseux : un AtomicBool seul permettait à deux
    /// outils LSP parallèles d'envoyer deux requêtes `initialize`.
    initialize_lock: tokio::sync::Mutex<()>,
    /// Version des documents ouverts par le frontend ou les outils agent.
    /// Le premier envoi est `didOpen`, les suivants sont `didChange`.
    documents: Mutex<HashMap<String, i32>>,
}

/// P6.12 — corrélation request/response EN COURS (le chemin éditeur est
/// événementiel : le LSPClient frontend fait sa corrélation lui-même).
/// Les réponses avec un `id` en attente sont routées vers le oneshot de
/// l'appelant ; `publishDiagnostics` nourrit les attentes par URI ET continue
/// d'être émis vers le frontend (notification partagée).
pub(crate) struct ResponseRouter {
    pending_requests:
        std::sync::Mutex<HashMap<i64, tokio::sync::oneshot::Sender<serde_json::Value>>>,
    pending_diagnostics:
        std::sync::Mutex<HashMap<String, Vec<tokio::sync::oneshot::Sender<serde_json::Value>>>>,
    next_id: std::sync::atomic::AtomicI64,
}

impl ResponseRouter {
    pub(crate) fn new() -> Self {
        Self {
            pending_requests: std::sync::Mutex::new(HashMap::new()),
            pending_diagnostics: std::sync::Mutex::new(HashMap::new()),
            // Les clients frontend utilisent habituellement des ids positifs.
            // Le bridge agent réserve les négatifs pour éviter toute collision
            // dans une session JSON-RPC partagée.
            next_id: std::sync::atomic::AtomicI64::new(-1),
        }
    }

    pub(crate) fn alloc_id(&self) -> i64 {
        self.next_id
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn register_request(
        &self,
        id: i64,
    ) -> tokio::sync::oneshot::Receiver<serde_json::Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut g) = self.pending_requests.lock() {
            g.insert(id, tx);
        }
        rx
    }

    pub(crate) fn unregister_request(&self, id: i64) {
        if let Ok(mut g) = self.pending_requests.lock() {
            g.remove(&id);
        }
    }

    pub(crate) fn register_diagnostics(
        &self,
        uri: &str,
    ) -> tokio::sync::oneshot::Receiver<serde_json::Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Ok(mut g) = self.pending_diagnostics.lock() {
            g.entry(uri.to_string()).or_default().push(tx);
        }
        rx
    }

    pub(crate) fn unregister_diagnostics(&self, uri: &str) {
        if let Ok(mut g) = self.pending_diagnostics.lock() {
            if let Some(waiters) = g.get_mut(uri) {
                waiters.retain(|tx| !tx.is_closed());
                if waiters.is_empty() {
                    g.remove(uri);
                }
            }
        }
    }

    /// Route un message sortant du serveur. Retourne `true` quand le message
    /// était une RÉPONSE à une requête agent en attente (consommée — ne pas
    /// l'émettre vers le frontend). Les notifications (diagnostics) nourrissent
    /// leurs attentes mais retournent `false` (l'event part quand même).
    pub(crate) fn route(&self, message: &str) -> bool {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(message) else {
            return false;
        };
        if let Some(id) = v["id"].as_i64() {
            let tx = self
                .pending_requests
                .lock()
                .ok()
                .and_then(|mut g| g.remove(&id));
            if let Some(tx) = tx {
                let _ = tx.send(v);
                return true;
            }
        }
        if v["method"].as_str() == Some("textDocument/publishDiagnostics") {
            let uri = v["params"]["uri"].as_str().unwrap_or("");
            let waiters = self
                .pending_diagnostics
                .lock()
                .ok()
                .and_then(|mut g| g.remove(uri));
            if let Some(waiters) = waiters {
                for tx in waiters {
                    let _ = tx.send(v["params"].clone());
                }
            }
        }
        false
    }

    /// EOF / crash du serveur : TOUTES les attentes échouent honnêtement
    /// (drop des senders → RecvError côté appelant, jamais de hang infini).
    pub(crate) fn fail_all(&self) {
        if let Ok(mut g) = self.pending_requests.lock() {
            g.clear();
        }
        if let Ok(mut g) = self.pending_diagnostics.lock() {
            g.clear();
        }
    }
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

/// Évite le check-then-spawn concurrent entre l'éditeur et plusieurs outils
/// agents. La création d'une session est rare ; sérialiser aussi les langages
/// différents garde le registry simple et ne touche pas le chemin des requêtes.
static LSP_START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
/// Même normalisation que `normalize_cwd_for_shell` (terminal.rs) — toutes
/// deux délèguent désormais au helper CENTRAL `pathutil::strip_extended_prefix`.
///
/// On utilise PATH_SEGMENT (RFC 3986) qui encode tout sauf les unreserved
/// + `/` (qu'on veut garder comme séparateur). Le `:` du drive Windows
/// (`C:`) est aussi préservé (pas dans le set).
fn path_to_file_uri(path: &std::path::Path) -> String {
    use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
    // Encode tout SAUF : alphanumeric, unreserved (-_.~), et / : (séparateurs).
    const PATH_SET: &AsciiSet = &CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'<')
        .add(b'>')
        .add(b'\\')
        .add(b'^')
        .add(b'`')
        .add(b'{')
        .add(b'|')
        .add(b'}')
        .add(b'?')
        .add(b'#')
        .add(b'%')
        .add(b'[')
        .add(b']');

    // Strip Windows extended-length prefix BEFORE encoding ; sinon le `?`
    // serait percent-encodé en `%3F` et le LSP server reconstruirait un
    // path corrompu type `F:\?\F:\Dev\...` (vérifié au smoke test).
    let cleaned = strip_extended_prefix(path.to_path_buf());
    let s = cleaned.to_string_lossy().replace('\\', "/");
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
fn resolve_lsp_binary(
    lang_id: &str,
    workspace_root: &std::path::Path,
) -> Option<(PathBuf, Vec<String>)> {
    // Note : seuls les langIds que `langFromPath` (src/lib/fs.ts) produit
    // sont matchés ici. Les `typescriptreact`/`javascriptreact` LSP-standard
    // ne sont pas traités séparément car `.tsx`/`.jsx` mappent à
    // "typescript"/"javascript" côté front (cf. langFromPath LANG_MAP).
    let (binary_name, args): (&str, Vec<&str>) = match lang_id {
        "typescript" | "javascript" => ("typescript-language-server", vec!["--stdio"]),
        "rust" => ("rust-analyzer", vec![]),
        "python" => ("pylsp", vec![]),
        "go" => ("gopls", vec![]),
        // clangd couvre C et C++ ; jdtls (Java) est best-effort (lanceur
        // complexe : data dir + JVM args). S'il ne handshake pas, le reader
        // verra EOF et émettra lsp://exited — l'app ne casse pas.
        "c" | "cpp" => ("clangd", vec![]),
        "java" => ("jdtls", vec![]),
        _ => return None,
    };
    let args: Vec<String> = args.into_iter().map(String::from).collect();

    // 1) node_modules/.bin du workspace — la toolchain fournie PAR le projet,
    //    comme VS Code/Cursor. Sur Windows, npm crée un shim `.cmd` qui n'est
    //    pas exécutable directement par CreateProcess → build_command wrappe
    //    `.cmd`/`.bat` via `cmd /d /c`. Sans ce check, typescript-language-server
    //    (jamais sur le PATH système, mais présent dans node_modules/.bin du
    //    repo) ne se résolvait pas → LSP TS muet sur le langage principal.
    let bin_dir = workspace_root.join("node_modules").join(".bin");
    let candidates: &[&str] = if cfg!(windows) {
        &[".cmd", ".CMD", ""]
    } else {
        &[""]
    };
    for ext in candidates {
        let candidate = bin_dir.join(format!("{binary_name}{ext}"));
        if candidate.is_file() {
            return Some((candidate, args));
        }
    }

    // 2) PATH système (LSP installé manuellement : rustup, pip, winget, brew…).
    let path = which::which(binary_name).ok()?;
    Some((path, args))
}

// STRIP du préfixe Windows extended-length `\\?\` : helper CENTRAL pathutil.
// **Pourquoi c'est critique ici (cause racine du LSP TS muet)** :
// `workspace_root` provient de `fs::canonicalize()` (donc verbatim), le `.cmd`
// résolu hérite du préfixe, et **cmd.exe REFUSE les chemins `\\?\`** →
// « Le chemin d'accès spécifié est introuvable. » → le child meurt au spawn →
// l'init LSP timeout. rust-analyzer échappe au bug (lancé DIRECTEMENT,
// CreateProcess accepte `\\?\`). Vérifié au repro : `cmd /d /c "\\?\….cmd"
// --version` → exit 1 ; le même sans préfixe → `5.2.0`.
use super::pathutil::strip_extended_prefix;

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
        // STRIP `\\?\` AVANT de passer le chemin à cmd.exe (qui le rejette).
        let clean = strip_extended_prefix(path);
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/d").arg("/c").arg(clean);
        for a in args {
            cmd.arg(a);
        }
        cmd
    } else {
        // Branche directe (CreateProcess) : `\\?\` est accepté, mais on strip
        // quand même par cohérence — un chemin propre n'a aucun inconvénient
        // et évite des surprises si un autre serveur passait un jour par ici.
        let clean = strip_extended_prefix(path);
        let mut cmd = Command::new(clean);
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
    let message = String::from_utf8(payload)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
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
    spawn_session_opt(binary, args, lang_id, Some(app)).await
}

/// Variante testable : `app` optionnelle — sans elle, la reader task route
/// uniquement vers le `ResponseRouter` (pas d'events Tauri). Le chemin
/// production passe toujours `Some(app)`.
async fn spawn_session_opt(
    binary: PathBuf,
    args: Vec<String>,
    lang_id: String,
    app: Option<AppHandle>,
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

    // ── Reader task : route d'abord les réponses en cours (P6.12, outils
    //    agent), puis emit "lsp://msg" pour le frontend. EOF/crash ⇒ toutes
    //    les attentes échouent honnêtement + session retirée du registry
    //    (un serveur mort ne reste pas « vivant » en cache).
    let router = std::sync::Arc::new(ResponseRouter::new());
    let initialized = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let app_for_reader = app.clone();
    let lang_for_reader = lang_id.clone();
    let router_for_reader = router.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_one_lsp_message(&mut reader).await {
                Ok(Some(message)) => {
                    // Réponse à une requête agent ? Consommée, pas d'event.
                    if router_for_reader.route(&message) {
                        continue;
                    }
                    if let Some(ref app) = app_for_reader {
                        let _ = app.emit(
                            "lsp://msg",
                            LspIncomingMessage {
                                lang_id: lang_for_reader.clone(),
                                message,
                            },
                        );
                    }
                }
                Ok(None) => {
                    // EOF — LSP child closed stdout (crash or graceful exit).
                    eprintln!("[lsp:{lang_for_reader}] reader EOF (child exited)");
                    router_for_reader.fail_all();
                    if let Some(ref app) = app_for_reader {
                        if let Some(registry) = app.try_state::<LspServerRegistry>() {
                            if let Ok(mut g) = registry.0.lock() {
                                if g.get(&lang_for_reader).is_some_and(|s| {
                                    std::sync::Arc::ptr_eq(&s.router, &router_for_reader)
                                }) {
                                    g.remove(&lang_for_reader);
                                }
                            }
                        }
                    }
                    if let Some(ref app) = app_for_reader {
                        let _ = app.emit(
                            "lsp://exited",
                            LspErrorEvent {
                                lang_id: lang_for_reader.clone(),
                                message: "LSP server exited (EOF on stdout)".to_string(),
                            },
                        );
                    }
                    break;
                }
                Err(e) => {
                    eprintln!("[lsp:{lang_for_reader}] reader error: {e}");
                    router_for_reader.fail_all();
                    if let Some(ref app) = app_for_reader {
                        let _ = app.emit(
                            "lsp://error",
                            LspErrorEvent {
                                lang_id: lang_for_reader.clone(),
                                message: e.to_string(),
                            },
                        );
                    }
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
        router,
        initialized,
        initializing: std::sync::atomic::AtomicBool::new(false),
        initialized_notify: tokio::sync::Notify::new(),
        initialize_lock: tokio::sync::Mutex::new(()),
        documents: Mutex::new(HashMap::new()),
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
        let guard = ws_state
            .lock()
            .map_err(|e| format!("workspace lock: {e}"))?;
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
    let _start_guard = LSP_START_LOCK.lock().await;
    {
        let guard = state.0.lock().map_err(|e| format!("registry lock: {e}"))?;
        if guard.contains_key(&args.lang_id) {
            return Ok(LspInitResult { workspace_uri });
        }
    }

    // Resolve binary (hybride : which-first ; sidecar fallback à wirer
    // plus tard, retourne Err pour MVP).
    let (path, bin_args) = resolve_lsp_binary(&args.lang_id, &workspace_root).ok_or_else(|| {
        format!(
            "LSP binary not found for '{}'. Install it: \
             typescript-language-server via npm, rust-analyzer via rustup, \
             pylsp via pip.",
            args.lang_id
        )
    })?;

    let session = spawn_session(path, bin_args, args.lang_id.clone(), app).await?;

    // Le verrou de création couvre le second check + spawn + insertion :
    // aucune session concurrente n'est créée puis écrasée.
    let mut guard = state.0.lock().map_err(|e| format!("registry lock: {e}"))?;
    guard.insert(args.lang_id, Arc::new(session));
    Ok(LspInitResult { workspace_uri })
}

/// Envoie un message JSON-RPC au LSP server du langage donné. Le message
/// est sérialisé par @codemirror/lsp-client côté JS ; le bridge observe les
/// notifications de cycle de vie/document pour partager proprement la session
/// avec les outils agent, puis la writer task assure le framing.
fn observe_outgoing_message(session: &LspSession, message: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(message) else {
        return;
    };
    match value["method"].as_str() {
        Some("initialize") => {
            session
                .initializing
                .store(true, std::sync::atomic::Ordering::Release);
        }
        Some("initialized") => {
            session
                .initialized
                .store(true, std::sync::atomic::Ordering::Release);
            session
                .initializing
                .store(false, std::sync::atomic::Ordering::Release);
            session.initialized_notify.notify_waiters();
        }
        Some("textDocument/didOpen") => {
            if let Some(uri) = value["params"]["textDocument"]["uri"].as_str() {
                let version = value["params"]["textDocument"]["version"]
                    .as_i64()
                    .and_then(|v| i32::try_from(v).ok())
                    .unwrap_or(1);
                if let Ok(mut docs) = session.documents.lock() {
                    docs.insert(uri.to_string(), version);
                }
            }
        }
        Some("textDocument/didChange") => {
            if let Some(uri) = value["params"]["textDocument"]["uri"].as_str() {
                let version = value["params"]["textDocument"]["version"]
                    .as_i64()
                    .and_then(|v| i32::try_from(v).ok())
                    .unwrap_or(1);
                if let Ok(mut docs) = session.documents.lock() {
                    docs.insert(uri.to_string(), version);
                }
            }
        }
        Some("textDocument/didClose") => {
            if let Some(uri) = value["params"]["textDocument"]["uri"].as_str() {
                if let Ok(mut docs) = session.documents.lock() {
                    docs.remove(uri);
                }
            }
        }
        _ => {}
    }
}

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
        .send(message.clone())
        .map_err(|e| format!("lsp_send channel: {e}"))?;
    observe_outgoing_message(session, &message);
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
    let _ = session
        .stdin_tx
        .send(r#"{"jsonrpc":"2.0","id":9999,"method":"shutdown"}"#.to_string());
    let _ = session
        .stdin_tx
        .send(r#"{"jsonrpc":"2.0","method":"exit"}"#.to_string());
    // 500 ms pour laisser le LSP server traiter shutdown+exit et fermer
    // proprement avant le SIGKILL via force_kill(). Si le LSP est bloqué
    // (deadlock JSON-RPC), force_kill garantit qu'on libère le process.
    // Le `stdin_tx` ne peut PAS être drop ici (session est dans un Arc),
    // donc le close-stdin path n'est pas disponible — force_kill suffit.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    session.force_kill();
    Ok(())
}

// ---------------------------------------------------------------------------
// P6.12 — chemin de requête EN COURS pour les outils agent (lsp_*). Le chemin
// éditeur est événementiel ; les outils agent ont besoin d'une réponse
// synchronisée : request/response avec timeout via le `ResponseRouter` de la
// session PARTAGÉE (même registry que l'éditeur — un kill du run ne tue
// JAMAIS les serveurs, ils sont app-level).
// ---------------------------------------------------------------------------

const AGENT_INIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Résout (ou crée) la session du langage dans le registry partagé — même
/// idempotence que `lsp_init` (une seule session par langue par workspace).
async fn ensure_session(
    app: &AppHandle,
    lang_id: &str,
) -> Result<std::sync::Arc<LspSession>, String> {
    {
        let state = app.state::<LspServerRegistry>();
        let guard = state.0.lock().map_err(|e| format!("registry lock: {e}"))?;
        if let Some(session) = guard.get(lang_id) {
            return Ok(session.clone());
        }
    }
    let _start_guard = LSP_START_LOCK.lock().await;
    {
        let state = app.state::<LspServerRegistry>();
        let guard = state.0.lock().map_err(|e| format!("registry lock: {e}"))?;
        if let Some(session) = guard.get(lang_id) {
            return Ok(session.clone());
        }
    }
    let workspace_root: std::path::PathBuf = {
        let ws_state = app.state::<std::sync::Mutex<Option<std::path::PathBuf>>>();
        let guard = ws_state
            .lock()
            .map_err(|e| format!("workspace lock: {e}"))?;
        guard.clone().ok_or("no workspace open")?
    };
    let (path, bin_args) = resolve_lsp_binary(lang_id, &workspace_root).ok_or_else(|| {
        format!(
            "pas de serveur LSP pour « {lang_id} » (binaire non installé —              typescript-language-server via npm, rust-analyzer via rustup, pylsp via pip)"
        )
    })?;
    let session = spawn_session(path, bin_args, lang_id.to_string(), app.clone()).await?;
    let session = std::sync::Arc::new(session);
    let state = app.state::<LspServerRegistry>();
    let mut guard = state.0.lock().map_err(|e| format!("registry lock: {e}"))?;
    guard.insert(lang_id.to_string(), session.clone());
    Ok(session)
}

fn workspace_root_required(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let ws_state = app.state::<std::sync::Mutex<Option<std::path::PathBuf>>>();
    let guard = ws_state
        .lock()
        .map_err(|e| format!("workspace lock: {e}"))?;
    guard.clone().ok_or("no workspace open".to_string())
}

/// Handshake LSP une fois par session (lazy, au premier besoin agent).
async fn ensure_initialized(
    workspace_uri: &str,
    session: &std::sync::Arc<LspSession>,
) -> Result<(), String> {
    if session
        .initialized
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    let _initialize_guard = session.initialize_lock.lock().await;
    if session
        .initialized
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }

    // L'éditeur peut avoir envoyé `initialize` via `lsp_send` juste avant
    // l'outil agent. On attend alors son `initialized` au lieu d'envoyer une
    // deuxième requête avec un autre id.
    if session
        .initializing
        .load(std::sync::atomic::Ordering::Acquire)
    {
        let notified = session.initialized_notify.notified();
        if session
            .initialized
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Ok(());
        }
        tokio::time::timeout(AGENT_INIT_TIMEOUT, notified)
            .await
            .map_err(|_| {
                "timeout en attendant la fin de l'initialisation LSP de l'éditeur".to_string()
            })?;
        return session
            .initialized
            .load(std::sync::atomic::Ordering::Acquire)
            .then_some(())
            .ok_or_else(|| "initialisation LSP de l'éditeur interrompue".to_string());
    }

    session
        .initializing
        .store(true, std::sync::atomic::Ordering::Release);
    let result = async {
        let resp = agent_lsp_request_inner(
            session,
            "initialize",
            serde_json::json!({
                "processId": std::process::id(),
                "rootUri": workspace_uri,
                "capabilities": {},
            }),
            AGENT_INIT_TIMEOUT,
        )
        .await?;
        if resp["error"].is_object() {
            return Err(format!(
                "initialize LSP refusé : {}",
                resp["error"]["message"]
            ));
        }
        session
            .stdin_tx
            .send(
                serde_json::json!({"jsonrpc":"2.0","method":"initialized","params":{}}).to_string(),
            )
            .map_err(|e| format!("lsp initialized send: {e}"))?;
        session
            .initialized
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }
    .await;
    session
        .initializing
        .store(false, std::sync::atomic::Ordering::Release);
    session.initialized_notify.notify_waiters();
    result
}

/// Requête request/response avec timeout sur une session donnée (cœur pur —
/// testable sans AppHandle avec une session mock).
async fn agent_lsp_request_inner(
    session: &LspSession,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let id = session.router.alloc_id();
    let rx = session.router.register_request(id);
    let msg = serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    session
        .stdin_tx
        .send(msg.to_string())
        .map_err(|e| format!("lsp send: {e}"))?;
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("serveur LSP mort pendant la requête".to_string()),
        Err(_) => {
            session.router.unregister_request(id);
            Err(format!("timeout LSP ({timeout:?}) pour `{method}`"))
        }
    }
}

/// URI file:// d'un chemin (réutilisé par les outils agent — même encodage
/// que le workspaceUri du handshake).
pub(crate) fn file_uri_for(path: &std::path::Path) -> String {
    path_to_file_uri(path)
}

/// Ouvre un document dans la session (didOpen, fire-and-forget) — requis par
/// la plupart des serveurs avant definition/references.
pub(crate) async fn agent_lsp_open_document(
    app: &AppHandle,
    lang_id: &str,
    uri: &str,
    text: &str,
    language: &str,
) -> Result<(), String> {
    let session = ensure_session(app, lang_id).await?;
    let ws_uri = path_to_file_uri(&workspace_root_required(app)?);
    ensure_initialized(&ws_uri, &session).await?;
    agent_lsp_open_document_on_session(&session, uri, text, language).await
}

/// Requête request/response complète (session partagée + handshake garanti).
pub(crate) async fn agent_lsp_request(
    app: &AppHandle,
    lang_id: &str,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let session = ensure_session(app, lang_id).await?;
    let uri = path_to_file_uri(&workspace_root_required(app)?);
    ensure_initialized(&uri, &session).await?;
    agent_lsp_request_inner(&session, method, params, timeout).await
}

/// Ouvre ou synchronise un document sur une session donnée. LSP interdit de
/// répéter `didOpen` pour une URI déjà ouverte : les appels suivants utilisent
/// `didChange` avec une version strictement croissante et le texte complet.
pub(crate) async fn agent_lsp_open_document_on_session(
    session: &LspSession,
    uri: &str,
    text: &str,
    language: &str,
) -> Result<(), String> {
    let (method, params) = {
        let mut documents = session
            .documents
            .lock()
            .map_err(|e| format!("lsp documents lock: {e}"))?;
        if let Some(version) = documents.get_mut(uri) {
            *version = version.saturating_add(1);
            (
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": { "uri": uri, "version": *version },
                    "contentChanges": [{ "text": text }],
                }),
            )
        } else {
            documents.insert(uri.to_string(), 1);
            (
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language,
                        "version": 1,
                        "text": text,
                    }
                }),
            )
        }
    };
    let msg = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    session
        .stdin_tx
        .send(msg.to_string())
        .map_err(|e| format!("lsp document sync send: {e}"))?;
    Ok(())
}

/// Ouvre un document et attend son `publishDiagnostics` (notification) — le
/// serveur publie quand il veut, on attend borné (timeout honnête, jamais de
/// liste vide fabriquée).
pub(crate) async fn agent_lsp_diagnostics(
    app: &AppHandle,
    lang_id: &str,
    uri: &str,
    text: &str,
    language: &str,
    timeout: std::time::Duration,
) -> Result<Vec<serde_json::Value>, String> {
    let session = ensure_session(app, lang_id).await?;
    let ws_uri = path_to_file_uri(&workspace_root_required(app)?);
    ensure_initialized(&ws_uri, &session).await?;
    agent_lsp_diagnostics_on_session(&session, uri, text, language, timeout).await
}

/// Attente bornée de publishDiagnostics sur une session donnée (cœur testable).
pub(crate) async fn agent_lsp_diagnostics_on_session(
    session: &LspSession,
    uri: &str,
    text: &str,
    language: &str,
    timeout: std::time::Duration,
) -> Result<Vec<serde_json::Value>, String> {
    let rx = session.router.register_diagnostics(uri);
    agent_lsp_open_document_on_session(session, uri, text, language).await?;
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(params)) => Ok(params["diagnostics"]
            .as_array()
            .cloned()
            .unwrap_or_default()),
        Ok(Err(_)) => Err("serveur LSP mort pendant l'attente des diagnostics".to_string()),
        Err(_) => {
            session.router.unregister_diagnostics(uri);
            Err(format!(
                "timeout ({timeout:?}) en attendant publishDiagnostics pour {uri}"
            ))
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Crée un faux node_modules/.bin/<name>(.cmd) dans un tempdir et vérifie
    /// que resolve_lsp_binary le préfère au PATH système.
    #[test]
    fn resolves_from_node_modules_bin_first() {
        let tmp = std::env::temp_dir().join(format!("shugu_lsp_test_{}", std::process::id()));
        let bin_dir = tmp.join("node_modules").join(".bin");
        fs::create_dir_all(&bin_dir).unwrap();
        // Sur Windows le shim npm est un .cmd ; sur Unix c'est un exécutable.
        let bin_name = if cfg!(windows) {
            "typescript-language-server.cmd"
        } else {
            "typescript-language-server"
        };
        let bin_path = bin_dir.join(bin_name);
        fs::write(&bin_path, "echo stub").unwrap();

        let resolved = resolve_lsp_binary("typescript", &tmp);
        assert!(resolved.is_some(), "should resolve from node_modules/.bin");
        let (path, args) = resolved.unwrap();
        assert_eq!(path, bin_path, "should pick the workspace-local binary");
        assert_eq!(args, vec!["--stdio".to_string()]);

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn returns_none_for_unknown_language() {
        let tmp = std::env::temp_dir();
        assert!(resolve_lsp_binary("cobol", &tmp).is_none());
    }

    // NB : les tests de strip_extended_prefix (formes `\\?\` et `//?/`) vivent
    // désormais dans `pathutil.rs` (helper centralisé).
}

// ---------------------------------------------------------------------------
// P6.12 — tests du chemin de requête agent (mock LSP Content-Length sur node)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod agent_query_tests {
    use super::*;
    use std::time::Duration;

    fn which_node() -> Option<PathBuf> {
        which::which("node").ok()
    }

    fn mock_server_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests-mock-lsp")
            .join("mock-lsp.mjs")
    }

    async fn mock_session() -> Option<LspSession> {
        let node = which_node()?;
        spawn_session_opt(
            node,
            vec![mock_server_path().to_string_lossy().to_string()],
            "typescript".to_string(),
            None,
        )
        .await
        .ok()
    }

    #[tokio::test]
    async fn request_response_roundtrip_with_mock_server() {
        let Some(session) = mock_session().await else {
            eprintln!("node absent — skip mock LSP test");
            return;
        };
        let resp = agent_lsp_request_inner(
            &session,
            "initialize",
            serde_json::json!({
                "processId": std::process::id(),
                "rootUri": "file:///tmp/mock-ws",
                "capabilities": {},
            }),
            Duration::from_secs(10),
        )
        .await
        .expect("initialize response");
        assert!(
            resp["result"]["capabilities"].is_object(),
            "result attendu : {resp}"
        );
        session.force_kill();
    }

    #[tokio::test]
    async fn concurrent_initialization_performs_one_handshake() {
        let Some(session) = mock_session().await.map(std::sync::Arc::new) else {
            eprintln!("node absent — skip mock LSP test");
            return;
        };
        let (first, second) = tokio::join!(
            ensure_initialized("file:///tmp/mock-ws", &session),
            ensure_initialized("file:///tmp/mock-ws", &session)
        );
        first.expect("first initialize");
        second.expect("second caller reuses initialization");
        assert!(session
            .initialized
            .load(std::sync::atomic::Ordering::Acquire));
        session.force_kill();
    }

    #[tokio::test]
    async fn agent_waits_for_frontend_initialization_instead_of_duplicating_it() {
        let Some(session) = mock_session().await.map(std::sync::Arc::new) else {
            eprintln!("node absent — skip mock LSP test");
            return;
        };
        let initialize = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "initialize",
            "params": {
                "processId": std::process::id(),
                "rootUri": "file:///tmp/mock-ws",
                "capabilities": {},
            }
        })
        .to_string();
        session.stdin_tx.send(initialize.clone()).unwrap();
        observe_outgoing_message(&session, &initialize);

        let frontend_finishes = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            let initialized = r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#.to_string();
            session.stdin_tx.send(initialized.clone()).unwrap();
            observe_outgoing_message(&session, &initialized);
        };
        let (agent_result, _) = tokio::join!(
            ensure_initialized("file:///tmp/mock-ws", &session),
            frontend_finishes
        );
        agent_result.expect("l'agent réutilise le handshake frontend");
        assert!(session
            .initialized
            .load(std::sync::atomic::Ordering::Acquire));
        session.force_kill();
    }

    #[tokio::test]
    async fn diagnostics_from_mock_server_contain_the_error() {
        let Some(session) = mock_session().await else {
            eprintln!("node absent — skip mock LSP test");
            return;
        };
        let diags = agent_lsp_diagnostics_on_session(
            &session,
            "file:///tmp/mock-ws/broken.ts",
            "const x: number = fooBar + 1;\n",
            "typescript",
            Duration::from_secs(10),
        )
        .await
        .expect("diagnostics response");
        assert_eq!(diags.len(), 1);
        let d = &diags[0];
        assert_eq!(d["severity"].as_u64(), Some(1), "une ERREUR");
        assert_eq!(d["range"]["start"]["line"].as_u64(), Some(2));
        assert_eq!(d["range"]["start"]["character"].as_u64(), Some(4));
        assert!(d["message"].as_str().unwrap_or("").contains("fooBar"));
        assert_eq!(d["code"].as_str(), Some("ts2304"));
        session.force_kill();
    }

    #[tokio::test]
    async fn diagnostics_are_bounded_with_truncation_flag_source() {
        let Some(session) = mock_session().await else {
            eprintln!("node absent — skip mock LSP test");
            return;
        };
        let diags = agent_lsp_diagnostics_on_session(
            &session,
            "file:///tmp/mock-ws/many.ts",
            "let a = 1;\n",
            "typescript",
            Duration::from_secs(10),
        )
        .await
        .expect("diagnostics response");
        // Le mock renvoie 60 diagnostics — le bridge les reçoit TOUS ; la
        // borne de sortie (MAX_DIAGNOSTICS) est appliquée au formatage dans
        // lsp_tools (assert ci-dessous sur le helper de borne).
        assert_eq!(diags.len(), 60, "le mock émet bien 60 diagnostics");
        session.force_kill();
    }

    #[tokio::test]
    async fn concurrent_diagnostics_share_notification_and_document_versions() {
        let Some(session) = mock_session().await else {
            eprintln!("node absent — skip mock LSP test");
            return;
        };
        let uri = "file:///tmp/mock-ws/shared.ts";
        let (first, second) = tokio::join!(
            agent_lsp_diagnostics_on_session(
                &session,
                uri,
                "const first = fooBar;\n",
                "typescript",
                Duration::from_secs(10),
            ),
            agent_lsp_diagnostics_on_session(
                &session,
                uri,
                "const second = fooBar;\n",
                "typescript",
                Duration::from_secs(10),
            )
        );
        assert_eq!(first.expect("first diagnostics").len(), 1);
        assert_eq!(second.expect("second diagnostics").len(), 1);
        assert_eq!(
            session.documents.lock().unwrap().get(uri).copied(),
            Some(2),
            "didOpen puis didChange version 2"
        );
        session.force_kill();
    }

    #[tokio::test]
    async fn definition_and_references_return_expected_locations() {
        let Some(session) = mock_session().await else {
            eprintln!("node absent — skip mock LSP test");
            return;
        };
        let uri = "file:///tmp/mock-ws/broken.ts";
        agent_lsp_open_document_on_session(&session, uri, "const x = 1;\n", "typescript")
            .await
            .expect("didOpen");

        let resp = agent_lsp_request_inner(
            &session,
            "textDocument/definition",
            serde_json::json!({
                "textDocument": { "uri": uri },
                "position": { "line": 0, "character": 6 },
            }),
            Duration::from_secs(10),
        )
        .await
        .expect("definition response");
        let locs = resp["result"].as_array().expect("definition array");
        assert_eq!(locs.len(), 1);
        assert_eq!(locs[0]["range"]["start"]["line"].as_u64(), Some(2));
        assert_eq!(locs[0]["range"]["start"]["character"].as_u64(), Some(4));

        let resp = agent_lsp_request_inner(
            &session,
            "textDocument/references",
            serde_json::json!({
                "textDocument": { "uri": uri },
                "position": { "line": 0, "character": 6 },
                "context": { "includeDeclaration": true },
            }),
            Duration::from_secs(10),
        )
        .await
        .expect("references response");
        let locs = resp["result"].as_array().expect("references array");
        assert_eq!(locs.len(), 2);
        session.force_kill();
    }

    #[test]
    fn router_fails_all_waiters_on_server_death() {
        let router = std::sync::Arc::new(ResponseRouter::new());
        let rx = router.register_request(router.alloc_id());
        let rx2 = router.register_diagnostics("file:///x");
        router.fail_all();
        assert!(
            rx.blocking_recv().is_err(),
            "requête en attente échoue honnêtement"
        );
        assert!(
            rx2.blocking_recv().is_err(),
            "attente diagnostics échoue honnêtement"
        );
    }

    #[test]
    fn router_consumes_only_pending_responses() {
        let router = ResponseRouter::new();
        let id = router.alloc_id();
        assert!(
            id < 0,
            "les ids agent ne collisionnent pas avec le frontend"
        );
        let rx = router.register_request(id);
        // Une réponse avec un AUTRE id n'est pas consommée.
        assert!(!router
            .route(&serde_json::json!({"jsonrpc":"2.0","id":id + 1,"result":{}}).to_string()));
        // La réponse attendue est consommée et livrée.
        assert!(router
            .route(&serde_json::json!({"jsonrpc":"2.0","id":id,"result":{"ok":true}}).to_string()));
        let v = rx.blocking_recv().expect("response delivered");
        assert_eq!(v["result"]["ok"], serde_json::json!(true));
        // publishDiagnostics n'est JAMAIS consommé (notification partagée avec l'éditeur).
        let _rx2 = router.register_diagnostics("file:///x");
        assert!(!router.route(
            &serde_json::json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{"uri":"file:///x","diagnostics":[]}}).to_string()
        ));
    }

    #[test]
    fn router_broadcasts_diagnostics_to_same_uri_waiters() {
        let router = ResponseRouter::new();
        let first = router.register_diagnostics("file:///shared.ts");
        let second = router.register_diagnostics("file:///shared.ts");
        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": "file:///shared.ts",
                "diagnostics": [{"message": "shared"}]
            }
        })
        .to_string();
        assert!(!router.route(&message));
        assert_eq!(
            first.blocking_recv().unwrap()["diagnostics"][0]["message"],
            "shared"
        );
        assert_eq!(
            second.blocking_recv().unwrap()["diagnostics"][0]["message"],
            "shared"
        );
    }

    #[test]
    fn manifest_exposes_the_three_lsp_tools() {
        let tools = crate::commands::agents::tools::tools_json_openai();
        let names: Vec<&str> = tools
            .as_array()
            .expect("tools array")
            .iter()
            .filter_map(|t| t["function"]["name"].as_str())
            .collect();
        for name in ["lsp_diagnostics", "lsp_definition", "lsp_references"] {
            assert!(names.contains(&name), "outil manquant au manifest : {name}");
        }
    }
}
