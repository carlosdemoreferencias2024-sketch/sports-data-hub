param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$Sport = "baseball",
  [string]$LeagueSlug = "mlb",
  [string]$MarketType = "moneyline_2way",
  [double]$MinModelProbability = 0.60,
  [double]$MinEv = 0.05,
  [double]$MinOdds = 2.01,
  [switch]$RuleExplorer,
  [switch]$Persist
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo como SPORTS_DATA_HUB_INTERNAL_KEY o pasalo con -InternalApiKey."
}

if ($RuleExplorer) {
  $query = @{
    active_only = "true"
    min_closed = 1
    limit = 100
    persist = [string]([bool]$Persist)
  }
  $path = "/api/v1/internal/analytics/rule-explorer"
} else {
  $query = @{
    sport = $Sport
    league_slug = $LeagueSlug
    market_type = $MarketType
    min_model_probability = $MinModelProbability
    min_ev = $MinEv
    min_odds = $MinOdds
  }
  $path = "/api/v1/internal/analytics/backtest-lab"
}

$queryString = ($query.GetEnumerator() | ForEach-Object {
  [System.Uri]::EscapeDataString($_.Key) + "=" + [System.Uri]::EscapeDataString([string]$_.Value)
}) -join "&"

$headers = @{ "X-Internal-API-Key" = $InternalApiKey }
$url = "$HubBaseUrl$path?$queryString"
Write-Host "[backtest-lab] $url"
Invoke-RestMethod -Headers $headers -Uri $url | ConvertTo-Json -Depth 8
