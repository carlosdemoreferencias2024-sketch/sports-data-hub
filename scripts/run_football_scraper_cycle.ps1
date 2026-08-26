param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$RuntimeRoot = "C:\Users\tsacl\Documents\SportsDataHubRuntime",
  [string]$PythonExe = "C:\Users\tsacl\AppData\Local\Python\pythoncore-3.14-64\python.exe",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [double]$MinEv = 0.03,
  [double]$MinConfidence = 0.50,
  [switch]$CaptureMarket,
  [switch]$Quiet,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { [System.IO.Path]::GetFullPath($RepoRoot) } else { Split-Path -Parent $PSScriptRoot }

function Get-DotEnvValue([string[]]$Names) {
  $envPath = Join-Path $repoRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { return "" }
  foreach ($name in $Names) {
    $prefix = "$name="
    $matches = @(Get-Content -LiteralPath $envPath | ForEach-Object {
      $trimmed = $_.Trim()
      if ($trimmed.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
        $trimmed.Substring($prefix.Length).Trim('"').Trim("'")
      }
    })
    if ($matches.Count) { return [string]$matches[-1] }
  }
  return ""
}

if (-not $InternalApiKey) { $InternalApiKey = Get-DotEnvValue @("INTERNAL_API_KEY", "SPORTS_DATA_HUB_INTERNAL_KEY") }
if (-not $InternalApiKey) { throw "INTERNAL_API_KEY is required" }
if (-not (Test-Path -LiteralPath $PythonExe)) { throw "Python executable not found: $PythonExe" }

$headers = @{ "X-Internal-API-Key" = $InternalApiKey; "X-API-Key" = $InternalApiKey }
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

$queue = Invoke-HubJson "Get" "/api/v1/internal/analytics/clean-sample-queue?date=$([uri]::EscapeDataString($Date))&sport=soccer&limit=120"
$focus = @($queue.focus_rows) | Select-Object -First 1
if (-not $focus) {
  if (-not $Quiet) {
    [pscustomobject]@{ system_status = "FOOTBALL_SCRAPER_NO_FOCUS"; date = $Date; decision = "NO_PICK" } | ConvertTo-Json -Depth 6
  }
  exit 0
}

$kickoff = if ($focus.kickoff -is [DateTime]) {
  [DateTimeOffset]::new([DateTime]$focus.kickoff).ToUniversalTime()
} else {
  [DateTimeOffset]::Parse(
    [string]$focus.kickoff,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal
  ).ToUniversalTime()
}
if ([DateTimeOffset]::UtcNow -ge $kickoff) {
  if (-not $Quiet) {
    [pscustomobject]@{ system_status = "FOOTBALL_SCRAPER_POST_KICKOFF_AUDIT_ONLY"; match_id = [string]$focus.match_id; decision = "NO_PICK" } | ConvertTo-Json -Depth 6
  }
  exit 0
}

$matchParts = @([string]$focus.match -split '\s+@\s+', 2)
if ($matchParts.Count -ne 2) { throw "Unsupported football match label: $($focus.match)" }
$expectedAway = $matchParts[0].Trim()
$expectedHome = $matchParts[1].Trim()
$worker = Join-Path $RuntimeRoot "espn_soccer_scraper.py"
if (-not (Test-Path -LiteralPath $worker)) { $worker = Join-Path $repoRoot "workers\espn_soccer_scraper.py" }
if (-not (Test-Path -LiteralPath $worker)) { throw "Football scraper not found: $worker" }
$providerLeagueSlug = if ([string]$focus.league -eq "football-observed-nwsl") { "nwsl" } else { [string]$focus.league }

$workerArgs = @(
  $worker,
  "--date", $Date,
  "--match-id", [string]$focus.match_id,
  "--expected-home", $expectedHome,
  "--expected-away", $expectedAway,
  "--expected-kickoff", $kickoff.ToString("o"),
  "--league-slug", $providerLeagueSlug,
  "--api-key", $InternalApiKey,
  "--history-api-url", "$HubBaseUrl/api/v1/internal/analytics/ingest-historical-matches",
  "--output-root", (Join-Path $repoRoot "uploads\source-captures\scraper-inbox"),
  "--evidence-root", (Join-Path $repoRoot "uploads\provider-evidence\football")
)
if (-not $DryRun) { $workerArgs += "--apply-history" }
if ($CaptureMarket) { $workerArgs += "--capture-market" }

$workerOutput = @(& $PythonExe @workerArgs 2>&1)
if ($LASTEXITCODE -ne 0) { throw "Football scraper failed: $($workerOutput -join ' ')" }
$scrape = ($workerOutput -join "`n") | ConvertFrom-Json
if ([string]$scrape.system_status -ne "ESPN_SOCCER_SCRAPER_OK") {
  if (-not $Quiet) {
    [pscustomobject]@{
      system_status = "FOOTBALL_SCRAPER_NO_MATCHING_EVENT"
      date = $Date
      match_id = [string]$focus.match_id
      match = [string]$focus.match
      kickoff = $kickoff.ToString("o")
      decision = "NO_PICK"
      reason = if ($scrape.PSObject.Properties.Name -contains "reason") {
        [string]$scrape.reason
      } else {
        [string]$scrape.system_status
      }
      guardrails = $scrape.guardrails
    } | ConvertTo-Json -Depth 10
  }
  exit 0
}

