param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$RuntimeRoot = "C:\Users\tsacl\Documents\SportsDataHubRuntime",
  [string]$PythonExe = "C:\Users\tsacl\AppData\Local\Python\pythoncore-3.14-64\python.exe",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { (Resolve-Path -LiteralPath $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
Set-Location $repoRoot

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

function Get-Prop($Object, [string]$Name, $Default = $null) {
  if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $Default
}

if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { $InternalApiKey = Get-DotEnvValue "INTERNAL_API_KEY" }
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { $InternalApiKey = Get-DotEnvValue "SPORTS_DATA_HUB_INTERNAL_KEY" }
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { throw "INTERNAL_API_KEY is required" }
if (-not (Test-Path -LiteralPath $PythonExe)) { throw "Python executable not found: $PythonExe" }

$headers = @{ "X-Internal-API-Key"=$InternalApiKey; "X-API-Key"=$InternalApiKey }
function Invoke-HubJson([string]$Method, [string]$Path, [object]$Body = $null, [int]$TimeoutSec = 60) {
  $params = @{
    Method = $Method
    Uri = "$HubBaseUrl$Path"
    Headers = $headers
    ContentType = "application/json"
    TimeoutSec = $TimeoutSec
  }
  if ($null -ne $Body) { $params.Body = $Body | ConvertTo-Json -Depth 20 }
  Invoke-RestMethod @params
}

$logDir = Join-Path $repoRoot "logs\clock"
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logPath = Join-Path $logDir "football-near-start.log"
function Write-ClockLog([string]$Stage, [string]$Detail = "") {
  Add-Content -LiteralPath $logPath -Value ("{0} stage={1} {2}" -f [DateTimeOffset]::UtcNow.ToString("o"), $Stage, $Detail) -Encoding UTF8
}

Write-ClockLog "START" "date=$Date dry_run=$([bool]$DryRun)"
$focusLock = Invoke-HubJson "Post" "/api/v1/internal/analytics/football/operational-focus/acquire" @{ date=$Date }
if (-not $focusLock.focus) {
  Write-ClockLog "NO_FOCUS" ([string]$focusLock.system_status)
  [pscustomobject]@{
    system_status = "FOOTBALL_NEAR_START_NO_OPERATIONAL_FOCUS"
    date = $Date
    focus_status = $focusLock.system_status
    guardrails = @{ real_candidate_count=0; real_money_enabled=$false; kelly_enabled=$false; telegram_auto_enabled=$false }
  } | ConvertTo-Json -Depth 8
  exit 0
}

$matchId = [string]$focusLock.focus.match_id
$kickoff = [DateTimeOffset]::Parse([string]$focusLock.focus.kickoff).ToUniversalTime()
$minutes = ($kickoff - [DateTimeOffset]::UtcNow).TotalMinutes
$entryWindowActive = (($minutes -ge 60 -and $minutes -le 90) -or ($minutes -ge 20 -and $minutes -le 45))
$dateQuery = [uri]::EscapeDataString($Date)
$queue = Invoke-HubJson "Get" "/api/v1/internal/analytics/clean-sample-queue?date=$dateQuery&sport=soccer&limit=240"
$queueRow = @($queue.rows | Where-Object { [string]$_.match_id -eq $matchId }) | Select-Object -First 1

$entryCapture = $null
$stageErrors = [Collections.Generic.List[string]]::new()
if ($entryWindowActive -and -not (Get-Prop $queueRow "entry_evidence_id" "")) {
  try {
    Write-ClockLog "ENTRY_CAPTURE_START" "match_id=$matchId minutes=$([Math]::Round($minutes,1))"
    $scraperScript = Join-Path $repoRoot "scripts\run_football_scraper_cycle.ps1"
    $scraperArgs = @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scraperScript,
      "-Date", $Date, "-RepoRoot", $repoRoot, "-RuntimeRoot", $RuntimeRoot,
      "-PythonExe", $PythonExe, "-HubBaseUrl", $HubBaseUrl, "-InternalApiKey", $InternalApiKey,
      "-MatchId", $matchId, "-SnapshotType", "current", "-CaptureMarket", "-AutoImportProviderEvidence"
    )
    if ($DryRun) { $scraperArgs += "-DryRun" }
    $entryCapture = @(& powershell.exe @scraperArgs 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "FOOTBALL_ENTRY_CAPTURE_FAILED match_id=$matchId detail=$entryCapture" }
    Write-ClockLog "ENTRY_CAPTURE_DONE" "match_id=$matchId"
  } catch {
    $stageErrors.Add("entry_capture:$($_.Exception.Message)")
    Write-ClockLog "ENTRY_CAPTURE_FAILED" "match_id=$matchId error=$($_.Exception.Message)"
  }
}

$formalCapture = $null
if ($entryWindowActive) {
  try {
    Write-ClockLog "CONTEXT_CAPTURE_START" "match_id=$matchId minutes=$([Math]::Round($minutes,1))"
    $captureWorker = Join-Path $RuntimeRoot "espn_football_near_start_capture.py"
    if (-not (Test-Path -LiteralPath $captureWorker)) { $captureWorker = Join-Path $repoRoot "workers\espn_football_near_start_capture.py" }
    if (-not (Test-Path -LiteralPath $captureWorker)) { throw "Football near-start capture worker not found: $captureWorker" }
    $captureArgs = @(
      $captureWorker,
      "--date", $Date,
      "--match-id", $matchId,
      "--api-key", $InternalApiKey,
      "--target-api-url", "$HubBaseUrl/api/v1/internal/analytics/football/near-start-capture/target",
      "--official-context-api-url", "$HubBaseUrl/api/v1/internal/analytics/football/near-start-capture/official-context",
      "--formal-context-import-url", "$HubBaseUrl/api/v1/internal/analytics/football/provider-near-start-capture",
      "--output-root", (Join-Path $repoRoot "uploads\source-captures\scraper-inbox")
    )
    if ($DryRun) { $captureArgs += "--dry-run" }
    $captureOutput = @(& $PythonExe @captureArgs 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Football near-start capture failed: $($captureOutput -join ' ')" }
    $formalCapture = ($captureOutput -join "`n") | ConvertFrom-Json
    Write-ClockLog "CONTEXT_CAPTURE_DONE" "match_id=$matchId status=$([string]$formalCapture.system_status) imported=$([bool](Get-Prop $formalCapture 'auto_import' $false))"
  } catch {
    $stageErrors.Add("context_capture:$($_.Exception.Message)")
    Write-ClockLog "CONTEXT_CAPTURE_FAILED" "match_id=$matchId error=$($_.Exception.Message)"
  }
}

$nearStart = Invoke-HubJson "Post" "/api/v1/internal/analytics/football/near-start-context/run" @{
  date=$Date
  apply=(-not $DryRun)
  fallback_recent=$false
} 180
$candidatePreflight = Invoke-HubJson "Post" "/api/v1/internal/analytics/candidate-preflight/run" @{
  match_id=$matchId
  decision_as_of=[DateTimeOffset]::UtcNow.ToString("o")
}

$shadow = $null
if (-not $DryRun -and [bool]$candidatePreflight.eligible_for_shadow_ticket) {
  $shadowPath = "/api/v1/internal/model-quotes/owned-fair-odds-bridge/register-shadow-review?sport=soccer&match_id=$([uri]::EscapeDataString($matchId))&model_name=sports_data_hub_football_fair_odds_v3&min_ev=0.03&min_shadow_confidence=0.50&max_model_age_minutes=1440&max_market_age_minutes=240&limit=1&dry_run=false&apply=true"
  $shadow = Invoke-HubJson "Post" $shadowPath @{} 120
  Write-ClockLog "SHADOW_REVIEW" "match_id=$matchId inserted=$([int](Get-Prop (Get-Prop $shadow 'feed_summary' $null) 'inserted' 0))"
}

$command = Invoke-HubJson "Get" "/api/v1/internal/analytics/command-center"
$realCandidate = [int](Get-Prop $command "real_candidate_count" 0)
$realMoney = [bool](Get-Prop $command "real_money_enabled" $false)
$kelly = [bool](Get-Prop $command "kelly_enabled" $false)
$telegram = [bool](Get-Prop $command "telegram_auto_enabled" $false)
if ($realCandidate -ne 0 -or $realMoney -or $kelly -or $telegram) {
  throw "GUARDRAIL_BROKEN real_candidate=$realCandidate real_money=$realMoney kelly=$kelly telegram=$telegram"
}

$result = [pscustomobject]@{
  system_status = "FOOTBALL_NEAR_START_CLOCK_AUTOMATED_V1"
  date = $Date
  match_id = $matchId
  match = "$([string]$focusLock.focus.away_team) @ $([string]$focusLock.focus.home_team)"
  kickoff = $kickoff.ToString("o")
  minutes_until_start = [Math]::Round($minutes, 1)
  entry_window_active = $entryWindowActive
  entry_capture = $entryCapture
  formal_capture = $formalCapture
  stage_errors = @($stageErrors)
  candidate_preflight = @{
    verdict = $candidatePreflight.candidate_snapshot.verdict
    reasons = @($candidatePreflight.candidate_snapshot.reasons_json)
    eligible_for_shadow_ticket = [bool]$candidatePreflight.eligible_for_shadow_ticket
  }
  shadow_registration = $shadow
  derived_context = @($nearStart.rows | Where-Object { [string]$_.match_id -eq $matchId } | Select-Object -First 1)
  guardrails = @{ real_candidate_count=0; real_money_enabled=$false; kelly_enabled=$false; telegram_auto_enabled=$false; kill_switch_enabled=$true }
}
$result | ConvertTo-Json -Depth 16
Write-ClockLog "DONE" "match_id=$matchId preflight=$([string]$candidatePreflight.candidate_snapshot.verdict)"
if ($stageErrors.Count) { exit 1 }
exit 0
