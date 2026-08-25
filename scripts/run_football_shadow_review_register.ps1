param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$Date = "",
  [string]$MatchId = "",
  [string]$ModelName = "sports_data_hub_football_fair_odds_v3",
  [double]$MinEv = 0.03,
  [double]$MinShadowConfidence = 0.50,
  [int]$MaxModelAgeMinutes = 1440,
  [int]$MaxMarketAgeMinutes = 240,
  [int]$Limit = 20,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

$queryParts = @(
  "sport=soccer",
  "model_name=$([uri]::EscapeDataString($ModelName))",
  "min_ev=$MinEv",
  "min_shadow_confidence=$MinShadowConfidence",
  "max_model_age_minutes=$MaxModelAgeMinutes",
  "max_market_age_minutes=$MaxMarketAgeMinutes",
  "limit=$Limit",
  "dry_run=$(-not $Apply)",
  "apply=$Apply"
)
if ($Date) {
  $queryParts += "date=$([uri]::EscapeDataString($Date))"
}
if ($MatchId) {
  try { [void][Guid]::Parse($MatchId) } catch { throw "MatchId debe ser UUID: $MatchId" }
  $queryParts += "match_id=$([uri]::EscapeDataString($MatchId))"
}

$headers = @{
  "X-Internal-API-Key" = $InternalApiKey
  "X-API-Key" = $InternalApiKey
}

$url = "$HubBaseUrl/api/v1/internal/model-quotes/owned-fair-odds-bridge/register-shadow-review?$($queryParts -join '&')"
Write-Host "[football-shadow-review-register] match_id=$(if ($MatchId) { $MatchId } else { 'all' }) date=$(if ($Date) { $Date } else { 'auto' }) dry_run=$(-not $Apply) apply=$Apply"

$response = Invoke-RestMethod `
  -Method Post `
  -Uri $url `
  -Headers $headers `
  -ContentType "application/json" `
  -Body "{}"

Write-Host "[football-shadow-review-register] scanned=$($response.scanned_bridge_rows) ready=$($response.ready_for_shadow_review) prepared=$($response.signals_prepared)"
Write-Host "[football-shadow-review-register] would_insert=$($response.feed_summary.would_insert) inserted=$($response.feed_summary.inserted) duplicates=$($response.feed_summary.duplicates) skipped=$($response.feed_summary.skipped) blocked=$($response.feed_summary.blocked)"

$response | ConvertTo-Json -Depth 16
