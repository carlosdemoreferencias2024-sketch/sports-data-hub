param(
  [int]$Limit = 500,
  [switch]$DryRun,
  [switch]$RequireClosing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Push-Location $repoRoot
try {
  $settleArgs = @(
    "compose", "--profile", "odds", "exec", "-T",
    "odds-worker", "python", "settle_real_paper_snapshots.py",
    "--limit", ([string]$Limit)
  )
  if ($DryRun) {
    $settleArgs += "--dry-run"
  }
  if ($RequireClosing) {
    $settleArgs += "--require-closing"
  }
  & docker @settleArgs
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($exitCode -ne 0) {
  throw "settle_real_paper_snapshots.py fallo con exit code $exitCode"
}
