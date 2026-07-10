param(
  [double]$MinEv = 0.05,
  [int]$Limit = 20,
  [switch]$DryRun,
  [switch]$MarkProcessed,
  [string]$TelegramBotToken = $env:TELEGRAM_BOT_TOKEN,
  [string]$TelegramChatId = $env:TELEGRAM_CHAT_ID
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$argsList = @(
  "compose", "--profile", "odds", "exec", "-T"
)

if ($TelegramBotToken) {
  $argsList += @("-e", "TELEGRAM_BOT_TOKEN=$TelegramBotToken")
}
if ($TelegramChatId) {
  $argsList += @("-e", "TELEGRAM_CHAT_ID=$TelegramChatId")
}

$argsList += @(
  "odds-worker",
  "python", "webhook_notifier.py",
  "--min-ev", ([string]$MinEv),
  "--limit", ([string]$Limit)
)

if ($DryRun) {
  $argsList += "--dry-run"
}
if ($MarkProcessed) {
  $argsList += "--mark-processed"
}

Push-Location $repoRoot
try {
  & docker @argsList
  if ($LASTEXITCODE -ne 0) {
    throw "webhook_notifier.py fallo con exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
