# Prospective Validation Cohort v1

This cohort is derived from the immutable forecast chain. It does not store a
second mutable sample classification.

## Sample classes

- `REPLAY_RESEARCH`: historical replay, never operational.
- `PROSPECTIVE_INCOMPLETE`: preregistered forward observation missing at least
  one strict chain or event-time requirement.
- `PROSPECTIVE_CLEAN`: complete prospective chain with pre-kickoff prediction,
  entry, context and closing; verified Preflight PASS; explicit SHADOW ticket;
  settlement; CLV; and a valid append-only assessment.

Only `forecast_operational_metrics_dataset_v1` may feed Operational Brier,
Operational CLV, Operational ROI or readiness calculations. Research uses
`forecast_replay_research_dataset_v1`.

## Temporal rules

The prediction/model quote, entry capture and import, context as-of and import,
and closing capture and import must all precede kickoff. A capture imported
after kickoff is not clean even if its source timestamp falls in the window.

## Liga MX

Liga MX remains `RESEARCH=true`, `SHADOW=true`, `PAPER=false`, `REAL=false`.
This restriction remains until prospective calibration is supported by a useful
clean sample. Global real money, Kelly, Telegram automation and autopost remain
disabled and the kill switch remains enabled.

## Milestones

- 20: initial pipeline-error signal.
- 50: stability review.
- 100: calibration review.
- 250: segment-level analysis.

Run the report after building and applying migration 064:

```powershell
npm run report:prospective-validation
```
