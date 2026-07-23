param(
  [int]$StartupTimeoutSeconds = 360,
  [string]$ModelPath = "",
  [string]$AgentHfModel = "Qwen/Qwen3-8B-GGUF:Q4_K_M",
  [switch]$SkipCodex
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

if (Get-Process -Name "shugu-forge" -ErrorAction SilentlyContinue) {
  throw "Une instance shugu-forge tourne déjà. Ferme-la avant le smoke provider live."
}
if (Get-Process -Name "llama-server" -ErrorAction SilentlyContinue) {
  throw "Un llama-server tourne déjà. Le smoke refuse de tuer un serveur qu'il n'a pas lancé."
}
foreach ($port in @(1420, 8090)) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    throw "Le port $port est déjà utilisé. Aucun processus tiers ne sera tué."
  }
}
if ([string]::IsNullOrWhiteSpace($ModelPath)) {
  $ModelPath = Join-Path $env:LOCALAPPDATA "dev.shugu.forge\models\qwen3.5-2b-q4_k_m.gguf"
}
if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
  throw "Modèle GGUF live introuvable : $ModelPath"
}
$modelInfo = Get-Item -LiteralPath $ModelPath
if ($modelInfo.Length -le 0) { throw "Le modèle GGUF live est vide : $ModelPath" }

$codex = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $codex) { throw "Le CLI Codex est introuvable." }
$llama = Get-Command llama-server -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $llama -or -not (Test-Path -LiteralPath $llama.Path -PathType Leaf)) {
  throw "Le binaire llama-server est introuvable."
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$cdpPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $repo "dev-logs\live-provider-smoke\$stamp"
$roaming = Join-Path $out "appdata\Roaming"
$local = Join-Path $out "appdata\Local"
$webview = Join-Path $out "webview2"
$agentWorkspace = Join-Path $out "agent-workspace"
New-Item -ItemType Directory -Force -Path $out, $roaming, $local, $webview, $agentWorkspace | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
  (Join-Path $agentWorkspace "README.txt"),
  "Workspace isolé du smoke agent live.`n",
  $utf8NoBom
)

$identifier = "dev.shugu.forge.live-provider-smoke"
$config = Join-Path $repo "src-tauri\tauri.live-provider-smoke.conf.json"
$saved = @{
  APPDATA = $env:APPDATA
  LOCALAPPDATA = $env:LOCALAPPDATA
  WEBVIEW2_USER_DATA_FOLDER = $env:WEBVIEW2_USER_DATA_FOLDER
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  SHUGU_CDP_URL = $env:SHUGU_CDP_URL
  SHUGU_LIVE_OUT = $env:SHUGU_LIVE_OUT
  SHUGU_LIVE_MODEL_PATH = $env:SHUGU_LIVE_MODEL_PATH
  SHUGU_LIVE_MODEL_BYTES = $env:SHUGU_LIVE_MODEL_BYTES
  SHUGU_LIVE_LLAMA_BIN = $env:SHUGU_LIVE_LLAMA_BIN
  SHUGU_LIVE_CODEX_MODEL = $env:SHUGU_LIVE_CODEX_MODEL
  SHUGU_LIVE_SKIP_CODEX = $env:SHUGU_LIVE_SKIP_CODEX
  SHUGU_LIVE_AGENT_WORKSPACE = $env:SHUGU_LIVE_AGENT_WORKSPACE
  SHUGU_LIVE_AGENT_HF_MODEL = $env:SHUGU_LIVE_AGENT_HF_MODEL
  SHUGU_CUSTOM_ALLOW_PRIVATE = $env:SHUGU_CUSTOM_ALLOW_PRIVATE
}
$profile = Join-Path $saved.APPDATA $identifier
$localProfile = Join-Path $saved.LOCALAPPDATA $identifier
$db = Join-Path $profile "shugu.db"
foreach ($candidate in @($profile, $localProfile)) {
  if (Test-Path -LiteralPath $candidate) {
    throw "Le profil provider live existe déjà : $candidate. Refus de supprimer un dossier non créé par cette invocation."
  }
}

