param(
  [string]$TaskName = "SportsDataHubResume",
  [int]$DelayMinutes = 2
)

$ErrorActionPreference = "Stop"
$ScriptPath = Join-Path $PSScriptRoot "resume_sports_data_hub.ps1"
$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Trigger.Delay = "PT${DelayMinutes}M"
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Resume sports-data-hub Docker services and run safe dashboard checks after Windows logon." `
  -Force | Out-Null

Write-Host "Installed scheduled task: $TaskName"
Write-Host "It runs $DelayMinutes minute(s) after Windows logon."
Write-Host "Keep Docker Desktop configured to start on sign-in for best results."
