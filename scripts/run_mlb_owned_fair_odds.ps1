param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$ModelName = "carlos_v1_mlb",
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { [System.IO.Path]::GetFullPath($RepoRoot) } else { Split-Path -Parent $PSScriptRoot }

function Get-DotEnvValue([string[]]$Names) {
  $envPath = Join-Path $repoRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { return "" }
  foreach ($name in $Names) {
    $prefix = "$name="
    $matches = @(Get-Content -LiteralPath $envPath | ForEach-Object {
      $trimmed = $_.Trim()
      if ($trimmed.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
        $trimmed.Substring($prefix.Length).Trim('"').Trim("'")
      }
    })
    if ($matches.Count) { return [string]$matches[-1] }
  }
  return ""
}

if (-not $InternalApiKey) { $InternalApiKey = Get-DotEnvValue @("INTERNAL_API_KEY", "SPORTS_DATA_HUB_INTERNAL_KEY") }
if (-not $InternalApiKey) { throw "INTERNAL_API_KEY is required" }
if ($Date -ne (Get-Date -Format "yyyy-MM-dd")) {
  [pscustomobject]@{ system_status="MLB_FAIR_ODDS_NOT_CURRENT_DATE"; date=$Date; applied=$false } | ConvertTo-Json -Depth 5
  exit 0
}

$headers = @{ "X-Internal-API-Key" = $InternalApiKey; "X-API-Key" = $InternalApiKey }
function Get-MlbQueue {
  Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/v1/internal/analytics/clean-sample-queue?date=$([uri]::EscapeDataString($Date))&sport=baseball&limit=200" -Headers $headers -TimeoutSec 30
}

$before = Get-MlbQueue
$missingBefore = [int]$before.summary.fair_odds_missing
if ($missingBefore -le 0) {
  [pscustomobject]@{
    system_status = "MLB_FAIR_ODDS_ALREADY_COMPLETE"
    date = $Date
    missing_before = 0
    applied = $false
    guardrails = @{ real_candidate_count=0; real_money_enabled=$false; kelly_enabled=$false; telegram_auto_enabled=$false }
  } | ConvertTo-Json -Depth 6
  exit 0
}

$dockerArgs = @(
  "compose", "--profile", "odds", "exec", "-T", "odds-worker",
  "python", "model_pipeline.py",
  "--sport", "mlb",
  "--model-name", $ModelName,
  "--league-slug", "mlb",
  "--skip-optimizer",
  "--skip-alpha",
  "--compact-logs"
)
if ($DryRun) { $dockerArgs += "--dry-run" }

Push-Location $repoRoot
try {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $pipelineOutput = @(& docker @dockerArgs 2>&1 | ForEach-Object { [string]$_ })
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
} finally {
  Pop-Location
}
if ($exitCode -ne 0) { throw "MLB fair-odds pipeline failed exit=$exitCode detail=$($pipelineOutput -join ' ')" }

$after = if ($DryRun) { $before } else { Get-MlbQueue }
[pscustomobject]@{
  system_status = "MLB_FAIR_ODDS_OK"
  date = $Date
  dry_run = [bool]$DryRun
  model_name = $ModelName
  missing_before = $missingBefore
  missing_after = [int]$after.summary.fair_odds_missing
  pipeline_output = @($pipelineOutput)
  guardrails = @{ real_candidate_count=0; real_money_enabled=$false; kelly_enabled=$false; telegram_auto_enabled=$false; autopost_enabled=$false }
} | ConvertTo-Json -Depth 8
