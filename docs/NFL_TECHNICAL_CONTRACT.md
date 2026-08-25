# NFL Technical Contract

## Scope

NFL is an independent lane. ESPN Site API provides schedule, canonical event identity, status, venue, weather and injury observations. It is not treated as a formal entry or closing capture, and its market fields remain audit-only.

## Candidate chain

1. Trusted event identity and exact kickoff.
2. Auditable owned fair odds for one supported market; market prices cannot be model inputs.
3. Formal entry/current evidence with bookmaker, both sides, timestamp, screenshot or provider artifact, and SHA-256.
4. Near-start context between 90 and 20 minutes: official inactives, confirmed starting quarterbacks, injury impact, venue and weather.
5. Candidate Preflight `PASS` with a valid append-only snapshot hash.
6. At most one PAPER/SHADOW ticket. Never real.
7. Closing between 10 and 3 minutes with `CAPTURED_ON_TIME`.
8. Verified result, settlement and CLV.

Missing inactives or quarterbacks keeps context incomplete. ESPN injury designations do not silently count as official inactives. No pregame record can be repaired after kickoff.

## Owned fair odds v1

- Model: `sports_data_hub_nfl_fair_odds_v1` / `elo_margin_recency_logit_v1`.
- Market: `moneyline_2way`; no draw and no spread/total inference.
- Inputs: up to 12 completed results per team, score margin, venue, recency, competition type and result-derived Elo.
- Minimum: eight verified results per team, source confidence at least 90 and a formal SHA-256 for every selected game.
- Leakage guard: `played_at`, `captured_at` and `feature_as_of` must all be valid before `decision_as_of`.
- Independence: bookmaker moneylines, spreads, totals and consensus prices are forbidden model inputs.
- Preseason: historical preseason games receive lower weight; preseason targets shrink toward 50% and confidence is capped at 0.62.
- Audit: artifact/config SHA-256, immutable model version, training cutoff, selected match IDs, evidence hashes, input snapshot hash and output hash are stored with every quote.
- Publication: append-only and idempotent for the same artifact plus input snapshot. Quotes remain uncalibrated prospective shadow and cannot promote real money.

Historical backfill uses ESPN final scores only. Full event JSON is persisted as evidence; market fields are not copied into model feature rows.

## Clock

- `SportsDataHubNflCalendar`: every 30 minutes, today plus tomorrow, then fair-odds generation for at most the queue's single NFL focus when due.
- `SportsDataHubNflNearStart`: every 5 minutes.
- `SportsDataHubClosingWatch`: shared read-only alerting, while captures remain sport-specific.

All jobs run through hidden `wscript.exe` launchers from `C:\Users\tsacl\Documents\SportsDataHubRuntime`. A failure in NFL cannot stop football or MLB.

## Guardrails

`REAL_CANDIDATE=0`; real money, Kelly, Telegram auto and autopost remain off. Kill switch remains on.
