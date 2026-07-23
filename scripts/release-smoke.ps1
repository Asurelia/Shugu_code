param(
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

$running = @(Get-Process -Name "shugu-forge", "shugu-forge-release-smoke" -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  throw "Une instance Shugu tourne déjà. Le profil release refuse de tuer un processus qu'il n'a pas lancé."
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$cdpPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$out = Join-Path $repo "dev-logs\release-smoke\$stamp"
$webview = Join-Path $out "webview2"
New-Item -ItemType Directory -Force -Path $out, $webview | Out-Null

$identifier = "dev.shugu.forge.release-smoke"
$profile = Join-Path $env:APPDATA $identifier
$localProfile = Join-Path $env:LOCALAPPDATA $identifier
if (Test-Path -LiteralPath $profile) {
  throw "Le profil release isolé existe déjà : $profile. Refus de supprimer un dossier qui ne vient pas de cette invocation."
}

$config = Join-Path $repo "src-tauri\tauri.release-smoke.conf.json"
$targetExe = Join-Path $repo "src-tauri\target\release\shugu-forge.exe"
$normalBackup = Join-Path $out "normal-release-backup.exe"
$releaseExe = Join-Path $out "shugu-forge-release-smoke.exe"
$buildLog = Join-Path $out "build.log"
$buildStdout = Join-Path $out "build.stdout.log"
$buildStderr = Join-Path $out "build.stderr.log"
$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars)) { throw "vcvars64.bat introuvable : $vcvars" }
if (-not (Test-Path -LiteralPath $targetExe)) { throw "Binaire release normal introuvable : $targetExe" }

$saved = @{
  APPDATA = $env:APPDATA
  LOCALAPPDATA = $env:LOCALAPPDATA
  WEBVIEW2_USER_DATA_FOLDER = $env:WEBVIEW2_USER_DATA_FOLDER
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  SHUGU_CDP_URL = $env:SHUGU_CDP_URL
  SHUGU_RELEASE_OUT = $env:SHUGU_RELEASE_OUT
}
$process = $null
$exitCode = 1
$normalRestored = $false
Copy-Item -LiteralPath $targetExe -Destination $normalBackup -Force

