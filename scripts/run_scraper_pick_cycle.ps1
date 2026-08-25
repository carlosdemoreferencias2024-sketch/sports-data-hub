param(
  [Parameter(Mandatory = $true)]
  [string]$MatchId,
  [Parameter(Mandatory = $true)]
  [string]$ProviderEventId,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedHomeTeam,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedAwayTeam,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedKickoff,
  [Parameter(Mandatory = $true)]
  [string]$Date,
  [string]$VerifiedBy = "sports_data_hub_scraper_review",
  [string]$EvidenceRoot = "",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [switch]$ApplyEvidence,
  [switch]$ApplyContext,
  [switch]$RegisterShadow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try { [void][Guid]::Parse($MatchId) } catch { throw "MatchId must be a UUID: $MatchId" }
$kickoffUtc = [DateTimeOffset]::Parse($ExpectedKickoff).ToUniversalTime()
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $EvidenceRoot) {
  $EvidenceRoot = Join-Path $repoRoot "uploads\source-captures\scraper-inbox"
}

$envPath = Join-Path $repoRoot ".env"
if (Test-Path -LiteralPath $envPath) {
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($name -and -not [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}
$InternalApiKey = if ($InternalApiKey) { $InternalApiKey } elseif ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }
if (-not $InternalApiKey) { throw "INTERNAL_API_KEY is not defined" }

$draft = Get-ChildItem -LiteralPath $EvidenceRoot -Recurse -File -Filter "espn__$ProviderEventId`__*.json" |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if (-not $draft) { throw "No scraper draft found for ESPN event $ProviderEventId under $EvidenceRoot" }

$importArgs = @{
  EvidencePath = $draft.FullName
  MatchId = $MatchId
  VerifiedBy = $VerifiedBy
  ExpectedHomeTeam = $ExpectedHomeTeam
  ExpectedAwayTeam = $ExpectedAwayTeam
  ExpectedKickoff = $kickoffUtc.ToString("o")
  HubBaseUrl = $HubBaseUrl
  InternalApiKey = $InternalApiKey
  ApplyVerifiedCapture = $true
}

Write-Host "[scraper-pick-cycle] validating=$($draft.FullName)"
$validationJson = & (Join-Path $PSScriptRoot "import_scraper_source_capture.ps1") @importArgs -DryRun
$validation = $validationJson | ConvertFrom-Json
if (-not $validation.validated) { throw "Scraper draft validation failed" }

$evidenceApplied = $false
if ($ApplyEvidence) {
  & (Join-Path $PSScriptRoot "import_scraper_source_capture.ps1") @importArgs | Out-Host
  $evidenceApplied = $true
}

$headers = @{
  "X-Internal-API-Key" = $InternalApiKey
  "X-API-Key" = $InternalApiKey
}

function Invoke-HubJson([string]$Method, [string]$Path, [object]$Body = $null) {
  $params = @{
    Method = $Method
    Uri = "$HubBaseUrl$Path"
    Headers = $headers
    ContentType = "application/json"
  }
  if ($null -ne $Body) { $params.Body = $Body | ConvertTo-Json -Depth 20 }
  return Invoke-RestMethod @params
}

$nearStart = Invoke-HubJson "Post" "/api/v1/internal/analytics/football/near-start-context/run" @{
  date = $Date
  apply = [bool]$ApplyContext
  fallback_recent = $false
}
$bridge = Invoke-HubJson "Get" "/api/v1/internal/model-quotes/owned-fair-odds-bridge?match_id=$([uri]::EscapeDataString($MatchId))&date=$([uri]::EscapeDataString($Date))&model_name=sports_data_hub_football_fair_odds_v3&limit=20"
$queue = Invoke-HubJson "Get" "/api/v1/internal/analytics/clean-sample-queue?date=$([uri]::EscapeDataString($Date))&sport=soccer&limit=120"
$candidatePreflight = Invoke-HubJson "Post" "/api/v1/internal/analytics/candidate-preflight/run" @{
  match_id = $MatchId
  decision_as_of = [DateTimeOffset]::UtcNow.ToString("o")
}

$nearRow = @($nearStart.rows | Where-Object { [string]$_.match_id -eq $MatchId }) | Select-Object -First 1
$queueRow = @($queue.rows | Where-Object { [string]$_.match_id -eq $MatchId }) | Select-Object -First 1
$candidateSnapshot = $candidatePreflight.candidate_snapshot
$bridgeRows = @($bridge.rows | Where-Object { [string]$_.match_id -eq $MatchId })
$readyRows = @($bridgeRows | Where-Object { [string]$_.bridge_status -eq "READY_FOR_SHADOW_REVIEW" })
$nearStatus = if ($nearRow -and $nearRow.PSObject.Properties["status"]) { [string]$nearRow.status } else { "UNKNOWN" }
$nearAction = if ($nearRow -and $nearRow.PSObject.Properties["action"]) { [string]$nearRow.action } else { "" }

$hardAuditFlags = @("CALIBRATING_CAP", "UNCALIBRATED_PRIOR_CAP", "MODEL_MARKET_GAP_HIGH", "EXTREME_EV_AUDIT")
$blockers = [Collections.Generic.List[string]]::new()
if ([DateTimeOffset]::UtcNow -ge $kickoffUtc) { $blockers.Add("EVENT_STARTED") }
if (-not $queueRow) {
  $blockers.Add("CLEAN_SAMPLE_QUEUE_ROW_MISSING")
} else {
  if (-not $queueRow.entry_evidence_id -or -not $queueRow.entry_screenshot_sha256) { $blockers.Add("ENTRY_EVIDENCE_MISSING") }
}
if (-not $nearRow) {
  $blockers.Add("NEAR_START_ROW_MISSING")
} elseif ($nearStatus -ne "READY") {
  $blockers.Add("NEAR_START_$nearStatus")
  if ($nearAction) { $blockers.Add($nearAction) }
}
if ($readyRows.Count -eq 0) { $blockers.Add("BRIDGE_NOT_READY_FOR_SHADOW_REVIEW") }
if (-not [bool]$candidatePreflight.eligible_for_shadow_ticket) {
  $blockers.Add("CANDIDATE_PREFLIGHT_FAIL")
  foreach ($reason in @($candidateSnapshot.reasons_json)) { $blockers.Add([string]$reason) }
}
foreach ($row in $bridgeRows) {
  foreach ($flag in @($row.audit_flags)) {
    if ($hardAuditFlags -contains [string]$flag) { $blockers.Add([string]$flag) }
  }
}

$uniqueBlockers = @($blockers | Select-Object -Unique)
$registration = $null
if ($RegisterShadow -and $uniqueBlockers.Count -eq 0) {
  $registrationJson = & (Join-Path $PSScriptRoot "run_football_shadow_review_register.ps1") `
    -HubBaseUrl $HubBaseUrl `
    -InternalApiKey $InternalApiKey `
    -Date $Date `
    -MatchId $MatchId `
    -ModelName "sports_data_hub_football_fair_odds_v3" `
    -Limit 10 `
    -Apply
  $registration = $registrationJson | ConvertFrom-Json
  if ([int]$registration.signals_prepared -gt 1 -or [int]$registration.feed_summary.inserted -gt 1) {
    throw "Guardrail violated: more than one shadow signal was prepared for the match"
  }
}

$decision = if ($uniqueBlockers.Count -gt 0) {
  "NO_PICK"
} elseif ($registration) {
  "SHADOW_REVIEW_REGISTERED"
} else {
  "PICK_READY_FOR_SHADOW_REGISTRATION"
}

$chainPreflight = $null
if ($registration) {
  $chainPreflight = Invoke-HubJson "Post" "/api/v1/internal/analytics/chain-preflight/run" @{
    date = $Date
    sport = "soccer"
    apply = $false
    limit = 120
  }
}

[pscustomobject]@{
  system_status = "SCRAPER_API_SHADOW_PICK_CYCLE_V1"
  match_id = $MatchId
  provider_event_id = $ProviderEventId
  draft_path = $draft.FullName
  evidence_validated = $true
  evidence_applied = $evidenceApplied
  context_applied = [bool]$ApplyContext
  decision = $decision
  blockers = $uniqueBlockers
  near_start = if ($nearRow) { @{
    status = $nearStatus
    action = $nearAction
    context_score = if ($nearRow.PSObject.Properties["context_score"]) { $nearRow.context_score } else { $null }
    market_score = if ($nearRow.PSObject.Properties["market_score"]) { $nearRow.market_score } else { $null }
    final_score = if ($nearRow.PSObject.Properties["final_score"]) { $nearRow.final_score } else { $null }
  } } else { $null }
  bridge = @{
    rows = $bridgeRows.Count
    ready = $readyRows.Count
    statuses = @($bridgeRows | ForEach-Object { $_.bridge_status } | Select-Object -Unique)
    audit_flags = @($bridgeRows | ForEach-Object { @($_.audit_flags) } | Select-Object -Unique)
  }
  candidate_preflight = @{
    verdict = $candidateSnapshot.verdict
    reasons = @($candidateSnapshot.reasons_json)
    snapshot_hash = $candidateSnapshot.snapshot_hash
    eligible_for_shadow_ticket = [bool]$candidatePreflight.eligible_for_shadow_ticket
  }
  chain_preflight = $chainPreflight
  registration = $registration
  guardrails = @{
    max_shadow_picks_per_match = 1
    real_candidate_count = 0
    real_money_enabled = $false
    kelly_enabled = $false
    telegram_auto_enabled = $false
    autopost_enabled = $false
    kill_switch_enabled = $true
  }
} | ConvertTo-Json -Depth 16
