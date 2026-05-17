// Shugu Forge — local llama-server lifecycle controller.
//
// Spawns / kills the `llama-server` binary with the correct flags for the
// chat backend to talk to (port 8090, OpenAI-compat protocol). Driven by
// buttons on the llama.cpp connection card.
//
// Design choices:
//
// * We use `tauri_plugin_shell::ShellExt` (NOT `std::process::Command`)
//   because its `.spawn()` gives us an async event stream we can listen to
//   for terminate / stderr surface, plus a `CommandChild` handle with a
//   clean `.kill()`. Note: dropping a CommandChild does NOT kill the child
//   — we MUST call `.kill()` explicitly. The app's RunEvent::Exit hook in
//   `lib.rs` takes care of this on shutdown; abnormal exits (panic,
//   process-kill) still leak the child and the probe-fallback in
//   `llama_status` is what surfaces leftover servers on next launch.
//
// * The Tauri shell plugin permissions in the capabilities file gate
//   webview-initiated spawns. We call from Rust directly, so no scope is
//   needed here — the permissions only matter if the frontend were to
//   `invoke` the shell plugin's `spawn` command.
//
// * Binary resolution priority (highest to lowest):
//     1. Explicit `binary` parameter (the user's "Binary path" override)
//     2. **Bundled sidecar** — `llama-server.exe` shipped with Shugu via
//        Tauri's `externalBin` config. This is the "zero-config" path:
//        every user has the binary the moment they install the app,
//        signed with the same chain as shugu.exe so Windows SmartScreen
//        and Mac Gatekeeper treat the pair as one trusted artifact.
//     3. PATH lookup via the `which` crate (devs with `winget install
//        ggml.llamacpp`, scoop, or a manual install)
//     4. Hard-coded fallback to the Docker Desktop inference binary
//        ($USERPROFILE\.docker\bin\inference\llama-server.exe) — last
//        resort, kept for safety even though it's unlikely to fire
//        once the sidecar is bundled.
//
// * Port choice: 8090 (NOT llama.cpp's conventional 8080) — dedicated to
//   Shugu so we never collide with another llama-server the user runs
//   for a separate project. Mirrored in src/lib/providers.ts.
//
// * Platform support today: Windows x64 only. The sidecar lookup is
//   gated on the target triple; on Mac / Linux we fall straight through
//   to PATH lookup (no sidecar, BYOL). When those platforms get their
//   own bundled binaries, add the corresponding triple-conditioned
//   `sidecar_path()` branch.
//
// * Restart semantics: `llama_start` always kills any previous child
//   before spawning a new one. The user can change the model in the UI
//   and just hit Start again; the contract is "Start makes the requested
//   model be the one currently running, full stop".

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use which::which;

// ───────────────────────────────────────────────────────────────────────
// Backend selection — CPU vs Vulkan
//
// Shugu ships TWO llama-server builds bundled side-by-side:
//   * `binaries/cpu/`     — CPU-only build, works on every Windows x64 box
//                           with SSE4.2 (i.e. essentially everything since 2010)
//   * `binaries/vulkan/`  — Vulkan-accelerated build, ~5-10× faster on any
//                           GPU/iGPU from 2017+ (NVIDIA / AMD / Intel iGPU)
//
// At runtime we pick the Vulkan build IFF `vulkan-1.dll` is loadable on this
// machine (== the Vulkan ICD is installed, which the GPU vendor driver
// provides on every modern install). Otherwise we fall back to CPU.
//
// The decision is cached for the process lifetime so we don't probe twice.
// The user can override via the `n_gpu_layers` arg of `llama_start` (set to
// 0 to force CPU even on a Vulkan-capable box — useful for debugging).
// ───────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    Cpu,
    Vulkan,
}

