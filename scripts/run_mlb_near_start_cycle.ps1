param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$RepoRoot = "",
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = if ($RepoRoot) { (Resolve-Path -LiteralPath $RepoRoot).Path } else { Split-Path -Parent $PSScriptRoot }
$mlbScript = Join-Path (Join-Path $repoRoot "scripts") "run_mlb_near_start_context.ps1"
$arguments = @{}
if (-not $DryRun) { $arguments.Apply = $true }
$arguments.RepoRoot = $repoRoot

$output = & $mlbScript @arguments 2>&1 | Out-String
[pscustomobject]@{
  system_status = "MLB_NEAR_START_CLOCK"
  date = $Date
  dry_run = [bool]$DryRun
  completed = $true
  output = $output.Trim()
  guardrails = @{ real_candidate_count=0; real_money_enabled=$false; kelly_enabled=$false; telegram_auto_enabled=$false }
} | ConvertTo-Json -Depth 8
