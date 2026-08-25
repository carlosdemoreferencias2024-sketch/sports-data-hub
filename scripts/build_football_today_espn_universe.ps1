param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$OutputPath,
  [string]$Source = "espn_site_api_scoreboard",
  [string[]]$LeagueIds = @(),
  [switch]$IncludeWatchLeagues,
  [switch]$IncludeOdds
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Convert-DateToEspn($value) {
  return ([datetime]::Parse($value)).ToString("yyyyMMdd")
}

function Get-PropertyValue($object, [string]$name, $default = $null) {
  if ($null -eq $object) { return $default }
  if ($object.PSObject.Properties.Name -contains $name) { return $object.$name }
  return $default
}

function Normalize-Status($competition) {
  $type = Get-PropertyValue (Get-PropertyValue $competition "status") "type"
  $state = [string](Get-PropertyValue $type "state" "pre")
  $completed = [bool](Get-PropertyValue $type "completed" $false)
  if ($completed -or $state -eq "post") { return "finished" }
  if ($state -eq "in") { return "live" }
  return "scheduled"
}

function Get-CompetitorName($competitor) {
  $team = Get-PropertyValue $competitor "team"
  $displayName = [string](Get-PropertyValue $team "displayName" "")
  if ($displayName.Trim()) { return $displayName.Trim() }
  $shortName = [string](Get-PropertyValue $team "shortDisplayName" "")
  if ($shortName.Trim()) { return $shortName.Trim() }
  return [string](Get-PropertyValue $team "abbreviation" "Unknown")
}

function Convert-AmericanOddsToDecimal($value) {
  if ($null -eq $value) { return $null }
  $raw = ([string]$value).Trim()
  if (-not $raw -or $raw -match "^(OFF|EVEN|N/A|NA|--)$") { return $null }
  $american = 0.0
  if (-not [double]::TryParse($raw, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$american)) {
    return $null
  }
  if ($american -gt 0) {
    return [Math]::Round(1.0 + ($american / 100.0), 4)
  }
  if ($american -lt 0) {
    return [Math]::Round(1.0 + (100.0 / [Math]::Abs($american)), 4)
  }
  return $null
}

function Get-NestedPropertyValue($object, [string[]]$path) {
  $current = $object
  foreach ($segment in $path) {
    if ($null -eq $current) { return $null }
    $current = Get-PropertyValue $current $segment
  }
  return $current
}

function Invoke-EspnJson([string]$Uri) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $curl) { throw "ESPN_CURL_NOT_AVAILABLE" }
  $tempPath = [System.IO.Path]::GetTempFileName()
  try {
    $detail = & curl.exe -sS --connect-timeout 15 --max-time 45 --output $tempPath $Uri 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "ESPN_CURL_FAILED exit=$LASTEXITCODE detail=$($detail.Trim())" }
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $body = [System.IO.File]::ReadAllText($tempPath, $utf8)
    try { return $body | ConvertFrom-Json } catch { throw "ESPN_INVALID_RESPONSE $($_.Exception.Message)" }
  } finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
  }
}

function Get-EspnFetchError([string]$Message) {
  $lower = $Message.ToLowerInvariant()
  if ($lower -match "timeout|timed out|econnreset|curl_failed|502|503|504") {
    return [pscustomobject]@{ code = "NETWORK_ERROR"; retryable = $true }
  }
  if ($lower -match "invalid_response") {
    return [pscustomobject]@{ code = "INVALID_RESPONSE"; retryable = $false }
  }
  return [pscustomobject]@{ code = "PROVIDER_ERROR"; retryable = $false }
}

