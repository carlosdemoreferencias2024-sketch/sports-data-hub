param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$ApiFootballKey = $(if ($env:API_FOOTBALL_KEY) { $env:API_FOOTBALL_KEY } else { $env:FOOTBALL_API_KEY }),
  [string]$SportsDataIoApiKey = $(if ($env:SPORTSDATAIO_API_KEY) { $env:SPORTSDATAIO_API_KEY } else { $env:SPORTS_DATA_IO_API_KEY }),
  [string]$LeagueIds = "mls,liga-mx,nwsl,brasileirao-serie-a,argentina-primera-division,uefa-champions-league,europa-league,conference-league,leagues-cup,copa-libertadores,copa-sudamericana,premier-league,la-liga,serie-a,bundesliga",
  [int]$MaxApiRequests = 20,
  [switch]$ApplyCalendar,
  [switch]$ApplyFootballContext,
  [switch]$IncludeTomorrow,
  [switch]$SkipFootballCalendar,
  [switch]$SkipFootballContext,
  [switch]$SkipMlbContext,
  [switch]$SkipConsensus
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = if ($RepoRoot) { (Resolve-Path -LiteralPath $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$ScriptRoot = Join-Path $RepoRoot "scripts"
Set-Location $RepoRoot

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Get-LocalDotEnvValue([string]$Name) {
  $envPath = Join-Path $RepoRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { return "" }
  $prefix = "$Name="
  foreach ($line in Get-Content -LiteralPath $envPath) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    if ($trimmed.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
      return $trimmed.Substring($prefix.Length).Trim('"').Trim("'")
    }
  }
  return ""
}

function Resolve-Key([string]$Current, [string[]]$Names) {
  if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current }
  foreach ($name in $Names) {
    $value = Get-LocalDotEnvValue $name
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return ""
}

function Invoke-HubGet([string]$Path) {
  $headers = @{ "X-API-Key" = $InternalApiKey; "X-Internal-API-Key" = $InternalApiKey }
  Invoke-RestMethod -Method Get -Uri "$HubBaseUrl$Path" -Headers $headers -TimeoutSec 60
}

function Invoke-HubPost([string]$Path, [object]$Payload) {
  $headers = @{ "X-API-Key" = $InternalApiKey; "X-Internal-API-Key" = $InternalApiKey }
  $json = $Payload | ConvertTo-Json -Depth 24
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  Invoke-RestMethod -Method Post -Uri "$HubBaseUrl$Path" -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 180
}

function Has-Prop($Object, [string]$Name) {
  return $null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]
}

function Get-Prop($Object, [string]$Name, $Default = $null) {
  if (Has-Prop $Object $Name) { return $Object.$Name }
  return $Default
}

function Assert-Guardrails($Name, $Response) {
  $guardrails = Get-Prop $Response "guardrails" $null
  $realCandidate = [int](Get-Prop $Response "real_candidate_count" 0)
  if (Has-Prop $guardrails "real_candidate_count") { $realCandidate = [int]$guardrails.real_candidate_count }
  $realMoney = [bool](Get-Prop $Response "real_money_enabled" $false)
  $kelly = [bool](Get-Prop $Response "kelly_enabled" $false)
  $telegram = [bool](Get-Prop $Response "telegram_auto_enabled" $false)
  if ($null -ne $guardrails) {
    if (Has-Prop $guardrails "real_money_enabled") { $realMoney = [bool]$guardrails.real_money_enabled }
    if (Has-Prop $guardrails "kelly_enabled") { $kelly = [bool]$guardrails.kelly_enabled }
    if (Has-Prop $guardrails "telegram_auto_enabled") { $telegram = [bool]$guardrails.telegram_auto_enabled }
  }
  if ($realCandidate -ne 0 -or $realMoney -or $kelly -or $telegram) {
    throw "$Name guardrail failure: real_candidate=$realCandidate real_money=$realMoney kelly=$kelly telegram=$telegram"
  }
  Write-Host "[$Name] guardrails OK real_candidate=0 real_money=false kelly=false telegram=false" -ForegroundColor Green
}

