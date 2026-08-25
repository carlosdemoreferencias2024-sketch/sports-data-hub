param(
  [string]$ModelName = "carlos_v1_mlb",
  [string]$OutputDir = "workers",
  [string]$RepoRoot = "",
  [switch]$Apply,
  [switch]$Strict,
  [switch]$Force,
  [switch]$NoHydrateSnapshots,
  [double]$SleepSeconds = 0.05
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = if ($RepoRoot) { Resolve-Path -LiteralPath $RepoRoot } else { Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..") }

function Invoke-DockerCommand([string[]]$Arguments) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & docker @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  foreach ($line in @($output)) { Write-Host $line }
  return $exitCode
}

Push-Location $repoRoot
try {
  $resolvedOutputDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDir)
  if (-not (Test-Path -LiteralPath $resolvedOutputDir)) {
    New-Item -ItemType Directory -Path $resolvedOutputDir | Out-Null
  }

  $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
  $templatePath = Join-Path $resolvedOutputDir "mlb_matchup_features_near_start_template_$stamp.csv"
  $filledPath = Join-Path $resolvedOutputDir "mlb_matchup_features_near_start_filled_$stamp.csv"
  $templateName = Split-Path -Leaf $templatePath
  $filledName = Split-Path -Leaf $filledPath

  Write-Host "[mlb-near-start] Step 1/3 generate active MLB template -> $templatePath"
  & (Join-Path $PSScriptRoot "run_mlb_matchup_features.ps1") -Mode GenerateTemplate -OutputPath $templatePath -RepoRoot $repoRoot
  if ($LASTEXITCODE -ne 0) {
    throw "template generation failed with exit code $LASTEXITCODE"
  }

  $nowUtc = [DateTimeOffset]::UtcNow
  $templateRows = @(Import-Csv -LiteralPath $templatePath)
  $windowRows = @($templateRows | Where-Object {
    if ([string]::IsNullOrWhiteSpace([string]$_.kickoff)) { return $false }
    try {
      $minutesToStart = ([DateTimeOffset]::Parse([string]$_.kickoff).ToUniversalTime() - $nowUtc).TotalMinutes
      return (($minutesToStart -ge 60 -and $minutesToStart -le 90) -or ($minutesToStart -ge 20 -and $minutesToStart -le 45))
    } catch {
      return $false
    }
  })
  if (-not $Force -and $windowRows.Count -eq 0) {
    Write-Host "[mlb-near-start] SKIP: no games inside 90-60 or 45-20 minute windows."
    Write-Host "[mlb-near-start] guardrails: REAL_CANDIDATE=0 real_money=false kelly=false telegram_auto=false"
    return
  }
  if (-not $Force) {
    $windowRows | Export-Csv -LiteralPath $templatePath -NoTypeInformation -Encoding UTF8
    Write-Host "[mlb-near-start] window_games=$($windowRows.Count) total_active=$($templateRows.Count)"
  } else {
    Write-Host "[mlb-near-start] force=true total_active=$($templateRows.Count)"
  }

  Write-Host "[mlb-near-start] Step 2/3 fill verified MLB context -> $filledPath"
  $fillArgs = @(
    "compose", "--profile", "odds", "run", "--rm",
    "-v", "${resolvedOutputDir}:/workio",
    "odds-worker",
    "python", "fill_mlb_matchup_features_from_mlb_api.py",
    "--input", "/workio/$templateName",
    "--output", "/workio/$filledName",
    "--sleep-seconds", "$SleepSeconds"
  )
  if (-not $Strict) {
    $fillArgs += "--allow-partial"
  }
  $dockerExitCode = Invoke-DockerCommand $fillArgs
  if ($dockerExitCode -ne 0) {
    throw "MLB Stats API fill failed with exit code $dockerExitCode"
  }

  Write-Host "[mlb-near-start] Step 3/3 hydrate feature_set apply=$Apply strict=$Strict"
  $hydrateParams = @{
    Mode = "Hydrate"
    InputPath = $filledPath
    ModelName = $ModelName
    RepoRoot = $repoRoot
  }
  if ($Apply) {
    $hydrateParams.Apply = $true
  }
  if (-not $NoHydrateSnapshots) {
    $hydrateParams.HydrateSnapshots = $true
  }
  if (-not $Strict) {
    $hydrateParams.AllowPartial = $true
  }
  & (Join-Path $PSScriptRoot "run_mlb_matchup_features.ps1") @hydrateParams
  if ($LASTEXITCODE -ne 0) {
    throw "feature hydration failed with exit code $LASTEXITCODE"
  }

  Write-Host "[mlb-near-start] Done."
  Write-Host "[mlb-near-start] template=$templatePath"
  Write-Host "[mlb-near-start] filled=$filledPath"
  Write-Host "[mlb-near-start] dry_run=$(-not $Apply)"
  Write-Host "[mlb-near-start] guardrails: REAL_CANDIDATE=0 real_money=false kelly=false telegram_auto=false"
} finally {
  Pop-Location
}
