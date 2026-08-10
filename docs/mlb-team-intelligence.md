# MLB Team Intelligence

This layer is read-only decision support for MLB Moneyline Real Paper. It does not activate real money, Kelly, Telegram automation, run lines, totals, or parlays.

## Flow

1. Generate the matchup template:

```powershell
scripts\run_mlb_matchup_features.cmd -Mode GenerateTemplate -OutputPath workers\mlb_matchup_features_template.csv
```

2. Fill only verified data:

- probable pitchers
- starter ERA / WHIP
- bullpen ERA
- lineup OPS / lineup confirmed
- rest days / travel distance
- source URL and verified timestamp

3. Dry-run hydration:

```powershell
scripts\run_mlb_matchup_features.cmd -Mode Hydrate -InputPath workers\mlb_matchup_features_template.csv
```

4. Apply only after the dry-run is clean:

```powershell
scripts\run_mlb_matchup_features.cmd -Mode Hydrate -InputPath workers\mlb_matchup_features_template.csv -Apply -HydrateSnapshots
```

## Dashboard Impact

`Team Intelligence` reads the latest `model_features` row per match and model. It improves Matchup Confirmation context, but the output remains review-only.

Football Liga MX / MLS / Mundial will use the same idea only after each league and market has enough closed sample.
