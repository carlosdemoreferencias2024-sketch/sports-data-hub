# Sports Research Worker

`sports-research-worker` is a safe data-collection orchestrator for `sports-data-hub`.

It does not create picks, does not enable real money, does not enable Kelly, and does not send Telegram alerts.

## What It Does

- Reads verified JSON payloads from `/research-payloads` and `/scripts`.
- Sends source observations to `source-observations`.
- Sends team/player/lineup context to `sports-context-ingest`.
- Sends historical matches to `ingest-historical-matches`.
- Runs `build-consensus` for affected matches.
- Keeps all guardrails checked on every cycle.

## Safety

Default mode is dry-run:

```powershell
scripts\run_sports_research_worker.cmd -Once
```

To apply data, two things are required:

1. Run with `-Apply`.
2. The JSON file must contain:

```json
{
  "research_worker_apply_allowed": true
}
```

Without that field, the worker blocks writes and keeps the file in dry-run.

## Start Service

```powershell
scripts\run_sports_research_worker.cmd
```

This starts the Docker service with profile `research`. It runs every 30 minutes by default.

## Apply One Verified Batch

```powershell
scripts\run_sports_research_worker.cmd -Once -Apply
```

Only files explicitly marked with `research_worker_apply_allowed=true` can write.

## Optional Windows Task

```powershell
scripts\install_sports_research_task.cmd
```

This installs a scheduled task that runs the worker periodically.

## Rule

The worker feeds intelligence. `sports-data-hub` remains the only decision engine.
