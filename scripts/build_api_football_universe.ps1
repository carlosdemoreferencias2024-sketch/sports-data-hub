param(
  [string]$ApiKey = $(if ($env:API_FOOTBALL_KEY) { $env:API_FOOTBALL_KEY } elseif ($env:FOOTBALL_API_KEY) { $env:FOOTBALL_API_KEY } else { "" }),
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$BaseUrl = "https://v3.football.api-sports.io",
  [string]$OutputPath = "",
  [string[]]$LeagueIds = @("liga-mx", "mls", "brasileirao-serie-a", "fifa-world-cup-2026"),
  [int[]]$ApiLeagueIds = @(),
  [int]$Season = 2026,
  [switch]$UseGlobalDateEndpoint,
  [switch]$IncludeFinished,
  [switch]$AllowApiOnlyTrustedKickoff
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $ApiKey) {
  throw "API_FOOTBALL_KEY no esta definido. Exportalo como API_FOOTBALL_KEY o FOOTBALL_API_KEY, o pasalo con -ApiKey."
}

function Assert-ApiFootballOk($Payload) {
  if ($null -eq $Payload) { throw "API_FOOTBALL_EMPTY_RESPONSE" }
  $errorsProperty = $Payload.PSObject.Properties["errors"]
  if ($errorsProperty -and $null -ne $Payload.errors) {
    $errorJson = $Payload.errors | ConvertTo-Json -Compress -Depth 8
    if ($errorJson -and $errorJson -ne "[]" -and $errorJson -ne "{}") {
      throw "API_FOOTBALL_RESPONSE_ERROR $errorJson"
    }
  }
  return $Payload
}

function Invoke-ApiFootballJson([string]$Uri) {
  $headers = @("x-apisports-key: $ApiKey")
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $body = & curl.exe -sS --connect-timeout 15 --max-time 45 -H $headers[0] $Uri 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "API_FOOTBALL_CURL_FAILED exit=$LASTEXITCODE detail=$body"
    }
    return Assert-ApiFootballOk ($body | ConvertFrom-Json)
  }
  return Assert-ApiFootballOk (Invoke-RestMethod -Method Get -Uri $Uri -Headers @{ "x-apisports-key" = $ApiKey } -TimeoutSec 30)
}

function Get-CalendarFetchError([string]$Message) {
  $lower = $Message.ToLowerInvariant()
  if ($lower -match "request limit for the day|daily.*limit|quota.*day") {
    return [pscustomobject]@{ code = "DAILY_LIMIT_REACHED"; retryable = $false }
  }
  if ($lower -match "429|rate limit|too many requests") {
    return [pscustomobject]@{ code = "RATE_LIMIT"; retryable = $true }
  }
  if ($lower -match "timeout|timed out|econnreset|curl_failed|502|503|504") {
    return [pscustomobject]@{ code = "NETWORK_ERROR"; retryable = $true }
  }
  if ($lower -match "response_error") {
    return [pscustomobject]@{ code = "PROVIDER_ERROR"; retryable = $false }
  }
  return [pscustomobject]@{ code = "UNKNOWN"; retryable = $false }
}

function Get-LeagueMeta([string]$leagueId) {
  $map = @{
    "liga-mx" = @{ api_id = 262; name = "Liga MX"; country = "Mexico" }
    "mls" = @{ api_id = 253; name = "Major League Soccer"; country = "USA" }
    "nwsl" = @{ api_id = 254; name = "NWSL Women"; country = "USA" }
    "brasileirao-serie-a" = @{ api_id = 71; name = "Serie A"; country = "Brazil" }
    "argentina-primera-division" = @{ api_id = 128; name = "Liga Profesional Argentina"; country = "Argentina" }
    "fifa-world-cup-2026" = @{ api_id = 1; name = "World Cup"; country = "World" }
    "uefa-champions-league" = @{ api_id = 2; name = "UEFA Champions League"; country = "World" }
    "europa-league" = @{ api_id = 3; name = "UEFA Europa League"; country = "World" }
    "conference-league" = @{ api_id = 848; name = "UEFA Europa Conference League"; country = "World" }
    "leagues-cup" = @{ api_id = 772; name = "Leagues Cup"; country = "World" }
    "copa-libertadores" = @{ api_id = 13; name = "CONMEBOL Libertadores"; country = "World" }
    "copa-sudamericana" = @{ api_id = 11; name = "CONMEBOL Sudamericana"; country = "World" }
    "premier-league" = @{ api_id = 39; name = "Premier League"; country = "England" }
    "la-liga" = @{ api_id = 140; name = "La Liga"; country = "Spain" }
    "serie-a" = @{ api_id = 135; name = "Serie A"; country = "Italy" }
    "bundesliga" = @{ api_id = 78; name = "Bundesliga"; country = "Germany" }
  }
  if ($map.ContainsKey($leagueId)) { return $map[$leagueId] }
  return @{ api_id = $null; name = $leagueId; country = "Global" }
}

