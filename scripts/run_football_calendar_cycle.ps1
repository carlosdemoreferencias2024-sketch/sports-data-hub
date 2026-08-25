param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$RuntimeRoot = "C:\Users\tsacl\Documents\SportsDataHubRuntime",
  [string]$PythonExe = "C:\Users\tsacl\AppData\Local\Python\pythoncore-3.14-64\python.exe",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$LeagueIds = "mls,liga-mx,nwsl,brasileirao-serie-a,argentina-primera-division,uefa-champions-league,europa-league,conference-league,leagues-cup,copa-libertadores,copa-sudamericana,premier-league,la-liga,serie-a,bundesliga",
  [int]$MaxAttempts = 3,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { [System.IO.Path]::GetFullPath($RepoRoot) } else { Split-Path -Parent $PSScriptRoot }
$contextScript = Join-Path $RuntimeRoot "run_context_refresh.ps1"
if (-not (Test-Path -LiteralPath $contextScript)) { $contextScript = Join-Path $repoRoot "scripts\run_context_refresh.ps1" }
$scraperScript = Join-Path $RuntimeRoot "run_football_scraper_cycle.ps1"
if (-not (Test-Path -LiteralPath $scraperScript)) { $scraperScript = Join-Path $repoRoot "scripts\run_football_scraper_cycle.ps1" }
$powershellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$logDir = Join-Path $RuntimeRoot "logs"
$logPath = Join-Path $logDir "football_calendar_latest.log"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Invoke-IsolatedStep {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string[]]$Arguments
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
    $startedAt = (Get-Date).ToString("o")
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & $powershellExe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    @(
      "[$startedAt] step=$Name attempt=$attempt/$MaxAttempts exit=$exitCode",
      $output.Trim(),
      ""
    ) | Add-Content -LiteralPath $logPath
    if ($exitCode -eq 0) {
      return
    }
    if ($attempt -lt $MaxAttempts) { Start-Sleep -Seconds (10 * $attempt) }
  }

  throw "$Name failed after $MaxAttempts attempts. See $logPath"
}

try {
  $calendarArgs = @(
    "-Date", $Date,
    "-HubBaseUrl", $HubBaseUrl,
    "-RepoRoot", $repoRoot,
    "-LeagueIds", $LeagueIds,
    "-IncludeTomorrow",
    "-SkipFootballContext",
    "-SkipMlbContext"
  )
  if (-not $DryRun) { $calendarArgs += "-ApplyCalendar" }
  Invoke-IsolatedStep -Name "football_calendar_refresh" -ScriptPath $contextScript -Arguments $calendarArgs

  $scraperArgs = @(
    "-Date", $Date,
    "-HubBaseUrl", $HubBaseUrl,
    "-RepoRoot", $repoRoot,
    "-RuntimeRoot", $RuntimeRoot,
    "-PythonExe", $PythonExe,
    "-CaptureMarket"
  )
  if ($DryRun) { $scraperArgs += "-DryRun" }
  Invoke-IsolatedStep -Name "football_scraper_pick_cycle" -ScriptPath $scraperScript -Arguments $scraperArgs
  exit 0
} catch {
  $failure = "[$((Get-Date).ToString('o'))] wrapper_failure=$($_.Exception.Message) position=$($_.InvocationInfo.PositionMessage)"
  $failure | Add-Content -LiteralPath $logPath
  exit 1
}
