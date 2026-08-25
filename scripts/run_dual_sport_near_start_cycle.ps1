param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Get-DotEnvValue([string]$Name) {
  $envPath = Join-Path $repoRoot ".env"
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
  $InternalApiKey = Get-DotEnvValue "INTERNAL_API_KEY"
}
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) {
  $InternalApiKey = Get-DotEnvValue "SPORTS_DATA_HUB_INTERNAL_KEY"
}
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { throw "INTERNAL_API_KEY is required" }

$headers = @{
  "X-Internal-API-Key" = $InternalApiKey
  "X-API-Key" = $InternalApiKey
}

function Invoke-HubGet([string]$Path) {
  Invoke-RestMethod -Method Get -Uri "$HubBaseUrl$Path" -Headers $headers -TimeoutSec 30
}

function Invoke-HubPost([string]$Path, [object]$Body) {
  $json = $Body | ConvertTo-Json -Depth 20
  Invoke-RestMethod -Method Post -Uri "$HubBaseUrl$Path" -Headers $headers -ContentType "application/json" -Body $json -TimeoutSec 60
}

function Get-Prop($Object, [string]$Name, $Default = $null) {
  if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $Default
}

function Assert-Guardrails($CommandCenter) {
  $realCandidate = if ($null -ne $CommandCenter.real_candidate_count) { [int]$CommandCenter.real_candidate_count } else { 0 }
  $realMoney = if ($null -ne $CommandCenter.real_money_enabled) { [bool]$CommandCenter.real_money_enabled } else { $false }
  $kelly = if ($null -ne $CommandCenter.kelly_enabled) { [bool]$CommandCenter.kelly_enabled } else { $false }
  $telegram = if ($null -ne $CommandCenter.telegram_auto_enabled) { [bool]$CommandCenter.telegram_auto_enabled } else { $false }
  if ($realCandidate -ne 0 -or $realMoney -or $kelly -or $telegram) {
    throw "GUARDRAIL_BROKEN real_candidate=$realCandidate real_money=$realMoney kelly=$kelly telegram=$telegram"
  }
}

$before = Invoke-HubGet "/api/v1/internal/analytics/command-center"
Assert-Guardrails $before

$football = Invoke-HubPost "/api/v1/internal/analytics/football/near-start-context/run" @{
  date = $Date
  apply = (-not $DryRun)
  fallback_recent = $false
}

$mlbScript = Join-Path $PSScriptRoot "run_mlb_near_start_context.ps1"
$mlbScriptArgs = @{}
if (-not $DryRun) { $mlbScriptArgs.Apply = $true }
$mlbCompleted = $true
$mlbExitCode = 0
try {
  $mlbOutput = & $mlbScript @mlbScriptArgs 2>&1 | Out-String
} catch {
  $mlbCompleted = $false
  $mlbExitCode = 1
  $mlbOutput = $_ | Out-String
}

$dateQuery = [uri]::EscapeDataString($Date)
$queue = Invoke-HubGet "/api/v1/internal/analytics/operational-window-queue?date=$dateQuery&sport=all&limit=240"
$closing = Invoke-HubGet "/api/v1/internal/analytics/closing-window-watch?date=$dateQuery&sport=all&limit=240"
$after = Invoke-HubGet "/api/v1/internal/analytics/command-center"
Assert-Guardrails $after

$footballRows = @($football.rows)
$queueRows = @($queue.rows)
$closingRows = @($closing.rows)
$actions = @($queueRows | Where-Object { (Get-Prop $_ "action" "") -and (Get-Prop $_ "action" "") -ne "WAIT" } | Select-Object match_id,sport,match,kickoff,minutes_to_start,window_state,action)
$closingNow = @($closingRows | Where-Object { (Get-Prop $_ "action" "") -eq "CAPTURE_CLOSING_NOW" } | Select-Object match_id,sport,match,kickoff,minutes_to_start,action)

[pscustomobject]@{
  system_status = "DUAL_SPORT_NEAR_START_CLOCK"
  date = $Date
  dry_run = [bool]$DryRun
  football = @{
    rows = $footballRows.Count
    actions = @($footballRows | Where-Object { (Get-Prop $_ "action" "") -and (Get-Prop $_ "action" "") -ne "WAIT" } | Select-Object match_id,match,kickoff,status,action,context_score,market_score,final_score)
  }
  mlb = @{
    completed = $mlbCompleted
    exit_code = $mlbExitCode
    output = $mlbOutput.Trim()
  }
  operational_actions = $actions
  closing_now = $closingNow
  guardrails = @{
    real_candidate_count = 0
    real_money_enabled = $false
    kelly_enabled = $false
    telegram_auto_enabled = $false
    autopost_enabled = $false
    kill_switch_enabled = $true
  }
} | ConvertTo-Json -Depth 12
