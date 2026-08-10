param(
  [string]$ApiKey = $(if ($env:THE_ODDS_API_KEY) { $env:THE_ODDS_API_KEY } else { $env:ODDS_API_KEY }),
  [string]$Group = "Soccer,Baseball",
  [switch]$All
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Invoke-OddsApiJson([string]$Uri) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    $body = & curl.exe -sS --connect-timeout 30 $Uri 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "THE_ODDS_API_CURL_FAILED exit=$LASTEXITCODE detail=$body"
    }
    return $body | ConvertFrom-Json
  }
  return Invoke-RestMethod -Method Get -Uri $Uri -TimeoutSec 30
}

if (-not $ApiKey) {
  throw "THE_ODDS_API_KEY no esta definido. Exportalo o pasalo con -ApiKey."
}

$uri = "https://api.the-odds-api.com/v4/sports/?apiKey=$([uri]::EscapeDataString($ApiKey))"
if ($All) { $uri += "&all=true" }

$sports = Invoke-OddsApiJson $uri
$groups = $Group.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }

$sports |
  Where-Object { $groups -contains $_.group -or $_.key -eq "baseball_mlb" } |
  Sort-Object group,title |
  Select-Object key,group,title,active,has_outrights |
  ConvertTo-Json -Depth 6
