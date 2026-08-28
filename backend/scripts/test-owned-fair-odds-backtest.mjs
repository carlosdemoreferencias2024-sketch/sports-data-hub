import assert from "node:assert/strict";
import { backtestMetricsForTest } from "../dist/trading/owned-fair-odds-backtest.js";

const rows = [
  {
    sport: "nfl", league: "nfl", matchId: "a", kickoff: "2026-01-01T00:00:00Z",
    modelName: "test", marketType: "moneyline_2way", homeProbability: 0.8,
    drawProbability: null, awayProbability: 0.2, actual: "home", predicted: "home",
    confidence: 0.7, contextComplete: false
  },
  {
    sport: "nfl", league: "nfl", matchId: "b", kickoff: "2026-01-02T00:00:00Z",
    modelName: "test", marketType: "moneyline_2way", homeProbability: 0.3,
    drawProbability: null, awayProbability: 0.7, actual: "away", predicted: "away",
    confidence: 0.7, contextComplete: true
  }
];

const metrics = backtestMetricsForTest(rows);
assert.equal(metrics.sample_size, 2);
assert.equal(metrics.accuracy, 1);
assert.equal(metrics.brier_score, 0.065);
assert.ok(metrics.log_loss > 0 && metrics.log_loss < 0.3);
assert.deepEqual(metrics.class_counts, { home: 1, draw: 0, away: 1 });

const empty = backtestMetricsForTest([]);
assert.equal(empty.sample_size, 0);
assert.equal(empty.brier_score, null);

console.log("owned fair odds backtest metric tests ok");
