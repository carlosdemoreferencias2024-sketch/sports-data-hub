@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_context_refresh.ps1" %*
