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

$resolvedInput = Resolve-Path -LiteralPath $InputPath
$json = Get-Content -LiteralPath $resolvedInput -Raw | ConvertFrom-Json
$json | Add-Member -NotePropertyName "dry_run" -NotePropertyValue (-not $Apply) -Force
$payload = $json | ConvertTo-Json -Depth 16
$headers = @{ "X-Internal-API-Key" = $InternalApiKey }

Write-Host "[football-today-universe] input=$resolvedInput dry_run=$(-not $Apply) apply=$Apply"

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/analytics/football-today-universe" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payload

Write-Host "[football-today-universe] fixtures=$($response.fixtures_received) would_insert=$($response.fixtures_would_insert) inserted=$($response.fixtures_inserted)"
Write-Host "[football-today-universe] signals=$($response.signals_received) would_insert=$($response.signals_would_insert) inserted=$($response.signals_inserted)"
Write-Host "[football-today-universe] observed=$($response.observation_only) snapshots=$($response.market_snapshots) candidates=$($response.shadow_candidates) shadow_paper=$($response.shadow_paper) rejected=$($response.rejected) blocked=$($response.blocked) duplicates=$($response.duplicates)"
Write-Host "[football-today-universe] guardrails real_candidate=$($response.guardrails.real_candidate_count) real_money=$($response.guardrails.real_money_enabled) kelly=$($response.guardrails.kelly_enabled) telegram=$($response.guardrails.telegram_auto_enabled)"

$response | ConvertTo-Json -Depth 12
