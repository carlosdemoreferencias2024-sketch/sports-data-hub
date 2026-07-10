param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$SportsDataIoApiKey = $(if ($env:SPORTSDATAIO_API_KEY) { $env:SPORTSDATAIO_API_KEY } else { $env:SPORTS_DATA_IO_API_KEY }),
  [string]$Date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd"),
  [string]$ProviderName = "sportsdataio_trial",
  [string]$OutputPath = "",
  [double]$MinEv = 0.03,
  [int]$MaxModelAgeMinutes = 240,
  [int]$MaxMarketAgeMinutes = 30,
  [switch]$ClosingOnly,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo como SPORTS_DATA_HUB_INTERNAL_KEY o pasalo con -InternalApiKey."
}
if (-not $SportsDataIoApiKey) {
  throw "SPORTSDATAIO_API_KEY no esta definido. Exportalo o pasalo con -SportsDataIoApiKey."
}

$headers = @{ "X-Internal-API-Key" = $InternalApiKey }
$sportsDataHeaders = @{ "Ocp-Apim-Subscription-Key" = $SportsDataIoApiKey }
$dateValue = [DateTime]::Parse($Date).ToUniversalTime()
$dateKey = $dateValue.ToString("yyyy-MMM-dd", [Globalization.CultureInfo]::InvariantCulture).ToUpperInvariant()
$dateIso = $dateValue.ToString("yyyy-MM-dd")

if (-not $ClosingOnly -and ([DateTime]::Parse($Date)).Date -lt (Get-Date).Date) {
  throw "RETROACTIVE_ENTRY_BLOCKED: $dateIso ya paso. Usa -ClosingOnly para guardar closing odds sin crear nuevas entradas."
}

if (-not $OutputPath) {
  $OutputPath = Join-Path ([IO.Path]::GetTempPath()) "real_mlb_moneyline_quotes_$($dateIso.Replace('-', '')).json"
}

function Convert-AmericanToDecimal($Value) {
  if ($null -eq $Value -or "$Value" -eq "") { return $null }
  $number = [double]$Value
  if ($number -gt 0) {
    return [math]::Round(1 + ($number / 100), 4)
  }
  return [math]::Round(1 + (100 / [math]::Abs($number)), 4)
}

