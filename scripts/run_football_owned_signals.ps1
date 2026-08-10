param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

function Assert-NoPlaceholder {
  param($Payload)

  $text = ($Payload | ConvertTo-Json -Depth 20)
  $placeholderPattern = "(__FILL_|UUID_REAL|TU_|PLACEHOLDER|REEMPLAZAR|Equipo Local|Equipo Visitante)"
  if ($text -match $placeholderPattern) {
    throw "El payload contiene placeholder o dato incompleto. No se envia."
  }
}

function Normalize-Payload {
  param($Json)

  $signals = @()
  if ($null -ne $Json.PSObject.Properties["signals"]) {
    $signals = @($Json.signals)
  } else {
    $signals = @($Json)
  }
  if ($signals.Count -lt 1) {
    throw "El archivo no contiene signals."
  }

  return @{
    dry_run = -not $Apply
    source = $(if ($null -ne $Json.PSObject.Properties["source"] -and $Json.source) { [string]$Json.source } else { "sports_data_hub_owned_api" })
    build_consensus = $(if ($null -ne $Json.PSObject.Properties["build_consensus"]) { [bool]$Json.build_consensus } else { $true })
    signals = $signals
  }
}

$resolvedInput = Resolve-Path -LiteralPath $InputPath
$json = Get-Content -LiteralPath $resolvedInput -Raw | ConvertFrom-Json
$payloadObject = Normalize-Payload -Json $json
Assert-NoPlaceholder -Payload $payloadObject

$payload = $payloadObject | ConvertTo-Json -Depth 20
$headers = @{
  "X-Internal-API-Key" = $InternalApiKey
  "X-API-Key" = $InternalApiKey
}

Write-Host "[football-owned-signals] input=$resolvedInput signals=$($payloadObject.signals.Count) dry_run=$($payloadObject.dry_run) apply=$Apply"

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/analytics/football-owned-signals" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $payload

Write-Host "[football-owned-signals] accepted=$($response.accepted) rejected=$($response.rejected) inserted=$($response.inserted) would_insert=$($response.would_insert) shadow_candidates=$($response.shadow_candidates) market_snapshots=$($response.market_snapshots)"
Write-Host "[football-owned-signals] observations_inserted=$($response.observations_inserted) consensus_built=$($response.consensus_built) blocked=$($response.blocked) duplicates=$($response.duplicates)"

$readiness = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/football-readiness-gate" -Headers $headers
Write-Host "[football-owned-signals] readiness_decision=$($readiness.decision) ready_for_shadow_review=$($readiness.ready_for_shadow_review) confirmed_paper=$($readiness.football_confirmed_paper) dominant_gap=$($readiness.dominant_gap)"

if ([int]$readiness.ready_for_shadow_review -gt 0) {
  Write-Warning "ALERT_READY_FOR_SHADOW_REVIEW: hay $($readiness.ready_for_shadow_review) partido(s) listos para revision Shadow Paper."
  foreach ($row in @($readiness.alert_rows)) {
    Write-Warning ("READY_FOR_SHADOW_REVIEW match={0} league={1} market={2} pick={3}" -f $row.match, $row.league, $row.market, $row.pick)
  }
}

$response | ConvertTo-Json -Depth 12
