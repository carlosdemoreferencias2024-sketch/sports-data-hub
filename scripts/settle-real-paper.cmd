@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
set "LIMIT=500"
set "DRY_RUN="
set "REQUIRE_CLOSING="

:parse
if "%~1"=="" goto run
if /I "%~1"=="--dry-run" (
  set "DRY_RUN=--dry-run"
  shift
  goto parse
)
if /I "%~1"=="--require-closing" (
  set "REQUIRE_CLOSING=--require-closing"
  shift
  goto parse
)
if /I "%~1"=="-RequireClosing" (
  set "REQUIRE_CLOSING=--require-closing"
  shift
  goto parse
)
if /I "%~1"=="-DryRun" (
  set "DRY_RUN=--dry-run"
  shift
  goto parse
)
if /I "%~1"=="--limit" (
  set "LIMIT=%~2"
  shift
  shift
  goto parse
)
if /I "%~1"=="-Limit" (
  set "LIMIT=%~2"
  shift
  shift
  goto parse
)
echo Unknown argument: %~1
exit /b 2

:run
pushd "%REPO_ROOT%"
docker compose --profile odds exec -T odds-worker python settle_real_paper_snapshots.py --limit %LIMIT% %DRY_RUN% %REQUIRE_CLOSING%
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
  echo settle_real_paper_snapshots.py fallo con exit code %EXIT_CODE%
  exit /b %EXIT_CODE%
)

endlocal
