param(
  [string]$ContainerName = "data_hub_db",
  [string]$Database = $(if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "sports_db" }),
  [string]$User = $(if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "sports_admin" }),
  [string]$BackupDir = "",
  [int]$RetentionDays = 14,
  [switch]$SkipVerify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BackupDir)) {
  $BackupDir = Join-Path $RepoRoot "backups\postgres"
}

if (-not (Test-Path -LiteralPath $BackupDir)) {
  New-Item -ItemType Directory -Path $BackupDir | Out-Null
}

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$fileName = "${Database}_${stamp}.dump"
$localPath = Join-Path $BackupDir $fileName
$containerPath = "/tmp/$fileName"

Write-Host "[backup-postgres] container=$ContainerName database=$Database user=$User"
Write-Host "[backup-postgres] output=$localPath"

docker exec $ContainerName pg_dump -U $User -d $Database --format=custom --no-owner --no-privileges --file=$containerPath
if ($LASTEXITCODE -ne 0) {
  throw "pg_dump failed."
}

if (-not $SkipVerify) {
  docker exec $ContainerName pg_restore --list $containerPath | Out-Null
  if ($LASTEXITCODE -ne 0) {
    docker exec $ContainerName rm -f $containerPath | Out-Null
    throw "pg_restore verification failed."
  }
  Write-Host "[backup-postgres] verification=ok"
}

docker cp "${ContainerName}:$containerPath" $localPath
if ($LASTEXITCODE -ne 0) {
  docker exec $ContainerName rm -f $containerPath | Out-Null
  throw "docker cp failed."
}

docker exec $ContainerName rm -f $containerPath | Out-Null

$fileInfo = Get-Item -LiteralPath $localPath
Write-Host "[backup-postgres] created=$($fileInfo.FullName)"
Write-Host "[backup-postgres] size_mb=$([Math]::Round($fileInfo.Length / 1MB, 2))"

if ($RetentionDays -gt 0) {
  $cutoff = (Get-Date).AddDays(-1 * $RetentionDays)
  $oldBackups = Get-ChildItem -LiteralPath $BackupDir -Filter "*.dump" -File |
    Where-Object { $_.LastWriteTime -lt $cutoff }

  foreach ($old in $oldBackups) {
    Remove-Item -LiteralPath $old.FullName -Force
    Write-Host "[backup-postgres] pruned=$($old.Name)"
  }
}

Write-Host "[backup-postgres] done"