function Test-DashboardReady {
  $code = curl.exe -s -o NUL -w "%{http_code}" "$HubBaseUrl/dashboard/trading"
  if ($code -ne "200") { throw "dashboard/trading no responde 200. HTTP=$code" }
  Write-Host "[dashboard] 200" -ForegroundColor Green
}

function Invoke-FootballCalendarRefresh([string]$RunDate) {
  $dateStamp = ([datetime]::Parse($RunDate)).ToString("yyyyMMdd")
  $apiOutputPath = Join-Path $ScriptRoot ("football_today_api_football_{0}.json" -f $dateStamp)
  $espnOutputPath = Join-Path $ScriptRoot ("football_today_espn_fallback_{0}.json" -f $dateStamp)
  $mergedOutputPath = Join-Path $ScriptRoot ("football_today_calendar_{0}.json" -f $dateStamp)
  $leagueList = @($LeagueIds -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })

  $apiPayload = $null
  if ([string]::IsNullOrWhiteSpace($ApiFootballKey)) {
    Write-Host "[football-calendar] API_FOOTBALL_KEY no disponible; usando ESPN para todas las ligas." -ForegroundColor Yellow
  } else {
    Write-Step "API-Football calendar $RunDate"
    & (Join-Path $ScriptRoot "build_api_football_universe.ps1") -ApiKey $ApiFootballKey -Date $RunDate -LeagueIds $leagueList -UseGlobalDateEndpoint -OutputPath $apiOutputPath -AllowApiOnlyTrustedKickoff
    $apiPayload = Get-Content -LiteralPath $apiOutputPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }

  $apiSummaryByLeague = @{}
  if ($null -ne $apiPayload) {
    foreach ($row in @($apiPayload.fetch_summary)) { $apiSummaryByLeague[[string]$row.league_id] = $row }
  }
  $fallbackLeagues = @($leagueList | Where-Object {
    -not $apiSummaryByLeague.ContainsKey($_) -or [string]$apiSummaryByLeague[$_].status -eq "ERROR"
  })

  $espnPayload = $null
  $espnSummaryByLeague = @{}
  if ($fallbackLeagues.Count -gt 0) {
    Write-Step "ESPN calendar fallback $RunDate leagues=$($fallbackLeagues.Count)"
    & (Join-Path $ScriptRoot "build_football_today_espn_universe.ps1") -Date $RunDate -LeagueIds $fallbackLeagues -OutputPath $espnOutputPath
    $espnPayload = Get-Content -LiteralPath $espnOutputPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($row in @($espnPayload.fetch_summary)) { $espnSummaryByLeague[[string]$row.league_id] = $row }
  }

  $finalSummary = New-Object System.Collections.Generic.List[object]
  $fixtures = New-Object System.Collections.Generic.List[object]
  $signals = New-Object System.Collections.Generic.List[object]
  foreach ($leagueId in $leagueList) {
    $apiRow = if ($apiSummaryByLeague.ContainsKey($leagueId)) { $apiSummaryByLeague[$leagueId] } else { $null }
    if ($null -ne $apiRow -and [string]$apiRow.status -ne "ERROR") {
      $finalSummary.Add([pscustomobject]@{
        league_id=$leagueId; provider="API_FOOTBALL"; status=[string]$apiRow.status;
        fixtures=[int]$apiRow.fixtures; fallback_used=$false; primary_error_code=$null; error_code=$null
      })
      foreach ($fixture in @($apiPayload.fixtures | Where-Object { [string]$_.league -eq $leagueId })) { $fixtures.Add($fixture) }
      foreach ($signal in @($apiPayload.signals | Where-Object { [string]$_.league -eq $leagueId })) { $signals.Add($signal) }
      continue
    }

    $espnRow = if ($espnSummaryByLeague.ContainsKey($leagueId)) { $espnSummaryByLeague[$leagueId] } else { $null }
    if ($null -ne $espnRow) {
      $finalSummary.Add([pscustomobject]@{
        league_id=$leagueId; provider="ESPN"; status=[string]$espnRow.status;
        fixtures=[int]$espnRow.fixtures; fallback_used=$true;
        primary_error_code=$(if ($null -ne $apiRow) { [string]$apiRow.error_code } else { "API_KEY_MISSING" });
        error_code=$(if ([string]$espnRow.status -eq "ERROR") { [string]$espnRow.error_code } else { $null })
      })
      foreach ($fixture in @($espnPayload.fixtures | Where-Object { [string]$_.league -eq $leagueId })) { $fixtures.Add($fixture) }
      foreach ($signal in @($espnPayload.signals | Where-Object { [string]$_.league -eq $leagueId })) { $signals.Add($signal) }
    } else {
      $finalSummary.Add([pscustomobject]@{
        league_id=$leagueId; provider="ESPN"; status="ERROR"; fixtures=0; fallback_used=$true;
        primary_error_code=$(if ($null -ne $apiRow) { [string]$apiRow.error_code } else { "API_KEY_MISSING" });
        error_code="ESPN_LEAGUE_UNSUPPORTED"
      })
    }
  }

  $summaryRows = @($finalSummary.ToArray())
  $failedLeagues = @($summaryRows | Where-Object { $_.status -eq "ERROR" }).Count
  $successfulLeagues = @($summaryRows | Where-Object { $_.status -eq "SUCCESS" }).Count
  $emptyLeagues = @($summaryRows | Where-Object { $_.status -eq "EMPTY" }).Count
  $health = if ($failedLeagues -eq $summaryRows.Count) { "FAILED" } elseif ($failedLeagues -gt 0) { "DEGRADED" } else { "HEALTHY" }
  $providersUsed = @($summaryRows | Select-Object -ExpandProperty provider -Unique)
  $runSummary = [ordered]@{
    health=$health; total_leagues=$summaryRows.Count; successful_leagues=$successfulLeagues;
    empty_leagues=$emptyLeagues; failed_leagues=$failedLeagues; fixtures=$fixtures.Count;
    providers_used=$providersUsed; fallback_leagues=$fallbackLeagues.Count
  }
  $apiErrors = if ($null -ne $apiPayload) { @($apiPayload.errors) } else { @() }
  $espnErrors = if ($null -ne $espnPayload) { @($espnPayload.meta.errors) } else { @() }
  $payload = [pscustomobject]@{
    date=$RunDate; source="football_calendar_provider_chain"; generated_at=(Get-Date).ToUniversalTime().ToString("o");
    dry_run=$true; fetch_summary=$summaryRows; run_summary=$runSummary;
    errors=@(@($apiErrors) + @($espnErrors));
    fixtures=@($fixtures.ToArray()); signals=@($signals.ToArray())
  }
  [System.IO.File]::WriteAllText($mergedOutputPath, ($payload | ConvertTo-Json -Depth 24), [System.Text.UTF8Encoding]::new($false))
  Write-Host "[football-calendar] health=$health fixtures=$($fixtures.Count) success=$successfulLeagues empty=$emptyLeagues failed=$failedLeagues fallback=$($fallbackLeagues.Count)"

  if ($health -eq "FAILED") {
    $dailyLimit = @($summaryRows | Where-Object { $_.primary_error_code -eq "DAILY_LIMIT_REACHED" }).Count -gt 0
    $prefix = if ($dailyLimit) { "NON_RETRYABLE:" } else { "" }
    throw "${prefix}CALENDAR_ALL_PROVIDERS_FAILED date=$RunDate leagues=$($summaryRows.Count)"
  }

  Write-Step "Football calendar dry-run $RunDate"
  $payload | Add-Member -NotePropertyName "dry_run" -NotePropertyValue $true -Force
  $dry = Invoke-HubPost "/api/v1/internal/analytics/football-today-universe" $payload
  Write-Host "[football-calendar] dry_run fixtures=$($dry.fixtures_received) would_insert=$($dry.fixtures_would_insert) signals=$($dry.signals_received) blocked=$($dry.blocked) duplicates=$($dry.duplicates)"
  Assert-Guardrails "football-calendar-dry-run" $dry

  if ($ApplyCalendar) {
    $hardBlocked = 0; if ($null -ne $dry.blocked) { $hardBlocked = [int]$dry.blocked }
    if ($hardBlocked -gt 0) { throw "football calendar dry-run trae blocked=$hardBlocked; no aplico." }
    $payload | Add-Member -NotePropertyName "dry_run" -NotePropertyValue $false -Force
    $apply = Invoke-HubPost "/api/v1/internal/analytics/football-today-universe" $payload
    Write-Host "[football-calendar] APPLY fixtures_inserted=$($apply.fixtures_inserted) signals_inserted=$($apply.signals_inserted) observed=$($apply.observation_only) candidates=$($apply.shadow_candidates)"
    Assert-Guardrails "football-calendar-apply" $apply
  } else {
    Write-Host "[football-calendar] dry-run solamente. Usa -ApplyCalendar para aplicar si sale limpio." -ForegroundColor Yellow
  }
}

