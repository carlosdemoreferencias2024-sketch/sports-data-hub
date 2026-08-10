# Sports Trading Bot Operating Rules

This document is the local memory for the sports-data-hub trading workflow. It is documentation only. It must not choose picks, write market quotes, run settlement, or promote tickets.

## Hard Guardrails

- REAL_CANDIDATE must remain 0.
- Real money stays OFF.
- Kelly staking stays OFF.
- Telegram automatic sending stays OFF.
- Kill switch stays ON.
- No autobet.
- No autopost from Source Capture Assistant.
- No fake odds, fake lineups, fake results, or fake closing snapshots.
- No settlement without a verified final result.
- No CLV or segment decision from closing unless closing_quality is CAPTURED_ON_TIME.

## Source Rules

- Sportsbook/bookmaker/SportsDataIO manual verified sources can provide current_odds and closing_odds.
- Flashscore and 365Scores are context-only sources. They can help with lineup, goalkeeper, result, or match_status, but not market odds.
- MLB official and MLB Stats sources are official sports-data sources. They can help with game status, boxscore, result, pitchers, and lineups, but not odds.
- Every manual capture should preserve source_url, captured_at, verified_by, confidence_score, and evidence when available.

## Football Flow

Football remains CALIBRATING until the model earns promotion through clean shadow data.

Required chain:

Universe -> Owned Fair Odds -> Market Quote -> EV -> CALIBRATING/Shadow -> Near-start XI/goalkeeper/context -> CAPTURED_ON_TIME closing -> Verified result -> Settlement -> CLV -> Segments -> Decision.

Football cannot become confirmed paper while model_label or calibration_state is UNCALIBRATED_PRIOR or CALIBRATING.

## MLB Flow

MLB confirmation requires moneyline-only discipline and complete near-start context.

Required chain:

Fixture -> Pitchers -> Pitcher stats -> Lineups -> Batting order -> Bullpen -> Park/weather -> Market odds -> Fair odds/EV -> CAPTURED_ON_TIME closing -> Settlement -> CLV.

Run line and totals remain analysis-only unless explicitly unlocked later.

## Window Rules

- Football closing window: 10 to 3 minutes before kickoff.
- MLB closing window: 10 to 3 minutes before first pitch.
- Before the window, prepare draft and source evidence only.
- During CAPTURE_CLOSING_NOW, capture visible odds, source, timestamp, and verifier.
- After kickoff/first pitch, mark POST_KICKOFF_AUDIT_ONLY. Do not rescue as pregame.

## Role Of Memory

Memory is a guide rail, not a decision engine. It may remind the operator what the system rules are. It must not:

- Select picks.
- Modify model probabilities.
- Write market_quotes.
- Write paper_trades.
- Run settlement.
- Promote paper or real candidates.
- Override dashboard guardrails.

## Daily Safety Gate

Before using a slate operationally, run the safety suite from the backend folder:

```powershell
npm run test:safety
```

If npm is not available in PowerShell, run from the project root:

```powershell
scripts\run_safety_suite.cmd
```

Passing the safety suite means the system guardrails are intact. It does not mean there is a bet. Picks still require verified market odds, context, CAPTURED_ON_TIME closing, settlement, CLV, and sample discipline.
