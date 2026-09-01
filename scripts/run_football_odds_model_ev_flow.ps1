param(
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [switch]$Apply,
  [switch]$AllowBttsManualReview
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

function Assert-NoPlaceholder {
  param($Signal, [int]$Index)

  $text = ($Signal | ConvertTo-Json -Depth 12)
  $placeholderPattern = "(__FILL_|UUID_REAL|TU_|PLACEHOLDER|REEMPLAZAR|Equipo Local|Equipo Visitante)"
  if ($text -match $placeholderPattern) {
    throw "Signal $Index contiene placeholder o dato incompleto. No se ejecuta feed."
  }
}

function Read-ReadySignals {
  param([string]$Path)

  $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  $signals = @()
  if ($null -ne $json.PSObject.Properties["signals"]) {
    $signals = @($json.signals)
  } else {
    $signals = @($json)
  }
  if ($signals.Count -lt 1) {
    throw "El archivo no contiene signals."
  }
  $index = 0
  foreach ($signal in $signals) {
    $index += 1
    Assert-NoPlaceholder -Signal $signal -Index $index
  }
  return $signals
}

function Get-OptionalProperty {
  param($Object, [string]$Name, $DefaultValue)

  if ($null -eq $Object) {
    return $DefaultValue
  }
  if ($null -ne $Object.PSObject.Properties[$Name]) {
    return $Object.$Name
  }
  return $DefaultValue
}

$resolvedInput = Resolve-Path -LiteralPath $InputPath
$signals = Read-ReadySignals -Path $resolvedInput.Path

Write-Host "[football-odds-model-ev] input=$resolvedInput signals=$($signals.Count) dry_run=$(-not $Apply) apply=$Apply"
Write-Host "[football-odds-model-ev] step=football-shadow-feed"

$feedArgs = @(
  "-NoProfile",
  "-NonInteractive",
  "-WindowStyle", "Hidden",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $PSScriptRoot "run_football_shadow_feed.ps1"),
  "-HubBaseUrl", $HubBaseUrl,
  "-InternalApiKey", $InternalApiKey,
  "-InputPath", $resolvedInput.Path
)
if ($Apply) {
  $feedArgs += "-Apply"
}
if ($AllowBttsManualReview) {
  $feedArgs += "-AllowBttsManualReview"
}

& powershell.exe @feedArgs
if ($LASTEXITCODE -ne 0) {
  throw "football-shadow-feed fallo con exit code $LASTEXITCODE."
}

$headers = @{ "X-API-Key" = $InternalApiKey }
$readiness = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/football-readiness-gate" -Headers $headers
$command = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/football-command-center" -Headers $headers
$pilot = Invoke-RestMethod -Method Get -Uri "$HubBaseUrl/api/trading/pilot-checklist" -Headers $headers
$pilotGuardrails = Get-OptionalProperty -Object $pilot -Name "guardrails" -DefaultValue $null
$pilotStatus = Get-OptionalProperty -Object $pilot -Name "pilot_status" -DefaultValue (Get-OptionalProperty -Object $pilot -Name "decision" -DefaultValue "UNKNOWN")
$realCandidateCount = Get-OptionalProperty -Object $pilot -Name "real_candidate_count" -DefaultValue (Get-OptionalProperty -Object $pilotGuardrails -Name "real_candidate_count" -DefaultValue 0)
$realMoneyEnabled = Get-OptionalProperty -Object $pilot -Name "real_money_enabled" -DefaultValue (Get-OptionalProperty -Object $pilotGuardrails -Name "real_money_enabled" -DefaultValue $false)
$kellyEnabled = Get-OptionalProperty -Object $pilot -Name "kelly_enabled" -DefaultValue (Get-OptionalProperty -Object $pilotGuardrails -Name "kelly_enabled" -DefaultValue $false)
$telegramEnabled = Get-OptionalProperty -Object $pilot -Name "telegram_auto_enabled" -DefaultValue (Get-OptionalProperty -Object $pilotGuardrails -Name "telegram_auto_enabled" -DefaultValue $false)
$killSwitchEnabled = Get-OptionalProperty -Object $pilot -Name "kill_switch_enabled" -DefaultValue (Get-OptionalProperty -Object $pilotGuardrails -Name "kill_switch_enabled" -DefaultValue $true)

Write-Host "[football-odds-model-ev] readiness_decision=$($readiness.decision) alert=$($readiness.alert_status)"
Write-Host "[football-odds-model-ev] observed=$($readiness.observed_matches) active_candidates=$($readiness.active_candidates) ready_for_shadow_review=$($readiness.ready_for_shadow_review) confirmed_paper=$($readiness.football_confirmed_paper)"
Write-Host "[football-odds-model-ev] with_odds=$($readiness.with_odds) with_model_ev=$($readiness.with_model_ev) dominant_gap=$($readiness.dominant_gap)"

if ([int]$readiness.ready_for_shadow_review -gt 0) {
  Write-Warning "ALERT_READY_FOR_SHADOW_REVIEW: hay $($readiness.ready_for_shadow_review) partido(s) listos para revision Shadow Paper."
  foreach ($row in @($readiness.alert_rows)) {
    Write-Warning ("READY_FOR_SHADOW_REVIEW match={0} league={1} market={2} pick={3}" -f $row.match, $row.league, $row.market, $row.pick)
  }
}

Write-Host "[football-odds-model-ev] command_status=$($command.system_status) action=$($command.recommended_action)"
Write-Host "[football-odds-model-ev] guardrails pilot=$pilotStatus real_candidate=$realCandidateCount real_money=$realMoneyEnabled kelly=$kellyEnabled telegram=$telegramEnabled"

[pscustomobject]@{
  dry_run = -not $Apply
  applied = [bool]$Apply
  signals = $signals.Count
  readiness_decision = $readiness.decision
  alert_status = $readiness.alert_status
  ready_for_shadow_review = $readiness.ready_for_shadow_review
  football_confirmed_paper = $readiness.football_confirmed_paper
  dominant_gap = $readiness.dominant_gap
  guardrails = @{
    real_candidate_count = $realCandidateCount
    real_money_enabled = $realMoneyEnabled
    kelly_enabled = $kellyEnabled
    telegram_auto_enabled = $telegramEnabled
    kill_switch_enabled = $killSwitchEnabled
  }
} | ConvertTo-Json -Depth 8
