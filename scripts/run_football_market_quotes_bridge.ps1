param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$Date = "",
  [string]$ModelName = "sports_data_hub_football_fair_odds_v1",
  [double]$MinEv = 0.03,
  [double]$MinShadowConfidence = 0.50,
  [int]$MaxQuoteAgeMinutes = 120,
  [int]$Limit = 80,
  [switch]$AllowStaleReview,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

$resolvedInput = Resolve-Path $InputPath
$payloadObject = Get-Content $resolvedInput -Raw | ConvertFrom-Json
$placeholderPattern = "(__FILL_|UUID_REAL|TU_|PLACEHOLDER|REEMPLAZAR|Equipo Local|Equipo Visitante)"

function Has-Prop($Object, [string]$Name) {
  return $null -ne $Object.PSObject.Properties[$Name]
}

function Read-Prop($Object, [string]$Name, $Default = $null) {
  if (Has-Prop $Object $Name) {
    return $Object.$Name
  }
  return $Default
}

function Set-SelectionOdds($Quote, [string]$Selection, [double]$Odds) {
  $normalized = $Selection.ToLowerInvariant()
  if ($normalized -in @("home", "over", "yes", "home_draw")) {
    $Quote.home_odds = $Odds
  } elseif ($normalized -in @("away", "under", "no", "draw_away")) {
    $Quote.away_odds = $Odds
  } elseif ($normalized -in @("draw", "home_away")) {
    $Quote.draw_odds = $Odds
  } else {
    throw "UNKNOWN_SELECTION: $Selection"
  }
}

function Is-Blank([object]$Value) {
  return $null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)
}

if (-not (Has-Prop $payloadObject "quotes")) {
  throw "El JSON debe traer quotes: [...]."
}

$accepted = New-Object System.Collections.Generic.List[object]
$rejected = New-Object System.Collections.Generic.List[object]
$quotes = @($payloadObject.quotes)

for ($i = 0; $i -lt $quotes.Count; $i++) {
  $q = $quotes[$i]
  $rawJson = $q | ConvertTo-Json -Depth 20 -Compress
  if ($rawJson -match $placeholderPattern) {
    $rejected.Add([pscustomobject]@{ index = $i; status = "REJECTED"; reason = "PLACEHOLDER_DETECTED" })
    continue
  }

  try {
    $matchId = [string](Read-Prop $q "match_id" "")
    $marketType = [string](Read-Prop $q "market_type" "moneyline_3way")
    $providerName = [string](Read-Prop $q "provider_name" (Read-Prop $q "provider" "manual_verified_market_quote"))
    $capturedAt = [string](Read-Prop $q "captured_at" (Read-Prop $q "odds_timestamp" ""))
    $bookmaker = [string](Read-Prop $q "bookmaker" "")
    $sourceLabel = [string](Read-Prop $q "source_label" (Read-Prop $q "source" ""))
    $sourceUrl = [string](Read-Prop $q "source_url" "")
    $verifiedBy = [string](Read-Prop $q "verified_by" "")

    if (-not $matchId) { throw "MISSING_MATCH_ID" }
    if (-not $providerName) { throw "MISSING_PROVIDER" }
    if (-not $capturedAt) { throw "MISSING_CAPTURED_AT" }
    if (Is-Blank $bookmaker) { throw "MISSING_BOOKMAKER" }
    if ((Is-Blank $sourceLabel) -and (Is-Blank $sourceUrl)) { throw "MISSING_VERIFIABLE_SOURCE" }
    if (([string]$providerName).ToLowerInvariant().Contains("manual") -and (Is-Blank $verifiedBy)) {
      throw "MISSING_VERIFIED_BY_FOR_MANUAL_QUOTE"
    }
    $capturedDate = [datetimeoffset]::Parse($capturedAt)
    $nowUtc = [datetimeoffset]::UtcNow
    $quoteAgeMinutes = ($nowUtc - $capturedDate.ToUniversalTime()).TotalMinutes
    if ($quoteAgeMinutes -lt -5) {
      throw "FUTURE_MARKET_QUOTE_REJECTED"
    }
    if ((-not $AllowStaleReview) -and $quoteAgeMinutes -gt $MaxQuoteAgeMinutes) {
      throw ("STALE_MARKET_QUOTE_REJECTED_{0}m_GT_{1}m" -f [math]::Round($quoteAgeMinutes, 1), $MaxQuoteAgeMinutes)
    }

    if (Has-Prop $q "kickoff") {
      $kickoff = [datetimeoffset]::Parse([string]$q.kickoff)
      if ($capturedDate -ge $kickoff) {
        throw "POST_KICKOFF_MARKET_QUOTE_REJECTED"
      }
    }

    $quote = [ordered]@{
      match_id = $matchId
      provider_name = $providerName
      market_type = $marketType
      line = Read-Prop $q "line" $null
      home_odds = Read-Prop $q "home_odds" $null
      away_odds = Read-Prop $q "away_odds" $null
      draw_odds = Read-Prop $q "draw_odds" $null
      captured_at = $capturedDate.ToUniversalTime().ToString("o")
      force_insert = [bool](Read-Prop $q "force_insert" $false)
      raw_data = @{
        source = $sourceLabel
        source_label = $sourceLabel
        source_url = $sourceUrl
        bookmaker = $bookmaker
        verified_by = $verifiedBy
        captured_age_minutes = [math]::Round($quoteAgeMinutes, 2)
        max_quote_age_minutes = $MaxQuoteAgeMinutes
        stale_review_allowed = [bool]$AllowStaleReview
        verified_market_quote = $true
        football_market_quote_bridge = $true
        real_money_enabled = $false
        kelly_enabled = $false
        telegram_auto_enabled = $false
      }
    }

    if (Has-Prop $q "raw_data") {
      foreach ($prop in $q.raw_data.PSObject.Properties) {
        $quote.raw_data[$prop.Name] = $prop.Value
      }
    }

    if ((-not $quote.home_odds) -and (-not $quote.away_odds) -and (-not $quote.draw_odds)) {
      $selection = [string](Read-Prop $q "selection" "")
      $marketOdds = [double](Read-Prop $q "market_odds" 0)
      if (-not $selection -or $marketOdds -le 1) {
        throw "MISSING_SELECTION_OR_MARKET_ODDS"
      }
      Set-SelectionOdds $quote $selection $marketOdds
    }

    foreach ($field in @("home_odds", "away_odds", "draw_odds")) {
      if ($quote[$field] -and [double]$quote[$field] -le 1) {
        throw "INVALID_ODDS_$field"
      }
    }

    $accepted.Add([pscustomobject]$quote)
  } catch {
    $rejected.Add([pscustomobject]@{ index = $i; status = "REJECTED"; reason = $_.Exception.Message })
  }
}

