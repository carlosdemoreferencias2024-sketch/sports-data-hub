param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $env:INTERNAL_API_KEY,
  [double]$TargetEv = 0.08,
  [double]$MinAlphaEv = 0.05,
  [int]$LiveBoardLimit = 20,
  [int]$MaxAgeMinutes = 1440,
  [string]$ProviderName = "manual_shadow"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

if ($TargetEv -le 0) {
  throw "TargetEv debe ser mayor a 0."
}

if ($MinAlphaEv -lt 0) {
  throw "MinAlphaEv no puede ser negativo."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$headers = @{ "X-Internal-API-Key" = $InternalApiKey }

function Get-SelectionProbability {
  param(
    [Parameter(Mandatory = $true)]
    $Quote
  )

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

function New-QuotePayload {
  param(
    [Parameter(Mandatory = $true)]
    $Quote,
    [Parameter(Mandatory = $true)]
    [double]$MarketOdds
  )

  $quoteBody = @{
    match_id = $Quote.match_id
    provider_name = $ProviderName
    market_type = $Quote.market_type
    raw_data = @{
      source = "manual_shadow_alpha_test"
      target_ev = $TargetEv
      min_alpha_ev = $MinAlphaEv
      best_selection = $Quote.best_selection
      model_name = $Quote.model_name
      generated_at = (Get-Date).ToUniversalTime().ToString("o")
    }
  }

  if ($null -ne $Quote.line -and "$($Quote.line)" -ne "") {
    $quoteBody.line = [double]$Quote.line
  }

  switch ($Quote.best_selection) {
    "home" { $quoteBody.home_odds = $MarketOdds }
    "over" { $quoteBody.home_odds = $MarketOdds }
    "yes" { $quoteBody.home_odds = $MarketOdds }
    "away" { $quoteBody.away_odds = $MarketOdds }
    "under" { $quoteBody.away_odds = $MarketOdds }
    "no" { $quoteBody.away_odds = $MarketOdds }
    "draw" { $quoteBody.draw_odds = $MarketOdds }
    default { throw "best_selection no soportado para quote payload: $($Quote.best_selection)" }
  }

  return @{ quotes = @($quoteBody) }
}

$liveBoardUri = "$HubBaseUrl/api/v1/internal/model-quotes/live-board?limit=$LiveBoardLimit&max_age_minutes=$MaxAgeMinutes"
$liveBoard = Invoke-RestMethod -Method Get -Uri $liveBoardUri -Headers $headers

if ($liveBoard.count -lt 1 -or $null -eq $liveBoard.board -or $liveBoard.board.Count -lt 1) {
  throw "No hay oportunidades activas en live-board. Ejecuta primero un model_pipeline para MLB/NBA/football."
}

$candidate = $liveBoard.board |
  Where-Object { $_.status -in @("scheduled", "live") } |
  Sort-Object -Property @{ Expression = { [double]$_.confidence }; Descending = $true }, generated_at -Descending |
  Select-Object -First 1

if ($null -eq $candidate) {
  throw "live-board respondio, pero no hay matches scheduled/live elegibles."
}

$probability = Get-SelectionProbability -Quote $candidate
if ($probability -le 0 -or $probability -ge 1) {
  throw "Probabilidad invalida para $($candidate.best_selection): $probability"
}

$marketOdds = [Math]::Round((1.0 + $TargetEv) / $probability, 4)
$payload = New-QuotePayload -Quote $candidate -MarketOdds $marketOdds
$payloadJson = $payload | ConvertTo-Json -Depth 10

Write-Host "[shadow] selected=$($candidate.best_selection) model=$($candidate.model_name) sport=$($candidate.sport_slug) match=$($candidate.match_id)"
Write-Host "[shadow] probability=$probability market_odds=$marketOdds target_ev=$TargetEv"

$quoteResponse = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/quotes" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payloadJson

Write-Host "[shadow] quote_post inserted=$($quoteResponse.inserted) unchanged=$($quoteResponse.unchanged)"

Push-Location $repoRoot
try {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $detectorOutput = & docker.exe "compose" "exec" "-T" "odds-worker" "python" "alpha_detector.py" "--model-name" ([string]$candidate.model_name) "--min-ev" ([string]$MinAlphaEv)
  $detectorExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
  Pop-Location
}

$detectorOutput | ForEach-Object { Write-Host $_ }
if ($detectorExitCode -ne 0) {
  throw "alpha_detector.py fallo con exit code $detectorExitCode"
}

$alphaUri = "$HubBaseUrl/api/v1/internal/model-quotes/alpha-opportunities?min_ev=0&limit=20"
$alphaResponse = Invoke-RestMethod -Method Get -Uri $alphaUri -Headers $headers
$manualShadow = @($alphaResponse.opportunities | Where-Object {
  $_.provider_name -eq $ProviderName -and $_.match_id -eq $candidate.match_id
})

Write-Host "[shadow] alpha_total=$($alphaResponse.count) manual_shadow_for_match=$($manualShadow.Count)"

if ($manualShadow.Count -lt 1) {
  throw "No se encontro alpha_opportunity manual_shadow para el match seleccionado."
}

$manualShadow |
  Select-Object `
    match_id,
    sport_slug,
    league_slug,
    model_name,
    provider_name,
    market_type,
    market_selection,
    model_probability,
    market_odds,
    expected_value,
    processed,
    detected_at |
  ConvertTo-Json -Depth 6
