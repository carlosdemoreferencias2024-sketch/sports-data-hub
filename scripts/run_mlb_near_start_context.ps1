param(
  [string]$ModelName = "carlos_v1_mlb",
  [string]$OutputDir = "workers",
  [switch]$Apply,
  [switch]$Strict,
  [switch]$NoHydrateSnapshots,
  [double]$SleepSeconds = 0.05
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
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
  & (Join-Path $PSScriptRoot "run_mlb_matchup_features.ps1") -Mode GenerateTemplate -OutputPath $templatePath
  if ($LASTEXITCODE -ne 0) {
    throw "template generation failed with exit code $LASTEXITCODE"
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
  & docker @fillArgs
  if ($LASTEXITCODE -ne 0) {
    throw "MLB Stats API fill failed with exit code $LASTEXITCODE"
  }

  Write-Host "[mlb-near-start] Step 3/3 hydrate feature_set apply=$Apply strict=$Strict"
  $hydrateParams = @{
    Mode = "Hydrate"
    InputPath = $filledPath
    ModelName = $ModelName
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
