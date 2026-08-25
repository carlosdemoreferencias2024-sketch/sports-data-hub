param(
  [switch]$Strict
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$expected = @{
  SportsDataHubFootballCalendar = @{ interval = "PT30M"; limit = "PT12M" }
  SportsDataHubFootballContext = @{ interval = "PT15M"; limit = "PT10M" }
  SportsDataHubFootballNearStart = @{ interval = "PT5M"; limit = "PT5M" }
  SportsDataHubMlbNearStart = @{ interval = "PT5M"; limit = "PT4M" }
  SportsDataHubClosingWatch = @{ interval = "PT2M"; limit = "PT10M" }
  SportsDataHubNflCalendar = @{ interval = "PT30M"; limit = "PT5M" }
  SportsDataHubNflNearStart = @{ interval = "PT5M"; limit = "PT4M" }
  SportsDataHubNbaCalendar = @{ interval = "PT30M"; limit = "PT6M" }
  SportsDataHubNbaNearStart = @{ interval = "PT5M"; limit = "PT5M" }
}
$obsolete = @("SportsDataHubContextRefresh", "SportsDataHubSafeOpsCycle", "SportsDataHubMlbClosingWindow", "SportsDataHubNearStart", "SportsDataHubNbaFairOdds")
$rows = foreach ($name in $expected.Keys | Sort-Object) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    [pscustomobject]@{ task=$name; exists=$false; enabled=$false; state="MISSING"; last_task_result=$null; interval_ok=$false; limit_ok=$false; hidden_launcher=$false; healthy=$false }
    continue
  }
  $info = Get-ScheduledTaskInfo -TaskName $name
  $interval = [string]$task.Triggers[0].Repetition.Interval
  $limit = [string]$task.Settings.ExecutionTimeLimit
  $overLimit = $task.State -eq "Running" -and $info.LastRunTime -and ((Get-Date) - $info.LastRunTime).TotalMinutes -gt [System.Xml.XmlConvert]::ToTimeSpan($expected[$name].limit).TotalMinutes
  $hiddenLauncher = [System.IO.Path]::GetFileName([string]$task.Actions[0].Execute).ToLowerInvariant() -eq "wscript.exe"
  $resultOk = $info.LastTaskResult -eq 0 -or ($task.State -eq "Running" -and $info.LastTaskResult -eq 267009)
  [pscustomobject]@{
    task=$name
    exists=$true
    enabled=$task.State -ne "Disabled"
    state=[string]$task.State
    last_run_time=$info.LastRunTime
    next_run_time=$info.NextRunTime
    last_task_result=$info.LastTaskResult
    interval=$interval
    execution_limit=$limit
    interval_ok=$interval -eq $expected[$name].interval
    limit_ok=$limit -eq $expected[$name].limit
    over_limit=$overLimit
    hidden_launcher=$hiddenLauncher
    healthy=($task.State -ne "Disabled" -and $resultOk -and $interval -eq $expected[$name].interval -and $limit -eq $expected[$name].limit -and $hiddenLauncher -and -not $overLimit)
  }
}
$legacy = foreach ($name in $obsolete) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  [pscustomobject]@{ task=$name; state=if($null -eq $task){"MISSING"}else{[string]$task.State}; safe=($null -eq $task -or $task.State -eq "Disabled") }
}
$ok = @($rows | Where-Object { -not $_.healthy }).Count -eq 0 -and @($legacy | Where-Object { -not $_.safe }).Count -eq 0
$result = [pscustomobject]@{
  system_status=if($ok){"MULTI_SPORT_CLOCK_HEALTHY"}else{"MULTI_SPORT_CLOCK_DEGRADED"}
  checked_at=(Get-Date).ToString("o")
  healthy=$ok
  tasks=@($rows)
  obsolete_tasks=@($legacy)
}
$result | ConvertTo-Json -Depth 8
if ($Strict -and -not $ok) { exit 1 }