function Invoke-FootballContextRefresh([string]$RunDate) {
  $leagueList = @($LeagueIds -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $basePayload = [ordered]@{
    dry_run = $true
    date = $RunDate
    league_ids = $leagueList
    priority_only = $false
    include_lineups = $true
    include_injuries = $true
    include_team_stats = $true
    include_player_stats = $true
    max_api_requests = $MaxApiRequests
  }

  Write-Step "Football context dry-run $RunDate"
  $dry = Invoke-HubPost "/api/v1/internal/analytics/hydrate-football-intelligence" $basePayload
  Write-Host "[football-context] dry_run targets=$($dry.target_count) would_fetch=$($dry.would_fetch) cache_hits=$($dry.cached_hits) skipped=$($dry.skipped) errors=$($dry.errors) quota=$($dry.quota_remaining_estimate) blocked_by_quota=$($dry.blocked_by_quota)"
  Assert-Guardrails "football-context-dry-run" $dry

  if ($ApplyFootballContext) {
    if ([bool]$dry.blocked_by_quota) {
      Write-Host "[football-context] SKIPPED_BY_QUOTA reserve protected; no apply." -ForegroundColor Yellow
      return
    }
    $dryErrors = 0; if ($null -ne $dry.errors) { $dryErrors = [int]$dry.errors }; if ($dryErrors -gt 0) { throw "football context dry-run trae errors=$($dry.errors); no aplico." }
    $basePayload.dry_run = $false
    $apply = Invoke-HubPost "/api/v1/internal/analytics/hydrate-football-intelligence" $basePayload
    Write-Host "[football-context] APPLY targets=$($apply.target_count) fetched=$($apply.fetched) cache_hits=$($apply.cached_hits) skipped=$($apply.skipped) errors=$($apply.errors)"
    Assert-Guardrails "football-context-apply" $apply
    if (-not $SkipConsensus) {
      Invoke-ConsensusForRows "football" $apply.rows
    }
  } else {
    Write-Host "[football-context] dry-run solamente. Usa -ApplyFootballContext para aplicar si sale limpio." -ForegroundColor Yellow
  }
}

function Invoke-ConsensusForRows([string]$Sport, $Rows) {
  $seen = @{}
  foreach ($row in @($Rows)) {
    if ($null -eq $row -or [string]::IsNullOrWhiteSpace([string]$row.match_id)) { continue }
    $key = "$Sport|$($row.league_id)|$($row.match_id)"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $payload = [ordered]@{
      dry_run = $false
      sport = $Sport
      league_id = $row.league_id
      match_id = $row.match_id
      data_types = @("fixture", "kickoff", "lineup", "injuries", "team_stats", "player_stats")
    }
    try {
      $consensus = Invoke-HubPost "/api/v1/internal/analytics/build-consensus" $payload
      $contextScore = Get-Prop $consensus "context_score" $null; $contextStatus = Get-Prop $contextScore "context_status" "UNKNOWN"; $overallScore = Get-Prop $contextScore "overall_context_score" "-"; Write-Host "[consensus] $($row.match) status=$($consensus.status) context=$contextStatus score=$overallScore"
      Assert-Guardrails "consensus" $consensus
    } catch {
      Write-Host "[consensus] $($row.match_id) skipped/error: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
}

function Invoke-MlbContextRefresh {
  Write-Step "MLB context refresh"
  try {
    if (-not [string]::IsNullOrWhiteSpace($SportsDataIoApiKey)) {
      & (Join-Path $ScriptRoot "run_auto_mlb_real_paper.cmd") -Date $Date -ForceEntry -InternalApiKey $InternalApiKey -SportsDataIoApiKey $SportsDataIoApiKey
      if ($LASTEXITCODE -ne 0) { Write-Host "[mlb-entry] warning exit=$LASTEXITCODE" -ForegroundColor Yellow }
    } else {
      Write-Host "[mlb-entry] SPORTSDATAIO_API_KEY no disponible; salto ForceEntry." -ForegroundColor Yellow
    }

    $templatePath = Join-Path $RepoRoot ("workers\mlb_matchup_features_template_{0}.csv" -f ([datetime]::Parse($Date)).ToString("yyyyMMdd"))
    & (Join-Path $ScriptRoot "run_mlb_matchup_features.cmd") -Mode GenerateTemplate -OutputPath $templatePath
    if ($LASTEXITCODE -ne 0) { Write-Host "[mlb-features] warning exit=$LASTEXITCODE" -ForegroundColor Yellow }
  } catch {
    Write-Host "[mlb-context] warning: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

$InternalApiKey = Resolve-Key $InternalApiKey @("INTERNAL_API_KEY", "SPORTS_DATA_HUB_INTERNAL_KEY")
$ApiFootballKey = Resolve-Key $ApiFootballKey @("API_FOOTBALL_KEY", "FOOTBALL_API_KEY")
$SportsDataIoApiKey = Resolve-Key $SportsDataIoApiKey @("SPORTSDATAIO_API_KEY", "SPORTS_DATA_IO_API_KEY")

if ([string]::IsNullOrWhiteSpace($InternalApiKey)) {
  throw "INTERNAL_API_KEY no esta definido. Ponlo en .env o pasalo con -InternalApiKey."
}

Write-Step "Context refresh start"
Write-Host "date=$Date include_tomorrow=$IncludeTomorrow apply_calendar=$ApplyCalendar apply_football_context=$ApplyFootballContext leagues=$LeagueIds"
Test-DashboardReady

$commandCenter = Invoke-HubGet "/api/v1/internal/analytics/command-center"
Assert-Guardrails "command-center-before" $commandCenter

$dates = @($Date)
if ($IncludeTomorrow) { $dates += ([datetime]::Parse($Date).AddDays(1).ToString("yyyy-MM-dd")) }

foreach ($runDate in $dates) {
  if (-not $SkipFootballCalendar) { Invoke-FootballCalendarRefresh $runDate }
  if (-not $SkipFootballContext) { Invoke-FootballContextRefresh $runDate }
}

if (-not $SkipMlbContext) { Invoke-MlbContextRefresh }

Write-Step "Post-refresh validation"
$finalCommand = Invoke-HubGet "/api/v1/internal/analytics/command-center"
Assert-Guardrails "command-center-after" $finalCommand
$footballChain = Invoke-HubGet "/api/v1/internal/analytics/football-confirmed-pick-chain"
Assert-Guardrails "football-chain-after" $footballChain
Write-Host "[summary] bettable_confirmed=$($finalCommand.counts.bettable_paper_confirmed) active_football=$($footballChain.active_football_picks) football_confirmed=$($footballChain.football_confirmed_paper) context_gaps=$($footballChain.context_gaps)"
Write-Host "[summary] dashboard=$HubBaseUrl/dashboard/trading"
