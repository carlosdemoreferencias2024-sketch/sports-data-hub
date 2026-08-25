import assert from "node:assert/strict";
import { selectOperationalFocusRows } from "../dist/trading/clean-sample-queue.js";
import { buildCandidateQueueRow } from "../dist/trading/operational-window-orchestrator.js";
import { getManualVerifiedSource } from "../dist/trading/source-registry.js";

const rows = [
  { match_id: "nfl-a", sport: "american_football", action: "RUN_NFL_NEAR_START_NOW", minutes_until_start: 42, focus_score: 95 },
  { match_id: "nfl-b", sport: "american_football", action: "RUN_NFL_NEAR_START_NOW", minutes_until_start: 41, focus_score: 85 },
  { match_id: "nfl-closing", sport: "american_football", action: "CAPTURE_CLOSING_NOW", minutes_until_start: 7, focus_score: 80 },
  { match_id: "nfl-started", sport: "american_football", action: "POST_KICKOFF_AUDIT_ONLY", minutes_until_start: -1, focus_score: 100 }
];

const focus = selectOperationalFocusRows(rows);
assert.deepEqual(focus.map((row) => row.match_id), ["nfl-a", "nfl-closing"]);
assert.equal(focus.filter((row) => row.sport === "american_football" && row.minutes_until_start > 20).length, 1);

const candidate = buildCandidateQueueRow({
  match_id: "nfl-a",
  sport: "american_football",
  league: "nfl",
  match: "Away @ Home",
  kickoff: "2026-09-11T00:20:00.000Z",
  minutes_until_start: 42,
  action: "GENERATE_NFL_FAIR_ODDS",
  next_step: "Generate auditable NFL fair odds."
});
assert.equal(candidate.status, "PREPARE_CANDIDATE");
assert.equal(candidate.ticket_id, null);
assert.equal(candidate.preflight_status, "NOT_RUN");
assert.ok(candidate.missing.includes("fair_odds"));
assert.ok(candidate.missing.includes("candidate_preflight"));
assert.equal(getManualVerifiedSource("nfl_inactives_manual_verified")?.auto_scrape_allowed, false);

console.log("NFL operational contract tests ok");
