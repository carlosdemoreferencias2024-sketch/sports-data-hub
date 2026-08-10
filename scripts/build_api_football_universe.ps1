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
    $body = & curl.exe -sS --connect-timeout 30 -H $headers[0] $Uri 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "API_FOOTBALL_CURL_FAILED exit=$LASTEXITCODE detail=$body"
    }
    return Assert-ApiFootballOk ($body | ConvertFrom-Json)
  }
  return Assert-ApiFootballOk (Invoke-RestMethod -Method Get -Uri $Uri -Headers @{ "x-apisports-key" = $ApiKey } -TimeoutSec 30)
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
    $summary.Add([pscustomobject]@{ league_id=$target.league_id; api_league_id=$target.api_id; fixtures=0; errors=0; mode="global_date_filter" })
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
  } catch {
    $errors.Add([ordered]@{ endpoint="fixtures_global_date"; error=$_.Exception.Message })
    foreach ($row in $summary) { $row.errors = [int]$row.errors + 1 }
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
      $summary.Add([pscustomobject]@{ league_id=$target.league_id; api_league_id=$target.api_id; fixtures=$count; errors=0; mode="league_date_filter" })
    } catch {
      $errors.Add([ordered]@{ league_id=$target.league_id; api_league_id=$target.api_id; endpoint="fixtures"; error=$_.Exception.Message })
      $summary.Add([pscustomobject]@{ league_id=$target.league_id; api_league_id=$target.api_id; fixtures=0; errors=1; mode="league_date_filter" })
    }
  }
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
  fetch_summary = @($summary.ToArray())
  errors = @($errors.ToArray())
  fixtures = @($fixtures.ToArray())
  signals = @($signals.ToArray())
}

$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path (Get-Location) $OutputPath }
$json = $output | ConvertTo-Json -Depth 24
[System.IO.File]::WriteAllText($resolvedOutput, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host "[api-football-universe] output=$resolvedOutput"
Write-Host "[api-football-universe] fixtures=$($fixtures.Count) signals=$($signals.Count) intent=OBSERVATION_ONLY"
$summary | ConvertTo-Json -Depth 8