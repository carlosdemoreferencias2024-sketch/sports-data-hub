param(
  [string]$Date = (Get-Date).ToString("yyyy-MM-dd"),
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$SportsDataIoApiKey = $(if ($env:SPORTSDATAIO_API_KEY) { $env:SPORTSDATAIO_API_KEY } else { $env:SPORTS_DATA_IO_API_KEY }),
  [switch]$ClosingOnly,
  [switch]$Settle,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo como SPORTS_DATA_HUB_INTERNAL_KEY o pasalo con -InternalApiKey."
}
if (-not $SportsDataIoApiKey) {
  throw "SPORTSDATAIO_API_KEY no esta definido. Exportalo como SPORTS_DATA_IO_API_KEY o pasalo con -SportsDataIoApiKey."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dateValue = [DateTime]::Parse($Date)
$dateIso = $dateValue.ToString("yyyy-MM-dd")
$backfillDate = $dateValue.ToString("yyyyMMdd")

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  Write-Host ""
  Write-Host "== $Name =="
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Name fallo con exit code $LASTEXITCODE"
  }
}

Push-Location $repoRoot
try {
  Invoke-Step "docker compose ps" {
    & docker compose --profile odds ps
  }

  Invoke-Step "refrescar scraper MLB $backfillDate" {
    & docker compose --profile odds exec -T scraper-mlb python mlb_scraper.py --source-mode espn --source espn-mlb --backfill-date $backfillDate
  }

  $quoteArgs = @(
    "-HubBaseUrl", $HubBaseUrl,
    "-InternalApiKey", $InternalApiKey,
    "-SportsDataIoApiKey", $SportsDataIoApiKey,
    "-Date", $dateIso
  )
  if ($ClosingOnly) { $quoteArgs += @("-ClosingOnly", "-AllowQuotaSkip") }
  if ($DryRun) { $quoteArgs += "-DryRun" }

  Invoke-Step "cargar SportsDataIO MLB Moneyline $dateIso" {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "real_paper_mlb_moneyline_sportsdataio.ps1") @quoteArgs
  }

  if (-not $ClosingOnly) {
    Invoke-Step "pipeline MLB Real Paper" {
      & docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport mlb --model-name carlos_v1_mlb --league-slug mlb --include-live --compact-logs --auto-paper --stake-mode flat --flat-fraction 0.01 --min-ev 0.05 --min-sample-to-persist 50
    }
  }

  $settleArgs = @("--require-closing")
  if (-not $Settle) { $settleArgs += "--dry-run" }

  Invoke-Step $(if ($Settle) { "settlement Real Paper" } else { "settlement Real Paper dry-run" }) {
    & docker compose --profile odds exec -T odds-worker python settle_real_paper_snapshots.py @settleArgs
  }

  Write-Host ""
  Write-Host "[daily-mlb] listo date=$dateIso closing_only=$ClosingOnly settle=$Settle"
} finally {
  Pop-Location
}