/// Returns true iff the Vulkan loader (`vulkan-1.dll`) can be opened on this
/// machine. The loader is shipped by every modern GPU driver on Windows
/// (AMD/NVIDIA/Intel), so a positive result effectively means "this box has
/// at least one Vulkan ICD". We don't enumerate physical devices here — if
/// the DLL loads but no device is present, llama-server itself will report
/// "no Vulkan device" and we'd just lose a second of startup; in practice
/// every machine with the loader also has at least one device.
///
/// Cached after the first call.
#[cfg(target_os = "windows")]
fn vulkan_available() -> bool {
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        // SAFETY: LoadLibraryW with a constant string is safe. We FreeLibrary
        // immediately because we only needed to know whether the load
        // succeeds — keeping the handle would needlessly tie up the ICD's
        // initialization state for the whole process.
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = OsStr::new("vulkan-1.dll").encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            #[link(name = "kernel32")]
            extern "system" {
                fn LoadLibraryW(lp_lib_file_name: *const u16) -> *mut std::ffi::c_void;
                fn FreeLibrary(h_lib_module: *mut std::ffi::c_void) -> i32;
            }
            let h = LoadLibraryW(wide.as_ptr());
            if h.is_null() {
                false
            } else {
                FreeLibrary(h);
                true
            }
        }
    })
}

#[cfg(not(target_os = "windows"))]
fn vulkan_available() -> bool {
    // Mac/Linux: not wired yet. Always CPU.
    false
}

fn pick_backend(user_override: Option<&str>) -> Backend {
    match user_override {
        Some("cpu")     => Backend::Cpu,
        Some("vulkan")  => Backend::Vulkan,
        Some("auto") | None | Some(_) => {
            if vulkan_available() { Backend::Vulkan } else { Backend::Cpu }
        }
    }
}

/// Tauri-managed app state for the single llama-server child we keep alive.
/// `Mutex<Option<_>>` because at any moment we either have a running child
/// or we don't; concurrent commands serialize on the mutex.
#[derive(Default)]
pub struct LlamaServerState(pub Mutex<Option<CommandChild>>);

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaStatus {
    /// True iff a child is currently running and hasn't exited yet.
    pub running: bool,
    /// OS process id when running, None otherwise.
    pub pid: Option<u32>,
    /// Resolved binary path Tauri actually spawned. Useful for the UI to
    /// confirm "yes, we found the binary, here is where" — purely advisory.
    pub binary: Option<String>,
}

fn resolve_binary(user_path: Option<&str>, backend: Backend) -> Result<PathBuf, String> {
    // 1) Explicit override from the UI — wins over everything else so the
    //    user can pin a specific build (CUDA, debug, custom flags) without
    //    Shugu silently preferring its bundled sidecar.
    if let Some(p) = user_path {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            let pb = PathBuf::from(trimmed);
            if pb.is_file() {
                return Ok(pb);
            }
            return Err(format!("binary path does not exist: {}", trimmed));
        }
    }

    // 2) Bundled Tauri sidecar for the requested backend (cpu/vulkan).
    if let Some(sidecar) = sidecar_path(backend) {
        return Ok(sidecar);
    }

    // 2b) If we wanted Vulkan but it isn't bundled, transparently fall back
    //     to the CPU sidecar. This makes the dual-bundle layout robust to
    //     dev installs where only the CPU variant has been provisioned via
    //     `scripts/fetch-llama-binary.ps1`.
    if backend == Backend::Vulkan {
        if let Some(sidecar) = sidecar_path(Backend::Cpu) {
            eprintln!("[backend] Vulkan binary not bundled — falling back to CPU sidecar");
            return Ok(sidecar);
        }
    }

    // 3) PATH lookup (winget install, scoop, manual install). Useful for
    //    devs running `pnpm tauri dev` without having dropped a sidecar
    //    into src-tauri/binaries/ yet, and for users who want to override
    //    the bundled version with a newer/different llama.cpp build by
    //    putting it on PATH.
    if let Ok(p) = which("llama-server") {
        return Ok(p);
    }

    // 4) Docker Desktop fallback — last resort, the binary itself is fine
    //    to invoke directly even if the user doesn't want a Docker-based
    //    workflow.
    if let Ok(home) = std::env::var("USERPROFILE") {
        let candidate = PathBuf::from(home)
            .join(".docker")
            .join("bin")
            .join("inference")
            .join("llama-server.exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err(
        "llama-server introuvable. Le binaire sidecar devrait \u{00ea}tre fourni par \
         Shugu (voir src-tauri/binaries/README.md). En d\u{00e9}veloppement, installe \
         llama.cpp via `winget install --id ggml.llamacpp` ou renseigne un chemin \
         absolu dans le champ 'Binary'."
            .into(),
    )
}

