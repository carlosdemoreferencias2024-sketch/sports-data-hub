@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_api_football_universe.ps1" %*
exit /b %ERRORLEVEL%