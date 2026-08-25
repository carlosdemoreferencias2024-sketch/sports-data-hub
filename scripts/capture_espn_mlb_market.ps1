param(
  [Parameter(Mandatory = $true)][string]$EventId,
  [Parameter(Mandatory = $true)][string]$MatchId,
  [Parameter(Mandatory = $true)][string]$ExpectedHomeTeam,
  [Parameter(Mandatory = $true)][string]$ExpectedAwayTeam,
  [ValidateSet("current", "closing")][string]$SnapshotType = "current",
  [string]$Bookmaker = "DraftKings",
  [string]$ChromePath = "",
  [string]$OutputRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$captureScript = Join-Path $repoRoot "workers\espn_mlb_market_capture.py"
if (-not (Test-Path -LiteralPath $captureScript)) { throw "Capture script not found: $captureScript" }
if (-not $OutputRoot) { $OutputRoot = Join-Path $repoRoot "uploads\source-captures\scraper-inbox" }

$knownPython = "C:\Users\tsacl\AppData\Local\Python\pythoncore-3.14-64\python.exe"
$python = if ($env:PYTHON -and (Test-Path -LiteralPath $env:PYTHON)) {
  $env:PYTHON
} elseif (Test-Path -LiteralPath $knownPython) {
  $knownPython
} else {
  $command = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($command -and $command.Source -notmatch '\\WindowsApps\\') { $command.Source } else { "" }
}
if (-not (Test-Path -LiteralPath $python)) { throw "Python executable not found. Set PYTHON to a valid path." }

$arguments = @(
  $captureScript,
  "--event-id", $EventId,
  "--match-id", $MatchId,
  "--expected-home", $ExpectedHomeTeam,
  "--expected-away", $ExpectedAwayTeam,
  "--snapshot-type", $SnapshotType,
  "--bookmaker", $Bookmaker,
  "--output-root", $OutputRoot
)
if ($ChromePath) { $arguments += @("--chrome-path", $ChromePath) }

& $python @arguments
if ($LASTEXITCODE -ne 0) { throw "ESPN market capture rejected. Review the JSON reason above." }
