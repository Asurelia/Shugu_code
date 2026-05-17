# `src-tauri/binaries/` — dual-bundle llama.cpp sidecars

Shugu Forge ships **two** `llama-server` builds side-by-side so the installed
app picks the fast backend on capable hardware and gracefully falls back to
pure CPU everywhere else. The runtime decision is made by
`pick_backend()` in [`../src/commands/llama.rs`](../src/commands/llama.rs):
if `vulkan-1.dll` loads on the user's machine (every modern GPU/iGPU driver
ships it), the Vulkan binary runs with `-ngl 99` — typically **5-10× faster**
than CPU. Otherwise the CPU binary runs unchanged.

## Layout

```
binaries/
├── cpu/
│   ├── llama-server-cpu-x86_64-pc-windows-msvc.exe   ← externalBin entry
│   ├── runtime/                                       ← resources entry
│   │   ├── ggml.dll
│   │   ├── ggml-cpu-*.dll       (many SIMD variants)
│   │   ├── llama.dll
│   │   └── ...
│   └── checksum.txt                                   ← provenance + SHA256
└── vulkan/
    ├── llama-server-vulkan-x86_64-pc-windows-msvc.exe ← externalBin entry
    ├── runtime/                                       ← resources entry
    │   ├── ggml-vulkan.dll      (Vulkan backend)
    │   ├── ggml-cpu-*.dll       (fallback DLLs, same as CPU bundle)
    │   ├── llama.dll
    │   └── ...
    └── checksum.txt
```

The two halves are declared in `src-tauri/tauri.conf.json`:

```json
"externalBin": [
  "binaries/cpu/llama-server-cpu",
  "binaries/vulkan/llama-server-vulkan"
],
"resources": [
  "binaries/cpu/runtime/*",
  "binaries/vulkan/runtime/*"
]
```

In release builds Tauri renames each externalBin to its bare suffix-stripped
name and copies it next to `Shugu Forge.exe`:
`llama-server-cpu.exe` and `llama-server-vulkan.exe`. The `resources` glob
preserves the relative path, so DLLs land at
`<app_dir>/resources/_up_/binaries/<variant>/runtime/*.dll` and the Rust
sidecar staging logic (`ensure_sidecar_dlls`) copies them next to the
selected variant before spawn.

## How to populate this folder

The binaries are **not committed** to the repo (they're large, machine-
specific, and version-bound). Run the provisioning script TWICE from the
repo root — once per variant:

```powershell
pwsh -File .\scripts\fetch-llama-binary.ps1 -Variant cpu
pwsh -File .\scripts\fetch-llama-binary.ps1 -Variant vulkan
```

Each invocation downloads the pinned release from `ggml-org/llama.cpp`,
verifies its SHA256, and lays out files under `binaries/<variant>/`.
Pass `-Version <tag>` to fetch a different release; pass `-Force` to
re-fetch when one already exists.

After each run, cross-check `binaries/<variant>/checksum.txt` against the
per-asset hash published on the release page. Only commit a bumped
version once the hashes match.

## Picking just one variant

If you really want a CPU-only installer (smaller download, slightly faster
build), you can skip the Vulkan fetch and remove the `binaries/vulkan/...`
entries from `tauri.conf.json`. The runtime resolver in `llama.rs` already
falls back from Vulkan to CPU when the Vulkan binary is missing (logged via
`[backend] Vulkan binary not bundled — falling back to CPU sidecar`), but
keeping the conf entries in sync with the disk layout is the cleanest
contract.

## Why this isn't auto-downloaded at runtime

We could fetch the binaries on the user's first launch instead of bundling
them. We chose to bundle because:

- **Zero-config dès l'install** — no second download, no firewall pop-up,
  no antivirus drama (the sidecars are signed with the same chain as
  `shugu.exe` during `pnpm tauri build`).
- **Reviewable supply chain** — the version, URL, and SHA256 live in
  source control. A drift in the upstream release would show up in a PR
  diff, not in a silent runtime download.
- **Works offline after install** — corporate networks, locked-down dev
  machines, or anywhere `https://github.com/ggml-org/...` is blocked.

The GGUF model file is a different story — too large to bundle, downloaded
at first launch with progress UI (see `src/features/onboarding/`).

## Backend detection details

`pick_backend()` in `llama.rs` calls `vulkan_available()` which probes
`vulkan-1.dll` via `LoadLibraryW`. A successful load means the Vulkan
loader is installed (every modern GPU vendor driver ships it). The
function is `OnceLock`-cached so the cost is paid once per process.

If you want to force CPU on a Vulkan-capable box (debugging, comparing
generation determinism, sharing VRAM with another process), pass
`backend: "cpu"` to the `llama_start` Tauri command — that takes priority
over auto-detection. Same for forcing Vulkan: `backend: "vulkan"`.

The Settings UI exposes this via the llama.cpp connection card (radio:
Auto / CPU / Vulkan).

## Platforms

Currently we ship sidecars for **Windows x64 only**. When Mac / Linux
support comes:

- Mirror the dual layout under their own triple-suffixed names:
  - `cpu/llama-server-cpu-aarch64-apple-darwin`
  - `vulkan/llama-server-vulkan-aarch64-apple-darwin` (Mac → MoltenVK)
  - `cpu/llama-server-cpu-x86_64-unknown-linux-gnu`
  - `vulkan/llama-server-vulkan-x86_64-unknown-linux-gnu`
- Extend `sidecar_path()` in `llama.rs` with `#[cfg(target_os = "...")]`
  branches.
- Update `scripts/fetch-llama-binary.ps1` (or fork it as a shell script
  per platform — bash + curl + unzip is straightforward).

The `resolve_binary()` priority chain in `llama.rs` is the single source
of truth for which binary wins on a given machine. Sidecar > PATH >
Docker fallback.

## License / attribution

`llama-server.exe` is built from [`ggml-org/llama.cpp`](https://github.com/ggml-org/llama.cpp)
which is **MIT-licensed**. We ship the binaries unmodified. Include the
upstream LICENSE text in Shugu's About / Credits panel (TODO).
