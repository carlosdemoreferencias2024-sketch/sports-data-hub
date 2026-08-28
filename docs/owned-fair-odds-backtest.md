# Owned fair odds backtest

This runner scores the hub's NFL, NBA and soccer fair-odds models without using market odds as model inputs.

Build first:

```powershell
npm --prefix backend run build
```

Operationally strict cohort (quotes actually persisted before kickoff):

```powershell
npm --prefix backend run backtest:owned-fair-odds -- --mode persisted --from 2025-01-01 --to 2026-08-29
```

Historical model replay by event time:

```powershell
npm --prefix backend run backtest:owned-fair-odds -- --mode event-time --sport all --from 2025-01-01 --to 2026-08-29
```

Strict historical availability replay:

```powershell
npm --prefix backend run backtest:owned-fair-odds -- --mode ingested-time --sport all --from 2025-01-01 --to 2026-08-29
```

Use `--require-context` to require a complete context snapshot captured before kickoff. Use `--league <slug>` to isolate one league and `--output <path>` to save the JSON report.

`event-time` is a model-quality experiment, not an operational availability claim: old source results were imported after many target fixtures. `persisted` is the cleanest operational cohort. The runner opens a read-only transaction and performs no writes.
