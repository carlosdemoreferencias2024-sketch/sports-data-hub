param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [string]$ProviderName = "",
  [double]$MinEv = 0.03,
  [int]$MaxModelAgeMinutes = 240,
  [int]$MaxMarketAgeMinutes = 30,
  [ValidateSet("market", "entry", "closing")]
  [string]$SnapshotRole = "market",
  [switch]$QuotesOnly,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

$resolvedInput = Resolve-Path $InputPath
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$headers = @{ "X-Internal-API-Key" = $InternalApiKey }

function Test-RealProviderName {
  param([string]$Name)
  $lower = $Name.ToLowerInvariant()
  if (-not $Name -or $lower.Contains("manual") -or $lower.Contains("shadow") -or $lower.Contains("simulated")) {
    throw "Provider real invalido: '$Name'. No puede ser manual/shadow/simulated."
  }
}

function Test-HasProperty {
  param($Object, [string]$Name)
  return $null -ne $Object.PSObject.Properties[$Name] -and $null -ne $Object.$Name -and "$($Object.$Name)" -ne ""
}

function Normalize-Quote {
  param($Item)

  $provider = if ($ProviderName) { $ProviderName } else { [string]$Item.provider_name }
  Test-RealProviderName -Name $provider

  $bookmaker = [string]$Item.bookmaker
  if (-not $bookmaker) {
    throw "Cada cuota real debe traer bookmaker."
  }

  $marketType = if (Test-HasProperty $Item "market_type") { [string]$Item.market_type } else { "moneyline_2way" }
  if ($marketType -ne "moneyline_2way") {
    throw "Solo se permite MLB Moneyline en Real Paper inicial. Recibido: $marketType"
  }

  if (-not $Item.match_id) {
    throw "Cada cuota debe traer match_id UUID."
  }

  $homeOdds = $null
  $awayOdds = $null
  if ($null -ne $Item.home_odds) { $homeOdds = [double]$Item.home_odds }
  if ($null -ne $Item.away_odds) { $awayOdds = [double]$Item.away_odds }
  if ($null -eq $homeOdds -and $null -eq $awayOdds) {
    throw "Cada cuota debe traer home_odds o away_odds."
  }

  $rawData = @{
    source = "real_paper_mlb_moneyline_from_json"
    processed = $true
    bookmaker = $bookmaker
    snapshot_role = $SnapshotRole
    snapshot_type = $SnapshotRole
    real_paper_only = $true
    real_bet_allowed = $false
    kelly_enabled = $false
    telegram_enabled = $false
    stake_mode = "flat"
    stake_fraction = 0.01
    ingested_at = (Get-Date).ToUniversalTime().ToString("o")
  }

  if (Test-HasProperty $Item "event_id") { $rawData.event_id = [string]$Item.event_id }
  if (Test-HasProperty $Item "bookmaker_event_id") { $rawData.bookmaker_event_id = [string]$Item.bookmaker_event_id }
  if (Test-HasProperty $Item "home_team") { $rawData.home_team = [string]$Item.home_team }
  if (Test-HasProperty $Item "away_team") { $rawData.away_team = [string]$Item.away_team }
  if (Test-HasProperty $Item "notes") { $rawData.notes = [string]$Item.notes }
  foreach ($evidenceField in @(
    "source_url",
    "source_type",
    "evidence_id",
    "raw_payload_hash",
    "verified_by",
    "safe_for_entry",
    "safe_for_closing",
    "audit_only",
    "stale_status",
    "window_status",
    "closing_quality"
  )) {
    if (Test-HasProperty $Item $evidenceField) {
      $rawData[$evidenceField] = $Item.$evidenceField
    }
  }

  $quote = @{
    match_id = [string]$Item.match_id
    provider_name = $provider
    market_type = "moneyline_2way"
    raw_data = $rawData
  }
  if ($null -ne $homeOdds) { $quote.home_odds = $homeOdds }
  if ($null -ne $awayOdds) { $quote.away_odds = $awayOdds }
  if (Test-HasProperty $Item "captured_at") { $quote.captured_at = [string]$Item.captured_at }
  if ($QuotesOnly) { $quote.force_insert = $true }
  return $quote
}

$json = Get-Content -LiteralPath $resolvedInput -Raw | ConvertFrom-Json
$itemsSource = if ($json.quotes) { $json.quotes } else { $json }
[object[]]$items = @($itemsSource)
if ($items.Count -lt 1) {
  throw "El archivo no contiene cuotas."
}

$quotes = @()
foreach ($item in $items) {
  $quotes += Normalize-Quote -Item $item
}

$payload = @{ quotes = $quotes } | ConvertTo-Json -Depth 12

Write-Host "[real-paper] quotes=$($quotes.Count) provider=$($quotes[0].provider_name) role=$SnapshotRole mode=MLB_MONEYLINE_ONLY dry_run=$DryRun"

if ($DryRun) {
  $payload
  exit 0
}

$quoteResponse = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/quotes" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payload

Write-Host "[real-paper] quote_post received=$($quoteResponse.received) inserted=$($quoteResponse.inserted) unchanged=$($quoteResponse.unchanged)"

if ($QuotesOnly) {
  Write-Host "[real-paper] quotes_only=true alpha_detector=skipped"
  exit 0
}

Push-Location $repoRoot
try {
  $detectorOutput = & docker.exe "compose" "--profile" "odds" "exec" "-T" "odds-worker" "python" "alpha_detector.py" `
    "--model-name" "carlos_v1_mlb" `
    "--min-ev" ([string]$MinEv) `
    "--max-model-age-minutes" ([string]$MaxModelAgeMinutes) `
    "--max-market-age-minutes" ([string]$MaxMarketAgeMinutes) `
    "--stake-mode" "flat" `
    "--flat-fraction" "0.01"
  $detectorExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

$detectorOutput | ForEach-Object { Write-Host $_ }
if ($detectorExitCode -ne 0) {
  throw "alpha_detector.py fallo con exit code $detectorExitCode"
}

$summary = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/v1/internal/model-quotes/real-paper-summary" -Headers $headers
$health = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/v1/internal/model-quotes/data-health" -Headers $headers

Write-Host "[real-paper] snapshots_groups=$($summary.count)"
Write-Host "[real-paper] health real_paper_candidate=$($health.counts.real_paper_candidate) real_candidate=$($health.counts.real_candidate)"
