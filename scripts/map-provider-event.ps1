param(
  [Parameter(Mandatory = $true)]
  [string]$ProviderName,

  [Parameter(Mandatory = $true)]
  [string]$ProviderEventId,

  [Parameter(Mandatory = $true)]
  [string]$HubMatchId,

  [Parameter(Mandatory = $true)]
  [string]$HomeTeamName,

  [Parameter(Mandatory = $true)]
  [string]$AwayTeamName,

  [Parameter(Mandatory = $true)]
  [string]$Kickoff,

  [string]$HubBaseUrl = "http://127.0.0.1:4000",
  [string]$InternalApiKey = $env:INTERNAL_API_KEY
)

if (-not $InternalApiKey) {
  throw "INTERNAL_API_KEY no esta definido. Exportalo o pasalo con -InternalApiKey."
}

$body = @{
  hub_match_id = $HubMatchId
  provider_name = $ProviderName
  provider_event_id = $ProviderEventId
  home_team_name = $HomeTeamName
  away_team_name = $AwayTeamName
  kickoff = $Kickoff
  is_active = $true
  raw_data = @{
    source = "manual_cli"
    mapped_at = (Get-Date).ToUniversalTime().ToString("o")
  }
} | ConvertTo-Json -Depth 6

Invoke-RestMethod `
  -Method Post `
  -Uri "$HubBaseUrl/api/v1/internal/mappings" `
  -Headers @{ "X-Internal-API-Key" = $InternalApiKey } `
  -ContentType "application/json" `
  -Body $body
