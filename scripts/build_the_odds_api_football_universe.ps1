param(
  [string]$ApiKey = $(if ($env:THE_ODDS_API_KEY) { $env:THE_ODDS_API_KEY } else { $env:ODDS_API_KEY }),
  [string[]]$Sports = @("soccer_usa_mls", "soccer_brazil_campeonato"),
  [string]$Regions = "us",
  [string]$Markets = "h2h,totals",
  [string]$OddsFormat = "decimal",
  [string]$DateFormat = "iso",
  [int]$DaysAhead = 3,
  [string]$OutputPath = "",
  [int]$MaxBookmakersPerEvent = 3,
  [switch]$IncludeUnknownLeagues
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-OddsApiJson([string]$Uri) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $body = & curl.exe -sS --connect-timeout 30 $Uri 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "THE_ODDS_API_CURL_FAILED exit=$LASTEXITCODE detail=$body"
    }
    return $body | ConvertFrom-Json
  }
  return Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec 30
}

if (-not $ApiKey) {
  throw "THE_ODDS_API_KEY no esta definido. Exportalo o pasalo con -ApiKey."
}

function Normalize-Provider([string]$value) {
  if (-not $value) { return "the_odds_api_unknown" }
  $slug = $value.ToLowerInvariant() -replace "[^a-z0-9]+", "_"
  $slug = $slug.Trim("_")
  return "the_odds_api_$slug"
}

function Get-LeagueId([string]$sportKey) {
  $map = @{
    "soccer_usa_mls" = "mls"
    "soccer_brazil_campeonato" = "brasileirao-serie-a"
    "soccer_mexico_ligamx" = "liga-mx"
    "soccer_mexico_liga_mx" = "liga-mx"
    "soccer_concacaf_leagues_cup" = "leagues-cup"
    "soccer_fifa_world_cup" = "fifa-world-cup-2026"
    "soccer_uefa_champs_league" = "uefa-champions-league"
    "soccer_epl" = "premier-league"
    "soccer_spain_la_liga" = "la-liga"
    "soccer_italy_serie_a" = "serie-a"
    "soccer_germany_bundesliga" = "bundesliga"
    "soccer_argentina_primera_division" = "argentina-primera-division"
  }
  if ($map.ContainsKey($sportKey)) { return $map[$sportKey] }
  return $sportKey
}

function Expand-SportKeys([string[]]$values) {
  $expanded = New-Object System.Collections.Generic.List[string]
  foreach ($value in @($values)) {
    if (-not $value) { continue }
    foreach ($part in ([string]$value -split ",")) {
      $sportKey = $part.Trim()
      if ($sportKey) {
        $expanded.Add($sportKey)
      }
    }
  }
  return @($expanded.ToArray() | Select-Object -Unique)
}

function Convert-OutcomeSelection($outcomeName, $homeTeam, $awayTeam, $marketKey) {
  if ($marketKey -eq "h2h") {
    if ($outcomeName -eq $homeTeam) { return "home" }
    if ($outcomeName -eq $awayTeam) { return "away" }
    if ($outcomeName -match "^(Draw|Tie)$") { return "draw" }
    return $null
  }
  if ($marketKey -eq "totals") {
    if ($outcomeName -match "^Over$") { return "over" }
    if ($outcomeName -match "^Under$") { return "under" }
    return $null
  }
  return $null
}

function Convert-Market($marketKey, $point) {
  if ($marketKey -eq "h2h") { return "moneyline_3way" }
  if ($marketKey -eq "totals" -and $null -ne $point -and [math]::Abs([double]$point - 2.5) -lt 0.001) { return "total_goals_2_5" }
  return $null
}

$from = (Get-Date).ToUniversalTime()
$to = $from.AddDays($DaysAhead)
$generatedAt = $from.ToString("o")
$date = $from.ToString("yyyy-MM-dd")

if (-not $OutputPath) {
  $OutputPath = Join-Path $PSScriptRoot ("the_odds_api_football_{0}.json" -f $from.ToString("yyyyMMdd_HHmmss"))
}

$sportKeys = Expand-SportKeys $Sports
$fixturesByKey = [ordered]@{}
$signals = New-Object System.Collections.Generic.List[object]
$fetchSummaries = New-Object System.Collections.Generic.List[object]

