import assert from "node:assert/strict";
import {
  computeFootballFairOdds,
  computeFootballFairOddsV3,
  FOOTBALL_FAIR_ODDS_MODEL_CONFIG,
  FOOTBALL_FAIR_ODDS_V3_CONFIG,
  footballFairOddsArtifactSha256,
  footballFairOddsV3ArtifactSha256
} from "../dist/trading/football-fair-odds-model.js";

const observation = (matchId, playedAt, goalsFor, goalsAgainst) => ({
  matchId,
  playedAt,
  goalsFor,
  goalsAgainst,
  isHome: true,
  source: "verified_test_source",
  sourceConfidenceScore: 90,
  evidenceSha256: "a".repeat(64),
  capturedAt: playedAt,
  featureAsOf: playedAt
});

const homeForm = [
  observation("h1", "2026-08-04T19:00:00Z", 1, 2),
  observation("h2", "2026-05-17T19:00:00Z", 0, 4),
  observation("h3", "2026-05-10T19:00:00Z", 1, 2),
  observation("h4", "2026-05-03T19:00:00Z", 4, 2),
  observation("h5", "2026-04-25T19:00:00Z", 3, 2)
];
const awayForm = [
  observation("a1", "2026-08-04T19:00:00Z", 2, 1),
  observation("a2", "2026-03-19T19:00:00Z", 0, 4),
  observation("a3", "2026-03-12T19:00:00Z", 1, 2),
  observation("a4", "2025-12-18T19:00:00Z", 3, 0),
  observation("a5", "2025-12-11T19:00:00Z", 2, 1)
];

const result = computeFootballFairOdds({
  homeTeam: "Lyon",
  awayTeam: "Sparta Praha",
  asOf: "2026-08-11T17:15:00Z",
  homeForm,
  awayForm
});

const probabilityTotal = result.probabilities.home + result.probabilities.draw + result.probabilities.away;
assert.ok(Math.abs(probabilityTotal - 1) < 0.00001, "1X2 probabilities must sum to one");
assert.notEqual(result.probabilities.home, result.probabilities.away, "verified form must produce differentiated probabilities");
assert.equal(result.training_cutoff_date, "2026-08-04");
assert.equal(result.basis.market_inputs_used, false);
assert.equal(result.basis.home_sample_size, 5);
assert.equal(result.basis.away_sample_size, 5);
assert.deepEqual(result.basis.home_feature_match_ids, ["h1", "h2", "h3", "h4", "h5"]);
assert.deepEqual(result.basis.away_feature_match_ids, ["a1", "a2", "a3", "a4", "a5"]);
assert.deepEqual(result.basis.data_sources, ["verified_test_source"]);
assert.match(footballFairOddsArtifactSha256(), /^[a-f0-9]{64}$/);
assert.equal(FOOTBALL_FAIR_ODDS_MODEL_CONFIG.min_form_matches, 3);

assert.throws(
  () => computeFootballFairOdds({
    homeTeam: "A",
    awayTeam: "B",
    asOf: "2026-08-11T17:15:00Z",
    homeForm: homeForm.slice(0, 2),
    awayForm
  }),
  /verified_form_insufficient/
);

assert.throws(
  () => computeFootballFairOdds({
    homeTeam: "A",
    awayTeam: "B",
    asOf: "2026-01-01T17:15:00Z",
    homeForm,
    awayForm
  }),
  /verified_form_insufficient/,
  "observations after as_of must not leak into the feature set"
);

console.log("FOOTBALL_FAIR_ODDS_MODEL_OK", JSON.stringify(result));

const v3Observation = (matchId, playedAt, goalsFor, goalsAgainst, options = {}) => ({
  ...observation(matchId, playedAt, goalsFor, goalsAgainst),
  xgFor: options.xgFor ?? goalsFor + 0.1,
  xgAgainst: options.xgAgainst ?? Math.max(0.1, goalsAgainst + 0.1),
  opponentElo: options.opponentElo ?? 1500,
  isHome: options.isHome ?? true
});

const dates = [
  "2026-08-04T19:00:00Z",
  "2026-07-26T19:00:00Z",
  "2026-07-17T19:00:00Z",
  "2026-07-08T19:00:00Z",
  "2026-06-29T19:00:00Z",
  "2026-06-20T19:00:00Z",
  "2026-06-11T19:00:00Z",
  "2026-06-02T19:00:00Z"
];
const v3HomeForm = dates.map((playedAt, index) => v3Observation(
  `vh${index}`,
  playedAt,
  index % 3 === 0 ? 2 : 1,
  index % 4 === 0 ? 0 : 1,
  { xgFor: 1.55 + index * 0.01, xgAgainst: 0.95, opponentElo: 1490 + index * 5, isHome: index % 2 === 0 }
));
const v3AwayForm = dates.map((playedAt, index) => v3Observation(
  `va${index}`,
  playedAt,
  index % 4 === 0 ? 2 : 1,
  index % 3 === 0 ? 2 : 1,
  { xgFor: 1.15, xgAgainst: 1.45 + index * 0.01, opponentElo: 1510 - index * 4, isHome: index % 2 !== 0 }
));
const featureEvidence = (suffix) => ({
  source: `verified_${suffix}`,
  capturedAt: "2026-08-11T16:55:00Z",
  asOf: "2026-08-11T16:50:00Z",
  confidenceScore: 95,
  evidenceSha256: "d".repeat(64)
});
const completeContext = {
  featureProvenance: Object.fromEntries([
    "elo", "rest", "absences", "goalkeepers", "lineups", "availability", "competition", "knockout"
  ].map((key) => [key, featureEvidence(key)])),
  homeElo: 1540,
  awayElo: 1500,
  homeRestDays: 6,
  awayRestDays: 5,
  homeAbsenceImpact: 0,
  awayAbsenceImpact: 0,
  homeGoalkeeperStatus: "confirmed_starting",
  awayGoalkeeperStatus: "confirmed_starting",
  homeLineupCompleteness: 1,
  awayLineupCompleteness: 1,
  availabilityVerified: true,
  competitionStrength: 1
};
const v3Input = {
  homeTeam: "Home",
  awayTeam: "Away",
  asOf: "2026-08-11T17:15:00Z",
  homeForm: v3HomeForm,
  awayForm: v3AwayForm,
  context: completeContext
};
const v3 = computeFootballFairOddsV3(v3Input);
assert.ok(Math.abs(v3.probabilities.home + v3.probabilities.draw + v3.probabilities.away - 1) < 0.00001);
assert.equal(v3.basis.market_inputs_used, false);
assert.equal(v3.basis.xg_ready, true);
assert.equal(v3.basis.xg_coverage, 1);
assert.equal(v3.basis.sample_reliability, FOOTBALL_FAIR_ODDS_V3_CONFIG.max_form_weight);

