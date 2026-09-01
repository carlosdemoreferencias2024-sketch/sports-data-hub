param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$RepoRoot = "",
  [string]$RuntimeRoot = "C:\Users\tsacl\Documents\SportsDataHubRuntime",
  [string]$InternalApiKey = "",
  [string]$ApiFootballKey = "",
  [string]$SportsDataIoApiKey = "",
  [string]$PythonExe = "C:\Users\tsacl\AppData\Local\Python\pythoncore-3.14-64\python.exe",
  [int]$CalendarIntervalMinutes = 30,
  [int]$ContextIntervalMinutes = 15,
  [int]$NearStartIntervalMinutes = 5,
  [int]$ClosingIntervalMinutes = 2,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = if ($RepoRoot) { [System.IO.Path]::GetFullPath($RepoRoot) } else { Split-Path -Parent $PSScriptRoot }
$sourceScriptRoot = Join-Path $repoRoot "scripts"
if (-not (Test-Path -LiteralPath $RuntimeRoot)) { New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null }
foreach ($entrypoint in @("run_context_refresh.ps1", "run_football_calendar_cycle.ps1", "run_football_scraper_cycle.ps1", "run_football_slate_fair_odds.ps1", "run_football_near_start_cycle.ps1", "run_mlb_near_start_cycle.ps1", "run_mlb_near_start_context.ps1", "run_mlb_matchup_features.ps1", "run_mlb_owned_fair_odds.ps1", "run_nfl_calendar_cycle.ps1", "run_nfl_owned_fair_odds.ps1", "run_nfl_near_start_cycle.ps1", "run_nba_calendar_cycle.ps1", "run_nba_near_start_cycle.ps1", "run_nba_owned_fair_odds.ps1", "run_dual_sport_closing_watch.ps1")) {
  Copy-Item -LiteralPath (Join-Path $sourceScriptRoot $entrypoint) -Destination (Join-Path $RuntimeRoot $entrypoint) -Force
}
Copy-Item -LiteralPath (Join-Path $repoRoot "workers\nfl_scraper.py") -Destination (Join-Path $RuntimeRoot "nfl_scraper.py") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "workers\nba_scraper.py") -Destination (Join-Path $RuntimeRoot "nba_scraper.py") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "workers\espn_soccer_scraper.py") -Destination (Join-Path $RuntimeRoot "espn_soccer_scraper.py") -Force
if (-not (Test-Path -LiteralPath $PythonExe)) { throw "Python executable not found: $PythonExe" }
$envPath = Join-Path $repoRoot ".env"
function Get-DotEnvValue([string[]]$Names) {
  if (-not (Test-Path -LiteralPath $envPath)) { return "" }
  foreach ($name in $Names) {
    $prefix = "$name="
    $matches = @()
    foreach ($line in Get-Content -LiteralPath $envPath) {
      $trimmed = $line.Trim()
      if ($trimmed.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
        $matches += $trimmed.Substring($prefix.Length).Trim('"').Trim("'")
      }
    }
    if ($matches.Count -gt 0) { return [string]$matches[-1] }
  }
  return ""
}
if (-not $InternalApiKey) { $InternalApiKey = Get-DotEnvValue @("INTERNAL_API_KEY", "SPORTS_DATA_HUB_INTERNAL_KEY") }
if (-not $ApiFootballKey) { $ApiFootballKey = Get-DotEnvValue @("API_FOOTBALL_KEY", "FOOTBALL_API_KEY") }
if (-not $SportsDataIoApiKey) { $SportsDataIoApiKey = Get-DotEnvValue @("SPORTSDATAIO_API_KEY", "SPORTS_DATA_IO_API_KEY") }
if (-not $InternalApiKey) { throw "INTERNAL_API_KEY is required to install clock tasks" }
$broadLeagues = "mls,liga-mx,nwsl,brasileirao-serie-a,argentina-primera-division,uefa-champions-league,europa-league,conference-league,leagues-cup,copa-libertadores,copa-sudamericana,premier-league,la-liga,serie-a,bundesliga"

