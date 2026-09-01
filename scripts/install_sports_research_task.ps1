param(
  [string]$TaskName = "SportsDataHubResearchWorker",
  [int]$IntervalMinutes = 30,
  [string]$InternalApiKey = $env:INTERNAL_API_KEY,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run_sports_research_worker.ps1"
if (-not (Test-Path -LiteralPath $runner)) { throw "No existe $runner" }

$argsList = New-Object System.Collections.Generic.List[string]
$argsList.Add("-NoProfile")
$argsList.Add("-NonInteractive")
$argsList.Add("-WindowStyle")
$argsList.Add("Hidden")
$argsList.Add("-ExecutionPolicy")
$argsList.Add("Bypass")
$argsList.Add("-File")
$argsList.Add(('"{0}"' -f $runner))
$argsList.Add("-Once")
if (-not [string]::IsNullOrWhiteSpace($InternalApiKey)) {
  $argsList.Add("-InternalApiKey")
  $argsList.Add(('"{0}"' -f ($InternalApiKey -replace '"','\"')))
}
if ($Apply) { $argsList.Add("-Apply") }

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($argsList -join " ") -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "sports-data-hub research worker. Collect/validate observations only; no picks, no money, no Kelly, no Telegram." -Force | Out-Null

Write-Host "[sports-research-task] installed task=$TaskName interval_minutes=$IntervalMinutes apply=$Apply"
Write-Host "[sports-research-task] runner=$runner"
