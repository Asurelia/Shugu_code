# =============================================================================
# Shugu Forge — llama.cpp sidecar provisioner (Windows x64)
# =============================================================================
#
# Downloads an official ggml-org/llama.cpp Windows release (CPU or Vulkan
# build), verifies its SHA256, and lays the files out under
# src-tauri/binaries/<variant>/ so Tauri can bundle them as a sidecar +
# runtime resources during `pnpm tauri build`.
#
# Dual-bundle layout produced (one folder per variant):
#
#   src-tauri/binaries/
#   ├── cpu/
#   │   ├── llama-server-cpu-x86_64-pc-windows-msvc.exe   <- externalBin entry
#   │   ├── runtime/*.dll                                  <- resources entry
#   │   └── checksum.txt
#   └── vulkan/
#       ├── llama-server-vulkan-x86_64-pc-windows-msvc.exe <- externalBin entry
#       ├── runtime/*.dll                                  <- resources entry
#       └── checksum.txt
#
# Variants:
#   * cpu     — works on every Windows x64 box (SSE4.2 baseline). The CPU
#               fallback ships in every release.
#   * vulkan  — accelerated for any GPU/iGPU from 2017+ (AMD/NVIDIA/Intel).
#               5-10× faster than cpu on typical hardware. Falls back to
#               CPU at runtime if no Vulkan device is present, but ship
#               the cpu variant too so the runtime decision is real.
#
# Usage:
#   .\scripts\fetch-llama-binary.ps1                  # default: -Variant cpu
#   .\scripts\fetch-llama-binary.ps1 -Variant vulkan
#   .\scripts\fetch-llama-binary.ps1 -Variant cpu -Version "b9500"
#   .\scripts\fetch-llama-binary.ps1 -Variant vulkan -Force
#
# After running:
#   1. Open src-tauri/binaries/<variant>/checksum.txt and cross-check the
#      SHA256 against https://github.com/ggml-org/llama.cpp/releases/tag/<Version>
#      (per-asset hashes are listed in the release body).
#   2. `pnpm tauri build` — Tauri now bundles both variants when present.
#
# Notes:
#   * Default version is pinned (see $DefaultVersion below). Bumping is a
#     deliberate, reviewable commit — never default to "latest" silently.
#   * Idempotent: re-running on the same version skips the download unless
#     -Force is passed.
#   * No tools required beyond PowerShell 5.1+ and .NET's built-in
#     System.IO.Compression.ZipFile (default on Windows 10/11).
# =============================================================================

