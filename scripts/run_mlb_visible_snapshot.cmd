@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0register_mlb_visible_entry.ps1" %*
exit /b %ERRORLEVEL%
