param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { (Resolve-Path -LiteralPath $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }

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
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { throw "INTERNAL_API_KEY is required" }

$headers = @{ "x-internal-api-key" = $InternalApiKey }
$queueUrl = "$HubBaseUrl/api/v1/internal/analytics/clean-sample-queue?date=$([uri]::EscapeDataString($Date))&sport=american_football&limit=50"
$queue = Invoke-RestMethod -Method Get -Uri $queueUrl -Headers $headers -TimeoutSec 30
$focus = @($queue.focus_rows) | Select-Object -First 1
if (-not $focus) {
  [pscustomobject]@{ system_status = "NFL_FAIR_ODDS_NO_FOCUS"; date = $Date; applied = $false } | ConvertTo-Json -Depth 5
  exit 0
}
if ([string]$focus.action -ne "GENERATE_NFL_FAIR_ODDS") {
  [pscustomobject]@{
    system_status = "NFL_FAIR_ODDS_NOT_DUE"
    date = $Date
    match_id = [string]$focus.match_id
    match = [string]$focus.match
    current_action = [string]$focus.action
    applied = $false
  } | ConvertTo-Json -Depth 5
  exit 0
}

$body = @{
  date = $Date
  match_id = [string]$focus.match_id
  apply = -not [bool]$DryRun
  limit = 1
} | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri "$HubBaseUrl/api/v1/internal/analytics/nfl-owned-fair-odds/run" -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 45
$result | ConvertTo-Json -Depth 12
exit 0
