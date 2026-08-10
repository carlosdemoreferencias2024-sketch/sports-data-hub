param(
  [string]$Date = (Get-Date -Format "yyyy-MM-dd"),
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$SportsDataIoApiKey = $(if ($env:SPORTSDATAIO_API_KEY) { $env:SPORTSDATAIO_API_KEY } else { $env:SPORTS_DATA_IO_API_KEY }),
  [string]$ApiFootballKey = $(if ($env:API_FOOTBALL_KEY) { $env:API_FOOTBALL_KEY } else { $env:FOOTBALL_API_KEY }),
  [int]$ClosingHourLocal = 22,
  [int]$FootballMaxApiRequests = 20,
  [switch]$SkipBackup,
  [switch]$SkipFootball,
  [switch]$SkipMlb,
  [switch]$SkipClosing,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

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

function Resolve-Key([string]$Current, [string[]]$Names) {
  if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current }
  foreach ($name in $Names) {
    $value = Get-LocalDotEnvValue $name
    if (-not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return ""
}

function Invoke-HubGet([string]$Path) {
  $headers = @{ "X-API-Key" = $InternalApiKey; "X-Internal-API-Key" = $InternalApiKey }
  Invoke-RestMethod -Method Get -Uri "$HubBaseUrl$Path" -Headers $headers -TimeoutSec 30
}

function Get-Prop($Object, [string]$Name, $Default = $null) {
  if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
  return $Default
}

function Assert-Guardrails($Name, $Response) {
  $guardrails = Get-Prop $Response "guardrails" $null
  $realCandidate = [int](Get-Prop $Response "real_candidate_count" 0)
  if ($null -ne $guardrails -and $null -ne $guardrails.PSObject.Properties["real_candidate_count"]) {
    $realCandidate = [int]$guardrails.real_candidate_count
  }
  $realMoney = [bool](Get-Prop $Response "real_money_enabled" $false)
  $kelly = [bool](Get-Prop $Response "kelly_enabled" $false)
  $telegram = [bool](Get-Prop $Response "telegram_auto_enabled" $false)
  if ($null -ne $guardrails) {
    if ($null -ne $guardrails.PSObject.Properties["real_money_enabled"]) { $realMoney = [bool]$guardrails.real_money_enabled }
    if ($null -ne $guardrails.PSObject.Properties["kelly_enabled"]) { $kelly = [bool]$guardrails.kelly_enabled }
    if ($null -ne $guardrails.PSObject.Properties["telegram_auto_enabled"]) { $telegram = [bool]$guardrails.telegram_auto_enabled }
  }
  if ($realCandidate -ne 0 -or $realMoney -or $kelly -or $telegram) {
    throw "$Name guardrail failure: real_candidate=$realCandidate real_money=$realMoney kelly=$kelly telegram=$telegram"
  }
  Write-Host "[$Name] guardrails OK" -ForegroundColor Green
}

function Test-Http200([string]$Name, [string]$Url, [switch]$WithKey) {
  $curlArgs = @("-s", "-o", "NUL", "-w", "%{http_code}")
  if ($WithKey) {
    $curlArgs += @("-H", "X-API-Key: $InternalApiKey")
  }
  $curlArgs += $Url
  $code = & curl.exe @curlArgs
  if ($code -ne "200") { throw "$Name expected HTTP 200, got $code" }
  Write-Host "[$Name] 200" -ForegroundColor Green
}

function Ensure-DailyBackup {
  if ($SkipBackup) {
    Write-Host "[backup] skipped by flag" -ForegroundColor Yellow
    return
  }
  $stamp = (Get-Date -Format "yyyyMMdd")
  $backupDir = Join-Path $RepoRoot "backups\postgres"
  $existing = @()
  if (Test-Path -LiteralPath $backupDir) {
    $existing = @(Get-ChildItem -LiteralPath $backupDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $stamp })
  }
  if ($existing.Count -gt 0) {
    Write-Host "[backup] daily backup exists: $($existing[0].Name)" -ForegroundColor Green
    return
  }
  $backupCmd = Join-Path $PSScriptRoot "backup_postgres.cmd"
  if (-not (Test-Path -LiteralPath $backupCmd)) {
    Write-Host "[backup] backup_postgres.cmd not found; skipping" -ForegroundColor Yellow
    return
  }
  Write-Host "[backup] no daily backup found; running backup_postgres.cmd"
  & $backupCmd
  if ($LASTEXITCODE -ne 0) { throw "backup_postgres.cmd failed with exit code $LASTEXITCODE" }
}

function Run-FootballAutomation {
  if ($SkipFootball) {
    Write-Host "[football] skipped by flag" -ForegroundColor Yellow
    return
  }
  $contextParams = @{
    Date = $Date
    HubBaseUrl = $HubBaseUrl
    InternalApiKey = $InternalApiKey
    MaxApiRequests = $FootballMaxApiRequests
    IncludeTomorrow = $true
    ApplyCalendar = $true
    ApplyFootballContext = $true
    SkipMlbContext = $true
  }
  if (-not [string]::IsNullOrWhiteSpace($ApiFootballKey)) {
    $contextParams.ApiFootballKey = $ApiFootballKey
  }
  if (-not [string]::IsNullOrWhiteSpace($SportsDataIoApiKey)) {
    $contextParams.SportsDataIoApiKey = $SportsDataIoApiKey
  }
  if ($DryRun) {
    $contextParams.Remove("ApplyCalendar")
    $contextParams.Remove("ApplyFootballContext")
  }
  & (Join-Path $PSScriptRoot "run_context_refresh.ps1") @contextParams
  if ($LASTEXITCODE -ne 0) { throw "run_context_refresh failed with exit code $LASTEXITCODE" }
}

function Run-MlbAutomation {
  if ($SkipMlb) {
    Write-Host "[mlb] skipped by flag" -ForegroundColor Yellow
    return
  }
  $nearStartParams = @{}
  if (-not $DryRun) { $nearStartParams.Apply = $true }
  & (Join-Path $PSScriptRoot "run_mlb_near_start_context.ps1") @nearStartParams
  if ($LASTEXITCODE -ne 0) { throw "run_mlb_near_start_context failed with exit code $LASTEXITCODE" }

  if ($SkipClosing) {
    Write-Host "[mlb-closing] skipped by flag" -ForegroundColor Yellow
    return
  }
  if ([string]::IsNullOrWhiteSpace($SportsDataIoApiKey)) {
    Write-Host "[mlb-auto] SPORTSDATAIO_API_KEY no disponible; salto entry/closing automatico." -ForegroundColor Yellow
    return
  }
  $mlbParams = @{
    Date = $Date
    HubBaseUrl = $HubBaseUrl
    InternalApiKey = $InternalApiKey
    ClosingHourLocal = $ClosingHourLocal
    SportsDataIoApiKey = $SportsDataIoApiKey
  }
  if ($DryRun) { $mlbParams.DryRun = $true }
  & (Join-Path $PSScriptRoot "run_auto_mlb_real_paper.ps1") @mlbParams
  if ($LASTEXITCODE -ne 0) { throw "run_auto_mlb_real_paper failed with exit code $LASTEXITCODE" }
}

$InternalApiKey = Resolve-Key $InternalApiKey @("INTERNAL_API_KEY", "SPORTS_DATA_HUB_INTERNAL_KEY")
$SportsDataIoApiKey = Resolve-Key $SportsDataIoApiKey @("SPORTSDATAIO_API_KEY", "SPORTS_DATA_IO_API_KEY")
$ApiFootballKey = Resolve-Key $ApiFootballKey @("API_FOOTBALL_KEY", "FOOTBALL_API_KEY")
if ([string]::IsNullOrWhiteSpace($InternalApiKey)) {
  throw "INTERNAL_API_KEY is required. Put it in .env or pass -InternalApiKey."
}

Write-Step "Safe ops cycle start"
Write-Host "date=$Date dry_run=$DryRun real_money=false kelly=false telegram_auto=false"

Test-Http200 "dashboard" "$HubBaseUrl/dashboard/trading"
$before = Invoke-HubGet "/api/trading/command-center"
Assert-Guardrails "before" $before
Ensure-DailyBackup

Write-Step "Football safe refresh"
Run-FootballAutomation

Write-Step "MLB near-start and auto entry/closing"
Run-MlbAutomation

Write-Step "Post-cycle validation"
Test-Http200 "dashboard" "$HubBaseUrl/dashboard/trading"
foreach ($path in @(
  "/api/trading/command-center",
  "/api/trading/pilot-checklist",
  "/api/trading/confirmed-pick-chain",
  "/api/trading/football-confirmed-pick-chain",
  "/api/trading/football-market-lab",
  "/api/trading/team-intelligence",
  "/api/trading/player-intelligence",
  "/api/trading/intelligence-scout",
  "/api/trading/matchup-confirmation"
)) {
  Test-Http200 $path "$HubBaseUrl$path" -WithKey
}
$after = Invoke-HubGet "/api/trading/command-center"
Assert-Guardrails "after" $after
Write-Host "[summary] bettable=$($after.counts.bettable_paper) confirmed=$($after.counts.bettable_paper_confirmed) real_candidate=$($after.real_candidate_count)"
Write-Host "[summary] dashboard=$HubBaseUrl/dashboard/trading"
