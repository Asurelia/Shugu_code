param(
  [int]$StartupTimeoutSeconds = 360,
  [int]$FileCount = 1200,
  [int]$StreamChunks = 1200
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

if ($FileCount -lt 100 -or $FileCount -gt 5000) {
  throw "FileCount doit être compris entre 100 et 5000."
}
if ($StreamChunks -lt 200 -or $StreamChunks -gt 10000) {
  throw "StreamChunks doit être compris entre 200 et 10000."
}
if (Get-Process -Name "shugu-forge" -ErrorAction SilentlyContinue) {
  throw "Une instance shugu-forge tourne déjà. Ferme-la avant le smoke de performance."
}
if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
  throw "Le port Tauri/Vite 1420 est déjà utilisé. Aucun processus tiers ne sera tué."
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$cdpPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $repo "dev-logs\perf-smoke\$stamp"
$fixture = Join-Path $out "workspace"
$roaming = Join-Path $out "appdata\Roaming"
$local = Join-Path $out "appdata\Local"
$webview = Join-Path $out "webview2"
New-Item -ItemType Directory -Force -Path $out, $fixture, $roaming, $local, $webview | Out-Null

# Deterministic TypeScript fixture: 1200 files by default, each large enough to
# exercise the real chunker/embedding path without creating an impractical test
# repository. The fixture is removed after its metrics have been captured.
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
try {
  for ($index = 0; $index -lt $FileCount; $index++) {
    $dirNumber = [int][Math]::Floor($index / 40)
    $dirName = "module-{0:D3}" -f $dirNumber
    $dir = Join-Path $fixture $dirName
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("// deterministic semantic performance sentinel module $index")
    $lines.Add("export const moduleId = `"SHUGU_PERF_MODULE_$('{0:D4}' -f $index)`";")
    for ($line = 0; $line -lt 24; $line++) {
      $lines.Add("export function compute_${index}_${line}(input: number): number { return input * $($line + 1) + $index; }")
    }
    $file = Join-Path $dir ("file-{0:D4}.ts" -f $index)
    [System.IO.File]::WriteAllText($file, ($lines -join "`n") + "`n", $utf8NoBom)
  }
} catch {
  if (Test-Path -LiteralPath $fixture) {
    $fixtureInfo = Get-Item -LiteralPath $fixture
    $outInfo = Get-Item -LiteralPath $out
    if ($fixtureInfo.Parent.FullName -eq $outInfo.FullName -and $fixtureInfo.Name -eq "workspace") {
      Remove-Item -LiteralPath $fixtureInfo.FullName -Recurse -Force
    }
  }
  throw
}

$smokeIdentifier = "dev.shugu.forge.perf-smoke"
$config = Join-Path $repo "src-tauri\tauri.perf-smoke.conf.json"
$saved = @{
  APPDATA = $env:APPDATA
  LOCALAPPDATA = $env:LOCALAPPDATA
  WEBVIEW2_USER_DATA_FOLDER = $env:WEBVIEW2_USER_DATA_FOLDER
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  SHUGU_CDP_URL = $env:SHUGU_CDP_URL
  SHUGU_PERF_OUT = $env:SHUGU_PERF_OUT
  SHUGU_PERF_WORKSPACE = $env:SHUGU_PERF_WORKSPACE
  SHUGU_PERF_FILE_COUNT = $env:SHUGU_PERF_FILE_COUNT
  SHUGU_PERF_STREAM_CHUNKS = $env:SHUGU_PERF_STREAM_CHUNKS
  SHUGU_CUSTOM_ALLOW_PRIVATE = $env:SHUGU_CUSTOM_ALLOW_PRIVATE
}
$launcher = $null
$exitCode = 1
$nativeProfile = Join-Path $saved.APPDATA $smokeIdentifier
$nativeLocalProfile = Join-Path $saved.LOCALAPPDATA $smokeIdentifier
$db = Join-Path $nativeProfile "shugu.db"
$nativeExecutable = Join-Path $repo "src-tauri\target\debug\shugu-forge.exe"

if (Test-Path -LiteralPath $nativeProfile) {
  throw "Le profil de performance existe déjà : $nativeProfile. Refus de supprimer un dossier non créé par cette invocation."
}

try {
  $env:APPDATA = $roaming
  $env:LOCALAPPDATA = $local
  $env:WEBVIEW2_USER_DATA_FOLDER = $webview
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
  $env:SHUGU_CDP_URL = "http://127.0.0.1:$cdpPort"
  $env:SHUGU_PERF_OUT = $out
  $env:SHUGU_PERF_WORKSPACE = $fixture
  $env:SHUGU_PERF_FILE_COUNT = "$FileCount"
  $env:SHUGU_PERF_STREAM_CHUNKS = "$StreamChunks"
  $env:SHUGU_CUSTOM_ALLOW_PRIVATE = "1"

  $launchStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
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
      throw "Le launcher Tauri s'est arrêté avant l'ouverture du port CDP (exit $($launcher.ExitCode))."
    }
    try {
      $targets = Invoke-RestMethod -Uri "$($env:SHUGU_CDP_URL)/json/list" -TimeoutSec 2
      if ($targets) { break }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $targets) {
    throw "WebView2 n'a pas exposé CDP sur $($env:SHUGU_CDP_URL) dans le délai imparti."
  }
  $cdpReadyMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $launchStarted

  & pnpm exec node scripts/perf-smoke.mjs
  if ($LASTEXITCODE -ne 0) {
    throw "Le parcours de charge Tauri a échoué (exit $LASTEXITCODE)."
  }

  $nativeMeasured = Get-CimInstance Win32_Process -Filter "Name = 'shugu-forge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $nativeExecutable } |
    Select-Object -First 1
  if (-not $nativeMeasured) {
    throw "Impossible de mesurer la mémoire : processus natif Shugu introuvable."
  }
  $nativeWorkingSetBytes = (Get-Process -Id $nativeMeasured.ProcessId -ErrorAction Stop).WorkingSet64
  $webviewProcessIds = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$webview*" } |
    Select-Object -ExpandProperty ProcessId)
  if ($webviewProcessIds.Count -eq 0) {
    throw "Impossible de mesurer la mémoire : processus WebView2 isolés introuvables."
  }
  $webviewWorkingSetBytes = ($webviewProcessIds | ForEach-Object {
    (Get-Process -Id $_ -ErrorAction SilentlyContinue).WorkingSet64
  } | Measure-Object -Sum).Sum
  if ($null -eq $webviewWorkingSetBytes) { $webviewWorkingSetBytes = 0 }
  $totalWorkingSetBytes = $nativeWorkingSetBytes + $webviewWorkingSetBytes
  if ($totalWorkingSetBytes -gt 1536MB) {
    throw "Budget mémoire sous charge dépassé : $totalWorkingSetBytes octets (> 1,5 Gio)."
  }
  if (-not (Test-Path -LiteralPath $db) -or (Get-Item -LiteralPath $db).Length -le 0) {
    throw "La base SQLite de performance n'a pas été créée correctement : $db"
  }
  $exitCode = 0
} finally {
  if ($launcher -and -not $launcher.HasExited) {
    Stop-OwnedProcessTree $launcher.Id
  }
  Start-Sleep -Seconds 2
  if (Get-Process -Name "shugu-forge" -ErrorAction SilentlyContinue) {
    throw "Teardown incomplet : shugu-forge tourne encore après l'arrêt ciblé."
  }
  if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
    throw "Teardown incomplet : le port 1420 est encore occupé."
  }

  if (Test-Path -LiteralPath $db) {
    # Measure after process shutdown so WAL has checkpointed into the main DB.
    $dbBytes = (Get-Item -LiteralPath $db).Length
    Copy-Item -LiteralPath $db -Destination (Join-Path $out "shugu.db") -Force
    if ($exitCode -eq 0) {
      "db=$db`nbytes=$dbBytes`ncdpReadyMs=$cdpReadyMs`nnativeWorkingSetBytes=$nativeWorkingSetBytes`nwebviewWorkingSetBytes=$webviewWorkingSetBytes`ntotalWorkingSetBytes=$totalWorkingSetBytes" |
        Set-Content -LiteralPath (Join-Path $out "native-proof.txt")
    }
  }
  if (Test-Path -LiteralPath $nativeProfile) {
    $profileInfo = Get-Item -LiteralPath $nativeProfile
    $appDataInfo = Get-Item -LiteralPath $saved.APPDATA
    if ($profileInfo.Parent.FullName -ne $appDataInfo.FullName -or
        $profileInfo.Name -ne "dev.shugu.forge.perf-smoke") {
      throw "Refus de nettoyer un profil inattendu : $($profileInfo.FullName)"
    }
    Remove-Item -LiteralPath $profileInfo.FullName -Recurse -Force
  }
  if (Test-Path -LiteralPath $nativeLocalProfile) {
    $localProfileInfo = Get-Item -LiteralPath $nativeLocalProfile
    $localAppDataInfo = Get-Item -LiteralPath $saved.LOCALAPPDATA
    if ($localProfileInfo.Parent.FullName -ne $localAppDataInfo.FullName -or
        $localProfileInfo.Name -ne "dev.shugu.forge.perf-smoke") {
      throw "Refus de nettoyer un profil local de performance inattendu : $($localProfileInfo.FullName)"
    }
    Remove-Item -LiteralPath $localProfileInfo.FullName -Recurse -Force
  }
  if (Test-Path -LiteralPath $fixture) {
    $fixtureInfo = Get-Item -LiteralPath $fixture
    $outInfo = Get-Item -LiteralPath $out
    if ($fixtureInfo.Parent.FullName -ne $outInfo.FullName -or $fixtureInfo.Name -ne "workspace") {
      throw "Refus de nettoyer un workspace de charge inattendu : $($fixtureInfo.FullName)"
    }
    Remove-Item -LiteralPath $fixtureInfo.FullName -Recurse -Force
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
  Write-Host "Native performance smoke OK: $out"
}
exit $exitCode
