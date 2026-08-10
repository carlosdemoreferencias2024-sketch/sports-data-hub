param(
  [ValidateSet("GenerateTemplate", "Hydrate")]
  [string]$Mode = "GenerateTemplate",
  [string]$OutputPath = "workers\mlb_matchup_features_template.csv",
  [string]$InputPath,
  [string]$ModelName = "carlos_v1_mlb",
  [switch]$Apply,
  [switch]$HydrateSnapshots,
  [switch]$AllowPartial
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
Push-Location $repoRoot
try {
  if ($Mode -eq "GenerateTemplate") {
    $resolvedOutput = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
    $outputDir = Split-Path -Parent $resolvedOutput
    $outputName = Split-Path -Leaf $resolvedOutput
    if (-not (Test-Path -LiteralPath $outputDir)) {
      New-Item -ItemType Directory -Path $outputDir | Out-Null
    }

    Write-Host "[mlb-features] Generating template -> $resolvedOutput"
    $dockerArgs = @(
      "compose", "--profile", "odds", "run", "--rm",
      "-v", "${outputDir}:/io",
      "odds-worker",
      "python", "generate_mlb_matchup_template.py",
      "--output", "/io/$outputName"
    )
    & docker @dockerArgs
    if ($LASTEXITCODE -ne 0) {
      throw "docker compose run fallo con exit code $LASTEXITCODE"
    }
    return
  }

  if (-not $InputPath) {
    throw "InputPath es requerido cuando Mode=Hydrate."
  }

  $resolvedInput = Resolve-Path -LiteralPath $InputPath
  $inputDir = Split-Path -Parent $resolvedInput
  $inputName = Split-Path -Leaf $resolvedInput
  $hydrateArgs = @(
    "compose", "--profile", "odds", "run", "--rm",
    "-v", "${inputDir}:/input:ro",
    "odds-worker",
    "python", "hydrate_mlb_real_paper_features.py",
    "--input", "/input/$inputName",
    "--model-name", $ModelName
  )
  if ($Apply) {
    $hydrateArgs += "--apply"
  }
  if ($HydrateSnapshots) {
    $hydrateArgs += "--hydrate-snapshots"
  }
  if ($AllowPartial) {
    $hydrateArgs += "--allow-partial"
  }

  Write-Host "[mlb-features] Hydrating features input=$resolvedInput apply=$Apply hydrate_snapshots=$HydrateSnapshots allow_partial=$AllowPartial"
  & docker @hydrateArgs
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose run fallo con exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