function Convert-FixtureStatus($short) {
  switch ($short) {
    "NS" { return "scheduled" }
    "TBD" { return "scheduled" }
    "1H" { return "live" }
    "HT" { return "live" }
    "2H" { return "live" }
    "ET" { return "live" }
    "P" { return "live" }
    "FT" { return "finished" }
    "AET" { return "finished" }
    "PEN" { return "finished" }
    "PST" { return "postponed" }
    "CANC" { return "cancelled" }
    "ABD" { return "cancelled" }
    default { return "scheduled" }
  }
}

function Add-FixtureFromResponse($Fixtures, $Item, [string]$LeagueId, [bool]$ApiOnlyTrusted) {
  $statusShort = [string]$Item.fixture.status.short
  $status = Convert-FixtureStatus $statusShort
  if (-not $IncludeFinished -and $status -eq "finished") { return $false }
  $Fixtures.Add([ordered]@{
    match_id = ""
    league = $LeagueId
    home_team = [string]$Item.teams.home.name
    away_team = [string]$Item.teams.away.name
    kickoff = [string]$Item.fixture.date
    status = $status
    source = "api_football"
    raw_data = [ordered]@{
      football_today_universe = $true
      observation_only = $true
      feed_status = "OBSERVATION_ONLY"
      source = "api_football"
      source_consensus = "api_football_only"
      kickoff_trusted = $ApiOnlyTrusted
      requires_onefootball_consensus = (-not $ApiOnlyTrusted)
      api_football_fixture_id = [string]$Item.fixture.id
      api_football_league_id = [string]$Item.league.id
      api_football_league_name = [string]$Item.league.name
      api_football_country = [string]$Item.league.country
      api_football_season = [string]$Item.league.season
      api_football_status_short = $statusShort
      provider_name = "api-football"
      provider_event_id = [string]$Item.fixture.id
      calendar_provider_status = "SUCCESS"
      venue_name = [string]$Item.fixture.venue.name
      venue_city = [string]$Item.fixture.venue.city
      real_money_enabled = $false
      kelly_enabled = $false
      telegram_auto_enabled = $false
    }
  })
  return $true
}

if (-not $OutputPath) {
  $OutputPath = Join-Path $PSScriptRoot ("football_today_api_football_{0}.json" -f ([datetime]::Parse($Date).ToString("yyyyMMdd")))
}

$fixtures = New-Object System.Collections.Generic.List[object]
$signals = New-Object System.Collections.Generic.List[object]
$errors = New-Object System.Collections.Generic.List[object]
$summary = New-Object System.Collections.Generic.List[object]
$targets = New-Object System.Collections.Generic.List[object]

foreach ($leagueId in $LeagueIds) {
  $meta = Get-LeagueMeta $leagueId
  if ($null -ne $meta.api_id) {
    $targets.Add([pscustomobject]@{ league_id=$leagueId; api_id=[int]$meta.api_id; name=$meta.name; country=$meta.country })
  }
}
foreach ($apiLeagueId in $ApiLeagueIds) {
  $targets.Add([pscustomobject]@{ league_id=("api-football-league-{0}" -f $apiLeagueId); api_id=$apiLeagueId; name=("API-Football League {0}" -f $apiLeagueId); country="Global" })
}

