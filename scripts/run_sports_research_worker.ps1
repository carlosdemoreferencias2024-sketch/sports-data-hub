param(
  [switch]$Once,
  [switch]$Apply,
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$PayloadDirs = "/research-payloads,/scripts",
  [string]$FileGlobs = "sports_research_*.json,football_hydrate*.json,historical_intelligence*.json",
  [int]$MaxFiles = 25
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
$env:SPORTS_RESEARCH_DRY_RUN = $(if ($Apply) { "false" } else { "true" })
$env:SPORTS_RESEARCH_PAYLOAD_DIRS = $PayloadDirs
$env:SPORTS_RESEARCH_FILE_GLOBS = $FileGlobs
$env:SPORTS_RESEARCH_MAX_FILES = [string]$MaxFiles

if ($Once) {
  Write-Host "[sports-research] run once dry_run=$($env:SPORTS_RESEARCH_DRY_RUN) max_files=$MaxFiles"
  docker compose --profile research run --rm sports-research-worker python sports_research_worker.py --once
  exit $LASTEXITCODE
}

Write-Host "[sports-research] start service dry_run=$($env:SPORTS_RESEARCH_DRY_RUN) max_files=$MaxFiles"
docker compose --profile research up -d sports-research-worker
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
docker compose --profile research ps sports-research-worker
