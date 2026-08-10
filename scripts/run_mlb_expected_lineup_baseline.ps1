param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [int]$DaysLookback = 30,
  [int]$LastN = 10,
  [double]$MinFrequency = 0.5,
  [double]$MinConfidenceScore = 50,
  [int]$Limit = 1000,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

$headers = @{
  "X-Internal-API-Key" = $InternalApiKey
  "X-API-Key" = $InternalApiKey
}

$payloadObject = @{
  dry_run = -not $Apply
  sport = "baseball"
  league_id = "mlb"
  days_lookback = $DaysLookback
  last_n = $LastN
  min_frequency = $MinFrequency
  min_confidence_score = $MinConfidenceScore
  limit = $Limit
}

$payload = $payloadObject | ConvertTo-Json -Depth 8
Write-Host "[mlb-expected-lineup-baseline] dry_run=$($payloadObject.dry_run) apply=$Apply days=$DaysLookback last_n=$LastN min_frequency=$MinFrequency"

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/analytics/rebuild-expected-lineups" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payload

Write-Host "[mlb-expected-lineup-baseline] source_lineups=$($response.source_lineups) teams_seen=$($response.teams_seen) would_upsert=$($response.would_upsert) upserted=$($response.upserted)"
Write-Host "[mlb-expected-lineup-baseline] recommendation=$($response.recommendation)"

$engine = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/expected-lineup-engine?sport=baseball&league_id=mlb&limit=20" -Headers $headers
Write-Host "[mlb-expected-lineup-baseline] expected_players=$($engine.summary.expected_players) expected_teams=$($engine.summary.expected_teams) confirmed=$($engine.confirmed) needs_official=$($engine.needs_official)"

$chain = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/confirmed-pick-chain" -Headers $headers
Write-Host "[mlb-expected-lineup-baseline] active=$($chain.active_picks) confirmed=$($chain.bettable_paper_confirmed) strong=$($chain.context_completeness_summary.strong) reviewable=$($chain.context_completeness_summary.reviewable) incomplete=$($chain.context_completeness_summary.incomplete)"

$response | ConvertTo-Json -Depth 12
