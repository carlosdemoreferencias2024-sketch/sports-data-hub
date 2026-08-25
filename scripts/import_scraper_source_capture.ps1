param(
  [Parameter(Mandatory = $true)]
  [string]$EvidencePath,
  [Parameter(Mandatory = $true)]
  [string]$MatchId,
  [Parameter(Mandatory = $true)]
  [string]$VerifiedBy,
  [string]$ExpectedHomeTeam = "",
  [string]$ExpectedAwayTeam = "",
  [string]$ExpectedKickoff = "",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [switch]$ApplyVerifiedCapture,
  [switch]$PostKickoffAuditOnly,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try { [void][Guid]::Parse($MatchId) } catch { throw "MatchId debe ser UUID: $MatchId" }
if (-not (Test-Path -LiteralPath $EvidencePath -PathType Leaf)) {
  throw "EvidencePath no existe o no es un archivo: $EvidencePath"
}

$draft = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
$required = @("source_name", "source_url", "captured_at", "evidence_id", "evidence_sha256", "evidence_canonical_json", "capture_type", "sport", "data")
foreach ($field in $required) {
  if (-not $draft.PSObject.Properties[$field] -or [string]::IsNullOrWhiteSpace([string]$draft.$field)) {
    throw "Campo obligatorio ausente en el borrador: $field"
  }
}
if ([string]$draft.workflow_state -ne "PENDING_HUMAN_VERIFICATION") {
  throw "Estado no permitido: $($draft.workflow_state)"
}
if ([bool]$draft.auto_post) { throw "Guardrail violado: auto_post debe ser false" }
if ($draft.verified_by) { throw "El borrador automático no debe llegar pre-verificado" }

function Convert-ToUtcDateTimeOffset([object]$Value) {
  if ($Value -is [DateTimeOffset]) { return ([DateTimeOffset]$Value).ToUniversalTime() }
  if ($Value -is [DateTime]) {
    $dateTime = [DateTime]$Value
    if ($dateTime.Kind -eq [DateTimeKind]::Unspecified) {
      $dateTime = [DateTime]::SpecifyKind($dateTime, [DateTimeKind]::Utc)
    }
    return ([DateTimeOffset]$dateTime).ToUniversalTime()
  }
  return [DateTimeOffset]::Parse(
    [string]$Value,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal
  ).ToUniversalTime()
}

$capturedAtUtc = Convert-ToUtcDateTimeOffset $draft.captured_at
$nowUtc = [DateTimeOffset]::UtcNow
if ($capturedAtUtc -gt $nowUtc.AddMinutes(5)) {
  throw "FUTURE_CAPTURE_REJECTED: captured_at=$($capturedAtUtc.ToString('o')) now=$($nowUtc.ToString('o'))"
}
$snapshotType = [string]$draft.capture_type
if ($draft.data -and $draft.data.PSObject.Properties["snapshot_type"]) {
  $snapshotType = [string]$draft.data.snapshot_type
}
$maxAgeMinutes = switch -Regex ($snapshotType.ToLowerInvariant()) {
  'closing' { 15; break }
  'near.?start|lineup|goalkeeper' { 45; break }
  'current' { 60; break }
  default { 360 }
}
$captureAgeMinutes = ($nowUtc - $capturedAtUtc).TotalMinutes
if ($ApplyVerifiedCapture -and -not $PostKickoffAuditOnly -and $captureAgeMinutes -gt $maxAgeMinutes) {
  throw "STALE_CAPTURE_REJECTED: type=$snapshotType age_minutes=$([Math]::Round($captureAgeMinutes, 2)) limit=$maxAgeMinutes"
}

function Normalize-TeamName([object]$Value) {
  return ([string]$Value).ToLowerInvariant().Normalize([Text.NormalizationForm]::FormD) -replace '[^a-z0-9]', ''
}

$normalizedEvent = $draft.data.normalized_event
$draftKickoffUtc = $null
if ($normalizedEvent -and $normalizedEvent.PSObject.Properties["starts_at"] -and $normalizedEvent.starts_at) {
  $draftKickoffUtc = Convert-ToUtcDateTimeOffset $normalizedEvent.starts_at
} elseif ($draft.data.PSObject.Properties["scheduled_kickoff"] -and $draft.data.scheduled_kickoff) {
  $draftKickoffUtc = Convert-ToUtcDateTimeOffset $draft.data.scheduled_kickoff
}
if ($draftKickoffUtc -and -not $PostKickoffAuditOnly) {
  if ($capturedAtUtc -ge $draftKickoffUtc) {
    throw "POST_KICKOFF_CAPTURE_REJECTED: captured_at=$($capturedAtUtc.ToString('o')) kickoff=$($draftKickoffUtc.ToString('o'))"
  }
  if (-not $DryRun -and $nowUtc -ge $draftKickoffUtc) {
    throw "PROSPECTIVE_WINDOW_CLOSED: kickoff=$($draftKickoffUtc.ToString('o')); use -PostKickoffAuditOnly for audit storage"
  }
}

$isOddsCapture = $snapshotType.ToLowerInvariant() -match '(^|_)(current|closing)(_|$)|odds'
$screenshotFilePath = $null
if ($isOddsCapture) {
  $screenshotSha256 = if ($draft.PSObject.Properties["screenshot_sha256"]) {
    [string]$draft.screenshot_sha256
  } elseif ($draft.data.PSObject.Properties["screenshot_sha256"]) {
    [string]$draft.data.screenshot_sha256
  } else { "" }
  if ($screenshotSha256 -notmatch '^[a-fA-F0-9]{64}$') {
    throw "MARKET_SCREENSHOT_SHA256_REQUIRED"
  }
  $screenshotPathValue = if ($draft.PSObject.Properties["screenshot_path"]) {
    [string]$draft.screenshot_path
  } elseif ($draft.data.PSObject.Properties["screenshot_path"]) {
    [string]$draft.data.screenshot_path
  } else { "" }
  if ([string]::IsNullOrWhiteSpace($screenshotPathValue)) {
    throw "MARKET_SCREENSHOT_FILE_REQUIRED"
  }
  $candidateScreenshotPath = if ([IO.Path]::IsPathRooted($screenshotPathValue)) {
    $screenshotPathValue
  } else {
    Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $EvidencePath)) $screenshotPathValue
  }
  if (-not (Test-Path -LiteralPath $candidateScreenshotPath -PathType Leaf)) {
    throw "MARKET_SCREENSHOT_FILE_NOT_FOUND: $candidateScreenshotPath"
  }
  $screenshotFilePath = (Resolve-Path -LiteralPath $candidateScreenshotPath).Path
  $actualScreenshotSha256 = (Get-FileHash -LiteralPath $screenshotFilePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualScreenshotSha256 -ne $screenshotSha256.ToLowerInvariant()) {
    throw "MARKET_SCREENSHOT_HASH_MISMATCH: expected=$screenshotSha256 actual=$actualScreenshotSha256"
  }
  if ([string]::IsNullOrWhiteSpace([string]$draft.bookmaker)) {
    throw "MARKET_BOOKMAKER_REQUIRED"
  }
  if ([string]$draft.sport -eq "soccer") {
    $oddsRows = @()
    if ($draft.data.PSObject.Properties["odds"] -and $draft.data.odds) { $oddsRows += @($draft.data.odds) }
    if ($normalizedEvent -and $normalizedEvent.PSObject.Properties["odds"] -and $normalizedEvent.odds) { $oddsRows += @($normalizedEvent.odds) }
    $labels = @($oddsRows | ForEach-Object {
      $label = ""
      foreach ($propertyName in @("selection", "side", "outcome", "name")) {
        if ($_.PSObject.Properties[$propertyName] -and -not [string]::IsNullOrWhiteSpace([string]$_.$propertyName)) {
          $label = [string]$_.$propertyName
          break
        }
      }
      $label.Trim().ToLowerInvariant()
    })
    foreach ($requiredSide in @("home", "draw", "away")) {
      if ($labels -notcontains $requiredSide) { throw "MARKET_THREE_WAY_SIDE_MISSING: $requiredSide" }
    }
  }
}

