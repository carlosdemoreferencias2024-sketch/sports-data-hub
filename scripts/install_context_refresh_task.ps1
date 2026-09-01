param(
  [string]$TaskName = "SportsDataHubContextRefresh",
  [int]$IntervalMinutes = 30,
  [string]$InternalApiKey = $env:INTERNAL_API_KEY,
  [string]$ApiFootballKey = $env:API_FOOTBALL_KEY,
  [string]$SportsDataIoApiKey = $env:SPORTSDATAIO_API_KEY,
  [switch]$ApplyCalendar,
  [switch]$ApplyFootballContext,
  [switch]$IncludeTomorrow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $PSScriptRoot "run_context_refresh.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) { throw "No existe $scriptPath" }

function Add-Arg([System.Collections.Generic.List[string]]$Args, [string]$Name, [string]$Value) {
  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    $Args.Add($Name)
    $Args.Add(('"{0}"' -f ($Value -replace '"','\"')))
  }
}

$argsList = New-Object System.Collections.Generic.List[string]
$argsList.Add("-NoProfile")
$argsList.Add("-NonInteractive")
$argsList.Add("-WindowStyle")
$argsList.Add("Hidden")
$argsList.Add("-ExecutionPolicy")
$argsList.Add("Bypass")
$argsList.Add("-File")
$argsList.Add(('"{0}"' -f $scriptPath))
Add-Arg $argsList "-InternalApiKey" $InternalApiKey
Add-Arg $argsList "-ApiFootballKey" $ApiFootballKey
Add-Arg $argsList "-SportsDataIoApiKey" $SportsDataIoApiKey
if ($ApplyCalendar) { $argsList.Add("-ApplyCalendar") }
if ($ApplyFootballContext) { $argsList.Add("-ApplyFootballContext") }
if ($IncludeTomorrow) { $argsList.Add("-IncludeTomorrow") }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($argsList -join " ") -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "sports-data-hub safe calendar and lineup/team context refresh. Real money/Kelly/Telegram stay off." -Force | Out-Null

Write-Host "[context-refresh-task] installed task=$TaskName interval_minutes=$IntervalMinutes apply_calendar=$ApplyCalendar apply_football_context=$ApplyFootballContext include_tomorrow=$IncludeTomorrow"
Write-Host "[context-refresh-task] script=$scriptPath"
Write-Host "[context-refresh-task] run manually: scripts\run_context_refresh.cmd -ApplyFootballContext"
