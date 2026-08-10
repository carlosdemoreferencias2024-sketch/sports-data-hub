@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_mlb_fixture_time_repair.ps1" %*
exit /b %ERRORLEVEL%
