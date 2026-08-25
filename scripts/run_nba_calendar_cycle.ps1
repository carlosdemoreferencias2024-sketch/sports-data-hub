param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$RuntimeRoot = $PSScriptRoot,
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$PythonExe = "C:\Users\tsacl\AppData\Local\Python\pythoncore-3.14-64\python.exe",
  [switch]$IncludeTomorrow,
  [switch]$NearStart,
  [switch]$GenerateFairOdds,
  [switch]$Quiet,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { [System.IO.Path]::GetFullPath($RepoRoot) } else { Split-Path -Parent $PSScriptRoot }
$worker = Join-Path $RuntimeRoot "nba_scraper.py"
if (-not (Test-Path -LiteralPath $worker)) { $worker = Join-Path $repoRoot "workers\nba_scraper.py" }
if (-not (Test-Path -LiteralPath $worker)) { throw "NBA worker not found: $worker" }
if (-not (Test-Path -LiteralPath $PythonExe)) { throw "Python executable not found: $PythonExe" }

function Get-DotEnvValue([string]$Name) {
  $envPath = Join-Path $repoRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { return "" }
  $prefix = "$Name="
  $matches = @(Get-Content -LiteralPath $envPath | ForEach-Object {
    $trimmed = $_.Trim()
    if ($trimmed.StartsWith($prefix, [System.StringComparison]::Ordinal)) { $trimmed.Substring($prefix.Length).Trim('"').Trim("'") }
  })
  return $(if ($matches.Count) { [string]$matches[-1] } else { "" })
}

if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { $InternalApiKey = Get-DotEnvValue "INTERNAL_API_KEY" }
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { $InternalApiKey = Get-DotEnvValue "SPORTS_DATA_HUB_INTERNAL_KEY" }
if ([string]::IsNullOrWhiteSpace($InternalApiKey) -and -not $DryRun) { throw "INTERNAL_API_KEY is required" }

$evidenceDir = Join-Path $repoRoot "backend\uploads\provider-captures\nba"
$arguments = @(
  $worker,
  "--date", $Date,
  "--api-url", "$HubBaseUrl/api/v1/internal/matches/batch",
  "--api-key", $InternalApiKey,
  "--evidence-dir", $evidenceDir
)
if ($IncludeTomorrow) { $arguments += "--include-tomorrow" }
if ($NearStart) { $arguments += "--near-start" }
if ($DryRun) { $arguments += "--dry-run" }

$output = & $PythonExe @arguments 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "NBA_PROVIDER_CAPTURE_FAILED exit=$LASTEXITCODE detail=$output" }
if (-not $Quiet) { Write-Output $output.Trim() }

if ($GenerateFairOdds -and -not $DryRun) {
  $fairOddsScript = Join-Path $RuntimeRoot "run_nba_owned_fair_odds.ps1"
  if (-not (Test-Path -LiteralPath $fairOddsScript)) { $fairOddsScript = Join-Path $repoRoot "scripts\run_nba_owned_fair_odds.ps1" }
  if (-not (Test-Path -LiteralPath $fairOddsScript)) { throw "NBA fair-odds entrypoint not found: $fairOddsScript" }
  $fairOddsOutput = & $fairOddsScript `
    -Date $Date `
    -RepoRoot $repoRoot `
    -HubBaseUrl $HubBaseUrl `
    -InternalApiKey $InternalApiKey `
    -Quiet:$Quiet 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "NBA_FAIR_ODDS_CYCLE_FAILED exit=$LASTEXITCODE detail=$fairOddsOutput" }
  if (-not $Quiet -and $fairOddsOutput.Trim()) { Write-Output $fairOddsOutput.Trim() }
}
exit 0