try {
  $buildCommand = "call `"$vcvars`" >nul 2>&1 && cd /d `"$repo`" && pnpm tauri build --config `"$config`" --no-bundle"
  $buildProcess = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/d", "/c", $buildCommand) `
    -WorkingDirectory $repo `
    -WindowStyle Hidden `
    -RedirectStandardOutput $buildStdout `
    -RedirectStandardError $buildStderr `
    -Wait `
    -PassThru
  $buildLines = @()
  if (Test-Path -LiteralPath $buildStdout) { $buildLines += Get-Content -LiteralPath $buildStdout }
  if (Test-Path -LiteralPath $buildStderr) { $buildLines += Get-Content -LiteralPath $buildStderr }
  $buildLines | Set-Content -LiteralPath $buildLog
  $buildLines | ForEach-Object { Write-Host $_ }
  if ($buildProcess.ExitCode -ne 0) { throw "Le build release isolé a échoué (exit $($buildProcess.ExitCode))." }
  if (-not (Test-Path -LiteralPath $targetExe)) { throw "Le build isolé n'a pas produit $targetExe" }

  Copy-Item -LiteralPath $targetExe -Destination $releaseExe -Force
  Copy-Item -LiteralPath $normalBackup -Destination $targetExe -Force
  $normalRestored = $true

  $env:WEBVIEW2_USER_DATA_FOLDER = $webview
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort"
  $env:SHUGU_CDP_URL = "http://127.0.0.1:$cdpPort"
  $env:SHUGU_RELEASE_OUT = $out

  $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $process = Start-Process -FilePath $releaseExe -WorkingDirectory $out -PassThru
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $targets = $null
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { throw "Le binaire release isolé s'est arrêté avant CDP (exit $($process.ExitCode))." }
    try {
      $targets = Invoke-RestMethod -Uri "$($env:SHUGU_CDP_URL)/json/list" -TimeoutSec 2
      if ($targets) { break }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $targets) { throw "WebView2 release n'a pas exposé CDP dans le délai imparti." }
  $cdpReadyMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startedAt
  if ($cdpReadyMs -gt 30000) { throw "Budget CDP release dépassé : $cdpReadyMs ms." }

  & pnpm exec node scripts/release-smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw "Le parcours release WebView2 a échoué (exit $LASTEXITCODE)." }

  $nativeWorkingSetBytes = (Get-Process -Id $process.Id -ErrorAction Stop).WorkingSet64
  $webviewProcessIds = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$webview*" } |
    Select-Object -ExpandProperty ProcessId)
  if ($webviewProcessIds.Count -eq 0) { throw "Processus WebView2 release isolés introuvables." }
  $webviewWorkingSetBytes = ($webviewProcessIds | ForEach-Object {
    (Get-Process -Id $_ -ErrorAction SilentlyContinue).WorkingSet64
  } | Measure-Object -Sum).Sum
  if ($null -eq $webviewWorkingSetBytes) { $webviewWorkingSetBytes = 0 }
  $totalWorkingSetBytes = $nativeWorkingSetBytes + $webviewWorkingSetBytes
  if ($totalWorkingSetBytes -gt 1GB) { throw "Budget mémoire release dépassé : $totalWorkingSetBytes octets." }

  $db = Join-Path $profile "shugu.db"
  if (-not (Test-Path -LiteralPath $db)) { throw "La base release isolée n'a pas été créée : $db" }
  $dbInfo = Get-Item -LiteralPath $db
  Copy-Item -LiteralPath $db -Destination (Join-Path $out "shugu.db") -Force
  "binary=$releaseExe`nbytes=$((Get-Item $releaseExe).Length)`ncdpReadyMs=$cdpReadyMs`nnativeWorkingSetBytes=$nativeWorkingSetBytes`nwebviewWorkingSetBytes=$webviewWorkingSetBytes`ntotalWorkingSetBytes=$totalWorkingSetBytes`ndbBytes=$($dbInfo.Length)" |
    Set-Content -LiteralPath (Join-Path $out "release-proof.txt")
  $exitCode = 0
} finally {
  if ($process -and -not $process.HasExited) { Stop-OwnedProcessTree $process.Id }
  Start-Sleep -Seconds 2
  if (-not $normalRestored -and (Test-Path -LiteralPath $normalBackup)) {
    Copy-Item -LiteralPath $normalBackup -Destination $targetExe -Force
    $normalRestored = $true
  }
  if (@(Get-Process -Name "shugu-forge-release-smoke" -ErrorAction SilentlyContinue).Count -gt 0) {
    throw "Teardown incomplet : le binaire release isolé tourne encore."
  }
  if (Test-Path -LiteralPath $profile) {
    $profileInfo = Get-Item -LiteralPath $profile
    $appDataInfo = Get-Item -LiteralPath $env:APPDATA
    if ($profileInfo.Parent.FullName -ne $appDataInfo.FullName -or $profileInfo.Name -ne $identifier) {
      throw "Refus de nettoyer un profil release inattendu : $($profileInfo.FullName)"
    }
    Remove-Item -LiteralPath $profileInfo.FullName -Recurse -Force
  }
  if (Test-Path -LiteralPath $localProfile) {
    $localProfileInfo = Get-Item -LiteralPath $localProfile
    $localAppDataInfo = Get-Item -LiteralPath $saved.LOCALAPPDATA
    if ($localProfileInfo.Parent.FullName -ne $localAppDataInfo.FullName -or
        $localProfileInfo.Name -ne $identifier) {
      throw "Refus de nettoyer un profil local release inattendu : $($localProfileInfo.FullName)"
    }
    Remove-Item -LiteralPath $localProfileInfo.FullName -Recurse -Force
  }
  foreach ($name in $saved.Keys) {
    if ($null -eq $saved[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$name" $saved[$name] }
  }
}

if ($exitCode -eq 0) { Write-Host "Release smoke OK: $out" }
exit $exitCode
