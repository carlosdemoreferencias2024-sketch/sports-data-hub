param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$RuntimeRoot = "C:\Users\tsacl\Documents\SportsDataHubRuntime",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { (Resolve-Path -LiteralPath $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$scriptRoot = Join-Path $repoRoot "scripts"
Set-Location $repoRoot
$logDir = Join-Path $repoRoot "logs\clock"
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir "closing-watch.log"
function Write-ClockLog([string]$Stage, [string]$Detail = "") {
  Add-Content -LiteralPath $logPath -Value ("{0} stage={1} {2}" -f [DateTimeOffset]::UtcNow.ToString("o"), $Stage, $Detail) -Encoding UTF8
}
Write-ClockLog "START" "date=$Date"

function Get-DotEnvValue([string]$Name) {
  $envPath = Join-Path $repoRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { return "" }
  $prefix = "$Name="
  foreach ($line in Get-Content -LiteralPath $envPath) {
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
      return $trimmed.Substring($prefix.Length).Trim('"').Trim("'")
    }
  }
  return ""
}

if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { $InternalApiKey = Get-DotEnvValue "INTERNAL_API_KEY" }
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { $InternalApiKey = Get-DotEnvValue "SPORTS_DATA_HUB_INTERNAL_KEY" }
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { throw "INTERNAL_API_KEY is required" }

function Get-Prop($Object, [string]$Name, $Default = $null) {
  if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $Default
}

$headers = @{ "X-Internal-API-Key"=$InternalApiKey; "X-API-Key"=$InternalApiKey }
$dateQuery = [uri]::EscapeDataString($Date)
$watchUrl = "$HubBaseUrl/api/v1/internal/analytics/closing-window-watch?date=$dateQuery&sport=all&limit=240"
Write-ClockLog "FETCH_START" $watchUrl
$watchJson = & curl.exe -sS --connect-timeout 5 --max-time 15 -H "X-Internal-API-Key: $InternalApiKey" -H "X-API-Key: $InternalApiKey" $watchUrl 2>&1
if ($LASTEXITCODE -ne 0) { throw "CLOSING_WATCH_HTTP_FAILED exit=$LASTEXITCODE detail=$watchJson" }
$watch = $watchJson | ConvertFrom-Json
Write-ClockLog "FETCH_DONE" "rows=$(@($watch.rows).Count)"
$rows = @($watch.rows)
$captureNow = @($rows | Where-Object { (Get-Prop $_ "action" "") -eq "CAPTURE_CLOSING_NOW" })
$mlbNow = @($captureNow | Where-Object { ([string](Get-Prop $_ "sport" "")).ToLowerInvariant() -in @("mlb","baseball") })
$footballNow = @($captureNow | Where-Object { ([string](Get-Prop $_ "sport" "")).ToLowerInvariant() -in @("soccer","football") })
$nflNow = @($captureNow | Where-Object { ([string](Get-Prop $_ "sport" "")).ToLowerInvariant() -in @("american_football","american-football","nfl") })

$footballOutput = ""
$focusBody = @{ date=$Date } | ConvertTo-Json -Depth 5
$focusLock = Invoke-RestMethod -Method Post -Uri "$HubBaseUrl/api/v1/internal/analytics/football/operational-focus/acquire" -Headers $headers -ContentType "application/json" -Body $focusBody -TimeoutSec 60
if ($focusLock.focus) {
  $focusMatchId = [string]$focusLock.focus.match_id
  $focusKickoff = [DateTimeOffset]::Parse([string]$focusLock.focus.kickoff).ToUniversalTime()
  $focusMinutes = ($focusKickoff - [DateTimeOffset]::UtcNow).TotalMinutes
  $cleanQueue = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/v1/internal/analytics/clean-sample-queue?date=$dateQuery&sport=soccer&limit=240" -Headers $headers -TimeoutSec 60
  $focusRow = @($cleanQueue.rows | Where-Object { [string]$_.match_id -eq $focusMatchId }) | Select-Object -First 1
  $hasEntry = [bool](Get-Prop $focusRow "entry_evidence_id" "")
  $hasClosing = [bool](Get-Prop $focusRow "closing_evidence_id" "")
  if ($focusMinutes -ge 3 -and $focusMinutes -le 10 -and $hasEntry -and -not $hasClosing) {
    Write-ClockLog "FOOTBALL_CAPTURE_START" "match_id=$focusMatchId minutes=$([Math]::Round($focusMinutes,1))"
    $footballArgs = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $scriptRoot "run_football_scraper_cycle.ps1"),
      "-Date", $Date, "-RepoRoot", $repoRoot, "-RuntimeRoot", $RuntimeRoot,
      "-HubBaseUrl", $HubBaseUrl, "-InternalApiKey", $InternalApiKey,
      "-MatchId", $focusMatchId, "-SnapshotType", "closing", "-CaptureMarket", "-AutoImportProviderEvidence"
    )
    if ($DryRun) { $footballArgs += "-DryRun" }
    $footballOutput = @(& powershell.exe @footballArgs 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "FOOTBALL_CLOSING_WATCH_FAILED exit=$LASTEXITCODE detail=$footballOutput" }
    Write-ClockLog "FOOTBALL_CAPTURE_DONE" "match_id=$focusMatchId"
  }
}

$mlbOutput = ""
if ($mlbNow.Count -gt 0) {
  Write-ClockLog "MLB_CAPTURE_START" "count=$($mlbNow.Count)"
  $args = @("-Date", $Date)
  if ($DryRun) { $args += "-DryRun" }
  $mlbOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot "run_mlb_closing_window_cycle.ps1") @args 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "MLB_CLOSING_WATCH_FAILED exit=$LASTEXITCODE detail=$mlbOutput" }
  Write-ClockLog "MLB_CAPTURE_DONE"
}

[pscustomobject]@{
  system_status = "DUAL_SPORT_CLOSING_WATCH"
  checked_at = [DateTimeOffset]::UtcNow.ToString("o")
  capture_closing_now = @($captureNow | Select-Object match_id,sport,match,kickoff,minutes_to_start,action)
  mlb_capture_invoked = ($mlbNow.Count -gt 0)
  mlb_output = $mlbOutput.Trim()
  football_capture_required = @($footballNow | Select-Object match_id,match,kickoff,minutes_to_start,action)
  football_capture_invoked = -not [string]::IsNullOrWhiteSpace($footballOutput)
  football_output = $footballOutput.Trim()
  football_focus = $focusLock.focus
  nfl_capture_required = @($nflNow | Select-Object match_id,match,kickoff,minutes_to_start,action)
  real_money_enabled = $false
} | ConvertTo-Json -Depth 8
Write-ClockLog "DONE" "capture_now=$($captureNow.Count)"
exit 0
