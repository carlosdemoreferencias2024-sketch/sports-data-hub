param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$Date = "",
  [string]$ModelName = "sports_data_hub_football_fair_odds_v3",
  [double]$MinEv = 0.03,
  [double]$MinShadowConfidence = 0.50,
  [int]$Limit = 80,
  [switch]$Apply,
  [switch]$IncludeTotals25,
  [switch]$IncludePostKickoff,
  [switch]$HistoricalBridge,
  [int]$MaxModelAgeMinutes = 1440,
  [int]$MaxMarketAgeMinutes = 1440
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

if ($HistoricalBridge) {
  $queryParts = @(
    "sport=soccer",
    "model_name=$([uri]::EscapeDataString($ModelName))",
    "mode=historical",
    "min_ev=$MinEv",
    "min_shadow_confidence=$MinShadowConfidence",
    "max_model_age_minutes=$MaxModelAgeMinutes",
    "max_market_age_minutes=$MaxMarketAgeMinutes",
    "limit=$Limit"
  )
  if ($Date) {
    $queryParts += "date=$([uri]::EscapeDataString($Date))"
  }
  $bridgeUrl = "$HubBaseUrl/api/v1/internal/model-quotes/owned-fair-odds-bridge?$($queryParts -join '&')"
  Write-Host "[football-owned-fair-odds-bridge] mode=historical date=$(if ($Date) { $Date } else { 'auto' }) model=$ModelName"
  $bridge = Invoke-RestMethod -Method Get -Uri $bridgeUrl -Headers $headers
  Write-Host "[football-owned-fair-odds-bridge] count=$($bridge.count) historical=$($bridge.summary.historical_comparison) ready=$($bridge.summary.ready_for_shadow_review) missing_market=$($bridge.summary.market_odds_missing)"
  $bridge | ConvertTo-Json -Depth 12
  exit 0
}

$body = @{
  apply = [bool]$Apply
  model_name = $ModelName
  model_version = $(if ($ModelName -eq "sports_data_hub_football_fair_odds_v2") { "v2" } else { "v3" })
  min_ev = $MinEv
  limit = $Limit
  include_totals_2_5 = [bool]$IncludeTotals25
  include_post_kickoff = [bool]$IncludePostKickoff
}
if ($Date) {
  $body.date = $Date
}

$query = if ($Date) { "?date=$([uri]::EscapeDataString($Date))" } else { "" }
$payload = $body | ConvertTo-Json -Depth 8

Write-Host "[football-owned-fair-odds] date=$(if ($Date) { $Date } else { 'auto' }) model=$ModelName dry_run=$(-not $Apply) apply=$Apply totals_2_5=$IncludeTotals25"

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/analytics/football-owned-fair-odds/run$query" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payload

Write-Host "[football-owned-fair-odds] priced_matches=$($response.priced_matches) quotes_generated=$($response.quotes_generated) inserted=$($response.inserted)"
Write-Host "[football-owned-fair-odds] note=$($response.note)"

$response | ConvertTo-Json -Depth 12
