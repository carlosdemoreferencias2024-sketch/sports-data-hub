param(
  [Parameter(Mandatory = $true)]
  [string]$AlphaId,

  [bool]$Processed = $true,
  [string]$Note = "manual_process",
  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $env:INTERNAL_API_KEY
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

$body = @{
  processed = $Processed
  note = $Note
} | ConvertTo-Json -Depth 4

$response = Invoke-RestMethod `
  -Method Patch `
  -Uri "$HubBaseUrl/api/v1/internal/model-quotes/alpha-opportunities/$AlphaId/process" `
  -Headers @{ "X-Internal-API-Key" = $InternalApiKey } `
  -ContentType "application/json" `
  -Body $body

$response | ConvertTo-Json -Depth 8
