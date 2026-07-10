param(
  [Parameter(Mandatory = $true)]
  [string]$SignalsPath,
  [Parameter(Mandatory = $true)]
  [string]$OneFootballPath,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [string]$SettlementOutputPath,
  [int]$KickoffToleranceMinutes = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-HasProperty {
  param($Object, [string]$Name)
  return $null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name] -and $null -ne $Object.$Name -and "$($Object.$Name)" -ne ""
}

function Normalize-Text {
  param([string]$Value)

  if (-not $Value) {
    return ""
  }

  $normalized = $Value.ToLowerInvariant().Normalize([Text.NormalizationForm]::FormD)
  $builder = [Text.StringBuilder]::new()
  foreach ($char in $normalized.ToCharArray()) {
    $category = [Globalization.CharUnicodeInfo]::GetUnicodeCategory($char)
    if ($category -ne [Globalization.UnicodeCategory]::NonSpacingMark) {
      [void]$builder.Append($char)
    }
  }

  $plain = $builder.ToString().Normalize([Text.NormalizationForm]::FormC)
  $plain = $plain -replace "\bfc\b", ""
  $plain = $plain -replace "\bclub\b", ""
  $plain = $plain -replace "[^a-z0-9]+", " "
  return ($plain -replace "\s+", " ").Trim()
}

function Get-LeagueKey {
  param($Item)

  if (Test-HasProperty $Item "league_id") {
    return Normalize-Text ([string]$Item.league_id)
  }
  if (Test-HasProperty $Item "league") {
    return Normalize-Text ([string]$Item.league)
  }
  if (Test-HasProperty $Item "league_name") {
    return Normalize-Text ([string]$Item.league_name)
  }
  return ""
}

function Get-TeamKey {
  param($Item)
  return "$(Normalize-Text ([string]$Item.home_team))|$(Normalize-Text ([string]$Item.away_team))"
}

function Get-SwappedTeamKey {
  param($Item)
  return "$(Normalize-Text ([string]$Item.away_team))|$(Normalize-Text ([string]$Item.home_team))"
}

function Get-FixtureKey {
  param($Item)
  return "$(Get-LeagueKey $Item)|$(Get-TeamKey $Item)"
}

function Get-UtcDateOrNull {
  param($Value)

  if ($null -eq $Value -or "$Value" -eq "") {
    return $null
  }
  try {
    return ([datetimeoffset][string]$Value).UtcDateTime
  } catch {
    return $null
  }
}

