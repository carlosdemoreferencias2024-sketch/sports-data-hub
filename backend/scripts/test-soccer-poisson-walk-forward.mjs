import assert from "node:assert/strict";
import { runSoccerPoissonWalkForwardBacktest } from "../dist/trading/soccer-poisson-walk-forward.js";

const rows = [
  ["m1", "2026-08-01T18:00:00Z", "a", "b", 2, 0, 2, 1],
  ["m2", "2026-08-02T18:00:00Z", "c", "d", 1, 1, 1, 1],
  ["m3", "2026-08-03T18:00:00Z", "a", "c", 0, 1, 1, 1],
  ["m4", "2026-08-04T18:00:00Z", "b", "d", 3, 2, 1, 1],
  ["m5", "2026-08-05T18:00:00Z", "a", "d", 1, 0, 1, 1],
  ["bad", "2026-08-06T18:00:00Z", "b", "c", 2, 1, 2, 2]
].map(([matchId, kickoff, homeId, awayId, homeScore, awayScore, duplicateCount, resultVariants]) => ({
  match_id: matchId,
  league_slug: "mls",
  kickoff,
  home_team_id: homeId,
  away_team_id: awayId,
  home_team: `Team ${homeId}`,
  away_team: `Team ${awayId}`,
  home_score: homeScore,
  away_score: awayScore,
  result_available_at: new Date(new Date(kickoff).getTime() + 2 * 60 * 60 * 1000).toISOString(),
  duplicate_count: duplicateCount,
  result_variants: resultVariants
}));

const seen = { sql: "", values: [] };
const db = {
  async query(sql, values) {
    seen.sql = sql;
    seen.values = values;
    return { rows };
  }
};

const report = await runSoccerPoissonWalkForwardBacktest(db, {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-09-01T00:00:00.000Z",
  minTrainingMatches: 2,
  priorMatches: 3
});

assert.match(seen.sql, /fm\.sport_slug = 'soccer'/);
assert.match(seen.sql, /match_competitors/);
assert.match(seen.sql, /COUNT\(DISTINCT \(home_score, away_score\)\)/);
assert.match(seen.sql, /MIN\(updated_at\) AS result_available_at/);
assert.match(seen.sql, /ROW_NUMBER\(\) OVER/);
assert.deepEqual(seen.values.slice(0, 3), [
  "2026-08-01T00:00:00.000Z",
  "2026-09-01T00:00:00.000Z",
  null
]);
assert.equal(report.sample_class, "REPLAY_RESEARCH");
assert.equal(report.operational_eligible, false);
assert.equal(report.real_money_eligible, false);
assert.equal(report.status, "EXPLORATORY_ONLY");
assert.equal(report.cohort.raw_rows, 8);
assert.equal(report.cohort.deduplicated_groups, 6);
assert.equal(report.cohort.unique_matches, 5);
assert.equal(report.cohort.duplicate_rows_excluded, 2);
assert.equal(report.cohort.conflicting_result_groups_excluded, 1);
assert.equal(report.cohort.evaluated_matches, 3);
assert.equal(report.cohort.result_availability_blocks, 0);
assert.equal(report.conflicting_groups[0].match_id, "bad");

for (const prediction of report.predictions) {
  assert.ok(prediction.training_max_kickoff < prediction.kickoff);
  assert.ok(prediction.training_max_result_available_at < prediction.kickoff);
  const probabilitySum = Object.values(prediction.probabilities).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(probabilitySum - 1) < 0.00001);
}

const strictReport = await runSoccerPoissonWalkForwardBacktest(db, {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-09-01T00:00:00.000Z"
});
assert.equal(strictReport.status, "INSUFFICIENT_HISTORY");
assert.equal(strictReport.cohort.evaluated_matches, 0);
assert.equal(strictReport.model.sample_size, 0);

const overlappingRows = rows.map((row) => ({ ...row }));
overlappingRows[0].result_available_at = "2026-08-05T20:00:00.000Z";
overlappingRows[1].result_available_at = "2026-08-05T20:00:00.000Z";
const availabilityReport = await runSoccerPoissonWalkForwardBacktest({
  async query() {
    return { rows: overlappingRows };
  }
}, {
  from: "2026-08-01T00:00:00.000Z",
  to: "2026-09-01T00:00:00.000Z",
  minTrainingMatches: 2
});
assert.equal(availabilityReport.predictions[0].match_id, "m5");
assert.equal(availabilityReport.predictions[0].training_matches, 2);
assert.ok(availabilityReport.skipped.some((row) => (
  row.match_id === "m3"
  && row.training_matches === 0
  && row.reason === "PRIOR_RESULTS_NOT_AVAILABLE_AS_OF"
)));

process.stdout.write("soccer-poisson-walk-forward tests passed\n");
