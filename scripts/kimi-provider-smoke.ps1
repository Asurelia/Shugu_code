param(
  [string]$ProviderId = "custom-1784812982217",
  [string]$Model = "k3",
  [string]$BinaryPath = "",
  [string]$ExistingWorkspace = "",
  [int]$StartupTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

function Stop-OwnedProcessTree([int]$TargetProcessId) {
  if (-not (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) { return }
  Start-Process -FilePath "taskkill.exe" `
    -ArgumentList @("/PID", "$TargetProcessId", "/T", "/F") `
    -WindowStyle Hidden `
    -Wait | Out-Null
}

if (-not ("ShuguSmokeWindow" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ShuguSmokeWindow {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hWnd, int command);

  public static void HideForProcess(int processId) {
    EnumWindows((hWnd, _) => {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner == processId) ShowWindow(hWnd, 0);
      return true;
    }, IntPtr.Zero);
  }
}
"@
}

if ([string]::IsNullOrWhiteSpace($BinaryPath)) {
  $candidate = Get-ChildItem `
    -LiteralPath (Join-Path $repo "dev-logs\release-smoke") `
    -Filter "shugu-forge-release-smoke.exe" `
    -Recurse `
    -File `
    -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($candidate) { $BinaryPath = $candidate.FullName }
}
if (
  [string]::IsNullOrWhiteSpace($BinaryPath) -or
  -not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)
) {
  throw "Binaire release-smoke introuvable. Lance d'abord pnpm release:smoke ou passe -BinaryPath."
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$cdpPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $repo "dev-logs\kimi-provider-smoke\$stamp"
$webview = Join-Path $out "webview2"
$resumeExisting = -not [string]::IsNullOrWhiteSpace($ExistingWorkspace)
$workspace = if ($resumeExisting) {
  (Resolve-Path -LiteralPath $ExistingWorkspace -ErrorAction Stop).Path
} else {
  Join-Path $out "agent-workspace"
}
New-Item -ItemType Directory -Force -Path $out, $webview | Out-Null
if (-not $resumeExisting) {
  New-Item -ItemType Directory -Force -Path $workspace | Out-Null
}

if (-not $resumeExisting) {
  $sourceCopies = @(
    @{ Source = "src\features\connections\Connections.tsx"; Target = "Connections.tsx" },
    @{ Source = "src\features\connections\connections-redesign.css"; Target = "connections-redesign.css" },
    @{ Source = "src\features\panels\ModelPicker.tsx"; Target = "ModelPicker.tsx" },
    @{ Source = "src\features\panels\model-picker.css"; Target = "model-picker.css" },
    @{ Source = "src\features\chat\views-chat.tsx"; Target = "ChatComposer.tsx" },
    @{ Source = "src\features\chat\composer-controls.css"; Target = "composer-controls.css" },
    @{ Source = "src\components\ProviderMark.tsx"; Target = "ProviderMark.tsx" },
    @{ Source = "src\components\provider-mark.css"; Target = "provider-mark.css" }
  )
  foreach ($copy in $sourceCopies) {
    Copy-Item `
      -LiteralPath (Join-Path $repo $copy.Source) `
      -Destination (Join-Path $workspace $copy.Target) `
      -Force
  }

  $brief = @"
# Audit UI Shugu — mission Kimi K3

Tu travailles dans une COPIE ISOLEE de huit fichiers de l'application Tauri Shugu.
Ne modifie jamais ces fichiers sources et ne sors jamais de ce workspace.

Problèmes observés dans l'application réelle :
- cartes de connexion de hauteurs incohérentes ; llama.cpp occupe plusieurs écrans ;
- aucune hiérarchie claire entre connecté, à configurer et en erreur ;
- absence d'identité visuelle forte/officielle des providers ;
- aucun repli des cartes ni séparation entre résumé et réglages avancés ;
- sélecteur de modèle minuscule, très à droite et visuellement détaché du mode agent ;
- identifiants techniques custom-... et erreurs SSRF brutes exposés à l'utilisateur ;
- informations répétées dans le picker et la barre sous le composer ;
- responsive dégradé aux largeurs étroites.

Ta sortie doit être KIMI_UI_REVIEW.md, en français, concrète et fondée sur les fichiers.
Elle doit contenir exactement ces titres :
1. VERDICT:
2. Architecture d'interface proposée
3. Cartes de connexion
4. Sélecteur de modèle
5. Responsive
6. Changements fichier par fichier
7. Critères E2E vérifiables

Donne des décisions précises de structure, états, dimensions et comportements. Pas de
marketing, pas de maquette générique et pas de code complet. Cite les classes/composants
existants que tu as réellement lus.
"@
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText((Join-Path $workspace "BRIEF.md"), $brief, $utf8NoBom)
}

$identifier = "dev.shugu.forge.release-smoke"
$saved = @{
  WEBVIEW2_USER_DATA_FOLDER = $env:WEBVIEW2_USER_DATA_FOLDER
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  SHUGU_CDP_URL = $env:SHUGU_CDP_URL
  SHUGU_KIMI_OUT = $env:SHUGU_KIMI_OUT
  SHUGU_KIMI_WORKSPACE = $env:SHUGU_KIMI_WORKSPACE
  SHUGU_KIMI_PROVIDER_ID = $env:SHUGU_KIMI_PROVIDER_ID
  SHUGU_KIMI_MODEL = $env:SHUGU_KIMI_MODEL
  SHUGU_KIMI_RESUME = $env:SHUGU_KIMI_RESUME
}
$profile = Join-Path $env:APPDATA $identifier
if (Test-Path -LiteralPath $profile) {
  throw "Le profil isolé $identifier existe déjà : $profile. Refus de le réutiliser ou de le supprimer implicitement."
}

$launcher = $null
$exitCode = 1
try {
  $env:WEBVIEW2_USER_DATA_FOLDER = $webview
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
  $env:SHUGU_CDP_URL = "http://127.0.0.1:$cdpPort"
  $env:SHUGU_KIMI_OUT = $out
  $env:SHUGU_KIMI_WORKSPACE = $workspace
  $env:SHUGU_KIMI_PROVIDER_ID = $ProviderId
  $env:SHUGU_KIMI_MODEL = $Model
  $env:SHUGU_KIMI_RESUME = if ($resumeExisting) { "1" } else { "0" }

  $launcher = Start-Process `
    -FilePath $BinaryPath `
    -WorkingDirectory $repo `
    -WindowStyle Hidden `
    -PassThru

  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $readyTarget = $null
  while ((Get-Date) -lt $deadline) {
    [ShuguSmokeWindow]::HideForProcess($launcher.Id)
    if ($launcher.HasExited) {
      throw "Le binaire Shugu isolé s'est arrêté avant l'ouverture de CDP (exit $($launcher.ExitCode))."
    }
    try {
      $targets = Invoke-RestMethod -Uri "$($env:SHUGU_CDP_URL)/json/list" -TimeoutSec 2
      $readyTarget = @($targets | Where-Object {
        $_.url -and $_.url -ne "about:blank" -and $_.url -notlike "*mascot.html*"
      })
      if ($readyTarget.Count -gt 0) { break }
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  if (-not $readyTarget -or $readyTarget.Count -eq 0) {
    throw "La WebView Shugu isolée n'a pas exposé sa page principale dans le délai imparti."
  }

  & pnpm exec node scripts/kimi-provider-smoke.mjs
  if ($LASTEXITCODE -ne 0) {
    throw "Le parcours Kimi/Shugu a échoué (exit $LASTEXITCODE)."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $out "summary.json"))) {
    throw "Le parcours Kimi/Shugu n'a pas produit son résumé."
  }
  $exitCode = 0
} finally {
  if ($launcher -and -not $launcher.HasExited) {
    Stop-OwnedProcessTree $launcher.Id
  }
  Start-Sleep -Seconds 1

  if (Test-Path -LiteralPath $profile) {
    $profileInfo = Get-Item -LiteralPath $profile
    $appDataInfo = Get-Item -LiteralPath $env:APPDATA
    if (
      $profileInfo.Parent.FullName -ne $appDataInfo.FullName -or
      $profileInfo.Name -ne $identifier
    ) {
      throw "Refus de nettoyer un profil Kimi inattendu : $($profileInfo.FullName)"
    }
    Remove-Item -LiteralPath $profileInfo.FullName -Recurse -Force
  }

  foreach ($name in $saved.Keys) {
    $value = $saved[$name]
    if ($null -eq $value) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$name" $value
    }
  }
}

if ($exitCode -eq 0) {
  Write-Host "Kimi provider smoke OK: $out"
}
exit $exitCode
