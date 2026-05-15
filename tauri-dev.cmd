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
echo.
echo [tauri-dev.cmd] Tauri exited with code %TAURI_EXIT%.
echo Press any key to close this window.
pause >nul
exit /b %TAURI_EXIT%