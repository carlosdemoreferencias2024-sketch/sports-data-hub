# ADR 0004: CAPTURED_ON_TIME Required For CLV

## Status

Accepted.

## Decision

Only closing snapshots with closing_quality CAPTURED_ON_TIME can feed formal CLV, CLV+, segment decisions, or promotion analysis.

## Context

Closing odds captured too early, late, or after kickoff can silently contaminate CLV. The system must prefer missing CLV over dirty CLV.

## Consequences

- CAPTURED_TOO_EARLY, CAPTURED_LATE, MISSING_KICKOFF, INVALID_KICKOFF_TIMESTAMP, and INVALID_CAPTURE_TIMESTAMP are visible for audit but excluded from formal CLV.
- Settlement requires verified final result.
- Missed windows are operational misses, not betting losses.
- Backfills must be idempotent and preserve diagnostic provenance.