const strongerHome = computeFootballFairOddsV3({
  ...v3Input,
  context: { ...completeContext, homeElo: 1750, awayElo: 1450 }
});
assert.ok(strongerHome.probabilities.home > v3.probabilities.home, "higher home Elo must monotonically increase home win probability");

const unverifiedElo = computeFootballFairOddsV3({
  ...v3Input,
  context: { ...completeContext, featureProvenance: {}, homeElo: 2200, awayElo: 1100 }
});
assert.equal(unverifiedElo.basis.context_evidence_valid.elo, false);
assert.ok(unverifiedElo.uncertainty > v3.uncertainty, "unverified context must be ignored and increase uncertainty");

const strongerOpponents = computeFootballFairOddsV3({
  ...v3Input,
  homeForm: v3HomeForm.map((row) => ({ ...row, opponentElo: 1800 }))
});
assert.ok(strongerOpponents.expected_goals.home > v3.expected_goals.home, "scoring against stronger opponents must increase normalized home attack");

const venueMismatch = computeFootballFairOddsV3({
  ...v3Input,
  homeForm: v3HomeForm.map((row, index) => ({ ...row, isHome: index >= 4, goalsFor: index < 4 ? 3 : 0 }))
});
const venueMatch = computeFootballFairOddsV3({
  ...v3Input,
  homeForm: v3HomeForm.map((row, index) => ({ ...row, isHome: index < 4, goalsFor: index < 4 ? 3 : 0 }))
});
assert.notEqual(venueMatch.expected_goals.home, venueMismatch.expected_goals.home, "historical venue must participate in the weighting");

const partialXg = computeFootballFairOddsV3({
  ...v3Input,
  homeForm: v3HomeForm.map((row, index) => ({ ...row, xgFor: index < 4 ? row.xgFor : null })),
  awayForm: v3AwayForm.map((row) => ({ ...row, xgAgainst: null }))
});
assert.ok(partialXg.basis.xg_coverage > 0 && partialXg.basis.xg_coverage < 1, "partial xG must degrade coverage instead of discarding the whole block");
assert.ok(partialXg.basis.xg_weight > 0, "available xG must retain non-zero weight");

const smallSample = computeFootballFairOddsV3({
  ...v3Input,
  homeForm: v3HomeForm.slice(0, 3),
  awayForm: v3AwayForm.slice(0, 3)
});
assert.ok(smallSample.uncertainty > v3.uncertainty, "smaller samples must increase uncertainty");
assert.ok(smallSample.confidence < v3.confidence, "smaller samples must reduce confidence");

assert.throws(
  () => computeFootballFairOddsV3({
    ...v3Input,
    homeForm: v3HomeForm.map((row) => ({ ...row, capturedAt: "2026-08-12T00:00:00Z" }))
  }),
  /verified_form_insufficient/,
  "form captured after decision_as_of must not enter the model"
);

const goalkeeperUnknown = computeFootballFairOddsV3({
  ...v3Input,
  context: { ...completeContext, homeGoalkeeperStatus: "unconfirmed" }
});
const goalkeeperAbsent = computeFootballFairOddsV3({
  ...v3Input,
  context: { ...completeContext, homeGoalkeeperStatus: "confirmed_absent", homeGoalkeeperImpact: 0.1 }
});
assert.ok(goalkeeperAbsent.expected_goals.away > goalkeeperUnknown.expected_goals.away, "confirmed absence must differ from an unconfirmed goalkeeper");

assert.match(footballFairOddsV3ArtifactSha256(), /^[a-f0-9]{64}$/);
const artifactA = footballFairOddsV3ArtifactSha256({ sourceCodeSha256: "b".repeat(64), gitCommit: "abc123" });
const artifactB = footballFairOddsV3ArtifactSha256({ sourceCodeSha256: "c".repeat(64), gitCommit: "abc123" });
assert.match(artifactA, /^[a-f0-9]{64}$/);
assert.notEqual(artifactA, artifactB, "artifact identity must change when the source-code hash changes");

console.log("FOOTBALL_FAIR_ODDS_V3_OK", JSON.stringify(v3));
