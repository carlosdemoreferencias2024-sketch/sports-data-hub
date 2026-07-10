param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [switch]$Apply,
  [switch]$AllowBttsManualReview
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

function Test-AllowedMarket {
  param($Signal)

  $market = [string]$Signal.market
  $allowed = @("moneyline_3way", "total_goals_2_5", "draw_no_bet")
  if ($allowed -contains $market) {
    return
  }

  if ($market -eq "btts") {
    $manualReview = $false
    if (Test-HasProperty $Signal "raw_data") {
      $raw = $Signal.raw_data
      $manualReview = ($raw.manual_review -eq $true -or $raw.manual_review_required -eq $true)
    }
    if ($AllowBttsManualReview -and $manualReview) {
      return
    }
    throw "BTTS no se alimenta por defecto. Usa -AllowBttsManualReview y raw_data.manual_review=true solo si ya lo revisaste."
  }

  throw "Mercado no permitido para carga inicial de futbol: $market"
}

function Get-LineFreshnessLabel {
  param([double]$MinutesToKickoff)

  if ($MinutesToKickoff -ge 180) {
    return "FRESH_LINE"
  }
  if ($MinutesToKickoff -ge 30) {
    return "ACCEPTABLE_LINE"
  }
  return "STALE_LINE"
}

function Normalize-Signal {
  param($Signal)

  $rawData = if (Test-HasProperty $Signal "raw_data") { $Signal.raw_data } else { @{} }
  $isObservationOnly = $false
  if (Test-HasProperty $rawData "observation_only") {
    $isObservationOnly = ($rawData.observation_only -eq $true)
  }
  if (Test-HasProperty $rawData "feed_status") {
    $isObservationOnly = $isObservationOnly -or ([string]$rawData.feed_status).ToUpperInvariant() -eq "OBSERVATION_ONLY"
  }

  $requiredFields = @("match_id", "league", "market", "selection", "home_team", "away_team", "kickoff", "odds_timestamp", "market_odds")
  if (-not $isObservationOnly) {
    $requiredFields += @("model_probability", "expected_value")
  }

  foreach ($required in $requiredFields) {
    if (-not (Test-HasProperty $Signal $required)) {
      throw "Cada signal debe traer '$required'."
    }
  }

  Test-AllowedMarket -Signal $Signal

  $league = [string]$Signal.league
  $provider = if (Test-HasProperty $Signal "provider") { [string]$Signal.provider } else { "manual_shadow_football" }
  if (-not $provider.ToLowerInvariant().Contains("manual_shadow")) {
    throw "Futbol inicial debe entrar como manual_shadow/shadow_paper. Provider recibido: $provider"
  }

  try {
    $kickoffOffset = [datetimeoffset][string]$Signal.kickoff
    $kickoff = $kickoffOffset.UtcDateTime.ToString("o")
  } catch {
    throw "kickoff invalido para $($Signal.home_team) vs $($Signal.away_team): $($Signal.kickoff)"
  }

  try {
    $oddsTimestampOffset = [datetimeoffset][string]$Signal.odds_timestamp
    $oddsTimestamp = $oddsTimestampOffset.UtcDateTime.ToString("o")
  } catch {
    throw "odds_timestamp invalido para $($Signal.home_team) vs $($Signal.away_team): $($Signal.odds_timestamp)"
  }

  $lineAgeToKickoffMinutes = [Math]::Round(($kickoffOffset.UtcDateTime - $oddsTimestampOffset.UtcDateTime).TotalMinutes, 2)
  if ($lineAgeToKickoffMinutes -le 0) {
    throw "POST_KICKOFF_REJECTED: odds_timestamp debe ser menor que kickoff para $($Signal.home_team) vs $($Signal.away_team). kickoff=$($Signal.kickoff) odds_timestamp=$($Signal.odds_timestamp)"
  }
  $lineFreshness = Get-LineFreshnessLabel -MinutesToKickoff $lineAgeToKickoffMinutes

  $rawData | Add-Member -NotePropertyName "source" -NotePropertyValue "run_football_shadow_feed" -Force
  $rawData | Add-Member -NotePropertyName "processed" -NotePropertyValue $true -Force
  $rawData | Add-Member -NotePropertyName "flow" -NotePropertyValue $(if ($isObservationOnly) { "observation_only" } else { "shadow_paper" }) -Force
  if ($isObservationOnly) {
    $rawData | Add-Member -NotePropertyName "observation_only" -NotePropertyValue $true -Force
    $rawData | Add-Member -NotePropertyName "feed_status" -NotePropertyValue "OBSERVATION_ONLY" -Force
  }
  $rawData | Add-Member -NotePropertyName "kickoff" -NotePropertyValue $kickoff -Force
  $rawData | Add-Member -NotePropertyName "kickoff_original" -NotePropertyValue ([string]$Signal.kickoff) -Force
  $rawData | Add-Member -NotePropertyName "odds_timestamp" -NotePropertyValue $oddsTimestamp -Force
  $rawData | Add-Member -NotePropertyName "odds_timestamp_original" -NotePropertyValue ([string]$Signal.odds_timestamp) -Force
  $rawData | Add-Member -NotePropertyName "line_age_to_kickoff_minutes" -NotePropertyValue $lineAgeToKickoffMinutes -Force
  $rawData | Add-Member -NotePropertyName "line_freshness" -NotePropertyValue $lineFreshness -Force
  $rawData | Add-Member -NotePropertyName "real_money_enabled" -NotePropertyValue $false -Force
  $rawData | Add-Member -NotePropertyName "kelly_enabled" -NotePropertyValue $false -Force
  $rawData | Add-Member -NotePropertyName "telegram_auto_enabled" -NotePropertyValue $false -Force
  $rawData | Add-Member -NotePropertyName "ingested_at" -NotePropertyValue (Get-Date).ToUniversalTime().ToString("o") -Force

  return @{
    match_id = [string]$Signal.match_id
    league = $league
    market = [string]$Signal.market
    selection = [string]$Signal.selection
    home_team = [string]$Signal.home_team
    away_team = [string]$Signal.away_team
    model_version = $(if (Test-HasProperty $Signal "model_version") { [string]$Signal.model_version } else { "carlos_v1_football" })
    provider = $provider
    model_probability = $(if (Test-HasProperty $Signal "model_probability") { [double]$Signal.model_probability } else { 0 })
    market_odds = [double]$Signal.market_odds
    expected_value = $(if (Test-HasProperty $Signal "expected_value") { [double]$Signal.expected_value } else { 0 })
    bankroll_allocation = $(if (Test-HasProperty $Signal "bankroll_allocation") { [double]$Signal.bankroll_allocation } else { 0.01 })
    raw_data = $rawData
  }
}

