param(
  [Parameter(Mandatory = $true)]
  [string]$UniversePath,
  [string]$OutputPath,
  [int]$MaxFixtures = 4,
  [string[]]$PreferredLeagues = @("fifa-world-cup-2026", "liga-mx", "mls", "brasileirao-serie-a"),
  [string[]]$Markets = @("moneyline_3way"),
  [switch]$ValidateReady,
  [string]$ReadyOutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-HasValue {
  param($Object, [string]$Name)
  return $null -ne $Object.PSObject.Properties[$Name] -and $null -ne $Object.$Name -and "$($Object.$Name)".Trim() -ne ""
}

function Normalize-ProviderName {
  param([string]$League)
  return "manual_shadow_" + ($League.ToLowerInvariant() -replace "[^a-z0-9]+", "_" -replace "^_+|_+$", "")
}

function Get-SelectionPlaceholder {
  param([string]$Market)
  switch ($Market) {
    "moneyline_3way" { return "__FILL_home_away_or_draw__" }
    "total_goals_2_5" { return "__FILL_over_or_under__" }
    "draw_no_bet" { return "__FILL_home_or_away__" }
    "double_chance" { return "__FILL_home_draw_home_away_or_draw_away__" }
    default { return "__FILL_SELECTION__" }
  }
}

function Test-ValidSelection {
  param([string]$Market, [string]$Selection)
  $value = $Selection.ToLowerInvariant()
  switch ($Market) {
    "moneyline_3way" { return @("home", "away", "draw") -contains $value }
    "total_goals_2_5" { return @("over", "under", "over_2_5", "under_2_5") -contains $value }
    "draw_no_bet" { return @("home", "away", "home_dnb", "away_dnb") -contains $value }
    "double_chance" { return @("home_draw", "home_or_draw", "1x", "home_away", "home_or_away", "12", "draw_away", "draw_or_away", "x2") -contains $value }
    default { return $false }
  }
}

function Convert-ToIsoUtc {
  param([string]$Value, [string]$FieldName)
  try {
    return ([datetimeoffset]$Value).UtcDateTime.ToString("o")
  } catch {
    throw "$FieldName invalido: $Value"
  }
}

function Normalize-StringList {
  param([string[]]$Values)
  $items = New-Object System.Collections.Generic.List[string]
  foreach ($value in $Values) {
    foreach ($part in ([string]$value -split ",")) {
      $clean = $part.Trim()
      if ($clean) {
        $items.Add($clean)
      }
    }
  }
  return @($items.ToArray())
}

function New-DraftPack {
  param($Universe, [string[]]$LeaguePriority, [string[]]$MarketList, [int]$Limit)

  $fixtures = @($Universe.fixtures)
  $ranked = $fixtures |
    Where-Object { Test-HasValue $_ "league" -and Test-HasValue $_ "home_team" -and Test-HasValue $_ "away_team" -and Test-HasValue $_ "kickoff" } |
    Sort-Object `
      @{ Expression = { $idx = [Array]::IndexOf($LeaguePriority, [string]$_.league); if ($idx -lt 0) { 999 } else { $idx } }; Ascending = $true },
      @{ Expression = { [datetimeoffset]$_.kickoff }; Ascending = $true },
      @{ Expression = { [string]$_.home_team }; Ascending = $true } |
    Select-Object -First $Limit

  $signals = @()
  foreach ($fixture in $ranked) {
    foreach ($market in $MarketList) {
      $raw = if (Test-HasValue $fixture "raw_data") { $fixture.raw_data } else { @{} }
      $signals += [ordered]@{
        match_id = if (Test-HasValue $fixture "match_id") { [string]$fixture.match_id } else { "" }
        league = [string]$fixture.league
        market = [string]$market
        selection = Get-SelectionPlaceholder -Market $market
        home_team = [string]$fixture.home_team
        away_team = [string]$fixture.away_team
        kickoff = [string]$fixture.kickoff
        odds_timestamp = "__FILL_ISO_TIMESTAMP_BEFORE_KICKOFF__"
        provider = Normalize-ProviderName -League ([string]$fixture.league)
        market_odds = $null
        model_version = "carlos_v1_football"
        model_probability = $null
        expected_value = $null
        raw_data = [ordered]@{
          candidate_status = "DRAFT_REQUIRES_ODDS_MODEL_AND_CONSENSUS"
          source_consensus = if (Test-HasValue $raw "source_consensus") { [string]$raw.source_consensus } else { "espn_api_only" }
          kickoff_trusted = if (Test-HasValue $raw "kickoff_trusted") { [bool]$raw.kickoff_trusted } else { $false }
          requires_onefootball_consensus = $true
          espn_event_id = if (Test-HasValue $raw "espn_event_id") { [string]$raw.espn_event_id } else { $null }
          espn_slug = if (Test-HasValue $raw "espn_slug") { [string]$raw.espn_slug } else { $null }
          observation_fixture_source = if (Test-HasValue $fixture "source") { [string]$fixture.source } else { "unknown" }
          real_money_enabled = $false
          kelly_enabled = $false
          telegram_auto_enabled = $false
        }
      }
    }
  }

  return [ordered]@{
    source = "prime_football_shadow_candidate_pack"
    mode = "DRAFT_NOT_APPLY"
    date = if (Test-HasValue $Universe "date") { [string]$Universe.date } else { (Get-Date).ToString("yyyy-MM-dd") }
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    instructions = @(
      "Fill selection, odds_timestamp, market_odds, model_probability, and expected_value before applying.",
      "Run this script again with -ValidateReady and -ReadyOutputPath to create a feed-ready JSON.",
      "Do not apply if any row still requires OneFootball/source consensus.",
      "BTTS is intentionally excluded from prime candidates.",
      "double_chance selections: home_draw/1x, home_away/12, draw_away/x2."
    )
    selected_fixtures = @($ranked)
    signals = $signals
    quality_check = [ordered]@{
      ready_to_apply = $false
      real_candidate_count = 0
      real_money_enabled = $false
      kelly_enabled = $false
      telegram_auto_enabled = $false
    }
  }
}

function Test-ReadyPack {
  param($Pack)

  $errors = New-Object System.Collections.Generic.List[object]
  $warnings = New-Object System.Collections.Generic.List[object]
  $readySignals = New-Object System.Collections.Generic.List[object]
  $index = 0

  foreach ($signal in @($Pack.signals)) {
    $index += 1
    $errorsBeforeSignal = $errors.Count
    $label = "$($signal.home_team) vs $($signal.away_team) [$($signal.market)]"
    foreach ($required in @("league", "market", "selection", "home_team", "away_team", "kickoff", "odds_timestamp", "provider", "market_odds", "model_probability", "expected_value")) {
      if (-not (Test-HasValue $signal $required)) {
        $errors.Add([ordered]@{ index = $index; match = $label; field = $required; reason = "missing_required_field" })
      }
    }
    if (-not (Test-HasValue $signal "selection") -or ([string]$signal.selection).StartsWith("__")) {
      $errors.Add([ordered]@{ index = $index; match = $label; field = "selection"; reason = "selection_placeholder_not_allowed" })
      continue
    }
    if (-not (Test-ValidSelection -Market ([string]$signal.market) -Selection ([string]$signal.selection))) {
      $errors.Add([ordered]@{ index = $index; match = $label; field = "selection"; reason = "selection_not_valid_for_market" })
    }
    if ([string]$signal.market -eq "btts") {
      $errors.Add([ordered]@{ index = $index; match = $label; field = "market"; reason = "btts_not_allowed_in_prime_pack" })
    }

    try {
      $kickoffUtc = Convert-ToIsoUtc -Value ([string]$signal.kickoff) -FieldName "kickoff"
      $oddsUtc = Convert-ToIsoUtc -Value ([string]$signal.odds_timestamp) -FieldName "odds_timestamp"
      $kickoffDate = [datetimeoffset]$kickoffUtc
      $oddsDate = [datetimeoffset]$oddsUtc
      if ($oddsDate -ge $kickoffDate) {
        $errors.Add([ordered]@{ index = $index; match = $label; field = "odds_timestamp"; reason = "POST_KICKOFF_REJECTED" })
      }
    } catch {
      $errors.Add([ordered]@{ index = $index; match = $label; field = "odds_timestamp"; reason = $_.Exception.Message })
    }

    $odds = 0.0
    $prob = 0.0
    $ev = 0.0
    if (-not [double]::TryParse("$($signal.market_odds)", [ref]$odds) -or $odds -le 1) {
      $errors.Add([ordered]@{ index = $index; match = $label; field = "market_odds"; reason = "odds_must_be_decimal_gt_1" })
    }
    if (-not [double]::TryParse("$($signal.model_probability)", [ref]$prob) -or $prob -le 0 -or $prob -gt 1) {
      $errors.Add([ordered]@{ index = $index; match = $label; field = "model_probability"; reason = "probability_must_be_0_to_1" })
    }
    if (-not [double]::TryParse("$($signal.expected_value)", [ref]$ev)) {
      $errors.Add([ordered]@{ index = $index; match = $label; field = "expected_value"; reason = "expected_value_must_be_numeric" })
    }
    if ($ev -lt 0.03) {
      $warnings.Add([ordered]@{ index = $index; match = $label; field = "expected_value"; reason = "ev_below_initial_shadow_threshold_3pct" })
    }
    if ($prob -lt 0.52) {
      $warnings.Add([ordered]@{ index = $index; match = $label; field = "model_probability"; reason = "probability_below_initial_shadow_threshold_52pct" })
    }

    $raw = if (Test-HasValue $signal "raw_data") { $signal.raw_data } else { @{} }
    $consensus = if (Test-HasValue $raw "source_consensus") { [string]$raw.source_consensus } else { "" }
    if ($consensus -eq "" -or $consensus -eq "espn_api_only") {
      $warnings.Add([ordered]@{ index = $index; match = $label; field = "source_consensus"; reason = "onefootball_consensus_recommended_before_apply" })
    }

    if ($errors.Count -eq $errorsBeforeSignal) {
      $readySignals.Add($signal)
    }
  }

  return [ordered]@{
    ready = $errors.Count -eq 0
    signal_count = @($Pack.signals).Count
    ready_signal_count = @($readySignals.ToArray()).Count
    errors = @($errors.ToArray())
    warnings = @($warnings.ToArray())
    ready_signals = @($readySignals.ToArray())
  }
}

$resolvedUniverse = Resolve-Path -LiteralPath $UniversePath
$json = Get-Content -LiteralPath $resolvedUniverse -Raw | ConvertFrom-Json
$Markets = Normalize-StringList -Values $Markets
$PreferredLeagues = Normalize-StringList -Values $PreferredLeagues

if ($ValidateReady) {
  $result = Test-ReadyPack -Pack $json
  Write-Host "[football-prime-pack] validate=$($result.ready) signals=$($result.signal_count) errors=$(@($result.errors).Count) warnings=$(@($result.warnings).Count)"
  if ($ReadyOutputPath -and $result.ready) {
    $readyPayload = [ordered]@{
      source = "prime_football_shadow_candidate_pack_ready"
      date = if (Test-HasValue $json "date") { [string]$json.date } else { (Get-Date).ToString("yyyy-MM-dd") }
      signals = @($json.signals)
    }
    $readyPayload | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $ReadyOutputPath -Encoding UTF8
    Write-Host "[football-prime-pack] ready_output=$ReadyOutputPath"
  }
  [pscustomobject]@{
    ready = $result.ready
    signal_count = $result.signal_count
    ready_signal_count = $result.ready_signal_count
    errors = $result.errors
    warnings = $result.warnings
  } | ConvertTo-Json -Depth 10
  if (-not $result.ready) {
    exit 1
  }
  exit 0
}

if (-not $OutputPath) {
  $base = [System.IO.Path]::GetFileNameWithoutExtension($resolvedUniverse.Path)
  $OutputPath = Join-Path ([System.IO.Path]::GetDirectoryName($resolvedUniverse.Path)) ($base -replace "football_today_espn", "football_shadow_candidates_prime" + ".draft")
}

$pack = New-DraftPack -Universe $json -LeaguePriority $PreferredLeagues -MarketList $Markets -Limit $MaxFixtures
$pack | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "[football-prime-pack] draft_output=$OutputPath selected=$(@($pack.selected_fixtures).Count) signals=$(@($pack.signals).Count)"
Write-Host "[football-prime-pack] status=DRAFT_NOT_APPLY fill odds/model fields, then run -ValidateReady"