if ($ApplyVerifiedCapture) {
  if (-not $ExpectedHomeTeam -or -not $ExpectedAwayTeam -or -not $ExpectedKickoff) {
    throw "ExpectedHomeTeam, ExpectedAwayTeam y ExpectedKickoff son obligatorios con -ApplyVerifiedCapture"
  }
  if (-not $normalizedEvent) { throw "normalized_event_required_for_verified_capture" }

  $actualHome = [string]$normalizedEvent.home.name
  $actualAway = [string]$normalizedEvent.away.name
  if ((Normalize-TeamName $actualHome) -ne (Normalize-TeamName $ExpectedHomeTeam)) {
    throw "HOME_TEAM_MISMATCH: expected=$ExpectedHomeTeam actual=$actualHome"
  }
  if ((Normalize-TeamName $actualAway) -ne (Normalize-TeamName $ExpectedAwayTeam)) {
    throw "AWAY_TEAM_MISMATCH: expected=$ExpectedAwayTeam actual=$actualAway"
  }

  $actualKickoff = Convert-ToUtcDateTimeOffset $normalizedEvent.starts_at
  $expectedKickoffUtc = Convert-ToUtcDateTimeOffset $ExpectedKickoff
  if ([Math]::Abs(($actualKickoff - $expectedKickoffUtc).TotalMinutes) -gt 1) {
    throw "KICKOFF_MISMATCH: expected=$($expectedKickoffUtc.ToString('o')) actual=$($actualKickoff.ToString('o'))"
  }
  if ([string]$normalizedEvent.status -notin @("scheduled", "pre", "prematch")) {
    throw "MATCH_NOT_PREGAME: status=$($normalizedEvent.status)"
  }
}

