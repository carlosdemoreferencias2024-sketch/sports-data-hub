# NBA Technical Contract

## Scope

- League: NBA.
- Market: two-way moneyline.
- Mode: PAPER/SHADOW only.
- Maximum focus: one match per operational window.
- Real money, Kelly, Telegram auto and autopost remain disabled. Kill switch remains enabled.

## Historical Evidence

- Primary historical source: ESPN NBA site API.
- Every completed event is stored with its canonical raw JSON and SHA-256.
- Each team observation records points for/against, venue, rest, competition type and deterministic result Elo.
- Minimum source confidence is 90; the current ESPN backfill assigns 95.
- Observations captured after `decision_as_of`, without valid SHA-256, or played after the decision timestamp are rejected.
- Bookmaker prices, spreads, totals and consensus lines are never model inputs.

## Owned Fair Odds V1

- Model family: `elo_margin_rest_recency_logit_v1`.
- Feature schema: `nba_results_elo_margin_rest_v1`.
- Maximum history: 20 games per team; minimum: 12.
- Signals: recency-weighted neutral score margin, deterministic Elo, target rest edge and scoring environment.
- Preseason results are downweighted and preseason targets are shrunk toward 50% with confidence capped at 0.62.
- Output includes probabilities, decimal fair odds, projected margin, confidence, uncertainty, training cutoff and immutable input/output hashes.

## Persistence And Gates

- Model versions are registered by artifact SHA-256, configuration SHA-256 and training cutoff.
- `model_quotes` is append-only and idempotent for the same artifact and input snapshot.
- The forecast match is registered before quote publication.
- Candidate Preflight must pass before any paper/shadow ticket is created.
- Entry/current odds require provider, two moneylines, timestamp, screenshot or raw payload hash, and evidence ID.
- Closing must be captured in the 10-to-3-minute window and marked `CAPTURED_ON_TIME`.

## Calendar And Near-Start

- `nba_scraper.py` captures the ESPN NBA scoreboard for today and tomorrow and stores canonical raw JSON plus SHA-256 before normalization.
- Near-start summary capture runs only while the event is still pre-tipoff and no more than 180 minutes away.
- An injury report is present only when ESPN returns a team group for both participants; an empty group is valid evidence of zero listed injuries.
- A starting lineup is confirmed only when ESPN publishes exactly five distinct `starter=true` athletes for each team. Projected or inferred starters never satisfy this gate.
- Workload context is derived from the prior six scoreboard days: hours since the previous game, back-to-back, third game in four days and fourth game in six days.
- Schedule-derived workload is explicitly marked as inference. A player rest designation is official only when the provider injury payload itself contains a rest designation.
- Complete NBA context requires the injury report, five confirmed starters per team, workload context, a valid provider SHA-256 and a capture timestamp before tipoff.
- Captures made at or after tipoff remain `POST_TIPOFF_AUDIT_ONLY` and cannot be rescued into pregame context.
- ESPN odds present in scoreboard JSON are retained only as audit observations. They are not formal entry evidence and are not model inputs.

## Clock

- `SportsDataHubNbaCalendar` runs every 30 minutes through hidden `wscript.exe`, captures today and tomorrow, then invokes owned fair odds when due.
- `SportsDataHubNbaNearStart` runs every 5 minutes through hidden `wscript.exe` and refreshes injuries, official starters and workload.
- The queue selects at most one NBA focus per operational window and emits `RUN_NBA_NEAR_START_NOW` when appropriate.
- The former standalone `SportsDataHubNbaFairOdds` task remains disabled to avoid duplicate runs.
- No started game is rescued and neither task creates a ticket.
