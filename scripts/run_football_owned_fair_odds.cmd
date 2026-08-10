@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_football_owned_fair_odds.ps1" %*
exit /b %ERRORLEVEL%
