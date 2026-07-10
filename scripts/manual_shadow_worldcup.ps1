param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $env:INTERNAL_API_KEY,
  [string]$LeagueSlug = "fifa-world-cup-2026",
  [string]$ProviderName = "manual_shadow_worldcup",
  [double]$TargetEv = 0.08,
  [int]$LiveBoardLimit = 200,
  [int]$MaxAgeMinutes = 1440,
  [string]$TargetDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd"),
  [switch]$OnlyTargetDate,
  [switch]$AllowOtherDate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

if ($TargetEv -le 0) {
  throw "TargetEv debe ser mayor a 0."
}

$headers = @{ "X-Internal-API-Key" = $InternalApiKey }

function Get-SelectionProbability {
  param([Parameter(Mandatory = $true)] $Quote)

  switch ($Quote.best_selection) {
    "home" { return [double]$Quote.home_probability }
    "over" { return [double]$Quote.home_probability }
    "yes" { return [double]$Quote.home_probability }
    "away" { return [double]$Quote.away_probability }
    "under" { return [double]$Quote.away_probability }
    "no" { return [double]$Quote.away_probability }
    "draw" {
      if ($null -eq $Quote.draw_probability) {
        throw "best_selection=draw pero draw_probability viene null."
      }
      return [double]$Quote.draw_probability
    }
    default { throw "best_selection no soportado: $($Quote.best_selection)" }
  }
}

function New-QuoteBody {
  param(
    [Parameter(Mandatory = $true)] $Quote,
    [Parameter(Mandatory = $true)] [double] $MarketOdds
  )

  $body = @{
    match_id = $Quote.match_id
    provider_name = $ProviderName
    market_type = $Quote.market_type
    raw_data = @{
      source = "manual_shadow_worldcup"
      target_ev = $TargetEv
      target_date = $TargetDate
      best_selection = $Quote.best_selection
      model_quote_id = $Quote.id
      model_name = $Quote.model_name
      generated_at = (Get-Date).ToUniversalTime().ToString("o")
    }
  }

  if ($null -ne $Quote.line -and "$($Quote.line)" -ne "") {
    $body.line = [double]$Quote.line
  }

  switch ($Quote.best_selection) {
    "home" { $body.home_odds = $MarketOdds }
    "over" { $body.home_odds = $MarketOdds }
    "yes" { $body.home_odds = $MarketOdds }
    "away" { $body.away_odds = $MarketOdds }
    "under" { $body.away_odds = $MarketOdds }
    "no" { $body.away_odds = $MarketOdds }
    "draw" { $body.draw_odds = $MarketOdds }
    default { throw "best_selection no soportado para payload: $($Quote.best_selection)" }
  }

  return $body
}

$liveBoardUri = "$HubBaseUrl/api/v1/internal/model-quotes/live-board?limit=$LiveBoardLimit&max_age_minutes=$MaxAgeMinutes"
$liveBoard = Invoke-RestMethod -Method Get -Uri $liveBoardUri -Headers $headers

if ($liveBoard.count -lt 1 -or $null -eq $liveBoard.board -or $liveBoard.board.Count -lt 1) {
  throw "No hay filas en live-board. Ejecuta primero el pipeline football."
}

$candidates = @(
  $liveBoard.board |
    Where-Object { $_.league_slug -eq $LeagueSlug -and $_.status -in @("scheduled", "live") } |
    Sort-Object -Property `
      @{ Expression = { "$($_.match_id)|$($_.market_type)|$($_.line)|$($_.best_selection)" }; Ascending = $true },
      @{ Expression = { [datetime]$_.generated_at }; Descending = $true } |
    Group-Object { "$($_.match_id)|$($_.market_type)|$($_.line)|$($_.best_selection)" } |
    ForEach-Object { $_.Group | Select-Object -First 1 }
)

if (-not $AllowOtherDate) {
  if ($OnlyTargetDate) {
    $candidates = @($candidates | Where-Object { ([datetime]$_.match_date).ToUniversalTime().ToString("yyyy-MM-dd") -eq $TargetDate })
  }

  $invalid = @($candidates | Where-Object { ([datetime]$_.match_date).ToUniversalTime().ToString("yyyy-MM-dd") -ne $TargetDate })
  if ($invalid.Count -gt 0) {
    $invalid |
      Select-Object match_id, home_team_name, away_team_name, market_type, match_date |
      ConvertTo-Json -Depth 4 |
      Write-Host
    throw "EXIT_ON_INVALID_DATE: $($invalid.Count) candidato(s) no son de $TargetDate. Usa -AllowOtherDate solo para pruebas controladas."
  }
}

if ($candidates.Count -lt 1) {
  throw "No hay candidatos $LeagueSlug scheduled/live para $TargetDate."
}

$quotes = @()
foreach ($candidate in $candidates) {
  $probability = Get-SelectionProbability -Quote $candidate
  if ($probability -le 0 -or $probability -ge 1) {
    throw "Probabilidad invalida para $($candidate.match_id) $($candidate.market_type) $($candidate.best_selection): $probability"
  }

  $marketOdds = [Math]::Round((1.0 + $TargetEv) / $probability, 4)
  $quotes += New-QuoteBody -Quote $candidate -MarketOdds $marketOdds

  Write-Host "[worldcup-shadow] $($candidate.home_team_name) vs $($candidate.away_team_name) market=$($candidate.market_type) pick=$($candidate.best_selection) odds=$marketOdds prob=$probability"
}

$payload = @{ quotes = $quotes } | ConvertTo-Json -Depth 10
$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/quotes" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payload

Write-Host "[worldcup-shadow] received=$($response.received) inserted=$($response.inserted) unchanged=$($response.unchanged)"
$response | ConvertTo-Json -Depth 6
