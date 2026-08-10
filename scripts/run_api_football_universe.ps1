param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$ApiFootballKey = $(if ($env:API_FOOTBALL_KEY) { $env:API_FOOTBALL_KEY } else { $env:FOOTBALL_API_KEY }),
  [string]$LeagueIds = "mls,liga-mx,brasileirao-serie-a",
  [string]$OutputPath = "",
  [switch]$Apply,
  [switch]$IncludeFinished,
  [switch]$AllowApiOnlyTrustedKickoff
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-LocalDotEnvValue([string]$Name) {
  $envPath = Join-Path (Split-Path -Parent $PSScriptRoot) ".env"
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

if (-not $InternalApiKey) {
  $InternalApiKey = Get-LocalDotEnvValue "INTERNAL_API_KEY"
  if (-not $InternalApiKey) { $InternalApiKey = Get-LocalDotEnvValue "SPORTS_DATA_HUB_INTERNAL_KEY" }
}
if (-not $ApiFootballKey) {
  $ApiFootballKey = Get-LocalDotEnvValue "API_FOOTBALL_KEY"
  if (-not $ApiFootballKey) { $ApiFootballKey = Get-LocalDotEnvValue "FOOTBALL_API_KEY" }
}

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}
if (-not $ApiFootballKey) {
  throw "API_FOOTBALL_KEY no esta definido. Exportalo o pasalo con -ApiFootballKey."
}

$leagueList = @($LeagueIds -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($leagueList.Count -eq 0) {
  throw "LeagueIds no puede estar vacio. Ejemplo: -LeagueIds 'mls,liga-mx,brasileirao-serie-a'"
}

if (-not $OutputPath) {
  $dateStamp = ([datetime]::Parse($Date)).ToString("yyyyMMdd")
  $OutputPath = Join-Path $PSScriptRoot ("football_today_api_football_{0}.json" -f $dateStamp)
}

$buildParams = @{
  ApiKey = $ApiFootballKey
  Date = $Date
  LeagueIds = $leagueList
  UseGlobalDateEndpoint = $true
  OutputPath = $OutputPath
}
if ($IncludeFinished) { $buildParams.IncludeFinished = $true }
if ($AllowApiOnlyTrustedKickoff) { $buildParams.AllowApiOnlyTrustedKickoff = $true }

Write-Host "[api-football-runner] date=$Date leagues=$($leagueList -join ',') apply=$Apply intent=OBSERVATION_ONLY"
& (Join-Path $PSScriptRoot "build_api_football_universe.ps1") @buildParams

$feedParams = @{
  HubBaseUrl = $HubBaseUrl
  InternalApiKey = $InternalApiKey
  InputPath = $OutputPath
}
if ($Apply) { $feedParams.Apply = $true }

& (Join-Path $PSScriptRoot "run_football_today_universe.ps1") @feedParams