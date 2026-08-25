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
Set-Location $repoRoot

function Get-DotEnvValue([string]$Name) {
  $envPath = Join-Path $repoRoot ".env"
  if (-not (Test-Path -LiteralPath $envPath)) { return "" }
  $prefix = "$Name="
  foreach ($line in Get-Content -LiteralPath $envPath) {
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
      return $trimmed.Substring($prefix.Length).Trim('"').Trim("'")
    }
  }
  return ""
}

function Get-Prop($Object, [string]$Name, $Default = $null) {
  if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $Default
}

if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { $InternalApiKey = Get-DotEnvValue "INTERNAL_API_KEY" }
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { $InternalApiKey = Get-DotEnvValue "SPORTS_DATA_HUB_INTERNAL_KEY" }
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) { throw "INTERNAL_API_KEY is required" }

$headers = @{ "X-Internal-API-Key"=$InternalApiKey; "X-API-Key"=$InternalApiKey }
$body = @{ date=$Date; apply=(-not $DryRun); fallback_recent=$false } | ConvertTo-Json -Depth 8
$nearStart = Invoke-RestMethod -Method Post -Uri "$HubBaseUrl/api/v1/internal/analytics/football/near-start-context/run" -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 180
$dateQuery = [uri]::EscapeDataString($Date)
$queue = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/v1/internal/analytics/operational-window-queue?date=$dateQuery&sport=soccer&limit=240" -Headers $headers -TimeoutSec 60
$command = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/v1/internal/analytics/command-center" -Headers $headers -TimeoutSec 60

$realCandidate = [int](Get-Prop $command "real_candidate_count" 0)
$realMoney = [bool](Get-Prop $command "real_money_enabled" $false)
$kelly = [bool](Get-Prop $command "kelly_enabled" $false)
$telegram = [bool](Get-Prop $command "telegram_auto_enabled" $false)
if ($realCandidate -ne 0 -or $realMoney -or $kelly -or $telegram) {
  throw "GUARDRAIL_BROKEN real_candidate=$realCandidate real_money=$realMoney kelly=$kelly telegram=$telegram"
}

$rows = @($nearStart.rows)
$operationalRows = @($queue.rows | Where-Object { (Get-Prop $_ "action" "") -and (Get-Prop $_ "action" "") -ne "WAIT" })
$focus = @($operationalRows | Select-Object -First 1)
$focusIds = @($focus | ForEach-Object { [string](Get-Prop $_ "match_id" "") } | Where-Object { $_ })
[pscustomobject]@{
  system_status = "FOOTBALL_NEAR_START_CLOCK"
  date = $Date
  dry_run = [bool]$DryRun
  scanned = $rows.Count
  actions = @($rows | Where-Object { $focusIds -contains [string](Get-Prop $_ "match_id" "") } | Select-Object match_id,match,kickoff,status,action,context_score,market_score,final_score)
  operational_queue = @($focus | Select-Object match_id,match,kickoff,minutes_until_start,window,action,missing,preflight_status)
  guardrails = @{ real_candidate_count=0; real_money_enabled=$false; kelly_enabled=$false; telegram_auto_enabled=$false }
} | ConvertTo-Json -Depth 10
