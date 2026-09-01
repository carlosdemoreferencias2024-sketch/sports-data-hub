param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [int]$Limit = 80,
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

$headers = @{ "X-Internal-API-Key" = $InternalApiKey; "X-API-Key" = $InternalApiKey }
function Invoke-HubJson([string]$Method, [string]$Path, [object]$Body = $null, [int]$TimeoutSec = 90) {
  $params = @{
    Method = $Method
    Uri = "$HubBaseUrl$Path"
    Headers = $headers
    ContentType = "application/json"
    TimeoutSec = $TimeoutSec
  }
  if ($null -ne $Body) { $params.Body = $Body | ConvertTo-Json -Depth 12 }
  Invoke-RestMethod @params
}

$queue = Invoke-HubJson "Get" "/api/v1/internal/analytics/clean-sample-queue?date=$([uri]::EscapeDataString($Date))&sport=soccer&limit=$Limit"
$nowUtc = [DateTimeOffset]::UtcNow
$pending = @($queue.rows | Where-Object {
  $kickoffUtc = if ($_.kickoff -is [DateTime]) {
    [DateTimeOffset]::new([DateTime]$_.kickoff).ToUniversalTime()
  } else {
    [DateTimeOffset]::Parse(
      [string]$_.kickoff,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::AssumeUniversal
    ).ToUniversalTime()
  }
  [string]$_.action -eq "GENERATE_OWNED_FAIR_ODDS" -and
  [bool]$_.calendar_trusted -and
  $kickoffUtc -gt $nowUtc
})

$rows = [Collections.Generic.List[object]]::new()
$errors = [Collections.Generic.List[string]]::new()
$pricedMatchesTotal = 0
$quotesGeneratedTotal = 0
$insertedTotal = 0
foreach ($candidate in $pending) {
  try {
    $response = Invoke-HubJson "Post" "/api/v1/internal/analytics/football-owned-fair-odds/run" @{
      date = $Date
      match_id = [string]$candidate.match_id
      model_name = "sports_data_hub_football_fair_odds_v3"
      model_version = "v3"
      min_ev = 0.03
      apply = -not [bool]$DryRun
      limit = 1
    } 120
    $pricedMatches = [int]$response.priced_matches
    $quotesGenerated = [int]$response.quotes_generated
    $inserted = [int]$response.inserted
    $pricedMatchesTotal += $pricedMatches
    $quotesGeneratedTotal += $quotesGenerated
    $insertedTotal += $inserted
    $rows.Add([pscustomobject]@{
      match_id = [string]$candidate.match_id
      match = [string]$candidate.match
      priced_matches = $pricedMatches
      quotes_generated = $quotesGenerated
      inserted = $inserted
      skipped = @($response.skipped_rows)
    })
  } catch {
    $errors.Add("$([string]$candidate.match_id):$($_.Exception.Message)")
  }
}

$result = [pscustomobject]@{
  system_status = if ($errors.Count) { "FOOTBALL_SLATE_FAIR_ODDS_PARTIAL_FAILURE" } else { "FOOTBALL_SLATE_FAIR_ODDS_OK" }
  date = $Date
  dry_run = [bool]$DryRun
  missing_before = [int]$queue.summary.fair_odds_missing
  eligible_attempted = $pending.Count
  priced_matches = $pricedMatchesTotal
  quotes_generated = $quotesGeneratedTotal
  inserted = $insertedTotal
  rows = @($rows)
  errors = @($errors)
  guardrails = @{ real_candidate_count=0; real_money_enabled=$false; kelly_enabled=$false; telegram_auto_enabled=$false; autopost_enabled=$false }
}
$result | ConvertTo-Json -Depth 14
if ($errors.Count) { throw "Football slate fair odds failed for $($errors.Count) match(es)" }