function Add-OddsSignal {
  param(
    [System.Collections.Generic.List[object]]$Signals,
    $Fixture,
    [string]$Market,
    [string]$Selection,
    [double]$DecimalOdds,
    [string]$Provider,
    [string]$OddsTimestamp,
    [object]$RawOdds
  )

  if ($null -eq $DecimalOdds -or $DecimalOdds -le 1) { return }
  $Signals.Add([ordered]@{
    match_id = ""
    league = $Fixture.league
    market = $Market
    selection = $Selection
    home_team = $Fixture.home_team
    away_team = $Fixture.away_team
    kickoff = $Fixture.kickoff
    odds_timestamp = $OddsTimestamp
    provider = $Provider
    market_odds = $DecimalOdds
    raw_data = [ordered]@{
      football_today_universe = $true
      feed_status = "MARKET_SNAPSHOT"
      snapshot_only = $true
      source = "espn_site_api_scoreboard_odds"
      source_consensus = "espn_api_draftkings"
      kickoff_trusted = $false
      requires_onefootball_consensus = $true
      provider = $Provider
      american_odds_source = "espn_odds"
      espn_event_id = $Fixture.raw_data.espn_event_id
      espn_slug = $Fixture.raw_data.espn_slug
      real_money_enabled = $false
      kelly_enabled = $false
      telegram_auto_enabled = $false
    }
  })
}

$espnDate = Convert-DateToEspn $Date
if (-not $OutputPath) {
  $OutputPath = Join-Path $PSScriptRoot ("football_today_espn_{0}.json" -f $espnDate)
}

$leagueConfigs = @(
  @{ Espn = "fifa.world"; League = "fifa-world-cup-2026"; Name = "Mundial 2026"; Tier = "favorite" },
  @{ Espn = "mex.1"; League = "liga-mx"; Name = "Liga MX"; Tier = "favorite" },
  @{ Espn = "usa.1"; League = "mls"; Name = "MLS"; Tier = "favorite" },
  @{ Espn = "eng.1"; League = "premier-league"; Name = "Premier League"; Tier = "favorite" },
  @{ Espn = "esp.1"; League = "la-liga"; Name = "La Liga"; Tier = "favorite" },
  @{ Espn = "ita.1"; League = "serie-a"; Name = "Serie A"; Tier = "favorite" },
  @{ Espn = "ger.1"; League = "bundesliga"; Name = "Bundesliga"; Tier = "favorite" },
  @{ Espn = "bra.1"; League = "brasileirao-serie-a"; Name = "Brasileirao Serie A"; Tier = "favorite" },
  @{ Espn = "arg.1"; League = "argentina-primera-division"; Name = "Argentina Primera Division"; Tier = "favorite" },
  @{ Espn = "usa.nwsl"; League = "nwsl"; Name = "NWSL"; Tier = "watch" },
  @{ Espn = "uefa.champions"; League = "uefa-champions-league"; Name = "UEFA Champions League"; Tier = "watch" },
  @{ Espn = "uefa.europa"; League = "europa-league"; Name = "Europa League"; Tier = "watch" },
  @{ Espn = "uefa.europa.conf"; League = "conference-league"; Name = "Conference League"; Tier = "watch" },
  @{ Espn = "concacaf.leagues.cup"; League = "leagues-cup"; Name = "Leagues Cup"; Tier = "watch" },
  @{ Espn = "conmebol.libertadores"; League = "copa-libertadores"; Name = "Copa Libertadores"; Tier = "watch" },
  @{ Espn = "conmebol.sudamericana"; League = "copa-sudamericana"; Name = "Copa Sudamericana"; Tier = "watch" },
  @{ Espn = "fra.1"; League = "ligue-1"; Name = "Ligue 1"; Tier = "watch" },
  @{ Espn = "ned.1"; League = "eredivisie"; Name = "Eredivisie"; Tier = "watch" },
  @{ Espn = "por.1"; League = "primeira-liga-portugal"; Name = "Primeira Liga Portugal"; Tier = "watch" },
  @{ Espn = "eng.league_cup"; League = "england-league-cup"; Name = "EFL League Cup"; Tier = "watch" }
)

$requestedLeagues = @($LeagueIds | ForEach-Object { [string]$_ } | Where-Object { $_ })
if ($requestedLeagues.Count -gt 0) {
  $requestedLookup = @{}
  foreach ($leagueId in $requestedLeagues) { $requestedLookup[$leagueId.Trim().ToLowerInvariant()] = $true }
  $leagueConfigs = @($leagueConfigs | Where-Object { $requestedLookup.ContainsKey(([string]$_.League).ToLowerInvariant()) })
} elseif (-not $IncludeWatchLeagues) {
  $leagueConfigs = @($leagueConfigs | Where-Object { $_.Tier -eq "favorite" })
}