/// Ensure the llama-server runtime DLLs are next to the sidecar binary
/// before we attempt to spawn it.
///
/// Why this exists: Tauri 2 declares the sidecar as `externalBin` (copied
/// next to the main exe automatically) and the DLLs as `resources` (copied
/// into a *separate* resource directory). On Windows, the PE loader looks
/// for dependent DLLs in the same directory as the loaded `.exe` — so the
/// resource-directory split breaks `llama-server.exe` at load time. This
/// is a real footgun in `pnpm tauri dev` where Tauri doesn't copy
/// resources at all.
///
/// We fix it once per spawn: if any of the expected `.dll` files are
/// missing next to the sidecar, copy them from the resource dir.
/// Idempotent — files already present are skipped via length-equality
/// (cheap O(1) stat check, no hashing). The first spawn after a fresh
/// `cargo clean` carries the ~30 MB copy cost; subsequent restarts are
/// nearly free.
fn ensure_sidecar_dlls(sidecar: &std::path::Path, app: &tauri::AppHandle, backend: Backend) {
    let target_dir = match sidecar.parent() {
        Some(p) => p,
        None => return,
    };

    let variant = match backend {
        Backend::Cpu => "cpu",
        Backend::Vulkan => "vulkan",
    };

    // Three candidate source paths, tried in order:
    //   1. Tauri resource_dir (release bundle): typically ends with
    //      `<app_dir>/resources/`; the DLLs live in
    //      `resources/_up_/binaries/<variant>/runtime/` because the resource glob
    //      `binaries/<variant>/runtime/*` is relative to src-tauri/ and Tauri
    //      mirrors that structure under `_up_`.
    //   2. CARGO_MANIFEST_DIR + `binaries/<variant>/runtime/` (dev mode
    //      fallback, compiled into the binary at build time).
    //   3. Legacy flat layout `binaries/runtime/` — kept so a freshly cloned
    //      tree that still has the pre-dual layout (or only ran the legacy
    //      fetch script) still boots.
    let mut sources: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        sources.push(res.join("_up_").join("binaries").join(variant).join("runtime"));
        sources.push(res.join("binaries").join(variant).join("runtime"));
        // Legacy
        sources.push(res.join("_up_").join("binaries").join("runtime"));
        sources.push(res.join("binaries").join("runtime"));
    }
    // `env!("CARGO_MANIFEST_DIR")` resolves at compile time to the path
    // of `src-tauri/` on the build machine. For a development build run
    // from the same machine, that's the canonical source.
    sources.push(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(variant)
            .join("runtime"),
    );
    sources.push(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("runtime"),
    );

    let runtime_dir = match sources.into_iter().find(|p| p.is_dir()) {
        Some(d) => d,
        None => {
            eprintln!(
                "[sidecar] no runtime DLL source dir found; sidecar may fail to start"
            );
            return;
        }
    };

    let entries = match std::fs::read_dir(&runtime_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut copied = 0u32;
    let mut skipped = 0u32;
    for entry in entries.flatten() {
        let src = entry.path();
        if src.extension().and_then(|e| e.to_str()) != Some("dll") {
            continue;
        }
        let name = match src.file_name() {
            Some(n) => n,
            None => continue,
        };
        let dst = target_dir.join(name);
        // Skip if same size already in place — cheap idempotency check.
        if let (Ok(s), Ok(d)) = (std::fs::metadata(&src), std::fs::metadata(&dst)) {
            if s.len() == d.len() {
                skipped += 1;
                continue;
            }
        }
        match std::fs::copy(&src, &dst) {
            Ok(_) => copied += 1,
            Err(e) => eprintln!("[sidecar] copy {} failed: {e}", name.to_string_lossy()),
        }
    }
    if copied > 0 {
        eprintln!(
            "[sidecar] staged {copied} DLL(s) next to llama-server.exe (skipped {skipped} already-present)"
        );
    }
}

