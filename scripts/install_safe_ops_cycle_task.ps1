param(
  [string]$TaskName = "SportsDataHubSafeOpsCycle",
  [int]$IntervalMinutes = 30,
  [string]$InternalApiKey = $env:INTERNAL_API_KEY,
  [string]$SportsDataIoApiKey = $env:SPORTSDATAIO_API_KEY,
  [string]$ApiFootballKey = $env:API_FOOTBALL_KEY,
  [int]$ClosingHourLocal = 22,
  [int]$FootballMaxApiRequests = 20,
  [switch]$DryRun,
  [switch]$SkipFootball,
  [switch]$SkipMlb,
  [switch]$SkipBackup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run_safe_ops_cycle.ps1"
if (-not (Test-Path -LiteralPath $runner)) { throw "No existe $runner" }

function Add-Arg([System.Collections.Generic.List[string]]$Args, [string]$Name, [string]$Value) {
  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    $Args.Add($Name)
    $Args.Add(('"{0}"' -f ($Value -replace '"','\"')))
  }
}

$argsList = New-Object System.Collections.Generic.List[string]
$argsList.Add("-NoProfile")
$argsList.Add("-ExecutionPolicy")
$argsList.Add("Bypass")
$argsList.Add("-File")
$argsList.Add(('"{0}"' -f $runner))
Add-Arg $argsList "-InternalApiKey" $InternalApiKey
Add-Arg $argsList "-SportsDataIoApiKey" $SportsDataIoApiKey
Add-Arg $argsList "-ApiFootballKey" $ApiFootballKey
$argsList.Add("-ClosingHourLocal")
$argsList.Add([string]$ClosingHourLocal)
$argsList.Add("-FootballMaxApiRequests")
$argsList.Add([string]$FootballMaxApiRequests)
if ($DryRun) { $argsList.Add("-DryRun") }
if ($SkipFootball) { $argsList.Add("-SkipFootball") }
if ($SkipMlb) { $argsList.Add("-SkipMlb") }
if ($SkipBackup) { $argsList.Add("-SkipBackup") }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($argsList -join " ") -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 35)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "sports-data-hub safe ops cycle: backup, football context, MLB near-start, entry/closing, guardrails. No real money/Kelly/Telegram." -Force | Out-Null

Write-Host "[safe-ops-task] installed task=$TaskName interval_minutes=$IntervalMinutes dry_run=$DryRun"
Write-Host "[safe-ops-task] runner=$runner"
Write-Host "[safe-ops-task] guardrails: REAL_CANDIDATE=0 real_money=false kelly=false telegram_auto=false"