$launcher = $null
$exitCode = 1
try {
  $env:APPDATA = $roaming
  $env:LOCALAPPDATA = $local
  $env:WEBVIEW2_USER_DATA_FOLDER = $webview
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
  $env:SHUGU_CDP_URL = "http://127.0.0.1:$cdpPort"
  $env:SHUGU_LIVE_OUT = $out
  $env:SHUGU_LIVE_MODEL_PATH = $modelInfo.FullName
  $env:SHUGU_LIVE_MODEL_BYTES = "$($modelInfo.Length)"
  $env:SHUGU_LIVE_LLAMA_BIN = $llama.Path
  $env:SHUGU_LIVE_AGENT_WORKSPACE = $agentWorkspace
  $env:SHUGU_LIVE_AGENT_HF_MODEL = $AgentHfModel
  $env:SHUGU_LIVE_SKIP_CODEX = if ($SkipCodex) { "1" } else { "0" }
  $env:SHUGU_CUSTOM_ALLOW_PRIVATE = "1"

  $launcher = Start-Process `
    -FilePath (Join-Path $repo "tauri-dev-log.cmd") `
    -ArgumentList @("dev", "--config", $config) `
    -WorkingDirectory $repo `
    -WindowStyle Hidden `
    -PassThru

  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $targets = $null
  while ((Get-Date) -lt $deadline) {
    if ($launcher.HasExited) {
      throw "Le launcher Tauri s'est arrêté avant l'ouverture de CDP (exit $($launcher.ExitCode))."
    }
    try {
      $targets = Invoke-RestMethod -Uri "$($env:SHUGU_CDP_URL)/json/list" -TimeoutSec 2
      $readyTarget = @($targets | Where-Object {
        $_.url -and $_.url -ne "about:blank" -and $_.url -notlike "*mascot.html*"
      })
      if ($readyTarget.Count -gt 0) { break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $readyTarget -or $readyTarget.Count -eq 0) {
    $urls = @($targets | ForEach-Object { $_.url }) -join ", "
    throw "WebView2 n'a pas exposé de page principale dans le délai imparti (cibles : $urls)."
  }

  & pnpm exec node scripts/live-provider-smoke.mjs
  if ($LASTEXITCODE -ne 0) {
    throw "Le parcours provider live a échoué (exit $LASTEXITCODE)."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $out "summary.json"))) {
    throw "Le parcours provider live n'a pas produit son résumé."
  }
  $exitCode = 0
} finally {
  if ($launcher -and -not $launcher.HasExited) {
    Stop-OwnedProcessTree $launcher.Id
  }
  Start-Sleep -Seconds 2
  if (Get-Process -Name "shugu-forge" -ErrorAction SilentlyContinue) {
    throw "Teardown incomplet : shugu-forge tourne encore."
  }
  if (Get-Process -Name "llama-server" -ErrorAction SilentlyContinue) {
    throw "Teardown incomplet : le llama-server lancé par le smoke tourne encore."
  }
  foreach ($port in @(1420, 8090)) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
      throw "Teardown incomplet : le port $port est encore occupé."
    }
  }

  if (Test-Path -LiteralPath $db) {
    Copy-Item -LiteralPath $db -Destination (Join-Path $out "shugu.db") -Force
  }
  if (Test-Path -LiteralPath $profile) {
    $profileInfo = Get-Item -LiteralPath $profile
    $appDataInfo = Get-Item -LiteralPath $saved.APPDATA
    if ($profileInfo.Parent.FullName -ne $appDataInfo.FullName -or
        $profileInfo.Name -ne $identifier) {
      throw "Refus de nettoyer un profil provider live inattendu : $($profileInfo.FullName)"
    }
    Remove-Item -LiteralPath $profileInfo.FullName -Recurse -Force
  }
  if (Test-Path -LiteralPath $localProfile) {
    $localProfileInfo = Get-Item -LiteralPath $localProfile
    $localAppDataInfo = Get-Item -LiteralPath $saved.LOCALAPPDATA
    if ($localProfileInfo.Parent.FullName -ne $localAppDataInfo.FullName -or
        $localProfileInfo.Name -ne $identifier) {
      throw "Refus de nettoyer un profil local provider live inattendu : $($localProfileInfo.FullName)"
    }
    Remove-Item -LiteralPath $localProfileInfo.FullName -Recurse -Force
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
  Write-Host "Live provider smoke OK: $out"
}
exit $exitCode
