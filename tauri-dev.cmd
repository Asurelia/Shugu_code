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
REM port 5173 in use and bloat the process table.
REM
REM This block targets ONLY the process still holding port 5173 (the
REM vite server) and kills its entire tree with /T. Esbuild workers
REM are children of vite, so /T sweeps them too. We avoid blanket
REM `taskkill /IM node.exe` because the user may have other node
REM services running (vault CLI, MCP servers, etc.).
REM
REM We use PowerShell rather than `for /f` + `netstat` so the script
REM never spawns a sub-cmd.exe (the user has cmd.exe AutoRun
REM configured, see vcvars64 comment above).
echo [tauri-dev.cmd] Sweeping port 5173 for orphaned vite...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue; if ($h) { foreach ($c in $h) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Host ('  killing ' + $p.Name + ' PID ' + $p.Id + ' (+ children)'); & taskkill /PID $p.Id /T /F | Out-Null } } } else { Write-Host '  port 5173 clean' }"

echo.
echo [tauri-dev.cmd] Tauri exited with code %TAURI_EXIT%.
echo Press any key to close this window.
pause >nul
exit /b %TAURI_EXIT%