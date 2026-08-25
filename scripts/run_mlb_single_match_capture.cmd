@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_mlb_single_match_capture.ps1" %*
exit /b %ERRORLEVEL%
