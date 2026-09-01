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

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dotenvPath = Join-Path $repoRoot ".env"

function Get-DotEnvValue {
  param([Parameter(Mandatory = $true)][string[]]$Names)

  if (-not (Test-Path -LiteralPath $dotenvPath)) { return $null }

  foreach ($name in $Names) {
    $line = Get-Content -LiteralPath $dotenvPath |
      Where-Object { $_ -match "^\s*$([regex]::Escape($name))\s*=" } |
      Select-Object -First 1
    if ($line) {
      return (($line -replace '^[^=]+=', '').Trim().Trim('"').Trim("'"))
    }
  }
  return $null
}

if (-not $InternalApiKey) {
  $InternalApiKey = Get-DotEnvValue @("INTERNAL_API_KEY", "SPORTS_DATA_HUB_INTERNAL_KEY")
}
if (-not $SportsDataIoApiKey) {
  $SportsDataIoApiKey = Get-DotEnvValue @("SPORTSDATAIO_API_KEY", "SPORTS_DATA_IO_API_KEY")
}

if (-not $InternalApiKey -or -not $SportsDataIoApiKey) {
  Write-Host "[auto-mlb] SKIPPED_MISSING_CREDENTIALS internal_api_key_present=$([bool]$InternalApiKey) sportsdataio_key_present=$([bool]$SportsDataIoApiKey)"
  exit 0
}

$mode = "entry"
$headers = @{ "x-internal-api-key" = $InternalApiKey }
$queueUrl = "$HubBaseUrl/api/v1/internal/analytics/clean-sample-queue?date=$Date&sport=baseball&limit=200"
$captureClosingNow = 0
try {
  $queue = Invoke-RestMethod -Method Get -Uri $queueUrl -Headers $headers -TimeoutSec 20
  $captureClosingNow = [int]$queue.summary.capture_closing_now
} catch {
  Write-Host "[auto-mlb] WINDOW_QUEUE_UNAVAILABLE closing_disabled reason=$($_.Exception.Message)"
}

if ($captureClosingNow -gt 0) {
  $mode = "closing"
}
if ($ForceClosing -and $captureClosingNow -eq 0) {
  Write-Host "[auto-mlb] SKIPPED_NO_VALID_CLOSING_WINDOW date=$Date fixed_hour_ignored=$ClosingHourLocal"
  exit 0
}
if ($ForceEntry) { $mode = "entry" }

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

Write-Host "[auto-mlb] mode=$mode date=$Date capture_closing_now=$captureClosingNow fixed_hour_ignored=$ClosingHourLocal dry_run=$DryRun"
& powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run_daily_mlb_real_paper.ps1") @argsList
