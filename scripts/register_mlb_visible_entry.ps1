param(
  [Parameter(Mandatory = $true)]
  [string]$MatchId,
  [ValidateSet("entry", "closing")]
  [string]$SnapshotType = "entry",
  [Parameter(Mandatory = $true)]
  [string]$EvidencePath,
  [Parameter(Mandatory = $true)]
  [string]$SourceUrl,
  [Parameter(Mandatory = $true)]
  [string]$Bookmaker,
  [Parameter(Mandatory = $true)]
  [double]$HomeOdds,
  [Parameter(Mandatory = $true)]
  [double]$AwayOdds,
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [string]$ProviderName = "espn_draftkings_visible",
  [string]$VerifiedBy = "codex_visible_source",
  [string]$VisibleText = "",
  [string]$CapturedAtIso = "",
  [switch]$EvidenceOnly,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try { [void][Guid]::Parse($MatchId) } catch { throw "MatchId debe ser UUID: $MatchId" }
if ($HomeOdds -le 1 -or $AwayOdds -le 1) { throw "Las cuotas deben estar en decimal y ser mayores que 1." }
if (-not (Test-Path -LiteralPath $EvidencePath)) { throw "EvidencePath no existe: $EvidencePath" }

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$envPath = Join-Path $repoRoot ".env"
if (Test-Path $envPath) {
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line -split '=', 2
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($name -and -not [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}
$InternalApiKey = if ($InternalApiKey) { $InternalApiKey } elseif ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }
if (-not $InternalApiKey) { throw "INTERNAL_API_KEY no esta definido." }

$matchSql = @"
SELECT json_build_object('kickoff', match_date, 'status', status)
FROM v_valid_matches
WHERE id = '$MatchId'::uuid;
"@
Push-Location $repoRoot
try {
  $matchJson = & docker.exe compose --profile odds exec -T db-postgres psql -U sports_admin -d sports_db -t -A -c $matchSql
  if ($LASTEXITCODE -ne 0) { throw "No se pudo consultar el partido." }
} finally {
  Pop-Location
}
$matchLine = $matchJson | Where-Object { $_ -and "$($_)".Trim() } | Select-Object -First 1
if (-not $matchLine) { throw "Partido no encontrado: $MatchId" }
$match = $matchLine | ConvertFrom-Json
if ($match.status -ne "scheduled") { throw "POST_KICKOFF_AUDIT_ONLY: status=$($match.status)" }

[DateTime]$captureMoment = if ($CapturedAtIso) {
  try { ([DateTimeOffset]::Parse($CapturedAtIso)).UtcDateTime } catch { throw "CapturedAtIso invalido: $CapturedAtIso" }
} else {
  (Get-Date).ToUniversalTime()
}
[DateTime]$kickoff = ([DateTimeOffset]::Parse([string]$match.kickoff)).UtcDateTime
$minutesToKickoff = (New-TimeSpan -Start $captureMoment -End $kickoff).TotalMinutes
$insideWindow = if ($SnapshotType -eq "entry") {
  $minutesToKickoff -ge 20 -and $minutesToKickoff -le 1440
} else {
  $minutesToKickoff -ge 3 -and $minutesToKickoff -le 10
}
if (-not $insideWindow) {
  throw "OUTSIDE_$($SnapshotType.ToUpperInvariant())_WINDOW: minutes_to_kickoff=$([math]::Round($minutesToKickoff, 1))"
}

$captureType = if ($SnapshotType -eq "closing") { "closing_odds" } else { "current_odds" }
if (-not $VisibleText) {
  $VisibleText = "Visible sportsbook capture; bookmaker=$Bookmaker; away_decimal=$AwayOdds; home_decimal=$HomeOdds; kickoff=$($kickoff.ToString('o'))."
}
$evidenceBody = @{
  match_id = $MatchId
  sport = "baseball"
  capture_type = $captureType
  source_name = "sportsbook_manual_verified"
  source_url = $SourceUrl
  verified_by = $VerifiedBy
  intended_market = "moneyline_2way"
  captured_at = $captureMoment.ToString("o")
  visible_text = $VisibleText
  screenshot_base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $EvidencePath)))
  data = @{
    market = "moneyline_2way"
    bookmaker = $Bookmaker
    home_odds = $HomeOdds
    away_odds = $AwayOdds
    scheduled_kickoff = $kickoff.ToString("o")
  }
}

if ($DryRun) {
  [pscustomobject]@{
    match_id = $MatchId
    provider = $ProviderName
    snapshot_type = $SnapshotType
    bookmaker = $Bookmaker
    home_odds = $HomeOdds
    away_odds = $AwayOdds
    captured_at = $captureMoment.ToString("o")
    minutes_to_kickoff = [math]::Round($minutesToKickoff, 1)
    evidence_bytes = (Get-Item -LiteralPath $EvidencePath).Length
    picks_created = 0
  } | ConvertTo-Json
  exit 0
}

$headers = @{ "X-Internal-API-Key" = $InternalApiKey }
$evidence = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/analytics/source-capture-assistant/evidence" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body ($evidenceBody | ConvertTo-Json -Depth 10)
if (-not $evidence.applied -or $evidence.evidence_status -ne "EVIDENCE_CAPTURED") {
  throw "La evidencia visible no fue aceptada: $($evidence.reason)"
}
if ($EvidenceOnly) {
  Write-Host "[visible-evidence] restored=true evidence_id=$($evidence.evidence_id) screenshot_sha256=$($evidence.screenshot_sha256)"
  exit 0
}

$rawData = @{
  source = "visible_sportsbook_capture"
  source_url = $SourceUrl
  source_type = "sportsbook_manual_verified"
  evidence_id = [string]$evidence.evidence_id
  screenshot_sha256 = [string]$evidence.screenshot_sha256
  verified_by = $VerifiedBy
  bookmaker = $Bookmaker
  snapshot_role = $SnapshotType
  snapshot_type = $SnapshotType
  safe_for_entry = ($SnapshotType -eq "entry")
  safe_for_closing = ($SnapshotType -eq "closing")
  stale_status = "FRESH"
  window_status = $(if ($SnapshotType -eq "closing") { "CAPTURED_ON_TIME" } else { "ENTRY_CAPTURED_ON_TIME" })
  closing_quality = $(if ($SnapshotType -eq "closing") { "CAPTURED_ON_TIME" } else { "NOT_CLOSING" })
  audit_only = $false
  real_bet_allowed = $false
  kelly_enabled = $false
  telegram_enabled = $false
  visible_text = $VisibleText
}
$quoteBody = @{
  quotes = @(@{
    match_id = $MatchId
    provider_name = $ProviderName
    market_type = "moneyline_2way"
    home_odds = $HomeOdds
    away_odds = $AwayOdds
    captured_at = $captureMoment.ToString("o")
    force_insert = $true
    raw_data = $rawData
  })
}
$quoteResponse = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/quotes" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body ($quoteBody | ConvertTo-Json -Depth 12)
if ([int]$quoteResponse.inserted -lt 1) { throw "No se inserto el snapshot $SnapshotType verificable." }

Write-Host "[visible-snapshot] match=$MatchId role=$SnapshotType inserted=$($quoteResponse.inserted) evidence_id=$($evidence.evidence_id) screenshot_sha256=$($evidence.screenshot_sha256)"
Write-Host "[visible-snapshot] picks_created=0 real_candidate=0 money_real=OFF kelly=OFF telegram=OFF kill_switch=ON"