$bytes = [Text.Encoding]::UTF8.GetBytes([string]$draft.evidence_canonical_json)
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $computedHash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
} finally {
  $sha.Dispose()
}
if ($computedHash -ne [string]$draft.evidence_sha256) {
  throw "EVIDENCE_HASH_MISMATCH: esperado=$($draft.evidence_sha256) calculado=$computedHash"
}
if (-not $computedHash.StartsWith([string]$draft.evidence_id)) {
  throw "EVIDENCE_ID_MISMATCH"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$envPath = Join-Path $repoRoot ".env"
if (Test-Path -LiteralPath $envPath) {
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

$captureData = @{}
foreach ($property in $draft.data.PSObject.Properties) { $captureData[$property.Name] = $property.Value }
$captureData["bookmaker"] = $draft.bookmaker
$captureData["upstream_evidence_id"] = [string]$draft.evidence_id
$captureData["upstream_evidence_sha256"] = [string]$draft.evidence_sha256
$captureData["screenshot_sha256"] = if ($draft.PSObject.Properties["screenshot_sha256"]) { [string]$draft.screenshot_sha256 } elseif ($draft.data.PSObject.Properties["screenshot_sha256"]) { [string]$draft.data.screenshot_sha256 } else { $null }
$captureData["source_event_id"] = [string]$draft.source_event_id
$captureData["match_fingerprint"] = [string]$draft.match_fingerprint
$captureData["post_kickoff_audit_only"] = [bool]$PostKickoffAuditOnly

$body = @{
  match_id = $MatchId
  sport = [string]$draft.sport
  capture_type = [string]$draft.capture_type
  source_name = [string]$draft.source_name
  source_url = [string]$draft.source_url
  captured_at = $capturedAtUtc.UtcDateTime.ToString("o")
  verified_by = $VerifiedBy
  visible_text = "Scraper evidence reviewed by human; source_event_id=$($draft.source_event_id); upstream_evidence_id=$($draft.evidence_id); sha256=$($draft.evidence_sha256)."
  data = $captureData
}
if ($screenshotFilePath) {
  $body["screenshot_base64"] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($screenshotFilePath))
}

if ($DryRun) {
  [pscustomobject]@{
    validated = $true
    posted = $false
    endpoint = "/api/v1/internal/analytics/source-capture-assistant/evidence"
    match_id = $MatchId
    source_name = $draft.source_name
    source_url = $draft.source_url
    bookmaker = $draft.bookmaker
    captured_at = $body.captured_at
    verified_by = $VerifiedBy
    evidence_id = $draft.evidence_id
    evidence_sha256 = $draft.evidence_sha256
    home_team = if ($normalizedEvent) { $normalizedEvent.home.name } else { $null }
    away_team = if ($normalizedEvent) { $normalizedEvent.away.name } else { $null }
    kickoff = if ($normalizedEvent) { $normalizedEvent.starts_at } else { $null }
    apply_verified_capture = [bool]$ApplyVerifiedCapture
    post_kickoff_audit_only = [bool]$PostKickoffAuditOnly
    picks_created = 0
  } | ConvertTo-Json -Depth 8
  exit 0
}
if (-not $InternalApiKey) { throw "INTERNAL_API_KEY no está definido" }

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/analytics/source-capture-assistant/evidence" `
  -Headers @{ "X-Internal-API-Key" = $InternalApiKey } `
  -ContentType "application/json" `
  -Body ($body | ConvertTo-Json -Depth 30)

if (-not $response.applied -or $response.rejected) {
  throw "Source Capture Assistant rechazó la evidencia: $($response.reason)"
}
if ([bool]$response.auto_posted -or [int]$response.picks_created -ne 0) {
  throw "Guardrail violado por la respuesta del asistente"
}
Write-Host "[source-capture] evidence_id=$($response.evidence_id) upstream=$($draft.evidence_id) state=$($response.workflow_state)"

$verifiedResponse = $null
$verifiedCaptureId = $null
$fairOddsResponse = $null
if ($ApplyVerifiedCapture -and -not $PostKickoffAuditOnly) {
  $verifiedBody = @{
    match_id = $MatchId
    sport = [string]$draft.sport
    source_name = [string]$draft.source_name
    source_url = [string]$draft.source_url
    capture_type = [string]$draft.capture_type
    captured_at = $body.captured_at
    verified_by = $VerifiedBy
    confidence_score = 85
    data = $captureData
  }
  $verifiedResponse = Invoke-RestMethod `
    -Method Post `
    -Uri "$HubBaseUrl/api/v1/internal/analytics/source-capture/manual-verified" `
    -Headers @{ "X-Internal-API-Key" = $InternalApiKey } `
    -ContentType "application/json" `
    -Body ($verifiedBody | ConvertTo-Json -Depth 30)

  if (-not $verifiedResponse.applied -or $verifiedResponse.rejected) {
    throw "Manual verified capture rejected: $($verifiedResponse.reason)"
  }
  if ([bool]$verifiedResponse.guardrails.real_money_enabled -or [int]$verifiedResponse.guardrails.real_candidate_count -ne 0) {
    throw "Guardrail violated by manual verified capture"
  }
  $verifiedCaptureId = if ($verifiedResponse.PSObject.Properties["capture_id"]) {
    $verifiedResponse.capture_id
  } elseif ($verifiedResponse.PSObject.Properties["idempotency_key"]) {
    $verifiedResponse.idempotency_key
  } else {
    $null
  }
  Write-Host "[source-capture] verified_capture_applied=true capture_id=$verifiedCaptureId"

  if ([string]$draft.sport -eq "soccer" -and [string]$draft.capture_type -notin @("current_odds", "closing_odds")) {
    $fairOddsResponse = Invoke-RestMethod `
      -Method Post `
      -Uri "$HubBaseUrl/api/v1/internal/analytics/football-owned-fair-odds/run" `
      -Headers @{ "X-Internal-API-Key" = $InternalApiKey } `
      -ContentType "application/json" `
      -Body (@{
        match_id = $MatchId
        model_version = "v3"
        apply = $true
        fallback_recent = $true
      } | ConvertTo-Json -Depth 10)
    if ([bool]$fairOddsResponse.guardrails.real_money_enabled -or [int]$fairOddsResponse.guardrails.real_candidate_count -ne 0) {
      throw "Guardrail violated by fair odds recalculation"
    }
    Write-Host "[source-capture] fair_odds_v3_recalculated=true quotes=$($fairOddsResponse.quotes_generated) skipped=$($fairOddsResponse.skipped_matches)"
  }
}

Write-Host "[source-capture] picks_created=0 auto_post=OFF human_verified_by=$VerifiedBy"
[pscustomobject]@{
  validated = $true
  staged = $true
  source_capture_evidence_id = $response.evidence_id
  upstream_evidence_id = $draft.evidence_id
  verified_capture_applied = [bool]($ApplyVerifiedCapture -and -not $PostKickoffAuditOnly)
  post_kickoff_audit_only = [bool]$PostKickoffAuditOnly
  verified_capture_id = $verifiedCaptureId
  fair_odds_v3_recalculated = [bool]$fairOddsResponse
  fair_odds_v3_quotes_generated = if ($fairOddsResponse) { $fairOddsResponse.quotes_generated } else { 0 }
  workflow_state = $response.workflow_state
  picks_created = 0
  real_candidate_count = if ($verifiedResponse) { $verifiedResponse.guardrails.real_candidate_count } else { 0 }
  real_money_enabled = if ($verifiedResponse) { $verifiedResponse.guardrails.real_money_enabled } else { $false }
} | ConvertTo-Json -Depth 12