function Get-TeamAbbreviation($Match, [string]$Side) {
  $competitor = @($Match.competitors | Where-Object { $_.home_away -eq $Side } | Select-Object -First 1)
  if (-not $competitor) { return "" }
  return [string]$competitor.abbreviation
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$statusFilter = if ($ClosingOnly) { "'scheduled','live','finished'" } else { "'scheduled','live'" }
$fixtureSql = @"
SELECT json_agg(row_to_json(x)) AS fixtures
FROM (
  SELECT
    m.id::text AS id,
    ht.abbreviation AS home_abbreviation,
    at.abbreviation AS away_abbreviation
  FROM matches m
  JOIN leagues l ON l.id = m.league_id
  JOIN match_competitors hc ON hc.match_id = m.id AND hc.home_away = 'home'
  JOIN teams ht ON ht.id = hc.team_id
  JOIN match_competitors ac ON ac.match_id = m.id AND ac.home_away = 'away'
  JOIN teams at ON at.id = ac.team_id
  WHERE l.slug = 'mlb'
    AND m.status IN ($statusFilter)
    AND m.match_date::date = '$dateIso'::date
  ORDER BY m.match_date, ht.name, at.name
) x;
"@

Push-Location $repoRoot
try {
  $fixtureJson = & docker.exe compose --profile odds exec -T db-postgres psql -U sports_admin -d sports_db -t -A -c $fixtureSql
  if ($LASTEXITCODE -ne 0) {
    throw "No se pudieron consultar fixtures MLB desde Postgres."
  }
} finally {
  Pop-Location
}

$fixtureJson = ($fixtureJson | Where-Object { $_ -and "$_".Trim() -ne "" } | Select-Object -First 1)
$parsedFixtures = if ($fixtureJson -and $fixtureJson -ne "null") { $fixtureJson | ConvertFrom-Json } else { $null }
if ($null -eq $parsedFixtures) {
  $hubMlbToday = @()
} elseif ($parsedFixtures.PSObject.Properties.Name -contains "fixtures") {
  $hubMlbToday = @($parsedFixtures.fixtures)
} else {
  $hubMlbToday = @($parsedFixtures)
}

if ($hubMlbToday.Count -lt 1) {
  throw "No hay fixtures MLB scheduled/live para $dateIso en el Hub. Corre scraper-mlb y model_pipeline primero."
}

$fixtureMap = @{}
foreach ($fixture in $hubMlbToday) {
  $key = "$($fixture.home_abbreviation)|$($fixture.away_abbreviation)"
  if (-not $fixtureMap.ContainsKey($key)) {
    $fixtureMap[$key] = [string]$fixture.id
  }
}

$oddsUrl = "https://api.sportsdata.io/v3/mlb/odds/json/GameOddsByDate/$dateKey"
$oddsPayload = Invoke-RestMethod -Method Get -Uri $oddsUrl -Headers $sportsDataHeaders
$odds = @()
foreach ($item in $oddsPayload) {
  $odds += $item
}

$quotes = @()
foreach ($game in $odds) {
  $matchKey = "$([string]$game.HomeTeamName)|$([string]$game.AwayTeamName)"
  if (-not $fixtureMap.ContainsKey($matchKey)) { continue }

  $gameOdd = @(
    $game.PregameOdds |
      Where-Object { $null -ne $_.HomeMoneyLine -and $null -ne $_.AwayMoneyLine } |
      Sort-Object Updated -Descending |
      Select-Object -First 1
  )
  if (-not $gameOdd) { continue }

  $bookmaker = "sportsdataio_sportsbook_$($gameOdd.SportsbookId)"
  $providerUpdated = if ($gameOdd.Updated) { [string]$gameOdd.Updated } else { "" }

  $quotes += [pscustomobject]@{
    match_id = [string]$fixtureMap[$matchKey]
    provider_name = $ProviderName
    bookmaker = $bookmaker
    market_type = "moneyline_2way"
    home_odds = Convert-AmericanToDecimal $gameOdd.HomeMoneyLine
    away_odds = Convert-AmericanToDecimal $gameOdd.AwayMoneyLine
    captured_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    event_id = [string]$game.GameId
    bookmaker_event_id = [string]$gameOdd.GameOddId
    home_team = [string]$game.HomeTeamName
    away_team = [string]$game.AwayTeamName
    notes = "SportsDataIO trial feed; sportsbook names are scrambled; provider_updated=$providerUpdated"
  }
}

if ($quotes.Count -lt 1) {
  $fixtureSample = ($fixtureMap.Keys | Select-Object -First 5) -join ", "
  $oddsSample = @($odds | Select-Object -First 5 | ForEach-Object { "$($_.HomeTeamName)|$($_.AwayTeamName)" }) -join ", "
  Write-Host "[sportsdataio] fixture_keys_sample=$fixtureSample"
  Write-Host "[sportsdataio] odds_keys_sample=$oddsSample"
  throw "SportsDataIO respondio, pero no se pudo mapear ninguna cuota MLB Moneyline contra fixtures del Hub para $dateIso."
}

@{ quotes = $quotes } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "[sportsdataio] date=$dateIso hub_matches=$($hubMlbToday.Count) quotes=$($quotes.Count) output=$OutputPath"

$loader = Join-Path $PSScriptRoot "real_paper_mlb_moneyline_from_json.ps1"
$loaderArgs = @(
  "-HubBaseUrl", $HubBaseUrl,
  "-InternalApiKey", $InternalApiKey,
  "-InputPath", $OutputPath,
  "-ProviderName", $ProviderName,
  "-MinEv", ([string]$MinEv),
  "-MaxModelAgeMinutes", ([string]$MaxModelAgeMinutes),
  "-MaxMarketAgeMinutes", ([string]$MaxMarketAgeMinutes)
)
if ($DryRun) { $loaderArgs += "-DryRun" }
if ($ClosingOnly) { $loaderArgs += "-QuotesOnly" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $loader @loaderArgs
exit $LASTEXITCODE
