param(
  [string]$Date = (Get-Date).ToString("yyyy-MM-dd"),
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$LeagueSlug = "fifa-world-cup-2026",
  [double]$TargetEv = 0.08,
  [switch]$AllowOtherDate,
  [switch]$SkipManualShadow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo como SPORTS_DATA_HUB_INTERNAL_KEY o pasalo con -InternalApiKey."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dateIso = ([DateTime]::Parse($Date)).ToString("yyyy-MM-dd")

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

  Invoke-Step "refrescar scraper Mundial" {
    & docker compose --profile odds exec -T scraper-soccer python soccer_scraper.py --source-mode espn
  }

  Invoke-Step "pipeline Mundial Shadow" {
    & docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug $LeagueSlug --include-live --compact-logs --auto-paper --stake-mode flat --flat-fraction 0.01 --min-ev 0.05 --min-sample-to-persist 50
  }

  if (-not $SkipManualShadow) {
    $shadowArgs = @(
      "-HubBaseUrl", $HubBaseUrl,
      "-InternalApiKey", $InternalApiKey,
      "-LeagueSlug", $LeagueSlug,
      "-TargetEv", ([string]$TargetEv),
      "-TargetDate", $dateIso,
      "-OnlyTargetDate"
    )
    if ($AllowOtherDate) {
      $shadowArgs = @(
        "-HubBaseUrl", $HubBaseUrl,
        "-InternalApiKey", $InternalApiKey,
        "-LeagueSlug", $LeagueSlug,
        "-TargetEv", ([string]$TargetEv),
        "-TargetDate", $dateIso,
        "-AllowOtherDate"
      )
    }

    Invoke-Step "alimentar manual_shadow_worldcup" {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "manual_shadow_worldcup.ps1") @shadowArgs
    }

    Invoke-Step "pipeline Mundial despues de cuotas shadow" {
      & docker compose --profile odds exec -T odds-worker python model_pipeline.py --sport football --model-name carlos_v1_football --league-slug $LeagueSlug --include-live --compact-logs --auto-paper --stake-mode flat --flat-fraction 0.01 --min-ev 0.05 --min-sample-to-persist 50
    }
  }

  Invoke-Step "settlement paper Mundial" {
    & docker compose --profile odds exec -T odds-worker python settle_paper_trades.py
  }

  Write-Host ""
  Write-Host "[daily-worldcup] listo date=$dateIso league=$LeagueSlug"
} finally {
  Pop-Location
}
