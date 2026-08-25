import assert from "node:assert/strict";
import { getCandidatePreflightStatus, runCandidatePreflight } from "../dist/trading/candidate-preflight-engine.js";
import { shadowCandidatePreflightPassed } from "../dist/trading/shadow-candidate-preflight-gate.js";

const matchId = "11111111-1111-4111-8111-111111111111";
const decisionAsOf = "2026-08-13T15:00:00.000Z";
const calls = [];
const db = {
  async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes("candidate_preflight(")) {
      return { rows: [{ id: "snapshot-1", match_id: matchId, verdict: "PASS", decision_as_of: decisionAsOf }] };
    }
    return { rows: [{ id: "snapshot-1", match_id: matchId, verdict: "PASS", hash_valid: true }] };
  }
};

const run = await runCandidatePreflight(db, { match_id: matchId, decision_as_of: decisionAsOf });
assert.equal(run.system_status, "CANDIDATE_PREFLIGHT_SAFE_V1");
assert.equal(run.eligible_for_shadow_ticket, true);
assert.equal(run.guardrails.real_money_enabled, false);
assert.equal(run.guardrails.real_candidate_count, 0);
assert.match(calls[0].sql, /candidate_preflight\(\$1::uuid, \$2::timestamptz\)/);
assert.deepEqual(calls[0].values, [matchId, decisionAsOf]);

const status = await getCandidatePreflightStatus(db, { match_id: matchId, date: "2026-08-13", sport: "football" });
assert.equal(status.passed, 1);
assert.equal(status.failed, 0);
assert.equal(status.scanned, 1);
assert.equal(status.sport, "soccer");
assert.equal(status.guardrails.kill_switch, true);
assert.match(calls[1].sql, /DISTINCT ON \(snapshot\.match_id\)/);
assert.match(calls[1].sql, /snapshot\.decision_as_of DESC/);

await assert.rejects(() => runCandidatePreflight(db, {}), /match_id_required/);
assert.equal(shadowCandidatePreflightPassed(undefined), false);
assert.equal(shadowCandidatePreflightPassed({ verdict: "FAIL", hash_valid: true }), false);
assert.equal(shadowCandidatePreflightPassed({ verdict: "PASS", hash_valid: false }), false);
assert.equal(shadowCandidatePreflightPassed({ verdict: "PASS", hash_valid: true }), true);
console.log("CANDIDATE_PREFLIGHT_ENGINE_OK");