function Ensure-RawData {
  param($Signal)

  if (-not (Test-HasProperty $Signal "raw_data")) {
    $Signal | Add-Member -NotePropertyName "raw_data" -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  return $Signal.raw_data
}

function Set-RawData {
  param($RawData, [string]$Name, $Value)
  $RawData | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Read-JsonArray {
  param([string]$Path, [string]$PropertyName)

  $resolved = Resolve-Path -LiteralPath $Path
  $json = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json
  if ($null -ne $json.PSObject.Properties[$PropertyName]) {
    return @($json.$PropertyName)
  }
  return @($json)
}

$signals = @(Read-JsonArray -Path $SignalsPath -PropertyName "signals")
$oneFootballFixtures = @(Read-JsonArray -Path $OneFootballPath -PropertyName "fixtures")

if ($signals.Count -lt 1) {
  throw "SignalsPath no contiene signals."
}
if ($oneFootballFixtures.Count -lt 1) {
  throw "OneFootballPath no contiene fixtures."
}

$fixturesByKey = @{}
$fixturesBySwappedKey = @{}
foreach ($fixture in $oneFootballFixtures) {
  $key = Get-FixtureKey $fixture
  if ($key -ne "|") {
    $fixturesByKey[$key] = $fixture
  }
  $swappedKey = "$(Get-LeagueKey $fixture)|$(Get-SwappedTeamKey $fixture)"
  if ($swappedKey -ne "|") {
    $fixturesBySwappedKey[$swappedKey] = $fixture
  }
}

$trusted = 0
$blocked = 0
$results = @()
$validatedSignals = @()

foreach ($signal in $signals) {
  $rawData = Ensure-RawData -Signal $signal
  $key = Get-FixtureKey $signal
  $oneFootball = $fixturesByKey[$key]
  $status = "KICKOFF_UNTRUSTED"
  $trustedFixture = $false
  $kickoffDeltaMinutes = $null

  if ($null -eq $oneFootball) {
    if ($fixturesBySwappedKey.ContainsKey($key)) {
      $oneFootball = $fixturesBySwappedKey[$key]
      $status = "TEAM_SIDE_MISMATCH"
    } else {
      $status = "ONEFOOTBALL_FIXTURE_NOT_FOUND"
    }
  } else {
    $signalKickoff = Get-UtcDateOrNull $signal.kickoff
    $oneFootballKickoff = Get-UtcDateOrNull $oneFootball.kickoff
    if ($null -eq $signalKickoff -or $null -eq $oneFootballKickoff) {
      $status = "KICKOFF_UNTRUSTED"
    } else {
      $kickoffDeltaMinutes = [Math]::Round([Math]::Abs(($signalKickoff - $oneFootballKickoff).TotalMinutes), 2)
      if ($kickoffDeltaMinutes -le $KickoffToleranceMinutes) {
        $status = "TRUSTED"
        $trustedFixture = $true
        $signal.kickoff = ([datetimeoffset]$oneFootballKickoff).UtcDateTime.ToString("o")
      } else {
        $status = "KICKOFF_UNTRUSTED"
      }
    }
  }

  if ($trustedFixture) {
    $trusted += 1
  } else {
    $blocked += 1
  }

  Set-RawData -RawData $rawData -Name "kickoff_trusted" -Value $trustedFixture
  Set-RawData -RawData $rawData -Name "source_consensus" -Value ($(if ($trustedFixture) { "espn+onefootball" } else { "espn_only" }))
  Set-RawData -RawData $rawData -Name "validation_status" -Value $status
  Set-RawData -RawData $rawData -Name "onefootball_validator" -Value $true
  Set-RawData -RawData $rawData -Name "onefootball_home_team" -Value ($(if ($oneFootball) { [string]$oneFootball.home_team } else { $null }))
  Set-RawData -RawData $rawData -Name "onefootball_away_team" -Value ($(if ($oneFootball) { [string]$oneFootball.away_team } else { $null }))
  Set-RawData -RawData $rawData -Name "onefootball_league" -Value ($(if ($oneFootball -and (Test-HasProperty $oneFootball "league")) { [string]$oneFootball.league } else { $null }))
  Set-RawData -RawData $rawData -Name "onefootball_kickoff" -Value ($(if ($oneFootball -and (Test-HasProperty $oneFootball "kickoff")) { [string]$oneFootball.kickoff } else { $null }))
  Set-RawData -RawData $rawData -Name "onefootball_status" -Value ($(if ($oneFootball -and (Test-HasProperty $oneFootball "status")) { [string]$oneFootball.status } else { $null }))
  Set-RawData -RawData $rawData -Name "kickoff_delta_minutes" -Value $kickoffDeltaMinutes

  $validatedSignals += $signal

  if ($oneFootball -and (Test-HasProperty $oneFootball "status")) {
    $ofStatus = ([string]$oneFootball.status).ToLowerInvariant()
    if (($ofStatus -eq "finished" -or $ofStatus -eq "final" -or $ofStatus -eq "ft") -and (Test-HasProperty $oneFootball "home_score") -and (Test-HasProperty $oneFootball "away_score")) {
      $results += [pscustomobject]@{
        match_id = $signal.match_id
        league = $(if (Test-HasProperty $signal "league") { $signal.league } else { $signal.league_id })
        home_team = $signal.home_team
        away_team = $signal.away_team
        home_score = [int]$oneFootball.home_score
        away_score = [int]$oneFootball.away_score
        finished_at = $(if (Test-HasProperty $oneFootball "finished_at") { $oneFootball.finished_at } else { (Get-Date).ToUniversalTime().ToString("o") })
        result_source = "onefootball"
        kickoff_trusted = $trustedFixture
        source_consensus = $(if ($trustedFixture) { "espn+onefootball" } else { "espn_only" })
      }
    }
  }
}

$output = [pscustomobject]@{
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  validator = "onefootball_fixture_validator"
  kickoff_tolerance_minutes = $KickoffToleranceMinutes
  total = $signals.Count
  trusted = $trusted
  blocked = $blocked
  signals = $validatedSignals
}

$outputDir = Split-Path -Parent $OutputPath
if ($outputDir) {
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}
$output | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
Write-Host "[onefootball-validator] total=$($signals.Count) trusted=$trusted blocked=$blocked output=$OutputPath"

if ($SettlementOutputPath) {
  $settlement = [pscustomobject]@{
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    result_source = "onefootball"
    results = $results
    closing_odds = @()
  }
  $settlementDir = Split-Path -Parent $SettlementOutputPath
  if ($settlementDir) {
    New-Item -ItemType Directory -Force -Path $settlementDir | Out-Null
  }
  $settlement | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $SettlementOutputPath -Encoding UTF8
  Write-Host "[onefootball-validator] settlement_results=$($results.Count) settlement_output=$SettlementOutputPath"
}
