param(
  [string]$TaskName = "SportsDataHubPostgresBackup",
  [string]$Time = "03:15",
  [int]$RetentionDays = 14
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $RepoRoot "scripts\backup_postgres.ps1"

if (-not (Test-Path -LiteralPath $ScriptPath)) {
  throw "Missing backup script: $ScriptPath"
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -RetentionDays $RetentionDays" `
  -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -Daily -At $Time
$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Sports Data Hub PostgreSQL daily local backup" `
    -Force | Out-Null

  Write-Host "[backup-task] installed=$TaskName time=$Time retention_days=$RetentionDays"
} catch {
  Write-Host "[backup-task] scheduled task failed: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "[backup-task] fallback: run scripts\backup_postgres.cmd manually, or run this installer from an elevated PowerShell." -ForegroundColor Yellow
  throw
}
