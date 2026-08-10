@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_sports_context_incremental_worker.ps1" %*