function Register-RepeatingTask(
  [string]$Name,
  [string]$ScriptPath,
  [string[]]$ScriptArgs,
  [int]$StartOffsetMinutes,
  [int]$IntervalMinutes,
  [int]$ExecutionLimitMinutes,
  [string]$Description
) {
  if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "Missing task script: $ScriptPath" }
  $arguments = @("-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $ScriptPath)) + $ScriptArgs
  if ($DryRun) { $arguments += "-DryRun" }
  $powerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  # Let Task Scheduler own the real process. A VBS launcher hides the window but
  # becomes the tracked process, so execution limits can leave PowerShell children orphaned.
  # Start outside OneDrive so PowerShell command discovery and child-process
  # launch cannot stall on a synchronized working directory.
  $action = New-ScheduledTaskAction -Execute $powerShellExe -Argument ($arguments -join " ") -WorkingDirectory $RuntimeRoot
  $secondOffset = switch ($Name) {
    "SportsDataHubFootballCalendar" { 5 }
    "SportsDataHubFootballNearStart" { 10 }
    "SportsDataHubMlbNearStart" { 25 }
    "SportsDataHubFootballContext" { 40 }
    "SportsDataHubClosingWatch" { 50 }
    "SportsDataHubNflCalendar" { 15 }
    "SportsDataHubNflNearStart" { 35 }
    "SportsDataHubNbaCalendar" { 30 }
    "SportsDataHubNbaNearStart" { 55 }
    default { 0 }
  }
  $startAt = (Get-Date).AddMinutes($StartOffsetMinutes).AddSeconds($secondOffset)
  $trigger = New-ScheduledTaskTrigger -Once -At $startAt -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
  # Missed pre-game windows are not replayable. Starting overdue tasks after wake
  # creates a launch stampede and can produce post-kickoff evidence.
  # These workers are interval-driven, not idle jobs. The scheduler default
  # StopOnIdleEnd=true sends Ctrl+C (0xC000013A) as soon as user activity resumes.
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes $ExecutionLimitMinutes)
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Description $Description -Force | Out-Null
}

$contextScript = Join-Path $RuntimeRoot "run_context_refresh.ps1"
$footballCalendarScript = Join-Path $RuntimeRoot "run_football_calendar_cycle.ps1"
$footballNearStartScript = Join-Path $RuntimeRoot "run_football_near_start_cycle.ps1"
$mlbNearStartScript = Join-Path $RuntimeRoot "run_mlb_near_start_cycle.ps1"
$nflCalendarScript = Join-Path $RuntimeRoot "run_nfl_calendar_cycle.ps1"
$nflNearStartScript = Join-Path $RuntimeRoot "run_nfl_near_start_cycle.ps1"
$nbaCalendarScript = Join-Path $RuntimeRoot "run_nba_calendar_cycle.ps1"
$nbaNearStartScript = Join-Path $RuntimeRoot "run_nba_near_start_cycle.ps1"
$closingScript = Join-Path $RuntimeRoot "run_dual_sport_closing_watch.ps1"

# Offsets prevent network-heavy stages from starting together.
Register-RepeatingTask "SportsDataHubFootballCalendar" $footballCalendarScript @(
  "-HubBaseUrl", ('"{0}"' -f $HubBaseUrl),
  "-RepoRoot", ('"{0}"' -f $repoRoot),
  "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
  "-PythonExe", ('"{0}"' -f $PythonExe),
  "-LeagueIds", ('"{0}"' -f $broadLeagues)
) 1 $CalendarIntervalMinutes 12 "Football calendar, scraper evidence staging and owned fair odds; PAPER draft only."

Register-RepeatingTask "SportsDataHubFootballNearStart" $footballNearStartScript @(
  "-HubBaseUrl", ('"{0}"' -f $HubBaseUrl),
  "-RepoRoot", ('"{0}"' -f $repoRoot)
) 2 $NearStartIntervalMinutes 5 "Football near-start orchestrator; independent from MLB."

Register-RepeatingTask "SportsDataHubMlbNearStart" $mlbNearStartScript @(
  "-RepoRoot", ('"{0}"' -f $repoRoot),
  "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
  "-HubBaseUrl", ('"{0}"' -f $HubBaseUrl)
) 3 $NearStartIntervalMinutes 4 "MLB fair odds plus near-start context; independent from football."

Register-RepeatingTask "SportsDataHubFootballContext" $contextScript @(
  "-HubBaseUrl", ('"{0}"' -f $HubBaseUrl),
  "-RepoRoot", ('"{0}"' -f $repoRoot),
  "-LeagueIds", ('"{0}"' -f $broadLeagues),
  "-ApplyFootballContext", "-SkipFootballCalendar", "-SkipMlbContext"
) 4 $ContextIntervalMinutes 10 "Football context hydration after calendar refresh; no picks."