$resolvedInput = Resolve-Path -LiteralPath $InputPath
$headers = @{ "X-Internal-API-Key" = $InternalApiKey }
$json = Get-Content -LiteralPath $resolvedInput -Raw | ConvertFrom-Json
$items = @()
if ($null -ne $json.PSObject.Properties["signals"]) {
  $items = @($json.signals)
} else {
  $items = @($json)
}

if ($items.Count -lt 1) {
  throw "El archivo no contiene signals."
}

$signals = @()
foreach ($item in $items) {
  $signals += Normalize-Signal -Signal $item
}

$dryRun = -not $Apply
$payload = @{
  dry_run = $dryRun
  signals = $signals
} | ConvertTo-Json -Depth 12

Write-Host "[football-shadow] signals=$($signals.Count) dry_run=$dryRun apply=$Apply"

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/analytics/football-shadow-feed" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payload

Write-Host "[football-shadow] inserted=$($response.inserted) would_insert=$($response.would_insert) skipped=$($response.skipped) blocked=$($response.blocked) duplicates=$($response.duplicates)"
$response.by_league_market | ForEach-Object {
  Write-Host "[football-shadow] league=$($_.league_id) market=$($_.market) inserted=$($_.inserted) would_insert=$($_.would_insert) skipped=$($_.skipped) duplicates=$($_.duplicates) blocked=$($_.blocked)"
}

$status = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/football-shadow-feed-status" -Headers @{ "X-API-Key" = $InternalApiKey }
$lab = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/football-market-lab" -Headers @{ "X-API-Key" = $InternalApiKey }
$command = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/football-command-center" -Headers @{ "X-API-Key" = $InternalApiKey }

Write-Host "[football-shadow] status_http=ok lab_rows=$($lab.visible_count) command_status=$($command.system_status)"
Write-Host "[football-shadow] guardrails real_candidate=$($lab.real_candidate_count) real_money=$($lab.real_money_enabled) kelly=$($lab.kelly_enabled) telegram=$($lab.telegram_auto_enabled)"

$response | ConvertTo-Json -Depth 8
