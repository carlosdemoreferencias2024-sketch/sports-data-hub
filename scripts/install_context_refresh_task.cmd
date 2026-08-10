@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_context_refresh_task.ps1" %*
