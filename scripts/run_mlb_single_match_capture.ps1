param(
  [Parameter(Mandatory = $true)]
  [string]$MatchId,
  [Parameter(Mandatory = $true)]
  [ValidateSet("entry", "closing")]
  [string]$SnapshotType,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try { [void][Guid]::Parse($MatchId) } catch { throw "MatchId debe ser UUID: $MatchId" }

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

$matchSql = @"
SELECT json_build_object(
  'id', m.id::text,
  'kickoff', m.match_date,
  'status', m.status,
  'league', l.slug,
  'home', ht.name,
  'away', at.name
)
FROM v_valid_matches m
JOIN leagues l ON l.id = m.league_id
JOIN match_competitors hc ON hc.match_id = m.id AND hc.home_away = 'home'
JOIN teams ht ON ht.id = hc.team_id
JOIN match_competitors ac ON ac.match_id = m.id AND ac.home_away = 'away'
JOIN teams at ON at.id = ac.team_id
WHERE m.id = '$MatchId'::uuid;
"@

Push-Location $repoRoot
try {
  $matchJson = & docker.exe compose --profile odds exec -T db-postgres psql -U sports_admin -d sports_db -t -A -c $matchSql
  if ($LASTEXITCODE -ne 0) { throw "No se pudo consultar el partido $MatchId." }
} finally {
  Pop-Location
}

$matchLine = $matchJson | Where-Object { $_ -and "$($_)".Trim() } | Select-Object -First 1
if (-not $matchLine) { throw "Partido no encontrado: $MatchId" }
$match = $matchLine | ConvertFrom-Json
if ($match.league -ne "mlb") { throw "El partido no es MLB: $($match.league)" }
if ($match.status -ne "scheduled") { throw "POST_KICKOFF_AUDIT_ONLY: status=$($match.status); no se captura como pregame." }

$now = (Get-Date).ToUniversalTime()
$kickoff = ([DateTimeOffset]::Parse([string]$match.kickoff)).UtcDateTime
$minutesToKickoff = ($kickoff - $now).TotalMinutes
$insideWindow = if ($SnapshotType -eq "entry") {
  $minutesToKickoff -ge 20 -and $minutesToKickoff -le 1440
} else {
  $minutesToKickoff -ge 3 -and $minutesToKickoff -le 10
}
if (-not $insideWindow) {
  throw "OUTSIDE_$($SnapshotType.ToUpperInvariant())_WINDOW: minutes_to_kickoff=$([math]::Round($minutesToKickoff, 1))"
}

Write-Host "[single-match] match=$($match.away) @ $($match.home) id=$MatchId role=$SnapshotType minutes_to_kickoff=$([math]::Round($minutesToKickoff, 1))"
$providerScript = Join-Path $PSScriptRoot "real_paper_mlb_moneyline_sportsdataio.ps1"
$providerArgs = @(
  "-Date", $kickoff.ToString("yyyy-MM-dd"),
  "-MatchId", $MatchId,
  "-SnapshotRole", $SnapshotType,
  "-QuotesOnly"
)
if ($DryRun) { $providerArgs += "-DryRun" }

& powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $providerScript @providerArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[single-match] complete role=$SnapshotType picks_created=0 real_candidate=0 money_real=OFF kelly=OFF telegram=OFF kill_switch=ON"
