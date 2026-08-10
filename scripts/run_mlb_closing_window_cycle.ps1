param(
  [string]$Date = (Get-Date).ToString("yyyy-MM-dd"),
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runner = Join-Path $PSScriptRoot "run_auto_mlb_real_paper.ps1"
if (-not (Test-Path -LiteralPath $runner)) { throw "No existe $runner" }

$arguments = @("-Date", $Date, "-ForceClosing")
if ($DryRun) { $arguments += "-DryRun" }

Write-Host "[mlb-closing-window-cycle] checking date=$Date dry_run=$DryRun"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner @arguments
exit $LASTEXITCODE