/// Look up the bundled `llama-server.exe` sidecar shipped by Tauri.
///
/// In release builds (the path that matters for end users), Tauri 2 copies
/// every `bundle.externalBin` entry next to the main app executable and
/// strips the target-triple suffix — so we look for a plain
/// `llama-server.exe` sibling of the current Shugu executable.
///
/// In `pnpm tauri dev`, Tauri does NOT rename the binary — it keeps the
/// triple-suffixed name as authored in `src-tauri/binaries/`. We check that
/// secondary path too so devs can iterate on the dev loop without copying
/// the binary by hand.
///
/// Returns None if neither candidate is present (e.g. dev mode with no
/// sidecar in place yet, or a platform we don't ship a binary for). The
/// caller falls through to PATH lookup in that case.
fn sidecar_path(backend: Backend) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let parent = exe.parent()?.to_path_buf();
    let variant = match backend {
        Backend::Cpu => "cpu",
        Backend::Vulkan => "vulkan",
    };

    // Release / installer layout (dual-bundle, NEW): each externalBin entry
    // is renamed to its bare name. Both `llama-server-cpu.exe` and
    // `llama-server-vulkan.exe` end up next to the main app exe.
    let release_path = parent.join(format!("llama-server-{variant}.exe"));
    if release_path.is_file() {
        return Some(release_path);
    }

    // Dev layout (NEW dual-bundle): triple-suffixed binary kept verbatim
    // inside `binaries/<variant>/`. We resolve it via the cargo manifest
    // dir at compile time, then check it exists at runtime.
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(variant)
            .join(format!("llama-server-{variant}-x86_64-pc-windows-msvc.exe"));
        if dev_path.is_file() {
            return Some(dev_path);
        }
    }

    // Legacy single-bundle layout fallback (pre dual-bundle migration):
    // `llama-server.exe` next to the main exe in release, or the unsuffixed
    // triple binary in `binaries/`. Kept so a partially-migrated checkout
    // doesn't immediately break.
    if backend == Backend::Cpu {
        let legacy_release = parent.join("llama-server.exe");
        if legacy_release.is_file() {
            return Some(legacy_release);
        }
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            let legacy_dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join("llama-server-x86_64-pc-windows-msvc.exe");
            if legacy_dev.is_file() {
                return Some(legacy_dev);
            }
        }
    }

    None
}

