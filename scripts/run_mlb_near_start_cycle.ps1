param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$RuntimeRoot = "C:\Users\tsacl\Documents\SportsDataHubRuntime",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { (Resolve-Path -LiteralPath $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$mlbScript = Join-Path (Join-Path $repoRoot "scripts") "run_mlb_near_start_context.ps1"
$fairOddsScript = Join-Path $RuntimeRoot "run_mlb_owned_fair_odds.ps1"
if (-not (Test-Path -LiteralPath $fairOddsScript)) { $fairOddsScript = Join-Path (Join-Path $repoRoot "scripts") "run_mlb_owned_fair_odds.ps1" }
$failures = [Collections.Generic.List[string]]::new()
$fairOddsOutput = ""
$contextOutput = ""

$fairOddsArguments = @{
  Date = $Date
  RepoRoot = $repoRoot
  HubBaseUrl = $HubBaseUrl
  InternalApiKey = $InternalApiKey
}
if ($DryRun) { $fairOddsArguments.DryRun = $true }
try {
  $fairOddsOutput = & $fairOddsScript @fairOddsArguments 2>&1 | Out-String
} catch {
  $failures.Add("fair_odds:$($_.Exception.Message)")
}

$arguments = @{}
if (-not $DryRun) { $arguments.Apply = $true }
$arguments.RepoRoot = $repoRoot

try {
  $contextOutput = & $mlbScript @arguments 2>&1 | Out-String
} catch {
  $failures.Add("near_start_context:$($_.Exception.Message)")
}

$result = [pscustomobject]@{
  system_status = if ($failures.Count) { "MLB_NEAR_START_CLOCK_PARTIAL_FAILURE" } else { "MLB_NEAR_START_CLOCK" }
  date = $Date
  dry_run = [bool]$DryRun
  completed = $failures.Count -eq 0
  fair_odds_output = $fairOddsOutput.Trim()
  context_output = $contextOutput.Trim()
  failures = @($failures)
  guardrails = @{ real_candidate_count=0; real_money_enabled=$false; kelly_enabled=$false; telegram_auto_enabled=$false }
}
$result | ConvertTo-Json -Depth 8
if ($failures.Count) { throw "MLB near-start cycle failed in $($failures.Count) independent stage(s)" }
