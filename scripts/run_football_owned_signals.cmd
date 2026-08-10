@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_football_owned_signals.ps1" %*
exit /b %ERRORLEVEL%
