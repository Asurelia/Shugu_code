param(
  [int]$StartupTimeoutSeconds = 360
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

function Stop-OwnedProcessTree([int]$TargetProcessId) {
  if (-not (Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue)) { return }
  # Start-Process does not promote taskkill's benign race (child exited between
  # the lookup and taskkill) into a terminating NativeCommandError.
  Start-Process -FilePath "taskkill.exe" `
    -ArgumentList @("/PID", "$TargetProcessId", "/T", "/F") `
    -WindowStyle Hidden `
    -Wait | Out-Null
}

if (Get-Process -Name "shugu-forge" -ErrorAction SilentlyContinue) {
  throw "Une instance shugu-forge tourne déjà. Ferme-la avant le smoke natif pour ne pas mélanger les profils."
}
if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
  throw "Le port Tauri/Vite 1420 est déjà utilisé. Le smoke refuse de tuer un processus qu'il n'a pas lancé."
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$cdpPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $repo "dev-logs\native-smoke\$stamp"
$roaming = Join-Path $out "appdata\Roaming"
$local = Join-Path $out "appdata\Local"
$webview = Join-Path $out "webview2"
New-Item -ItemType Directory -Force -Path $roaming, $local, $webview | Out-Null

# Windows resolves Tauri's app_config_dir through Known Folders, not through a
# process-local APPDATA override. A unique identifier is therefore the reliable
# way to keep this run away from the user's real dev.shugu.forge database.
$smokeIdentifier = "dev.shugu.forge.native-smoke"
$config = Join-Path $repo "src-tauri\tauri.native-smoke.conf.json"

$saved = @{
  APPDATA = $env:APPDATA
  LOCALAPPDATA = $env:LOCALAPPDATA
  WEBVIEW2_USER_DATA_FOLDER = $env:WEBVIEW2_USER_DATA_FOLDER
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  SHUGU_CDP_URL = $env:SHUGU_CDP_URL
  SHUGU_NATIVE_OUT = $env:SHUGU_NATIVE_OUT
}
$launcher = $null
$exitCode = 1
$restoreAppliedAtBoot = $false
$nativeProfile = Join-Path $saved.APPDATA $smokeIdentifier
$nativeLocalProfile = Join-Path $saved.LOCALAPPDATA $smokeIdentifier
$db = Join-Path $nativeProfile "shugu.db"
$nativeExecutable = Join-Path $repo "src-tauri\target\debug\shugu-forge.exe"
if (Test-Path -LiteralPath $nativeProfile) {
  throw "Le profil natif de test existe déjà : $nativeProfile. Refus de supprimer un dossier qui ne vient pas de cette invocation."
}
try {
  $env:APPDATA = $roaming
  $env:LOCALAPPDATA = $local
  $env:WEBVIEW2_USER_DATA_FOLDER = $webview
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
  $env:SHUGU_CDP_URL = "http://127.0.0.1:$cdpPort"
  $env:SHUGU_NATIVE_OUT = $out

  $firstLaunchStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
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
  $firstCdpReadyMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $firstLaunchStarted

  & pnpm exec node scripts/native-smoke.mjs
  if ($LASTEXITCODE -ne 0) {
    throw "Le parcours Playwright WebView2 a échoué (exit $LASTEXITCODE)."
  }

  $nativeMeasured = Get-CimInstance Win32_Process -Filter "Name = 'shugu-forge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $nativeExecutable } |
    Select-Object -First 1
  if (-not $nativeMeasured) {
    throw "Impossible de mesurer la mémoire : processus natif Shugu introuvable."
  }
  $nativeWorkingSetBytes = if ($nativeMeasured) {
    (Get-Process -Id $nativeMeasured.ProcessId -ErrorAction Stop).WorkingSet64
  } else { 0 }
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
  $nativeTotalWorkingSetBytes = $nativeWorkingSetBytes + $webviewWorkingSetBytes
  if ($nativeTotalWorkingSetBytes -gt 1GB) {
    throw "Budget mémoire natif dépassé : $nativeTotalWorkingSetBytes octets (> 1 Gio)."
  }

  # The JS phase schedules a validated restore. Restart the SAME isolated
  # profile and prove Tauri setup applies it before plugin-sql reopens the DB.
  $pendingRestore = Join-Path $nativeProfile "shugu.db.pending-restore"
  if (-not (Test-Path -LiteralPath $pendingRestore)) {
    throw "Le smoke n'a pas préparé le fichier de restauration attendu : $pendingRestore"
  }
  if ($launcher -and -not $launcher.HasExited) {
    Stop-OwnedProcessTree $launcher.Id
  }
  $launcher = $null
  $stopDeadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $stopDeadline) {
    $nativeAlive = Get-Process -Name "shugu-forge" -ErrorAction SilentlyContinue
    $viteAlive = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
    if (-not $nativeAlive -and -not $viteAlive) { break }
    Start-Sleep -Milliseconds 250
  }
  if (Get-Process -Name "shugu-forge" -ErrorAction SilentlyContinue) {
    throw "Le premier lancement natif ne s'est pas arrêté avant le test de restauration."
  }

  $restoreLaunchStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $launcher = Start-Process `
    -FilePath (Join-Path $repo "tauri-dev-log.cmd") `
    -ArgumentList @("dev", "--config", $config) `
    -WorkingDirectory $repo `
    -WindowStyle Hidden `
    -PassThru
  $restartDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $restoredNativeProcess = $null
  while ((Get-Date) -lt $restartDeadline) {
    if ($launcher.HasExited) {
      throw "Le second lancement Tauri s'est arrêté avant d'appliquer la restauration (exit $($launcher.ExitCode))."
    }
    $restoredNativeProcess = Get-CimInstance Win32_Process -Filter "Name = 'shugu-forge.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -eq $nativeExecutable } |
      Select-Object -First 1
    if ($restoredNativeProcess -and -not (Test-Path -LiteralPath $pendingRestore)) {
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path -LiteralPath $pendingRestore) {
    throw "La restauration préparée n'a pas été appliquée au second boot : $pendingRestore"
  }
  if (-not $restoredNativeProcess) {
    throw "Le processus natif restauré n'est pas resté actif après le second boot."
  }
  $restoreAppliedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $restoreLaunchStarted
  $restoreAppliedAtBoot = $true

  if (-not (Test-Path -LiteralPath $db)) {
    throw "La vraie base Tauri temporaire n'a pas été créée : $db"
  }
  $dbInfo = Get-Item -LiteralPath $db
  if ($dbInfo.Length -le 0) {
    throw "La base Tauri temporaire est vide : $db"
  }
  "db=$db`nbytes=$($dbInfo.Length)`ncdpPort=$cdpPort`nfirstCdpReadyMs=$firstCdpReadyMs`nrestoreAppliedMs=$restoreAppliedMs`nnativeWorkingSetBytes=$nativeWorkingSetBytes`nwebviewWorkingSetBytes=$webviewWorkingSetBytes`nnativeTotalWorkingSetBytes=$nativeTotalWorkingSetBytes`nrestoreAppliedAtBoot=$restoreAppliedAtBoot" | Set-Content -LiteralPath (Join-Path $out "native-proof.txt")
  $exitCode = 0
} finally {
  if ($launcher -and -not $launcher.HasExited) {
    Stop-OwnedProcessTree $launcher.Id
  }
  Start-Sleep -Seconds 2
  if (Get-Process -Name "shugu-forge" -ErrorAction SilentlyContinue) {
    throw "Teardown incomplet : shugu-forge tourne encore après l'arrêt ciblé du launcher."
  }
  if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
    throw "Teardown incomplet : le port 1420 est encore occupé."
  }

  # Preserve the actual native SQLite file as evidence, then remove only the
  # unique profile created by this invocation. Never touch dev.shugu.forge.
  if (Test-Path -LiteralPath $db) {
    Copy-Item -LiteralPath $db -Destination (Join-Path $out "shugu.db") -Force
  }
  if (Test-Path -LiteralPath $nativeProfile) {
    $profileInfo = Get-Item -LiteralPath $nativeProfile
    $appDataInfo = Get-Item -LiteralPath $saved.APPDATA
    if ($profileInfo.Parent.FullName -ne $appDataInfo.FullName -or
        $profileInfo.Name -ne "dev.shugu.forge.native-smoke") {
      throw "Refus de nettoyer un profil natif inattendu : $($profileInfo.FullName)"
    }
    Remove-Item -LiteralPath $profileInfo.FullName -Recurse -Force
  }
  if (Test-Path -LiteralPath $nativeLocalProfile) {
    $localProfileInfo = Get-Item -LiteralPath $nativeLocalProfile
    $localAppDataInfo = Get-Item -LiteralPath $saved.LOCALAPPDATA
    if ($localProfileInfo.Parent.FullName -ne $localAppDataInfo.FullName -or
        $localProfileInfo.Name -ne "dev.shugu.forge.native-smoke") {
      throw "Refus de nettoyer un profil local natif inattendu : $($localProfileInfo.FullName)"
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
  Write-Host "Native smoke OK: $out"
}
exit $exitCode