Register-RepeatingTask "SportsDataHubClosingWatch" $closingScript @(
  "-HubBaseUrl", ('"{0}"' -f $HubBaseUrl),
  "-RepoRoot", ('"{0}"' -f $repoRoot)
) 5 $ClosingIntervalMinutes 10 "Shared closing window watch; MLB capture plus football and NFL capture alerts."

Register-RepeatingTask "SportsDataHubNflCalendar" $nflCalendarScript @(
  "-HubBaseUrl", ('"{0}"' -f $HubBaseUrl),
  "-RepoRoot", ('"{0}"' -f $repoRoot),
  "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
  "-PythonExe", ('"{0}"' -f $PythonExe),
  "-IncludeTomorrow", "-GenerateFairOdds"
) 6 $CalendarIntervalMinutes 5 "NFL calendar and provider evidence for today and tomorrow; observation only."

Register-RepeatingTask "SportsDataHubNflNearStart" $nflNearStartScript @(
  "-HubBaseUrl", ('"{0}"' -f $HubBaseUrl),
  "-RepoRoot", ('"{0}"' -f $repoRoot),
  "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
  "-PythonExe", ('"{0}"' -f $PythonExe)
) 10 $NearStartIntervalMinutes 4 "NFL near-start context; fail closed without official inactives and starting quarterbacks."

Register-RepeatingTask "SportsDataHubNbaCalendar" $nbaCalendarScript @(
  "-HubBaseUrl", ('"{0}"' -f $HubBaseUrl),
  "-RepoRoot", ('"{0}"' -f $repoRoot),
  "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
  "-PythonExe", ('"{0}"' -f $PythonExe),
  "-IncludeTomorrow", "-GenerateFairOdds", "-Quiet"
) 8 $CalendarIntervalMinutes 6 "NBA calendar plus owned fair odds for today and tomorrow; observation only."

Register-RepeatingTask "SportsDataHubNbaNearStart" $nbaNearStartScript @(
  "-HubBaseUrl", ('"{0}"' -f $HubBaseUrl),
  "-RepoRoot", ('"{0}"' -f $repoRoot),
  "-RuntimeRoot", ('"{0}"' -f $RuntimeRoot),
  "-PythonExe", ('"{0}"' -f $PythonExe),
  "-Quiet"
) 11 $NearStartIntervalMinutes 5 "NBA near-start injuries, official starters and schedule-derived workload; fail closed."

foreach ($obsolete in @("SportsDataHubContextRefresh", "SportsDataHubSafeOpsCycle", "SportsDataHubMlbClosingWindow", "SportsDataHubNearStart", "SportsDataHubNbaFairOdds")) {
  if (Get-ScheduledTask -TaskName $obsolete -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $obsolete -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $obsolete | Out-Null
  }
}

[pscustomobject]@{
  installed = @(
    @{ task="SportsDataHubFootballCalendar"; interval_minutes=$CalendarIntervalMinutes; offset_minutes=1 },
    @{ task="SportsDataHubFootballNearStart"; interval_minutes=$NearStartIntervalMinutes; offset_minutes=2 },
    @{ task="SportsDataHubMlbNearStart"; interval_minutes=$NearStartIntervalMinutes; offset_minutes=3 },
    @{ task="SportsDataHubFootballContext"; interval_minutes=$ContextIntervalMinutes; offset_minutes=4 },
    @{ task="SportsDataHubClosingWatch"; interval_minutes=$ClosingIntervalMinutes; offset_minutes=5 },
    @{ task="SportsDataHubNflCalendar"; interval_minutes=$CalendarIntervalMinutes; offset_minutes=6 },
    @{ task="SportsDataHubNflNearStart"; interval_minutes=$NearStartIntervalMinutes; offset_minutes=10 },
    @{ task="SportsDataHubNbaCalendar"; interval_minutes=$CalendarIntervalMinutes; offset_minutes=8 },
    @{ task="SportsDataHubNbaNearStart"; interval_minutes=$NearStartIntervalMinutes; offset_minutes=11 }
  )
  disabled_duplicates = @("SportsDataHubContextRefresh", "SportsDataHubSafeOpsCycle", "SportsDataHubMlbClosingWindow", "SportsDataHubNearStart", "SportsDataHubNbaFairOdds")
  broad_leagues = $broadLeagues -split ","
  runtime_root = $RuntimeRoot
  hidden_launcher = "powershell.exe -WindowStyle Hidden"
  guardrails = @{ real_money=$false; kelly=$false; telegram_auto=$false; autopost=$false }
} | ConvertTo-Json -Depth 8
