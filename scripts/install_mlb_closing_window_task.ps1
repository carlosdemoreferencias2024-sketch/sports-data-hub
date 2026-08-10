param(
  [string]$TaskName = "SportsDataHubMlbClosingWindow",
  [int]$IntervalMinutes = 2,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run_mlb_closing_window_cycle.ps1"
if (-not (Test-Path -LiteralPath $runner)) { throw "No existe $runner" }

$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
if ($DryRun) { $arguments += " -DryRun" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "MLB closing watcher: local queue check every 2 minutes; capture only in the 10-to-3 minute pregame window. No real money." -Force | Out-Null
Write-Host "[mlb-closing-window-task] installed task=$TaskName interval_minutes=$IntervalMinutes"
