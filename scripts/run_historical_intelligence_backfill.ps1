param(
  [string]$InternalApiKey = $env:INTERNAL_API_KEY,
  [string]$BaseUrl = "http://127.0.0.1:4000",
  [ValidateSet("matches", "players", "rebuild")]
  [string]$Mode = "matches",
  [string]$InputPath = "",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "InternalApiKey is required. Pass -InternalApiKey or set INTERNAL_API_KEY."
}

$endpoint = switch ($Mode) {
  "matches" { "/api/v1/internal/analytics/ingest-historical-matches" }
  "players" { "/api/v1/internal/analytics/ingest-player-history" }
  "rebuild" { "/api/v1/internal/analytics/rebuild-historical-context" }
}

if ($InputPath) {
  if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "InputPath not found: $InputPath"
  }
  $payload = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
} else {
  $payload = [ordered]@{}
}

$payload | Add-Member -NotePropertyName dry_run -NotePropertyValue (-not $Apply.IsPresent) -Force
$json = $payload | ConvertTo-Json -Depth 80

Write-Host "[historical-intelligence] mode=$Mode dry_run=$(-not $Apply.IsPresent) endpoint=$endpoint"

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "$BaseUrl$endpoint" `
  -Headers @{ "X-API-Key" = $InternalApiKey } `
  -ContentType "application/json" `
  -Body $json

$response | ConvertTo-Json -Depth 80
