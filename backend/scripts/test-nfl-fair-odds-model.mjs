import assert from "node:assert/strict";
import {
  computeNflFairOdds,
  NFL_FAIR_ODDS_CONFIG,
  nflFairOddsArtifactSha256,
  nflFairOddsConfigSha256
} from "../dist/trading/nfl-fair-odds-model.js";

const dates = [
  "2026-08-10T00:00:00Z", "2026-08-03T00:00:00Z", "2026-02-01T00:00:00Z",
  "2026-01-24T00:00:00Z", "2026-01-17T00:00:00Z", "2026-01-10T00:00:00Z",
  "2026-01-03T00:00:00Z", "2025-12-27T00:00:00Z", "2025-12-20T00:00:00Z",
  "2025-12-13T00:00:00Z", "2025-12-06T00:00:00Z", "2025-11-29T00:00:00Z"
];

const observation = (prefix, index, options = {}) => ({
  matchId: `${prefix}-${index}`,
  playedAt: dates[index],
  pointsFor: options.pointsFor ?? 27 - (index % 3),
  pointsAgainst: options.pointsAgainst ?? 19 + (index % 4),
  isHome: index % 2 === 0,
  isPreseason: index < 2,
  source: "espn_nfl_site_api",
  sourceConfidenceScore: 95,
  evidenceSha256: (index % 2 === 0 ? "a" : "b").repeat(64),
  capturedAt: "2026-08-19T12:00:00Z",
  featureAsOf: dates[index],
  teamEloBefore: options.teamEloBefore ?? 1510 + index,
  teamEloAfter: options.teamEloAfter ?? 1520 + index,
  opponentEloBefore: options.opponentEloBefore ?? 1500
});

const homeForm = dates.map((_, index) => observation("home", index));
const awayForm = dates.map((_, index) => observation("away", index, {
  pointsFor: 20 + (index % 3),
  pointsAgainst: 25 - (index % 2),
  teamEloBefore: 1485 - index,
  teamEloAfter: 1480 - index
}));
const baseInput = {
  homeTeam: "Houston Texans",
  awayTeam: "Las Vegas Raiders",
  asOf: "2026-08-20T13:00:00Z",
  targetCompetitionType: "regular",
  homeForm,
  awayForm
};

const result = computeNflFairOdds(baseInput);
assert.ok(Math.abs(result.probabilities.home + result.probabilities.away - 1) < 0.000001);
assert.ok(result.probabilities.home > result.probabilities.away);
assert.equal(result.basis.market_inputs_used, false);
assert.equal(result.basis.home_sample_size, NFL_FAIR_ODDS_CONFIG.max_form_matches);
assert.equal(result.training_cutoff_date, "2026-08-10");
assert.match(result.input_snapshot_sha256, /^[a-f0-9]{64}$/);
assert.match(result.output_sha256, /^[a-f0-9]{64}$/);
assert.equal(computeNflFairOdds(baseInput).output_sha256, result.output_sha256, "same immutable input must reproduce exactly");

const preseason = computeNflFairOdds({ ...baseInput, targetCompetitionType: "preseason" });
assert.ok(
  Math.abs(preseason.probabilities.home - 0.5) < Math.abs(result.probabilities.home - 0.5),
  "preseason target must shrink toward 50%"
);
assert.ok(preseason.confidence < result.confidence, "preseason target must carry lower confidence");

const strongerHome = computeNflFairOdds({
  ...baseInput,
  homeForm: homeForm.map((row) => ({ ...row, teamEloAfter: 1700 }))
});
assert.ok(strongerHome.probabilities.home > result.probabilities.home, "higher owned Elo must increase home probability");

assert.throws(
  () => computeNflFairOdds({ ...baseInput, homeForm: homeForm.slice(0, 7) }),
  /verified_history_insufficient/
);
assert.throws(
  () => computeNflFairOdds({
    ...baseInput,
    homeForm: homeForm.map((row) => ({ ...row, evidenceSha256: "missing" }))
  }),
  /verified_history_insufficient/,
  "rows without formal SHA-256 evidence must be rejected"
);
assert.throws(
  () => computeNflFairOdds({
    ...baseInput,
    homeForm: homeForm.map((row) => ({ ...row, capturedAt: "2026-08-21T00:00:00Z" }))
  }),
  /verified_history_insufficient/,
  "features captured after decision_as_of must not leak"
);

assert.match(nflFairOddsConfigSha256(), /^[a-f0-9]{64}$/);
const artifactA = nflFairOddsArtifactSha256({ sourceCodeSha256: "c".repeat(64), gitCommit: "abc" });
const artifactB = nflFairOddsArtifactSha256({ sourceCodeSha256: "d".repeat(64), gitCommit: "abc" });
assert.match(artifactA, /^[a-f0-9]{64}$/);
assert.notEqual(artifactA, artifactB);

console.log("NFL_FAIR_ODDS_MODEL_OK", JSON.stringify(result));
