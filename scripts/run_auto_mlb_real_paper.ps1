param(
  [string]$Date = (Get-Date).ToString("yyyy-MM-dd"),
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$SportsDataIoApiKey = $(if ($env:SPORTSDATAIO_API_KEY) { $env:SPORTSDATAIO_API_KEY } else { $env:SPORTS_DATA_IO_API_KEY }),
  [int]$ClosingHourLocal = 22,
  [switch]$ForceEntry,
  [switch]$ForceClosing,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($ForceEntry -and $ForceClosing) {
  throw "Usa solo una bandera: -ForceEntry o -ForceClosing."
}

$now = Get-Date
$mode = "entry"
if ($ForceClosing -or (-not $ForceEntry -and $now.Hour -ge $ClosingHourLocal)) {
  $mode = "closing"
}

$argsList = @(
  "-Date", $Date,
  "-HubBaseUrl", $HubBaseUrl,
  "-InternalApiKey", $InternalApiKey,
  "-SportsDataIoApiKey", $SportsDataIoApiKey
)

if ($mode -eq "closing") {
  $argsList += @("-ClosingOnly", "-Settle")
}
if ($DryRun) {
  $argsList += "-DryRun"
}

Write-Host "[auto-mlb] mode=$mode date=$Date closing_hour_local=$ClosingHourLocal dry_run=$DryRun"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run_daily_mlb_real_paper.ps1") @argsList
