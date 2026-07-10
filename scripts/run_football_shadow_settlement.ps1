param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

function Test-HasProperty {
  param($Object, [string]$Name)
  return $null -ne $Object.PSObject.Properties[$Name] -and $null -ne $Object.$Name -and "$($Object.$Name)" -ne ""
}

function Test-DateField {
  param($Object, [string]$Name)
  if (-not (Test-HasProperty $Object $Name)) {
    return
  }
  try {
    $null = [datetimeoffset][string]$Object.$Name
  } catch {
    throw "$Name invalido: $($Object.$Name)"
  }
}

$resolvedInput = Resolve-Path -LiteralPath $InputPath
$headers = @{ "X-Internal-API-Key" = $InternalApiKey }
$json = Get-Content -LiteralPath $resolvedInput -Raw | ConvertFrom-Json
$results = @()
if ($null -ne $json.PSObject.Properties["results"]) {
  $results = @($json.results)
}
$closings = @()
if ($null -ne $json.PSObject.Properties["closing_odds"]) {
  $closings = @($json.closing_odds)
}

foreach ($result in $results) {
  foreach ($required in @("match_id", "home_score", "away_score")) {
    if (-not (Test-HasProperty $result $required)) {
      throw "Cada result debe traer '$required'."
    }
  }
  Test-DateField -Object $result -Name "finished_at"
}

foreach ($closing in $closings) {
  foreach ($required in @("match_id", "market", "selection", "closing_odds", "closing_odds_timestamp")) {
    if (-not (Test-HasProperty $closing $required)) {
      throw "Cada closing_odds debe traer '$required'."
    }
  }
  if ([double]$closing.closing_odds -le 1) {
    throw "closing_odds debe ser mayor a 1."
  }
  Test-DateField -Object $closing -Name "closing_odds_timestamp"
}

$payload = @{
  dry_run = -not $Apply
  results = $results
  closing_odds = $closings
} | ConvertTo-Json -Depth 12

Write-Host "[football-settlement] results=$($results.Count) closing_odds=$($closings.Count) dry_run=$(-not $Apply) apply=$Apply"

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/analytics/football-shadow-settlement" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payload

Write-Host "[football-settlement] would_check=$($response.would_check) would_settle=$($response.would_settle) would_update_closing=$($response.would_update_closing) settled=$($response.settled) missing_results=$($response.missing_results) missing_closing=$($response.missing_closing) blocked=$($response.blocked) errors=$($response.errors)"

$monitor = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/football-pending-settlement-monitor" -Headers @{ "X-API-Key" = $InternalApiKey }
$lab = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/football-market-lab" -Headers @{ "X-API-Key" = $InternalApiKey }
$quality = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/football-feed-quality-report" -Headers @{ "X-API-Key" = $InternalApiKey }

Write-Host "[football-settlement] pending_total=$($monitor.total) missing_result=$($monitor.missing_result) missing_closing=$($monitor.missing_closing) recommendation=$($monitor.recommendation)"
Write-Host "[football-settlement] quality_total=$($quality.total_signals) fresh=$($quality.fresh_line) stale=$($quality.stale_line)"
Write-Host "[football-settlement] guardrails real_candidate=$($lab.real_candidate_count) real_money=$($lab.real_money_enabled) kelly=$($lab.kelly_enabled) telegram=$($lab.telegram_auto_enabled)"

$response | ConvertTo-Json -Depth 8
