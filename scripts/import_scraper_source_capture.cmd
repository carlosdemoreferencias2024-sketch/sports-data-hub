@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0import_scraper_source_capture.ps1" %*
exit /b %errorlevel%
