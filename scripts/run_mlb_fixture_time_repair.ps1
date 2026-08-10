param(
  [string]$Date = "",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $(if ($env:INTERNAL_API_KEY) { $env:INTERNAL_API_KEY } else { $env:SPORTS_DATA_HUB_INTERNAL_KEY }),
  [int]$Limit = 120,
  [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

$query = "limit=$Limit"
if ($Date) {
  $query = "$query&date=$([uri]::EscapeDataString($Date))"
}
if ($Apply) {
  $query = "$query&apply=true"
}

$url = "$HubBaseUrl/api/v1/internal/analytics/mlb/fixture-time-repair/run?$query"
$headers = @{
  "X-Internal-API-Key" = $InternalApiKey
  "X-API-Key" = $InternalApiKey
}

Write-Host "[mlb-fixture-time-repair] apply=$Apply url=$url"
$response = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType "application/json" -Body "{}"
$response | ConvertTo-Json -Depth 20