[CmdletBinding()]
param(
    # Which build flavour to fetch.
    [ValidateSet("cpu", "vulkan")]
    [string]$Variant = "cpu",

    # ggml-org/llama.cpp release tag. Bump deliberately when you want a
    # newer build — never default to "latest", that defeats the whole
    # point of a reviewable supply chain.
    [string]$Version = "b9181",

    # Force re-download even if the sidecar already exists.
    [switch]$Force,

    # Skip the actual download — useful for dry-runs / CI smoke tests.
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# -----------------------------------------------------------------------------
# Paths (resolved relative to the repo root, regardless of where the script
# is invoked from). The script lives at `scripts/fetch-llama-binary.ps1`, so
# the repo root is its parent's parent.
# -----------------------------------------------------------------------------

$RepoRoot      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$VariantDir    = Join-Path $RepoRoot "src-tauri\binaries\$Variant"
$RuntimeDir    = Join-Path $VariantDir "runtime"
$ChecksumFile  = Join-Path $VariantDir "checksum.txt"
$SidecarTarget = Join-Path $VariantDir "llama-server-$Variant-x86_64-pc-windows-msvc.exe"

# Working directory for the download / extraction. Lives under %TEMP% so it
# never pollutes the repo even if the script crashes mid-way.
$WorkDir = Join-Path $env:TEMP "shugu-llama-fetch-$Variant-$Version"

# -----------------------------------------------------------------------------
# Upstream URL — ggml-org renamed from ggerganov in 2025 but the old URLs
# redirect. We use the canonical name here for clarity.
#
# Asset naming as of the b4500+ series:
#   llama-<version>-bin-win-cpu-x64.zip
#   llama-<version>-bin-win-vulkan-x64.zip
# -----------------------------------------------------------------------------

$AssetName  = "llama-$Version-bin-win-$Variant-x64.zip"
$AssetUrl   = "https://github.com/ggml-org/llama.cpp/releases/download/$Version/$AssetName"
$ZipPath    = Join-Path $WorkDir $AssetName
$ExtractDir = Join-Path $WorkDir "extract"

# -----------------------------------------------------------------------------
# Pre-flight
# -----------------------------------------------------------------------------

Write-Host ""
Write-Host "Shugu Forge - llama.cpp sidecar fetcher" -ForegroundColor Cyan
Write-Host "========================================"
Write-Host "Variant       : $Variant"
Write-Host "Version       : $Version"
Write-Host "Target sidecar: $SidecarTarget"
Write-Host "Runtime DLLs  : $RuntimeDir"
Write-Host ""

if ((Test-Path $SidecarTarget) -and -not $Force) {
    Write-Host "Sidecar already present. Pass -Force to re-fetch." -ForegroundColor Yellow
    Write-Host "  $SidecarTarget"
    exit 0
}

if ($DryRun) {
    Write-Host "[DRY-RUN] Would download $AssetUrl" -ForegroundColor Yellow
    Write-Host "[DRY-RUN] Would extract to $ExtractDir"
    Write-Host "[DRY-RUN] Would install to $VariantDir"
    exit 0
}

# Ensure target directories exist. Tauri's `externalBin` resolves relative
# to src-tauri/, so these paths matter for the bundle step.
New-Item -ItemType Directory -Force -Path $VariantDir | Out-Null
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $WorkDir    | Out-Null

# -----------------------------------------------------------------------------
# Download
# -----------------------------------------------------------------------------

Write-Host "Downloading $AssetUrl ..."
try {
    # Invoke-WebRequest follows redirects by default and shows a progress bar.
    # We disable the progress bar in non-interactive sessions to avoid the
    # huge slowdown it causes (PowerShell's progress UI is notoriously slow
    # on large file downloads — turning it off can speed downloads ~10x).
    $oldProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $AssetUrl -OutFile $ZipPath -UseBasicParsing
    $ProgressPreference = $oldProgress
} catch {
    Write-Error "Download failed: $_"
    exit 1
}

$zipSize = (Get-Item $ZipPath).Length
Write-Host ("  -> Downloaded {0:N1} MB" -f ($zipSize / 1MB)) -ForegroundColor Green

# -----------------------------------------------------------------------------
# SHA256 verification
#
# ggml-org publishes per-asset hashes in the release body on GitHub. We do
# NOT auto-fetch / compare against that page (one more network dependency
# and a parsing surface that breaks every time they reformat the markdown).
# Instead we compute the hash locally and write it to checksum.txt; the
# human review step is to cross-check that file against the release page
# the first time a new $Version is committed.
# -----------------------------------------------------------------------------

Write-Host "Computing SHA256 ..."
$hash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash
Write-Host "  -> $hash" -ForegroundColor Green

@"
# Shugu Forge — llama.cpp sidecar provenance ($Variant)
# Generated by scripts/fetch-llama-binary.ps1 — do not edit by hand.

variant  = $Variant
version  = $Version
asset    = $AssetName
url      = $AssetUrl
sha256   = $hash
fetched  = $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

# Cross-check this SHA256 against the per-asset hash published in the
# release body at:
#   https://github.com/ggml-org/llama.cpp/releases/tag/$Version
#
# If it does NOT match, DO NOT COMMIT the binaries — investigate the source
# of the divergence (compromised mirror, MITM, wrong build channel).
"@ | Out-File -FilePath $ChecksumFile -Encoding UTF8

# -----------------------------------------------------------------------------
# Extraction + installation
# -----------------------------------------------------------------------------

Write-Host "Extracting archive ..."
if (Test-Path $ExtractDir) { Remove-Item -Recurse -Force $ExtractDir }
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

# The archive flattens to a single directory inside (varies by version).
# Find llama-server.exe wherever it landed.
$llamaServerExe = Get-ChildItem -Path $ExtractDir -Filter "llama-server.exe" -Recurse | Select-Object -First 1
if (-not $llamaServerExe) {
    Write-Error "llama-server.exe not found inside $AssetName - has the archive layout changed?"
    exit 1
}
$llamaServerSourceDir = $llamaServerExe.DirectoryName

Write-Host "Installing llama-server.exe ..."
Copy-Item -Path $llamaServerExe.FullName -Destination $SidecarTarget -Force

# Copy ALL DLLs from the same dir into runtime/. Future llama.cpp builds may
# ship more (CUDA loaders, Vulkan extras, etc.) - we don't filter by name so
# the resource set stays in sync upstream-down without manual whitelist edits.
Write-Host "Installing runtime DLLs ..."
$dlls = Get-ChildItem -Path $llamaServerSourceDir -Filter "*.dll"
# Wipe runtime/ first so removed DLLs from a previous version don't linger.
Get-ChildItem -Path $RuntimeDir -Filter "*.dll" -ErrorAction SilentlyContinue | Remove-Item -Force
foreach ($dll in $dlls) {
    Copy-Item -Path $dll.FullName -Destination (Join-Path $RuntimeDir $dll.Name) -Force
    Write-Host "  -> $($dll.Name)" -ForegroundColor DarkGray
}

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------

$sidecarSize = (Get-Item $SidecarTarget).Length
$runtimeSize = (Get-ChildItem $RuntimeDir -Filter "*.dll" | Measure-Object Length -Sum).Sum

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ("  Sidecar: {0:N1} MB" -f ($sidecarSize / 1MB))
Write-Host ("  Runtime: {0:N1} MB ({1} DLLs)" -f ($runtimeSize / 1MB), $dlls.Count)
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Cross-check src-tauri/binaries/$Variant/checksum.txt against the release page."
Write-Host "  2. (If not done yet) fetch the OTHER variant too:"
$other = if ($Variant -eq "cpu") { "vulkan" } else { "cpu" }
Write-Host "       .\scripts\fetch-llama-binary.ps1 -Variant $other"
Write-Host "  3. Run ``pnpm tauri build`` - Tauri bundles both variants when present."
Write-Host "  4. Runtime picks the right variant via vulkan-1.dll detection in"
Write-Host "     src-tauri/src/commands/llama.rs (Backend enum + pick_backend)."
Write-Host ""
