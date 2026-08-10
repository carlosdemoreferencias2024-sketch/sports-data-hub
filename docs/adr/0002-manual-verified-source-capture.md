# ADR 0002: Manual Verified Source Capture Only

## Status

Accepted.

## Decision

Source Capture Assistant can create evidence and draft JSON, but it cannot automatically post manual_verified payloads or create picks.

## Context

The current bottleneck is not model intelligence. The bottleneck is verified reality: market quotes, closing odds, lineups, goalkeepers, pitchers, and final results captured in the right window with traceability.

## Consequences

- Every capture requires source_url, captured_at, verified_by, and confidence metadata.
- Evidence can include screenshot_sha256 and evidence_path.
- Flashscore and 365Scores remain context-only and cannot provide closing odds.
- MLB official sources remain sports-data-only and cannot provide odds.
- The assistant helps the operator move faster without becoming a scraper or autobet system.