/// Internal helper: shared spawn logic used by both `llama_start` (UI-driven)
/// and `llama_autostart` (boot-driven). Accepts either a local file path
/// OR an HF repo id — exactly one of the two MUST be provided.
///
/// State is fetched via `app.state()` inside the function so we don't need
/// a `State<'_>` parameter that ties us to the Tauri command lifetime —
/// callers from other Rust modules (the boot hook) can invoke this freely.
async fn do_start(
    app: tauri::AppHandle,
    binary: Option<String>,
    hf_model: Option<String>,
    model_path: Option<String>,
    ctx: Option<u32>,
    port: Option<u16>,
    backend_override: Option<String>,
    n_gpu_layers: Option<i32>,
) -> Result<LlamaStatus, String> {
    // Drop any existing child first. We do this BEFORE resolving the new
    // binary so a bad new path doesn't leave us with a dangling running
    // process and no UI confirmation.
    let state = app.state::<LlamaServerState>();
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }

    let backend = pick_backend(backend_override.as_deref());
    let bin = resolve_binary(binary.as_deref(), backend)?;
    // 8090 (NOT 8080): Shugu-dedicated port. Avoids stomping on a separate
    // llama-server the user may run elsewhere. Kept overridable via the
    // command arg for future "advanced settings" — must stay in sync with
    // src/lib/providers.ts and the probe URL in `probe_llama_endpoint`.
    let port = port.unwrap_or(8090);
    // Default context size — 8192 is the new sweet spot for chat with
    // thinking-enabled models (Qwen 3.5, DeepSeek-R1):
    //   * Qwen 3 burns 1500-3000 tokens of `<think>` content even on
    //     casual prompts ("ça va ?"). With ctx=4096 + a few turns of
    //     history, the reasoning overflows before the model can emit
    //     the visible answer → empty response, only `<think>` visible.
    //   * 8192 doubles the budget so most thinking fits with room for
    //     the answer + a few prior turns.
    //   * On Vulkan/GPU the extra KV-cache is ~32 MB more on 2B Q4 —
    //     negligible against 16 GB VRAM. On CPU it's the same delta.
    //   * Users who want short replies should toggle thinking OFF in
    //     Settings rather than crank ctx higher (cheaper + more reliable
    //     than betting on context budget).
    // The previous 32k default was a performance trap on CPU — KV-cache
    // alone allocated ~250 MB on a 2B model, and every token iteration
    // touched it. 8k is a balanced sweet spot for both backends.
    let ctx = ctx.unwrap_or(8192);
    // GPU layer offload. On the Vulkan path we offload everything (99 is
    // llama-server's "all layers" idiom, internally clamped to model depth).
    // On the CPU path it stays at 0 — the flag is still passed because that
    // makes the picture deterministic across both binaries.
    let ngl = match (backend, n_gpu_layers) {
        (Backend::Vulkan, None)        => 99,
        (Backend::Cpu, None)           => 0,
        (_, Some(n)) if n < 0          => 0,
        (_, Some(n))                   => n,
    };

    // Resolve which model the user wants. Local path wins over hf_model
    // when both are provided — the local file is already on disk, so
    // there's no reason to ask llama-server to re-fetch from HF.
    let path_str = model_path
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let hf_str = hf_model
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let (model_flag, model_value): (&str, String) = match (path_str, hf_str) {
        (Some(p), _) => ("-m", p),
        (None, Some(h)) => ("-hf", h),
        (None, None) => {
            return Err(
                "either modelPath or hfModel must be provided (got neither)".into(),
            )
        }
    };

    // Ensure runtime DLLs are next to the sidecar. No-op for an external
    // binary (PATH / user-override / Docker) but critical for the bundled
    // sidecar — without this, llama-server.exe fails to load `ggml.dll`
    // and the spawn dies silently in `pnpm tauri dev` mode.
    ensure_sidecar_dlls(&bin, &app, backend);

    let bin_display = bin.to_string_lossy().into_owned();
    let port_str = port.to_string();
    let ctx_str = ctx.to_string();
    let ngl_str = ngl.to_string();

    eprintln!(
        "[llama] starting backend={:?} ngl={ngl} ctx={ctx} port={port} bin={bin_display}",
        backend
    );

    // tauri_plugin_shell::Command — sidecar-style API but for an external
    // binary specified by absolute path. Flag rationale below.
    //
    // FLAG NOTES (every one of these was a measured win on the smoke-test
    // box — RX 7800 XT, i5-12600K, Qwen 3.5 2B Q4_K_M):
    //
    //   `-fit off` — DISABLES llama.cpp's "auto-fit params to device memory"
    //      heuristic. With auto-fit on, `-ngl 99` is treated as a hint that
    //      the heuristic may silently override — observed in practice as
    //      llama-server reporting "Vulkan device found" but pinning 0
    //      layers to GPU because auto-fit decided the prompt cache + KV
    //      cache wouldn't all fit alongside the weights. Turning auto-fit
    //      off makes `-ngl 99` mean exactly what it says.
    //
    //   `--parallel 1` — single inference slot. Shugu is a single-user
    //      desktop app; multi-slot would split the KV cache N ways and
    //      mostly waste memory. Default is N=4 which hurts perf on small
    //      models.
    //
    //   `--cache-ram 0` — disables llama-server's 8 GB on-disk prompt
    //      cache (introduced in PR #16391). Our chat layer already
    //      replays the full conversation history from SQLite on every
    //      send (see chat-sync.ts `sendChatMessage`), so the upstream
    //      cache duplicates work AND inflates the auto-fit heuristic's
    //      memory budget, pushing layers off the GPU.
    //
    //   `--mlock` — keeps model weights resident in RAM (CPU path) and
    //      pins any KV cache that stays on CPU (Vulkan partial-offload
    //      edge case). Without it, Windows can page mmap'd weights back
    //      to disk under memory pressure → multi-second freezes mid-gen.
    //
    //   We deliberately do NOT pass `--chat-template <preset>` — it
    //      breaks any GGUF that embeds its own template (Gemma 4 was the
    //      regression that proved this). Always trust the file's template.
    // `--reasoning-format deepseek` is explicit even though `auto` (default)
    // detects it correctly for Qwen 3.5 / DeepSeek-R1 / Llama-3.3-Reasoning.
    // Being explicit means the OpenAI-compat stream's `delta.reasoning_content`
    // field is guaranteed to carry `<think>...</think>` text (chat.rs picks
    // that up and broadcasts kind:"reasoning" deltas to the UI). If we left
    // it on `auto` and a future template variant slipped through with the
    // legacy in-content format, the UI would silently fall back to the old
    // "pavé" behaviour where reasoning isn't visually separated.
    let (mut rx, child) = app
        .shell()
        .command(&bin_display)
        .args([
            model_flag,
            &model_value,
            "-c",
            &ctx_str,
            "-ngl",
            &ngl_str,
            "-fit",
            "off",
            "--parallel",
            "1",
            "--cache-ram",
            "0",
            "--mlock",
            "--reasoning-format",
            "deepseek",
            "--host",
            "127.0.0.1",
            "--port",
            &port_str,
        ])
        .spawn()
        .map_err(|e| format!("failed to spawn llama-server: {e}"))?;

    let pid = child.pid();
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    // Drain the receiver in the background so the OS pipe buffers don't fill
    // up (which would deadlock llama-server on its own stdout/stderr writes).
    // We don't surface the lines to the UI for now — the user has llama-server
    // logs in their own terminal anyway. A future enhancement could emit
    // Tauri events here for a "server console" panel.
    tauri::async_runtime::spawn(async move {
        while let Some(_event) = rx.recv().await {
            // Intentionally drop. The receiver MUST be polled or the spawn
            // pipe becomes a slow-write hazard for the child process.
        }
    });

    // Readiness probe + broadcast.
    //
    // llama-server's HTTP listener comes up BEFORE the model is fully loaded
    // — for Qwen 3.5 2B Q4 + Vulkan that's typically 1-3 s of mmap + GPU
    // weight upload. If the frontend's model discovery fires during that
    // window, the fetch to `/v1/models` returns connection-refused (or
    // hangs), the discovery records an error, and the picker stays empty
    // until something else triggers a refresh — at which point the user
    // sees the bug "I had to open the picker, click refresh, then the model
    // appeared".
    //
    // We fix this by polling /v1/models in the background after spawn and
    // emitting `llama://ready` exactly once when it succeeds. The frontend
    // `useDiscoveredModels` listens for this event and invalidates its
    // cache, so the picker populates on its own as soon as llama-server is
    // actually serving — no user interaction required.
    //
    // 90 s overall budget: a cold-cache load of a 1.3 GB GGUF over a slow
    // disk can hit ~30 s; doubled for safety. Beyond that, treat as a
    // permanent failure and stop polling — the chat layer surfaces the
    // problem the next time the user sends a message.
    let port_for_probe = port;
    let app_for_probe = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
        while std::time::Instant::now() < deadline {
            if probe_llama_endpoint_on_port(port_for_probe).await {
                eprintln!("[llama] server ready on port {port_for_probe}; emitting llama://ready");
                let _ = app_for_probe.emit("llama://ready", port_for_probe);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        eprintln!("[llama] readiness probe timed out after 90s — server may be wedged");
    });

    Ok(LlamaStatus {
        running: true,
        pid: Some(pid),
        binary: Some(bin_display),
    })
}

