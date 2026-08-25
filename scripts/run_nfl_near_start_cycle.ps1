param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$RuntimeRoot = $PSScriptRoot,
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$PythonExe = "C:\Users\tsacl\AppData\Local\Python\pythoncore-3.14-64\python.exe",
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { (Resolve-Path -LiteralPath $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$calendarScript = Join-Path $RuntimeRoot "run_nfl_calendar_cycle.ps1"
if (-not (Test-Path -LiteralPath $calendarScript)) { $calendarScript = Join-Path $repoRoot "scripts\run_nfl_calendar_cycle.ps1" }

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

$arguments = @{
  Date = $Date
  RepoRoot = $repoRoot
  RuntimeRoot = $RuntimeRoot
  HubBaseUrl = $HubBaseUrl
  InternalApiKey = $InternalApiKey
  PythonExe = $PythonExe
  IncludeTomorrow = $true
  NearStart = $true
}
if ($DryRun) { $arguments.DryRun = $true }

$captureOutput = & $calendarScript @arguments 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "NFL_NEAR_START_CAPTURE_FAILED exit=$LASTEXITCODE detail=$captureOutput" }
if ($DryRun) { Write-Output $captureOutput.Trim(); exit 0 }

$headers = @{ "X-Internal-API-Key"=$InternalApiKey; "X-API-Key"=$InternalApiKey }
$dateQuery = [uri]::EscapeDataString($Date)
$queue = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/v1/internal/analytics/operational-window-queue?date=$dateQuery&sport=american_football&limit=120" -Headers $headers -TimeoutSec 60
$focus = @($queue.rows | Where-Object { $_.minutes_until_start -le 90 -and $_.minutes_until_start -ge 20 } | Select-Object -First 1)
[pscustomobject]@{
  system_status = "NFL_NEAR_START_CLOCK"
  date = $Date
  scanned = @($queue.rows).Count
  focus = @($focus | Select-Object match_id,match,kickoff,minutes_until_start,window,action,missing,preflight_status)
  provider_capture = ($captureOutput.Trim() | ConvertFrom-Json)
  context_policy = @{ required=@("official_inactives","starting_quarterbacks","injury_context","weather_context","venue"); fail_closed=$true }
  guardrails = @{ real_candidate_count=0; real_money_enabled=$false; kelly_enabled=$false; telegram_auto_enabled=$false; autopost_enabled=$false }
} | ConvertTo-Json -Depth 12
exit 0