if ($UseGlobalDateEndpoint) {
  $targetByApiId = @{}
  foreach ($target in @($targets.ToArray())) {
    $targetByApiId[[string]$target.api_id] = $target
    $summary.Add([pscustomobject]@{ league_id=$target.league_id; api_league_id=$target.api_id; provider="API_FOOTBALL"; status="PENDING"; fixtures=0; errors=0; error_code=$null; retryable=$false; mode="global_date_filter" })
  }
  try {
    $payload = Invoke-ApiFootballJson "$BaseUrl/fixtures?date=$([uri]::EscapeDataString($Date))"
    foreach ($item in @($payload.response)) {
      $apiId = [string]$item.league.id
      if (-not $targetByApiId.ContainsKey($apiId)) { continue }
      $target = $targetByApiId[$apiId]
      $added = Add-FixtureFromResponse -Fixtures $fixtures -Item $item -LeagueId ([string]$target.league_id) -ApiOnlyTrusted ([bool]$AllowApiOnlyTrustedKickoff)
      if ($added) {
        foreach ($row in $summary) {
          if ([string]$row.api_league_id -eq $apiId) { $row.fixtures = [int]$row.fixtures + 1 }
        }
      }
    }
    foreach ($row in $summary) {
      $row.status = if ([int]$row.fixtures -gt 0) { "SUCCESS" } else { "EMPTY" }
    }
  } catch {
    $classified = Get-CalendarFetchError $_.Exception.Message
    $errors.Add([ordered]@{ endpoint="fixtures_global_date"; code=$classified.code; retryable=$classified.retryable; error=$_.Exception.Message })
    foreach ($row in $summary) {
      $row.errors = [int]$row.errors + 1
      $row.status = "ERROR"
      $row.error_code = $classified.code
      $row.retryable = $classified.retryable
    }
  }
} else {
  foreach ($target in @($targets.ToArray())) {
    $uri = "$BaseUrl/fixtures?date=$([uri]::EscapeDataString($Date))&league=$($target.api_id)&season=$Season"
    try {
      $payload = Invoke-ApiFootballJson $uri
      $count = 0
      foreach ($item in @($payload.response)) {
        $added = Add-FixtureFromResponse -Fixtures $fixtures -Item $item -LeagueId ([string]$target.league_id) -ApiOnlyTrusted ([bool]$AllowApiOnlyTrustedKickoff)
        if ($added) { $count += 1 }
      }
      $status = if ($count -gt 0) { "SUCCESS" } else { "EMPTY" }
      $summary.Add([pscustomobject]@{ league_id=$target.league_id; api_league_id=$target.api_id; provider="API_FOOTBALL"; status=$status; fixtures=$count; errors=0; error_code=$null; retryable=$false; mode="league_date_filter" })
    } catch {
      $classified = Get-CalendarFetchError $_.Exception.Message
      $errors.Add([ordered]@{ league_id=$target.league_id; api_league_id=$target.api_id; endpoint="fixtures"; code=$classified.code; retryable=$classified.retryable; error=$_.Exception.Message })
      $summary.Add([pscustomobject]@{ league_id=$target.league_id; api_league_id=$target.api_id; provider="API_FOOTBALL"; status="ERROR"; fixtures=0; errors=1; error_code=$classified.code; retryable=$classified.retryable; mode="league_date_filter" })
    }
  }
}

$summaryRows = @($summary.ToArray())
$failedLeagues = @($summaryRows | Where-Object { $_.status -eq "ERROR" }).Count
$successfulLeagues = @($summaryRows | Where-Object { $_.status -eq "SUCCESS" }).Count
$emptyLeagues = @($summaryRows | Where-Object { $_.status -eq "EMPTY" }).Count
$health = if ($summaryRows.Count -gt 0 -and $failedLeagues -eq $summaryRows.Count) { "FAILED" } elseif ($failedLeagues -gt 0) { "DEGRADED" } else { "HEALTHY" }
$runSummary = [ordered]@{
  health = $health
  total_leagues = $summaryRows.Count
  successful_leagues = $successfulLeagues
  empty_leagues = $emptyLeagues
  failed_leagues = $failedLeagues
  fixtures = $fixtures.Count
  providers_used = @("API_FOOTBALL")
}

$output = [ordered]@{
  date = $Date
  source = "api_football"
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  dry_run = $true
  safety = [ordered]@{
    real_candidate = 0
    real_money_enabled = $false
    kelly_enabled = $false
    telegram_auto_enabled = $false
    output_intent = "OBSERVATION_ONLY"
  }
  fetch_summary = $summaryRows
  run_summary = $runSummary
  errors = @($errors.ToArray())
  fixtures = @($fixtures.ToArray())
  signals = @($signals.ToArray())
}

$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path (Get-Location) $OutputPath }
$json = $output | ConvertTo-Json -Depth 24
[System.IO.File]::WriteAllText($resolvedOutput, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host "[api-football-universe] output=$resolvedOutput"
Write-Host "[api-football-universe] fixtures=$($fixtures.Count) signals=$($signals.Count) intent=OBSERVATION_ONLY"
Write-Host "[api-football-universe] health=$health success=$successfulLeagues empty=$emptyLeagues failed=$failedLeagues"
$summary | ConvertTo-Json -Depth 8
