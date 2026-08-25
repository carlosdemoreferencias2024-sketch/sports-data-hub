import assert from "node:assert/strict";
import {
  computeNbaFairOdds,
  NBA_FAIR_ODDS_CONFIG,
  nbaFairOddsArtifactSha256,
  nbaFairOddsConfigSha256
} from "../dist/trading/nba-fair-odds-model.js";

const dates = Array.from({ length: 20 }, (_, index) => {
  const date = new Date("2026-04-15T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - index * 2);
  return date.toISOString();
});

const observation = (prefix, index, options = {}) => ({
  matchId: `${prefix}-${index}`,
  playedAt: dates[index],
  pointsFor: options.pointsFor ?? 117 - (index % 5),
  pointsAgainst: options.pointsAgainst ?? 109 + (index % 4),
  isHome: index % 2 === 0,
  isPreseason: false,
  source: "espn_nba_site_api",
  sourceConfidenceScore: 95,
  evidenceSha256: (index % 2 === 0 ? "a" : "b").repeat(64),
  capturedAt: "2026-04-16T00:00:00Z",
  featureAsOf: dates[index],
  restDays: 2,
  teamEloBefore: options.teamEloBefore ?? 1530 + index,
  teamEloAfter: options.teamEloAfter ?? 1540 + index,
  opponentEloBefore: options.opponentEloBefore ?? 1500
});

const homeForm = dates.map((_, index) => observation("home", index));
const awayForm = dates.map((_, index) => observation("away", index, {
  pointsFor: 108 + (index % 4),
  pointsAgainst: 116 - (index % 3),
  teamEloBefore: 1475 - index,
  teamEloAfter: 1470 - index
}));
const baseInput = {
  homeTeam: "Boston Celtics",
  awayTeam: "Los Angeles Lakers",
  asOf: "2026-04-17T00:00:00Z",
  kickoff: "2026-04-18T00:00:00Z",
  targetCompetitionType: "regular",
  homeForm,
  awayForm
};

const result = computeNbaFairOdds(baseInput);
assert.ok(Math.abs(result.probabilities.home + result.probabilities.away - 1) < 0.000001);
assert.ok(result.probabilities.home > result.probabilities.away);
assert.ok(result.projected_margin > 0);
assert.equal(result.basis.market_inputs_used, false);
assert.equal(result.basis.home_sample_size, NBA_FAIR_ODDS_CONFIG.max_form_matches);
assert.equal(result.training_cutoff_date, "2026-04-15");
assert.match(result.input_snapshot_sha256, /^[a-f0-9]{64}$/);
assert.match(result.output_sha256, /^[a-f0-9]{64}$/);
assert.equal(computeNbaFairOdds(baseInput).output_sha256, result.output_sha256);

const preseason = computeNbaFairOdds({ ...baseInput, targetCompetitionType: "preseason" });
assert.ok(Math.abs(preseason.probabilities.home - 0.5) < Math.abs(result.probabilities.home - 0.5));
assert.ok(preseason.confidence < result.confidence);

const strongerHome = computeNbaFairOdds({
  ...baseInput,
  homeForm: homeForm.map((row) => ({ ...row, teamEloAfter: 1700 }))
});
assert.ok(strongerHome.probabilities.home > result.probabilities.home);

assert.throws(
  () => computeNbaFairOdds({ ...baseInput, homeForm: homeForm.slice(0, 11) }),
  /verified_history_insufficient/
);
assert.throws(
  () => computeNbaFairOdds({
    ...baseInput,
    homeForm: homeForm.map((row) => ({ ...row, evidenceSha256: "missing" }))
  }),
  /verified_history_insufficient/
);
assert.throws(
  () => computeNbaFairOdds({
    ...baseInput,
    homeForm: homeForm.map((row) => ({ ...row, capturedAt: "2026-04-19T00:00:00Z" }))
  }),
  /verified_history_insufficient/
);
assert.throws(
  () => computeNbaFairOdds({ ...baseInput, kickoff: "2026-04-16T00:00:00Z" }),
  /kickoff_invalid_or_started/
);

assert.match(nbaFairOddsConfigSha256(), /^[a-f0-9]{64}$/);
const artifactA = nbaFairOddsArtifactSha256({ sourceCodeSha256: "c".repeat(64), gitCommit: "abc" });
const artifactB = nbaFairOddsArtifactSha256({ sourceCodeSha256: "d".repeat(64), gitCommit: "abc" });
assert.match(artifactA, /^[a-f0-9]{64}$/);
assert.notEqual(artifactA, artifactB);

console.log("NBA_FAIR_ODDS_MODEL_OK", JSON.stringify(result));
