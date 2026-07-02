@echo off

REM Shugu Forge - Windows Tauri dev launcher WITH timestamped log capture.
REM
REM This is a SEPARATE diagnostic launcher; it does NOT replace tauri-dev.cmd
REM (your daily driver stays untouched). Use this one when you want a native
REM crash (e.g. STATUS_ILLEGAL_INSTRUCTION) written to disk instead of
REM scrolling past in a closed terminal.
REM
REM It tees combined stdout+stderr into dev-logs\run-<timestamp>.log.
REM The cargo "process didn't exit successfully ... STATUS_..." line is
REM printed by cargo (which survives the exe crash), so it IS captured.
REM
REM Design constraints (same as tauri-dev.cmd):
REM   - load MSVC env via vcvars64 so cargo build scripts find cl.exe;
REM   - do NOT use `setlocal` (it lost env mods for cargo grandchildren);
REM   - do NOT spawn a sub-cmd.exe (no `for /f` backticks, no `cmd /c`) —
REM     the user's cmd.exe AutoRun launches a vault on every cmd.exe.
REM     We delegate the run + timestamp + tee to PowerShell (NOT cmd.exe),
REM     so AutoRun never fires; PowerShell inherits the vcvars env we set.
REM
REM Usage:
REM   tauri-dev-log.cmd          runs `pnpm tauri dev`, logged
REM   tauri-dev-log.cmd build    runs `pnpm tauri build`, logged
REM   tauri-dev-log.cmd info     runs `pnpm tauri info`, logged

REM ─── Toujours s'exécuter depuis le dossier du script (cf. tauri-dev.cmd) ──
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Write-Host ('[tauri-dev-log.cmd] Dossier : ' + (Get-Location)); Write-Host ('[tauri-dev-log.cmd] Code    : ' + (git rev-parse --abbrev-ref HEAD) + ' @ ' + (git log -1 --format='%%h %%s'))"

set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"

if not exist "%VCVARS%" (
  echo.
  echo [tauri-dev-log.cmd] ERROR: vcvars64.bat not found at:
  echo   %VCVARS%
  echo.
  echo If your Visual Studio install is elsewhere, edit the VCVARS
  echo line at the top of this script.
  echo.
  pause
  exit /b 1
)

echo [tauri-dev-log.cmd] Loading MSVC env from: %VCVARS%
call "%VCVARS%" >nul 2>&1

if errorlevel 1 (
  echo [tauri-dev-log.cmd] ERROR: failed to load MSVC env.
  pause
  exit /b 1
)

if not exist "dev-logs" mkdir "dev-logs"

set "TAURI_SUBCMD=dev"
if not "%~1"=="" set "TAURI_SUBCMD=%*"

REM Pré-balayage du port 1420 — même rationale que tauri-dev.cmd : un vite
REM orphelin d'une session précédente peut capter la fenêtre Tauri et servir
REM du vieux code.
echo [tauri-dev-log.cmd] Pre-sweep du port 1420...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue; if ($h) { foreach ($c in $h) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Host ('  killing ' + $p.Name + ' PID ' + $p.Id + ' (+ children)'); & taskkill /PID $p.Id /T /F | Out-Null } } } else { Write-Host '  port 1420 clean' }"

echo [tauri-dev-log.cmd] MSVC env loaded. Starting Tauri (subcmd: %TAURI_SUBCMD%) with logging...
echo.

REM PowerShell owns: timestamp, the run, and the tee. It inherits the vcvars
REM environment from this cmd process. `2>&1` merges stderr into stdout so the
REM crash line is captured; Tee-Object writes the log line-by-line (durable on
REM a hard crash) AND echoes to the console so you still see it live.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ts = Get-Date -Format 'yyyyMMdd-HHmmss';" ^
  "$log = Join-Path 'dev-logs' ('run-' + $ts + '.log');" ^
  "Write-Host ('[tauri-dev-log.cmd] Logging to ' + $log);" ^
  "pnpm tauri %TAURI_SUBCMD% 2>&1 | Tee-Object -FilePath $log;" ^
  "Write-Host ('[tauri-dev-log.cmd] Tauri exited. Full log: ' + $log)"

set "TAURI_EXIT=%errorlevel%"

REM Orphan cleanup — same rationale as tauri-dev.cmd: `pnpm tauri dev` leaks
REM the vite node process on shutdown. Kill ONLY that tree (not all node.exe —
REM the user may run vault/MCP node services). PowerShell, not `for /f`, to
REM avoid spawning a sub-cmd.exe.
REM FIX : le port vite de Shugu est 1420 (vite.config.ts, strictPort) — ce
REM script balayait 5173, c'est-à-dire… le port du projet taptapshugu, qu'il
REM risquait de tuer, tout en laissant vivre le vrai orphelin sur 1420.
echo [tauri-dev-log.cmd] Sweeping port 1420 for orphaned vite...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue; if ($h) { foreach ($c in $h) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Host ('  killing ' + $p.Name + ' PID ' + $p.Id + ' (+ children)'); & taskkill /PID $p.Id /T /F | Out-Null } } } else { Write-Host '  port 1420 clean' }"

echo.
echo [tauri-dev-log.cmd] Done (exit code %TAURI_EXIT%).
echo Press any key to close this window.
pause >nul
exit /b %TAURI_EXIT%
