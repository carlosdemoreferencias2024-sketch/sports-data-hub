import assert from "node:assert/strict";
import { selectOperationalFocusRows } from "../dist/trading/clean-sample-queue.js";
import { buildCandidateQueueRow } from "../dist/trading/operational-window-orchestrator.js";

const rows = [
  { match_id: "soccer-a", sport: "soccer", action: "GENERATE_OWNED_FAIR_ODDS", minutes_until_start: 36, focus_score: 90 },
  { match_id: "soccer-b", sport: "soccer", action: "GENERATE_OWNED_FAIR_ODDS", minutes_until_start: 35, focus_score: 80 },
  { match_id: "mlb-a", sport: "baseball", action: "GENERATE_MODEL_FAIR_ODDS", minutes_until_start: 34, focus_score: 90 },
  { match_id: "soccer-closing", sport: "soccer", action: "CAPTURE_CLOSING_NOW", minutes_until_start: 7, focus_score: 75 },
  { match_id: "started", sport: "soccer", action: "POST_KICKOFF_AUDIT_ONLY", minutes_until_start: -1, focus_score: 100 }
];

const focus = selectOperationalFocusRows(rows);
assert.deepEqual(focus.map((row) => row.match_id), ["soccer-a", "mlb-a", "soccer-closing"]);
assert.equal(focus.filter((row) => row.sport === "soccer" && row.minutes_until_start > 20).length, 1);

const candidate = buildCandidateQueueRow({
  match_id: "soccer-a",
  sport: "soccer",
  league: "liga-mx",
  match: "Away @ Home",
  kickoff: "2026-08-20T20:00:00.000Z",
  minutes_until_start: 36,
  action: "GENERATE_OWNED_FAIR_ODDS",
  next_step: "Generate fair odds."
});
assert.equal(candidate.status, "PREPARE_CANDIDATE");
assert.equal(candidate.ticket_id, null);
assert.equal(candidate.preflight_status, "NOT_RUN");
assert.ok(candidate.missing.includes("fair_odds"));
assert.ok(candidate.missing.includes("candidate_preflight"));

console.log("football operational contract tests ok");
