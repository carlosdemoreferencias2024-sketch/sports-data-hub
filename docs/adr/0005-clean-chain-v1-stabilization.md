# ADR 0005: Clean Chain v1 stabilization

## Status

Accepted on 2026-08-10 for shadow/paper operation only.

## Decision

The system must not count a sample as clean unless the full chain is present:

1. Fresh pregame entry/current snapshot from an allowed source.
2. `evidence_id` and `screenshot_sha256` for entry and closing.
3. Closing captured between kickoff minus 10 and minus 3 minutes.
4. `closing_quality=CAPTURED_ON_TIME` and no entry-as-closing fallback.
5. Verified final result, final settlement, and valid CLV.
6. Canonical match with legacy and duplicate rows excluded.

The real-money gate remains blocked until MLB reaches 150 clean v2 samples and
football reaches 50 clean samples, followed by favorable clean CLV and ROI
confidence checks.

## Stabilized components

- Entry and closing integrity policy in TypeScript and Python.
- Clean Sample Queue and Clean Chain Progress dashboard card.
- Odds Snapshot Cache and Source Capture Assistant evidence flow.
- Closing Window Watch, Closing Capture Draft, and Operational Alerts.
- Settlement guards, duplicate exclusion, and legacy-only reporting.
- Safety Suite, E2E clean-chain coverage, and Python integrity tests.
- Backup, scheduled safe-operation scripts, and deployment documentation.

## Runtime artifacts

Date-stamped JSON captures and generated safety reports are runtime evidence,
not source code. They remain local and are ignored by Git. Reusable
`*.template.json` files remain versionable.

## Verification

- TypeScript build: pass.
- Safety Suite: pass.
- Clean-chain E2E: pass.
- Python integrity tests: 13 pass.
- Docker engine build and health: pass.
- Dashboard `/dashboard/trading`: HTTP 200.
- PostgreSQL custom-format backup: structurally readable by `pg_restore`.

## Guardrails

- `REAL_CANDIDATE=0`
- Real money OFF
- Kelly OFF
- Telegram automatic picks OFF
- Autopost OFF
- Kill switch ON

This ADR does not authorize real-money betting.
