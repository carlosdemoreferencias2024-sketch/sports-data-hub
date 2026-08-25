# Football Technical Contract

## Scope

The football lane covers MLS, Liga MX, NWSL, Brazil, Argentina, UEFA Champions League, Europa League, Conference League, Leagues Cup, Libertadores, Sudamericana, and the principal European leagues. It remains independent from MLB and future NFL/NBA lanes.

## Non-negotiable safety

- `REAL_CANDIDATE=0`; real money, Kelly, Telegram auto, and autopost remain off.
- The kill switch remains on.
- A failed football job cannot stop another sport lane.
- No pregame record may be created or repaired after kickoff.
- At most one focus is selected per sport and operational window.

## Data contract

Every source observation retains provider, source identifier, canonical match identity, observed timestamp, captured timestamp, raw payload, and a SHA-256 evidence hash. Official APIs or stable JSON/HTTP feeds are preferred; browser capture is a fallback for visible evidence, not the primary ingestion mechanism.

The football scraper selects only the first Clean Sample Queue focus. It imports completed ESPN schedule results as pre-kickoff model history, stages a complete DraftKings 1X2 capture with screenshot and SHA-256, and compares that unverified market against owned fair odds v3. Automatic captures remain `PENDING_HUMAN_VERIFICATION`; the clock may emit `PAPER_PICK_DRAFT_PENDING_EVIDENCE_VERIFICATION`, but it cannot register a ticket or claim human verification.

Team and player names resolve through canonical entities plus source aliases. Fixture identity and kickoff must be trusted before any operational window is opened.

## Candidate chain

The required chain is:

1. Auditable fair odds v3 generated before kickoff.
2. Formal entry/current market with bookmaker, all three 1X2 prices, timestamp, screenshot or raw evidence, and SHA-256.
3. Candidate Preflight append-only snapshot with a valid hash and `PASS` verdict.
4. At most one PAPER/SHADOW ticket. Never a real ticket.
5. Near-start context in the 90-60 or 45-20 minute window: official XI, goalkeepers, injuries, suspensions, and tie state where applicable.
6. Closing capture between 10 and 3 minutes before kickoff with `CAPTURED_ON_TIME`.
7. Verified final result, final settlement, valid CLV, and clean-v2 eligibility.

Missing any required stage blocks promotion. A post-kickoff import is audit-only forever.

## Clock contract

The active independent clock jobs are:

| Task | Interval | Limit |
| --- | ---: | ---: |
| SportsDataHubFootballCalendar | 30 min | 12 min |
| SportsDataHubFootballContext | 15 min | 10 min |
| SportsDataHubFootballNearStart | 5 min | 5 min |
| SportsDataHubMlbNearStart | 5 min | 4 min |
| SportsDataHubClosingWatch | 2 min | 10 min |
| SportsDataHubNflCalendar | 30 min | 5 min |
| SportsDataHubNflNearStart | 5 min | 4 min |
| SportsDataHubNbaCalendar | 30 min | 6 min |
| SportsDataHubNbaNearStart | 5 min | 5 min |

Entrypoints execute from `C:\Users\tsacl\Documents\SportsDataHubRuntime`. Legacy aggregate tasks remain disabled or absent. `scripts/get_dual_sport_clock_status.ps1 -Strict` is the acceptance check: every active task must exist, be enabled, match its interval and limit, have `LastTaskResult=0`, and not be over its execution limit.

## Acceptance gate

Football is operationally closed only when:

- TypeScript build and the full safety suite pass.
- The football operational contract test passes.
- All nine clock tasks pass strict validation through hidden launchers.
- Clean Sample Queue exposes no more than one football focus per window.
- Operational Window Queue exposes pre-ticket preparation instead of returning an empty queue.
- Candidate Preflight, evidence, near-start, closing, settlement, and clean-v2 gates remain fail-closed.

Sample targets are evidence goals, not launch gates: first 20 clean football records, then 50. NFL and NBA must reuse this contract through separate sport adapters and independent jobs.