/// Spawn (or restart) llama-server with the recommended flags.
///
/// Idempotent on restart: if a child is already running it is killed first,
/// then we spawn fresh with whatever model the user passed in. The "I want
/// llama-server to be running THIS model" contract is preserved across the
/// `-hf` / `-m` axis — exactly one of `hfModel` / `modelPath` must be
/// non-empty (defaults flow from the UI to whichever the user configured).
#[tauri::command]
pub async fn llama_start(
    app: tauri::AppHandle,
    _state: State<'_, LlamaServerState>,
    binary: Option<String>,
    hf_model: Option<String>,
    model_path: Option<String>,
    ctx: Option<u32>,
    port: Option<u16>,
    backend: Option<String>,
    n_gpu_layers: Option<i32>,
) -> Result<LlamaStatus, String> {
    // State<'_> is kept in the signature purely so the frontend's existing
    // invoke shape stays compatible (Tauri's command resolver doesn't mind
    // extra refs). The actual mutex access happens inside `do_start` via
    // app.state() so the boot-time autostart path can share the impl.
    //
    // `backend` accepts "auto" (default — Vulkan when available, else CPU),
    // "cpu", or "vulkan". Anything else is treated as "auto".
    do_start(app, binary, hf_model, model_path, ctx, port, backend, n_gpu_layers).await
}

