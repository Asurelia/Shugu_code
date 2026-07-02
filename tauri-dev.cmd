@echo off

REM Shugu Forge - Windows Tauri dev launcher.
REM
REM Loads the MSVC build environment vcvars64.bat before running
REM pnpm tauri dev so Rust crates that compile C/C++ at build time
REM can find cl.exe and kernel32.lib.
REM
REM CRITICAL: this script does NOT use setlocal. We tested with setlocal
REM and the env modifications from vcvars64.bat propagated correctly to
REM the immediate child process (pnpm), but were lost by the time cargo
REM build scripts ran (cc-rs reported VCINSTALLDIR=None and cl.exe not
REM found). Removing setlocal fixed it: nested SETLOCAL inside pnpm.cmd
REM (the npm-shim wrapper) was apparently interacting badly with our
REM outer setlocal and losing the env mods for grandchildren.
REM
REM We also avoid spawning any sub-cmd.exe (no for /f backtick, no
REM cmd /c, etc.) because the user has cmd.exe AutoRun configured to
REM launch a vault and Shugu CLI on every cmd.exe invocation.
REM
REM Usage:
REM   tauri-dev.cmd          runs pnpm tauri dev
REM   tauri-dev.cmd build    runs pnpm tauri build
REM   tauri-dev.cmd info     runs pnpm tauri info

REM ─── Toujours s'exécuter depuis le dossier du script ─────────
REM Sans ça, un raccourci Windows avec un « Démarrer dans » différent
REM (ou un lancement depuis un autre clone) compile UN AUTRE dossier
REM que celui-ci — symptôme : « je viens de lancer et c'est l'ancienne
REM version ». %~dp0 = dossier de CE fichier .cmd.
cd /d "%~dp0"

REM ─── Afficher le code réellement exécuté ─────────────────────
REM Branche + commit imprimés à chaque lancement : plus jamais de doute
REM sur la version qui tourne. (PowerShell, pas de sub-cmd — AutoRun.)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ('[tauri-dev.cmd] Dossier : ' + (Get-Location)); Write-Host ('[tauri-dev.cmd] Code    : ' + (git rev-parse --abbrev-ref HEAD) + ' @ ' + (git log -1 --format='%%h %%s'))"

set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"

if not exist "%VCVARS%" (
  echo.
  echo [tauri-dev.cmd] ERROR: vcvars64.bat not found at:
  echo   %VCVARS%
  echo.
  echo If your Visual Studio install is elsewhere, edit the VCVARS
  echo line at the top of this script.
  echo.
  pause
  exit /b 1
)

echo [tauri-dev.cmd] Loading MSVC env from: %VCVARS%
call "%VCVARS%" >nul 2>&1

if errorlevel 1 (
  echo [tauri-dev.cmd] ERROR: failed to load MSVC env from:
  echo   %VCVARS%
  pause
  exit /b 1
)

REM ─── Pré-balayage du port 1420 ────────────────────────────────
REM Le nettoyage post-exécution (plus bas) ne tourne PAS si la fenêtre
REM du terminal est fermée à la main — le vite orphelin garde alors le
REM port, et au lancement suivant la fenêtre Tauri peut se connecter à
REM CET ANCIEN vite (strictPort fait échouer le nouveau) → l'app
REM « fraîchement lancée » sert du vieux code. On balaie donc AUSSI
REM avant de démarrer.
echo [tauri-dev.cmd] Pre-sweep du port 1420 (vite orphelin d'une session precedente)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue; if ($h) { foreach ($c in $h) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Host ('  killing ' + $p.Name + ' PID ' + $p.Id + ' (+ children)'); & taskkill /PID $p.Id /T /F | Out-Null } } } else { Write-Host '  port 1420 clean' }"

echo [tauri-dev.cmd] MSVC env loaded. Starting Tauri...
echo.

if "%~1"=="" (
  pnpm tauri dev
) else (
  pnpm tauri %*
)

set "TAURI_EXIT=%errorlevel%"

REM ─── Orphan cleanup ──────────────────────────────────────────
REM On Windows, `pnpm tauri dev` spawns a sub-chain
REM   pnpm.cmd → node (vite) → esbuild workers
REM and the SIGTERM emitted when Tauri shuts down does NOT propagate
REM cleanly through pnpm.cmd. Result: every `tauri-dev` cycle leaks
REM the vite node process + its esbuild service workers, which keep
REM port 1420 in use and bloat the process table.
REM
REM This block targets ONLY the process still holding port 1420 (Shugu's
REM DEDICATED vite port — see vite.config.ts) and kills its entire tree
REM with /T. Esbuild workers are children of vite, so /T sweeps them too.
REM We avoid blanket `taskkill /IM node.exe` because the user may have
REM other node services running (vault CLI, MCP servers, the `taptapshugu`
REM sim on 5173, etc.) — sweeping 1420 leaves all of those untouched.
REM
REM We use PowerShell rather than `for /f` + `netstat` so the script
REM never spawns a sub-cmd.exe (the user has cmd.exe AutoRun
REM configured, see vcvars64 comment above).
echo [tauri-dev.cmd] Sweeping port 1420 for orphaned vite...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue; if ($h) { foreach ($c in $h) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Host ('  killing ' + $p.Name + ' PID ' + $p.Id + ' (+ children)'); & taskkill /PID $p.Id /T /F | Out-Null } } } else { Write-Host '  port 1420 clean' }"

echo.
echo [tauri-dev.cmd] Tauri exited with code %TAURI_EXIT%.
echo Press any key to close this window.
pause >nul
exit /b %TAURI_EXIT%