$fair = Invoke-HubJson "Post" "/api/v1/internal/analytics/football-owned-fair-odds/run" @{
  date = $Date
  match_id = [string]$focus.match_id
  model_name = "sports_data_hub_football_fair_odds_v3"
  model_version = "v3"
  min_ev = $MinEv
  apply = -not [bool]$DryRun
  limit = 1
} 120
$moneyline = @($fair.rows | Where-Object { [string]$_.market_type -eq "moneyline_3way" }) | Select-Object -First 1
$market = $scrape.market_capture

$comparisons = @()
if ($moneyline -and $market) {
  foreach ($selection in @("home", "draw", "away")) {
    $probability = [double]$moneyline."${selection}_probability"
    $marketOdds = [double]$market."${selection}_decimal"
    $comparisons += [pscustomobject]@{
      selection = $selection
      probability = [Math]::Round($probability, 6)
      fair_odds = [Math]::Round(1 / $probability, 4)
      market_odds = $marketOdds
      expected_value = [Math]::Round(($probability * $marketOdds) - 1, 6)
    }
  }
}
$best = @($comparisons | Sort-Object expected_value -Descending) | Select-Object -First 1
$candidatePreflight = try {
  Invoke-HubJson "Post" "/api/v1/internal/analytics/candidate-preflight/run" @{
    match_id = [string]$focus.match_id
    decision_as_of = [DateTimeOffset]::UtcNow.ToString("o")
  }
} catch {
  [pscustomobject]@{
    eligible_for_shadow_ticket = $false
    candidate_snapshot = [pscustomobject]@{
      verdict = "FAIL"
      reasons_json = @("CANDIDATE_PREFLIGHT_UNAVAILABLE")
    }
  }
}

$blockers = [Collections.Generic.List[string]]::new()
if (-not $moneyline) { $blockers.Add("FAIR_ODDS_V3_MISSING") }
if (-not $market) { $blockers.Add("FORMAL_1X2_MARKET_MISSING") }
if ($market) { $blockers.Add("HUMAN_EVIDENCE_VERIFICATION_REQUIRED") }
if ($moneyline -and [double]$moneyline.confidence -lt $MinConfidence) { $blockers.Add("MODEL_CONFIDENCE_BELOW_THRESHOLD") }
if ($best -and [double]$best.expected_value -lt $MinEv) { $blockers.Add("EV_BELOW_THRESHOLD") }
if (-not [bool]$candidatePreflight.eligible_for_shadow_ticket) { $blockers.Add("CANDIDATE_PREFLIGHT_NOT_PASS") }

$hasDraftValue = $best -and $moneyline -and $market -and [double]$moneyline.confidence -ge $MinConfidence -and [double]$best.expected_value -ge $MinEv
$decision = if ($hasDraftValue) { "PAPER_PICK_DRAFT_PENDING_EVIDENCE_VERIFICATION" } else { "NO_PICK" }
$selectedTeam = if (-not $best) { $null } elseif ($best.selection -eq "home") { $expectedHome } elseif ($best.selection -eq "away") { $expectedAway } else { "Draw" }

$result = [pscustomobject]@{
  system_status = "FOOTBALL_SCRAPER_FAIR_ODDS_PICK_CYCLE_V1"
  date = $Date
  match_id = [string]$focus.match_id
  match = [string]$focus.match
  kickoff = $kickoff.ToString("o")
  provider_event_id = [string]$scrape.event_id
  decision = $decision
  pick = if ($hasDraftValue) { @{
    selection = [string]$best.selection
    team = $selectedTeam
    market = "moneyline_3way"
    market_odds = $best.market_odds
    fair_odds = $best.fair_odds
    model_probability = $best.probability
    expected_value = $best.expected_value
    model_confidence = if ($moneyline) { $moneyline.confidence } else { $null }
  } } else { $null }
  best_candidate = if ($best) { @{
    selection = [string]$best.selection
    team = $selectedTeam
    market_odds = $best.market_odds
    fair_odds = $best.fair_odds
    model_probability = $best.probability
    expected_value = $best.expected_value
    model_confidence = if ($moneyline) { $moneyline.confidence } else { $null }
  } } else { $null }
  all_selections = $comparisons
  evidence = if ($market) { @{
    status = [string]$market.status
    bookmaker = [string]$market.bookmaker
    draft_path = [string]$market.draft_path
    screenshot_path = [string]$market.screenshot_path
    screenshot_sha256 = [string]$market.screenshot_sha256
    evidence_id = [string]$market.evidence_id
    captured_at = [string]$market.captured_at
  } } else { $null }
  fair_odds = @{
    priced_matches = $fair.priced_matches
    quotes_generated = $fair.quotes_generated
    applied = -not [bool]$DryRun
    skipped = @($fair.skipped_rows)
  }
  candidate_preflight = @{
    verdict = $candidatePreflight.candidate_snapshot.verdict
    reasons = @($candidatePreflight.candidate_snapshot.reasons_json)
    eligible_for_shadow_ticket = [bool]$candidatePreflight.eligible_for_shadow_ticket
  }
  blockers = @($blockers | Select-Object -Unique)
  guardrails = @{
    picks_created = 0
    max_paper_shadow = 1
    real_candidate = 0
    real_money_enabled = $false
    kelly_enabled = $false
    telegram_auto_enabled = $false
    autopost_enabled = $false
    kill_switch_enabled = $true
  }
}
if (-not $Quiet) { $result | ConvertTo-Json -Depth 16 }
exit 0