/// Boot-time helper: if the default bundle model is installed on disk,
/// spawn llama-server pointing at it. Idempotent — calling it a second
/// time with the same model is a no-op (the spawn would be redundant);
/// calling it with a different model would restart, which is not what
/// we want during boot, so we early-return if the server is already
/// running.
///
/// Used by `lib.rs::setup()` to deliver the "zero-config, ready the moment
/// the app launches" experience. Failures are logged and swallowed — the
/// onboarding overlay handles the missing-model case from the frontend
/// side.
#[tauri::command]
pub async fn llama_autostart(app: tauri::AppHandle) -> Result<LlamaStatus, String> {
    // If a server is already running (either spawned by a previous call or
    // detected externally), don't disrupt it. The user might be in the
    // middle of a chat.
    let state = app.state::<LlamaServerState>();
    let already_owned = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.is_some()
    };
    if already_owned {
        return llama_status(state).await;
    }

    // Nothing owned — does an external server hold the port? If yes, leave
    // it alone (the user may have started one manually).
    if probe_llama_endpoint().await {
        return Ok(LlamaStatus { running: true, pid: None, binary: None });
    }

    // No server anywhere AND the default bundle is installed → fire it up.
    if !crate::commands::model_bundle::default_model_installed(&app) {
        return Ok(LlamaStatus { running: false, pid: None, binary: None });
    }
    let path = crate::commands::model_bundle::default_model_path(&app)
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no default bundle model path".to_string())?;

    do_start(app, None, None, Some(path), None, None, None, None).await
}

/// Cheap "what would `llama_start` pick on this box?" probe — returns the
/// auto-detected backend without spawning anything. Used by the Settings
/// UI to display "Detected: Vulkan ✓" vs "Detected: CPU only" so the user
/// understands why their selected mode is what it is.
#[tauri::command]
pub fn llama_backend_info() -> BackendInfo {
    BackendInfo {
        vulkan_available: vulkan_available(),
        auto_pick: if vulkan_available() { "vulkan" } else { "cpu" }.to_string(),
    }
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub vulkan_available: bool,
    pub auto_pick: String,
}

/// Kill the running llama-server child. Idempotent — returns ok even if
/// nothing was running.
#[tauri::command]
pub fn llama_stop(state: State<'_, LlamaServerState>) -> Result<LlamaStatus, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
    Ok(LlamaStatus { running: false, pid: None, binary: None })
}

