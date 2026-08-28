# Cut review: 2026-08-28

## Clock and publication

- Branch `repair/clean-chain-v1-stabilized` was published through backtest commit `a764939`.
- The wake-up stampede fix keeps `StartWhenAvailable=false` and staggers the scheduled cycles.
- API-Football remains at 0/100 calls with its reserve of 20 intact.
- The nine active Windows tasks were re-registered and validated as `Ready`; every task reports `LastTaskResult=0` with the intended interval and execution limit.
- The five obsolete tasks remain disabled.

## Clean Sample Queue and fair odds

The queue scanned 37 rows:

- 1 NFL focus already has owned fair odds and is waiting for entry/current evidence.
- 9 additional NFL games show `GENERATE_NFL_FAIR_ODDS`. This is expected because the NFL clock prices at most one focus per cycle.
- 19 trusted soccer fixtures show `GENERATE_OWNED_FAIR_ODDS`.
- 8 additional soccer fixtures have no quote because Calendar Trust is incomplete; they are not counted in `fair_odds_missing`.

A read-only soccer model dry-run over the 19 trusted fixtures produced this split:

- 8 priceable matches (16 1X2/DNB quotes): 6 ready and 2 observation-only.
- 11 blocked by `football_fair_odds_verified_form_insufficient`.

The soccer focus selected by the operational queue is Cruz Azul at Necaxa and its action is still `VERIFY_CALENDAR`. The one-focus policy therefore does not skip ahead to price another fixture. The 28/37 headline is not one cross-sport persistence defect: it is 19 soccer rows behind one-focus/calendar/history gates plus 9 non-focus NFL rows. MLB and NBA were not present in this date's queue.

## Backtest cohorts

The new runner separates cohorts that must not be conflated:

- `persisted`: model quotes actually stored before kickoff. This is the operationally auditable cohort.
- `ingested-time`: history that the hub had captured before each target kickoff.
- `event-time`: historical replay ordered by when games occurred. Most archive evidence was imported later, so this measures model behavior but does not claim operational availability.

Mixed 1X2 and two-way markets do not receive one global Brier score because their Brier scales differ. Metrics remain available per sport, league, model and market.

### Results of this cut

The persisted pre-kickoff cohort contains only 2 settled NFL quotes. It is too small for a model conclusion: accuracy 0.50, Brier 0.300233 and log loss 0.796895.

The event-time replay scanned 3,087 targets and scored 2,575:

| Segment | N | Accuracy | Brier | Log loss | Brier skill vs empirical |
| --- | ---: | ---: | ---: | ---: | ---: |
| NFL | 204 | 0.6716 | 0.2240 | 0.6396 | 0.1033 |
| NBA | 2,227 | 0.6731 | 0.2145 | 0.6190 | 0.1337 |
| La Liga | 70 | 0.5143 | 0.6007 | 1.0061 | 0.0387 |
| Liga MX | 47 | 0.4468 | 0.6407 | 1.0651 | 0.0265 |
| NWSL | 24 | 0.2917 | 0.6604 | 1.0853 | -0.0625 |

The ingested-time replay scored 0 targets. Requiring complete pre-kickoff context also scored 0 of 3,087 targets. The historical archive is suitable for model experiments but cannot yet prove the old matches were operationally available to the hub at their original cutoffs.
