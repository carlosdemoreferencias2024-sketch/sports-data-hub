@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_backtest_lab.ps1" %*
