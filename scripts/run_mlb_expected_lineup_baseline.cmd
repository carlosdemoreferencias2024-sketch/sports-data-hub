@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_mlb_expected_lineup_baseline.ps1" %*
exit /b %ERRORLEVEL%
