@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_mlb_matchup_features.ps1" %*