/// Hard-kill ALL `llama-server.exe` processes on the system (Windows-only).
/// Surfaces in the UI as the "Force stop external" button — used when
/// `llama_status` reports `running:true` with `pid:None`, meaning the HTTP
/// probe found a server we don't own (orphan from a prior session whose
/// cleanup hook didn't fire, or another tool's instance). Bluntly kills by
/// image name; the trade-off is "may also kill an unrelated llama-server
/// the user wanted alive" — acceptable for the one-button UX vs the
/// alternative of parsing `netstat -ano` for the port-8090 PID.
#[tauri::command]
pub async fn llama_force_stop_external(app: tauri::AppHandle) -> Result<LlamaStatus, String> {
    #[cfg(target_os = "windows")]
    {
        // Use the shell plugin so we go through the same Tauri process
        // tracking infrastructure as llama_start. Async output to keep the
        // UI responsive even if taskkill takes a moment.
        let output = app
            .shell()
            .command("taskkill")
            .args(["/F", "/IM", "llama-server.exe"])
            .output()
            .await
            .map_err(|e| format!("taskkill spawn failed: {e}"))?;
        // taskkill exits 128 ("process not found") when nothing matched —
        // that's a SUCCESS from our point of view ("ensure none running").
        if !output.status.success() && !matches!(output.status.code(), Some(128)) {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("taskkill failed: {}", stderr.trim()));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app
            .shell()
            .command("pkill")
            .args(["-f", "llama-server"])
            .output()
            .await;
    }
    // Give the OS a beat to release the port, then re-probe so the UI
    // reflects reality immediately instead of waiting for the next 2s poll.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let still_running = probe_llama_endpoint().await;
    Ok(LlamaStatus { running: still_running, pid: None, binary: None })
}

/// Snapshot current llama-server status. Two-tier detection:
///
///   1. Owned child handle — if the app spawned llama-server itself, the
///      CommandChild is in `state.0`. This is the fast path (no IO).
///   2. HTTP probe on 127.0.0.1:8090/v1/models — when there's no owned
///      handle, the server may still be running EXTERNALLY: started from a
///      terminal, left over from a previous app session whose state we lost
///      on relaunch, or spawned by another tool. The previous one-tier
///      implementation would report `stopped` in those cases even though
///      chat requests against the same endpoint were succeeding, which is
///      exactly what just confused a user staring at "Server stopped" while
///      the chibi happily replied.
///
/// When we detect a detached server (HTTP probe ok, no owned child) we
/// return `running: true` with `pid: None` — the UI uses the missing pid
/// as a signal to hide the Stop button (we can't kill what we don't own)
/// and to grey out Restart.
///
/// 250 ms timeout keeps the 2s UI polling responsive even when nothing
/// is on the port.
#[tauri::command]
pub async fn llama_status(state: State<'_, LlamaServerState>) -> Result<LlamaStatus, String> {
    // Scope the mutex lock so the guard is dropped BEFORE any await — std's
    // Mutex isn't Send-safe across await points and we don't need it held
    // while we do IO anyway.
    let owned_pid: Option<u32> = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.as_ref().map(|c| c.pid())
    };

    if let Some(pid) = owned_pid {
        return Ok(LlamaStatus { running: true, pid: Some(pid), binary: None });
    }

    let detached_running = probe_llama_endpoint().await;
    Ok(LlamaStatus { running: detached_running, pid: None, binary: None })
}

/// Best-effort GET against the standard llama-server endpoint. Returns true
/// iff the server responds with a 2xx within 250 ms. Any error (DNS,
/// connection refused, timeout, non-2xx) counts as "not running".
async fn probe_llama_endpoint() -> bool {
    probe_llama_endpoint_on_port(8090).await
}

/// Variant that targets an explicit port — used by the readiness poller so
/// it follows whatever `--port` the spawn was actually configured with
/// (today always 8090, but a future "advanced settings" override would
/// otherwise leave the readiness signal pointing at the wrong port).
async fn probe_llama_endpoint_on_port(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(250))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let url = format!("http://127.0.0.1:{port}/v1/models");
    match client.get(&url).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}
