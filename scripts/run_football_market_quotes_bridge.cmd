@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_football_market_quotes_bridge.ps1" %*
exit /b %ERRORLEVEL%