$fixtures = New-Object System.Collections.Generic.List[object]
$signals = New-Object System.Collections.Generic.List[object]
$errors = New-Object System.Collections.Generic.List[object]
$summary = New-Object System.Collections.Generic.List[object]

foreach ($config in $leagueConfigs) {
  $fixtureCountBefore = $fixtures.Count
  $url = "https://site.api.espn.com/apis/site/v2/sports/soccer/$($config.Espn)/scoreboard?dates=$espnDate"
  try {
    $response = Invoke-EspnJson $url
  } catch {
    $classified = Get-EspnFetchError $_.Exception.Message
    $errors.Add([ordered]@{
      league = $config.League
      espn_slug = $config.Espn
      code = $classified.code
      retryable = $classified.retryable
      error = $_.Exception.Message
    })
    $summary.Add([pscustomobject]@{ league_id=$config.League; provider="ESPN"; status="ERROR"; fixtures=0; errors=1; error_code=$classified.code; retryable=$classified.retryable })
    continue
  }

  $events = @(Get-PropertyValue $response "events" @())
  foreach ($event in $events) {
    $competition = @((Get-PropertyValue $event "competitions" @())) | Select-Object -First 1
    if ($null -eq $competition) { continue }
    $competitors = @(Get-PropertyValue $competition "competitors" @())
    $homeCompetitor = $competitors | Where-Object { [string](Get-PropertyValue $_ "homeAway" "") -eq "home" } | Select-Object -First 1
    $awayCompetitor = $competitors | Where-Object { [string](Get-PropertyValue $_ "homeAway" "") -eq "away" } | Select-Object -First 1
    if ($null -eq $homeCompetitor -or $null -eq $awayCompetitor) { continue }

    $fixture = [ordered]@{
      match_id = ""
      league = $config.League
      home_team = Get-CompetitorName $homeCompetitor
      away_team = Get-CompetitorName $awayCompetitor
      kickoff = [string](Get-PropertyValue $event "date")
      status = Normalize-Status $competition
      source = $Source
      raw_data = [ordered]@{
        espn_event_id = [string](Get-PropertyValue $event "id")
        provider_name = "espn-soccer"
        provider_event_id = [string](Get-PropertyValue $event "id")
        calendar_provider_status = "SUCCESS"
        espn_uid = [string](Get-PropertyValue $event "uid")
        espn_slug = $config.Espn
        espn_league_name = $config.Name
        espn_tier = $config.Tier
        observation_only = $true
        feed_status = "OBSERVATION_ONLY"
        source_consensus = "espn_api_only"
        kickoff_trusted = $false
        requires_onefootball_consensus = $true
        real_money_enabled = $false
        kelly_enabled = $false
        telegram_auto_enabled = $false
      }
    }
    $fixtures.Add($fixture)

    if ($IncludeOdds) {
      $oddsRows = @(Get-PropertyValue $competition "odds" @())
      $odds = $oddsRows | Select-Object -First 1
      if ($null -ne $odds) {
        $provider = Get-PropertyValue (Get-PropertyValue $odds "provider") "name" "espn_odds"
        $providerName = ("espn_" + ([string]$provider).ToLowerInvariant() -replace "[^a-z0-9]+", "_").Trim("_")
        $oddsTimestamp = (Get-Date).ToUniversalTime().ToString("o")

        Add-OddsSignal -Signals $signals -Fixture $fixture -Market "moneyline_3way" -Selection "home" -DecimalOdds (Convert-AmericanOddsToDecimal (Get-NestedPropertyValue $odds @("moneyline", "home", "close", "odds"))) -Provider $providerName -OddsTimestamp $oddsTimestamp -RawOdds $odds
        Add-OddsSignal -Signals $signals -Fixture $fixture -Market "moneyline_3way" -Selection "away" -DecimalOdds (Convert-AmericanOddsToDecimal (Get-NestedPropertyValue $odds @("moneyline", "away", "close", "odds"))) -Provider $providerName -OddsTimestamp $oddsTimestamp -RawOdds $odds
        Add-OddsSignal -Signals $signals -Fixture $fixture -Market "moneyline_3way" -Selection "draw" -DecimalOdds (Convert-AmericanOddsToDecimal (Get-NestedPropertyValue $odds @("moneyline", "draw", "close", "odds"))) -Provider $providerName -OddsTimestamp $oddsTimestamp -RawOdds $odds
        Add-OddsSignal -Signals $signals -Fixture $fixture -Market "total_goals_2_5" -Selection "over" -DecimalOdds (Convert-AmericanOddsToDecimal (Get-NestedPropertyValue $odds @("total", "over", "close", "odds"))) -Provider $providerName -OddsTimestamp $oddsTimestamp -RawOdds $odds
        Add-OddsSignal -Signals $signals -Fixture $fixture -Market "total_goals_2_5" -Selection "under" -DecimalOdds (Convert-AmericanOddsToDecimal (Get-NestedPropertyValue $odds @("total", "under", "close", "odds"))) -Provider $providerName -OddsTimestamp $oddsTimestamp -RawOdds $odds
      }
    }
  }
  $fixtureCount = $fixtures.Count - $fixtureCountBefore
  $fetchStatus = if ($fixtureCount -gt 0) { "SUCCESS" } else { "EMPTY" }
  $summary.Add([pscustomobject]@{ league_id=$config.League; provider="ESPN"; status=$fetchStatus; fixtures=$fixtureCount; errors=0; error_code=$null; retryable=$false })
}

