import assert from "node:assert/strict";

import { selectOperationalFocusRows } from "../dist/trading/clean-sample-queue.js";
import { buildCandidateQueueRow } from "../dist/trading/operational-window-orchestrator.js";

const rows = [
  { match_id: "nba-a", sport: "basketball", action: "RUN_NBA_NEAR_START_NOW", minutes_until_start: 42, focus_score: 95 },
  { match_id: "nba-b", sport: "basketball", action: "RUN_NBA_NEAR_START_NOW", minutes_until_start: 41, focus_score: 85 },
  { match_id: "nba-closing", sport: "basketball", action: "CAPTURE_CLOSING_NOW", minutes_until_start: 7, focus_score: 80 },
  { match_id: "nba-started", sport: "basketball", action: "POST_KICKOFF_AUDIT_ONLY", minutes_until_start: -1, focus_score: 100 }
];

const focus = selectOperationalFocusRows(rows);
assert.deepEqual(focus.map((row) => row.match_id), ["nba-a", "nba-closing"]);
assert.equal(focus.filter((row) => row.sport === "basketball" && row.minutes_until_start > 20).length, 1);

const candidate = buildCandidateQueueRow({
  match_id: "nba-a",
  sport: "basketball",
  league: "nba",
  match: "Away @ Home",
  kickoff: "2026-10-20T23:00:00.000Z",
  minutes_until_start: 42,
  action: "GENERATE_NBA_FAIR_ODDS",
  next_step: "Generate auditable NBA fair odds."
});
assert.equal(candidate.status, "PREPARE_CANDIDATE");
assert.equal(candidate.ticket_id, null);
assert.equal(candidate.preflight_status, "NOT_RUN");
assert.ok(candidate.missing.includes("fair_odds"));
assert.ok(candidate.missing.includes("candidate_preflight"));

console.log("NBA operational contract tests ok");
