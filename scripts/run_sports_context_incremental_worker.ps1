param(
  [switch]$Once,
  [switch]$Apply,
  [switch]$NearKickoff,
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [int]$LookaheadHours = 6,
  [int]$LookbackMinutes = 30,
  [int]$MaxMatches = 20,
  [int]$MaxApiRequests = 10,
  [switch]$IncludeObservationOnly,
  [switch]$RebuildOnlyWhenChanged,
  [switch]$AllowPostKickoffRefresh,
  [string]$TargetStatuses = "PARTIAL_CONTEXT_REVIEW,CONTEXT_GAPS,FOOTBALL_CONTEXT_GAPS,BLOCK_CONFIRMATION"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

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

if ([string]::IsNullOrWhiteSpace($InternalApiKey)) {
  $InternalApiKey = Get-LocalDotEnvValue "INTERNAL_API_KEY"
}
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) {
  $InternalApiKey = Get-LocalDotEnvValue "SPORTS_DATA_HUB_INTERNAL_KEY"
}
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) {
  throw "INTERNAL_API_KEY no esta definido. Ponlo en .env o pasalo con -InternalApiKey."
}

$env:INTERNAL_API_KEY = $InternalApiKey
$env:SPORTS_CONTEXT_INCREMENTAL_DRY_RUN = $(if ($Apply) { "false" } else { "true" })
$env:SPORTS_CONTEXT_INCREMENTAL_NEAR_KICKOFF = $(if ($NearKickoff -or -not $PSBoundParameters.ContainsKey("NearKickoff")) { "true" } else { "false" })
$env:SPORTS_CONTEXT_INCREMENTAL_LOOKAHEAD_HOURS = [string]$LookaheadHours
$env:SPORTS_CONTEXT_INCREMENTAL_LOOKBACK_MINUTES = [string]$LookbackMinutes
$env:SPORTS_CONTEXT_INCREMENTAL_MAX_MATCHES = [string]$MaxMatches
$env:SPORTS_CONTEXT_INCREMENTAL_MAX_API_REQUESTS = [string]$MaxApiRequests
$env:SPORTS_CONTEXT_INCREMENTAL_INCLUDE_OBSERVATION_ONLY = $(if ($IncludeObservationOnly) { "true" } else { "false" })
$env:SPORTS_CONTEXT_INCREMENTAL_ONLY_REBUILD_WHEN_CHANGED = $(if ($RebuildOnlyWhenChanged) { "true" } else { "false" })
$env:SPORTS_CONTEXT_INCREMENTAL_SKIP_IF_KICKOFF_PASSED = $(if ($AllowPostKickoffRefresh) { "false" } else { "true" })
$env:SPORTS_CONTEXT_INCREMENTAL_TARGET_STATUSES = $TargetStatuses

if ($Once) {
  Write-Host "[sports-context-incremental] run once dry_run=$($env:SPORTS_CONTEXT_INCREMENTAL_DRY_RUN) near_kickoff=$($env:SPORTS_CONTEXT_INCREMENTAL_NEAR_KICKOFF) lookahead_hours=$LookaheadHours max_matches=$MaxMatches"
  docker compose --profile research run --rm sports-context-incremental-worker python sports_context_incremental_worker.py --once
  exit $LASTEXITCODE
}

Write-Host "[sports-context-incremental] start service dry_run=$($env:SPORTS_CONTEXT_INCREMENTAL_DRY_RUN) near_kickoff=$($env:SPORTS_CONTEXT_INCREMENTAL_NEAR_KICKOFF) lookahead_hours=$LookaheadHours max_matches=$MaxMatches"
docker compose --profile research up -d sports-context-incremental-worker
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker compose --profile research ps sports-context-incremental-worker