$fixtureRows = @($fixtures.ToArray())
$signalRows = @($signals.ToArray())
$errorRows = @($errors.ToArray())
$summaryRows = @($summary.ToArray())
$failedLeagues = @($summaryRows | Where-Object { $_.status -eq "ERROR" }).Count
$successfulLeagues = @($summaryRows | Where-Object { $_.status -eq "SUCCESS" }).Count
$emptyLeagues = @($summaryRows | Where-Object { $_.status -eq "EMPTY" }).Count
$health = if ($summaryRows.Count -gt 0 -and $failedLeagues -eq $summaryRows.Count) { "FAILED" } elseif ($failedLeagues -gt 0) { "DEGRADED" } else { "HEALTHY" }

$payload = [ordered]@{
  date = ([datetime]::Parse($Date)).ToString("yyyy-MM-dd")
  source = $Source
  fixtures = $fixtureRows
  signals = $signalRows
  fetch_summary = $summaryRows
  run_summary = [ordered]@{
    health = $health
    total_leagues = $summaryRows.Count
    successful_leagues = $successfulLeagues
    empty_leagues = $emptyLeagues
    failed_leagues = $failedLeagues
    fixtures = $fixtureRows.Count
    providers_used = @("ESPN")
  }
  meta = [ordered]@{
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    espn_date = $espnDate
    leagues_checked = $leagueConfigs.Count
    fixtures_count = $fixtureRows.Count
    signals_count = $signalRows.Count
    include_odds = [bool]$IncludeOdds
    errors = $errorRows
    quality_policy = "OBSERVATION_ONLY plus optional MARKET_SNAPSHOT odds; SHADOW_CANDIDATE still requires model_probability, expected_value, and source consensus."
  }
}

$payload | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding UTF8

Write-Host "[espn-football-universe] date=$Date espn_date=$espnDate leagues=$($leagueConfigs.Count) fixtures=$($fixtures.Count) signals=$($signals.Count) include_odds=$IncludeOdds output=$OutputPath errors=$($errors.Count)"
Write-Host "[espn-football-universe] health=$health success=$successfulLeagues empty=$emptyLeagues failed=$failedLeagues"
if ($errors.Count -gt 0) {
  $errors | ConvertTo-Json -Depth 4
}
