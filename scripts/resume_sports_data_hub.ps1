param(
  [string]$InternalApiKey = $env:INTERNAL_API_KEY,
  [string]$SportsDataIoApiKey = $env:SPORTSDATAIO_API_KEY,
  [switch]$ForceClosing,
  [switch]$SkipBackupOnResume
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step($Message) {
  Write-Host ""
  Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Invoke-HealthGet($Name, $Url, $ApiKey = "") {
  try {
    if ($ApiKey) {
      $Body = curl.exe -s -H "X-API-Key: $ApiKey" $Url
    } else {
      $Body = curl.exe -s $Url
    }
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Body)) {
      Write-Host "${Name}: FAIL" -ForegroundColor Red
      return $false
    }
    Write-Host "${Name}: OK" -ForegroundColor Green
    return $true
  } catch {
    Write-Host "${Name}: FAIL - $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
}

Write-Step "Starting sports-data-hub services"
$ComposeStarted = $false
for ($i = 1; $i -le 12; $i++) {
  docker compose --profile odds --profile football-data --profile bi up -d
  if ($LASTEXITCODE -eq 0) {
    $ComposeStarted = $true
    break
  }
  Write-Host "Docker is not ready yet; retry $i/12 in 10 seconds..." -ForegroundColor Yellow
  Start-Sleep -Seconds 10
}

if (-not $ComposeStarted) {
  Write-Host "Docker did not become ready. Open Docker Desktop, wait until it starts, then run this script again." -ForegroundColor Red
}

Write-Step "Waiting for dashboard"
$DashboardReady = $false
for ($i = 1; $i -le 24; $i++) {
  $Code = curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:4000/dashboard/trading
  if ($Code -eq "200") {
    $DashboardReady = $true
    break
  }
  Start-Sleep -Seconds 5
}

if ($DashboardReady) {
  Write-Host "dashboard/trading: 200" -ForegroundColor Green
} else {
  Write-Host "dashboard/trading: NOT READY" -ForegroundColor Yellow
}

Write-Step "Docker status"
docker compose --profile odds --profile football-data --profile bi ps

if ([string]::IsNullOrWhiteSpace($InternalApiKey)) {
  Write-Host "INTERNAL_API_KEY not provided; skipping protected endpoint checks." -ForegroundColor Yellow
} else {
  Write-Step "Guardrail endpoint checks"
  Invoke-HealthGet "command-center" "http://127.0.0.1:4000/api/v1/internal/analytics/command-center" $InternalApiKey | Out-Null
  Invoke-HealthGet "football-confirmed-pick-chain" "http://127.0.0.1:4000/api/v1/internal/analytics/football-confirmed-pick-chain" $InternalApiKey | Out-Null
  Invoke-HealthGet "expected-lineup-engine" "http://127.0.0.1:4000/api/v1/internal/analytics/expected-lineup-engine?sport=football&limit=20" $InternalApiKey | Out-Null
  Invoke-HealthGet "pilot-checklist" "http://127.0.0.1:4000/api/v1/internal/analytics/pilot-checklist" $InternalApiKey | Out-Null
}

if ($ForceClosing) {
  Write-Step "Optional MLB ForceClosing"
  if ([string]::IsNullOrWhiteSpace($InternalApiKey) -or [string]::IsNullOrWhiteSpace($SportsDataIoApiKey)) {
    Write-Host "Skipping ForceClosing: InternalApiKey and SportsDataIoApiKey are required." -ForegroundColor Yellow
  } else {
    & "$RepoRoot\scripts\run_auto_mlb_real_paper.cmd" -ForceClosing -InternalApiKey $InternalApiKey -SportsDataIoApiKey $SportsDataIoApiKey
  }
}

if (-not $SkipBackupOnResume) {
  Write-Step "Postgres backup on resume"
  try {
    $BackupDir = Join-Path $RepoRoot "backups\postgres"
    $todayPrefix = "sports_db_$((Get-Date).ToString("yyyyMMdd"))_"
    $hasTodayBackup = $false

    if (Test-Path -LiteralPath $BackupDir) {
      $hasTodayBackup = [bool](Get-ChildItem -LiteralPath $BackupDir -Filter "$todayPrefix*.dump" -File -ErrorAction SilentlyContinue | Select-Object -First 1)
    }

    if ($hasTodayBackup) {
      Write-Host "Backup already exists for today; skipping." -ForegroundColor Green
    } else {
      & "$RepoRoot\scripts\backup_postgres.cmd"
    }
  } catch {
    Write-Host "Backup on resume failed: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "Dashboard resume can continue; run scripts\backup_postgres.cmd manually later." -ForegroundColor Yellow
  }
}

Write-Step "Resume complete"
Write-Host "Dashboard: http://127.0.0.1:4000/dashboard/trading"
Write-Host "Metabase:  http://127.0.0.1:3001"
