# Soccer Poisson Walk-Forward Backtest

This runner evaluates only completed soccer fixtures from PostgreSQL. It is a
research diagnostic and cannot authorize SHADOW or REAL activity.

## Integrity rules

- Reads `v_valid_matches` joined to `forecast_matches`.
- Requires `forecast_matches.sport_slug = 'soccer'`.
- Uses canonical `match_competitors.team_id` identifiers.
- Deduplicates by league, canonical competitors, and kickoff.
- Excludes duplicate groups whose final scores conflict.
- Trains each prediction only with same-league matches whose kickoff is earlier
  than the target kickoff and whose final result was already persisted.
- Reports the latest training kickoff and result-availability timestamp for every
  prediction so temporal integrity is auditable. Overlapping games cannot train
  one another merely because their kickoff differs.
- Distinguishes insufficient prior fixtures from prior results that were not yet
  available at the prediction cutoff.
- Runs inside a read-only transaction and labels every report
  `REPLAY_RESEARCH`.

## Commands

Build and run the unit checks:

```powershell
npm --prefix backend run build
npm --prefix backend run test:soccer-poisson-walk-forward
```

Run the strict report. `--to` is exclusive and the default minimum is 20 prior
matches in the same league:

```powershell
npm --prefix backend run backtest:soccer-poisson-walk-forward -- `
  --from 2026-08-01T00:00:00Z `
  --to 2026-09-03T00:00:00Z
```

For pipeline diagnosis only, the minimum can be lowered. A report produced this
way remains exploratory:

```powershell
npm --prefix backend run backtest:soccer-poisson-walk-forward -- `
  --from 2026-08-01T00:00:00Z `
  --to 2026-09-03T00:00:00Z `
  --league mls `
  --min-training-matches 3
```

The current database is expected to produce no strict evaluation until enough
finished, canonically linked soccer history accumulates. Do not lower the
threshold to present model quality; use the diagnostic mode only to verify the
walk-forward mechanics.