foreach ($sport in $sportKeys) {
  $leagueId = Get-LeagueId $sport
  if (($leagueId -eq $sport) -and (-not $IncludeUnknownLeagues)) {
    $fetchSummaries.Add([pscustomobject]@{ sport=$sport; league=$leagueId; skipped=$true; reason="UNKNOWN_LEAGUE_MAP" })
    continue
  }

  $uri = "https://api.the-odds-api.com/v4/sports/$([uri]::EscapeDataString($sport))/odds/?apiKey=$([uri]::EscapeDataString($ApiKey))&regions=$([uri]::EscapeDataString($Regions))&markets=$([uri]::EscapeDataString($Markets))&oddsFormat=$([uri]::EscapeDataString($OddsFormat))&dateFormat=$([uri]::EscapeDataString($DateFormat))&commenceTimeFrom=$([uri]::EscapeDataString($from.ToString("o")))&commenceTimeTo=$([uri]::EscapeDataString($to.ToString("o")))"
  try {
    $events = Invoke-OddsApiJson $uri
  } catch {
    $fetchSummaries.Add([pscustomobject]@{ sport=$sport; league=$leagueId; skipped=$false; error=$_.Exception.Message })
    continue
  }

  $eventCount = 0
  $signalCount = 0
  foreach ($event in @($events)) {
    $eventCount += 1
    $fixtureKey = "$sport|$($event.id)"
    if (-not $fixturesByKey.Contains($fixtureKey)) {
      $fixturesByKey[$fixtureKey] = [pscustomobject]@{
        match_id = ""
        league = $leagueId
        home_team = $event.home_team
        away_team = $event.away_team
        kickoff = $event.commence_time
        status = "scheduled"
        source = "the_odds_api"
        raw_data = [ordered]@{
          football_today_universe = $true
          observation_only = $true
          feed_status = "OBSERVATION_ONLY"
          source = "the_odds_api"
          source_consensus = "the_odds_api_only"
          requires_onefootball_consensus = $true
          kickoff_trusted = $false
          the_odds_api_sport_key = $sport
          the_odds_api_event_id = $event.id
          real_money_enabled = $false
          kelly_enabled = $false
          telegram_auto_enabled = $false
        }
      }
    }

    $bookmakers = @($event.bookmakers) | Select-Object -First $MaxBookmakersPerEvent
    foreach ($bookmaker in $bookmakers) {
      $provider = Normalize-Provider $bookmaker.key
      $lastUpdate = if ($bookmaker.last_update) { $bookmaker.last_update } else { $generatedAt }
      foreach ($market in @($bookmaker.markets)) {
        foreach ($outcome in @($market.outcomes)) {
          $standardMarket = Convert-Market $market.key $outcome.point
          if (-not $standardMarket) { continue }
          $selection = Convert-OutcomeSelection $outcome.name $event.home_team $event.away_team $market.key
          if (-not $selection) { continue }
          if (-not $outcome.price -or [double]$outcome.price -le 1) { continue }

          $signals.Add([pscustomobject]@{
            match_id = ""
            league = $leagueId
            market = $standardMarket
            selection = $selection
            home_team = $event.home_team
            away_team = $event.away_team
            kickoff = $event.commence_time
            odds_timestamp = $lastUpdate
            provider = $provider
            market_odds = [double]$outcome.price
            raw_data = [ordered]@{
              football_today_universe = $true
              source = "the_odds_api"
              source_consensus = "the_odds_api_only"
              requires_onefootball_consensus = $true
              kickoff_trusted = $false
              feed_status = "MARKET_SNAPSHOT"
              observation_only = $false
              shadow_candidate = $false
              the_odds_api_sport_key = $sport
              the_odds_api_event_id = $event.id
              bookmaker_key = $bookmaker.key
              bookmaker_title = $bookmaker.title
              market_key = $market.key
              point = $outcome.point
              real_money_enabled = $false
              kelly_enabled = $false
              telegram_auto_enabled = $false
            }
          })
          $signalCount += 1
        }
      }
    }
  }

  $fetchSummaries.Add([pscustomobject]@{ sport=$sport; league=$leagueId; skipped=$false; events=$eventCount; signals=$signalCount })
}

$fixtureRows = New-Object System.Collections.Generic.List[object]
foreach ($fixtureKey in $fixturesByKey.Keys) {
  $fixtureRows.Add($fixturesByKey[$fixtureKey])
}
$summaryRows = @($fetchSummaries.ToArray())
$signalRows = @($signals.ToArray())

$output = [ordered]@{
  date = $date
  source = "the_odds_api"
  generated_at = $generatedAt
  dry_run = $true
  safety = [ordered]@{
    real_candidate = 0
    real_money_enabled = $false
    kelly_enabled = $false
    telegram_auto_enabled = $false
    output_intent = "MARKET_SNAPSHOT_ONLY"
  }
  fetch_summary = $summaryRows
  fixtures = @($fixtureRows.ToArray())
  signals = $signalRows
}

$outputJson = $output | ConvertTo-Json -Depth 24
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path (Get-Location) $OutputPath }
[System.IO.File]::WriteAllText($resolvedOutput, $outputJson, [System.Text.UTF8Encoding]::new($false))

Write-Host "[the-odds-api-football] output=$resolvedOutput"
Write-Host "[the-odds-api-football] fixtures=$($fixturesByKey.Count) signals=$($signals.Count) intent=MARKET_SNAPSHOT_ONLY"
$fetchSummaries | ConvertTo-Json -Depth 8
