@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_sports_research_worker.ps1" %*