$headers = @{
  "X-Internal-API-Key" = $InternalApiKey
  "X-API-Key" = $InternalApiKey
}

Write-Host "[football-market-quotes-bridge] input=$resolvedInput quotes=$($quotes.Count) accepted=$($accepted.Count) rejected=$($rejected.Count) apply=$Apply"

if ($rejected.Count -gt 0) {
  $rejected | ConvertTo-Json -Depth 8
}

if (-not $Apply) {
  [pscustomobject]@{
    system_status = "FOOTBALL_MARKET_QUOTES_BRIDGE_DRY_RUN"
    accepted = $accepted.Count
    rejected = $rejected.Count
    would_insert = $accepted.Count
    validation = @{
      min_ev = $MinEv
      min_shadow_confidence = $MinShadowConfidence
      max_quote_age_minutes = $MaxQuoteAgeMinutes
      stale_review_allowed = [bool]$AllowStaleReview
      requires_bookmaker = $true
      requires_source_label_or_url = $true
      requires_verified_by_for_manual = $true
    }
    guardrails = @{
      real_candidate_count = 0
      real_money_enabled = $false
      kelly_enabled = $false
      telegram_auto_enabled = $false
      shadow_paper_only_for_football = $true
    }
    quotes = $accepted
  } | ConvertTo-Json -Depth 16
  exit 0
}

if ($accepted.Count -eq 0) {
  throw "No hay market quotes validas para aplicar."
}

$body = @{ quotes = $accepted } | ConvertTo-Json -Depth 16
$quoteResponse = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/quotes" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body

$queryParts = @(
  "sport=soccer",
  "model_name=$([uri]::EscapeDataString($ModelName))",
  "min_ev=$MinEv",
  "min_shadow_confidence=$MinShadowConfidence",
  "max_model_age_minutes=1440",
  "max_market_age_minutes=$MaxQuoteAgeMinutes",
  "limit=$Limit"
)
if ($Date) {
  $queryParts += "date=$([uri]::EscapeDataString($Date))"
}
$bridge = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/v1/internal/model-quotes/owned-fair-odds-bridge?$($queryParts -join '&')" -Headers $headers

[pscustomobject]@{
  system_status = "FOOTBALL_MARKET_QUOTES_BRIDGE_APPLIED"
  inserted = $quoteResponse.inserted
  unchanged = $quoteResponse.unchanged
  accepted = $accepted.Count
  rejected = $rejected.Count
  bridge_summary = $bridge.summary
  ready_for_shadow_review = $bridge.summary.ready_for_shadow_review
  model_confidence_review = $bridge.summary.model_confidence_review
  promotion_not_allowed = $bridge.summary.promotion_not_allowed
  recommendation = "Market quotes aplicadas; el bridge compara contra fair odds propias y no confirma dinero real."
  guardrails = @{
    real_candidate_count = 0
    real_money_enabled = $false
    kelly_enabled = $false
    telegram_auto_enabled = $false
    shadow_paper_only_for_football = $true
  }
} | ConvertTo-Json -Depth 12
