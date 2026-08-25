import assert from "node:assert/strict";
import {
  deriveForecastGateMetrics,
  deterministicBootstrapMeanCi,
  evaluateForecastGate,
  FORECAST_GATE_POLICY
} from "../dist/trading/forecast-gate.js";

assert.equal(FORECAST_GATE_POLICY.evaluationSampleSize, 150);
assert.equal(FORECAST_GATE_POLICY.readySampleSize, 300);

const ready = evaluateForecastGate({
  cleanSampleSize: 300,
  observationWeeks: 8,
  clvMean: 0.015,
  clvCiLower: 0.002,
  clvCiUpper: 0.028,
  calibrationRatio: 0.97,
  calibrationDiffCiUpper: -0.001,
  walkForwardPassed: true
});
assert.equal(ready.evaluationEligible, true);
assert.equal(ready.overallStatus, "READY");
assert.deepEqual(ready.blockingReasons, []);

const notReady = evaluateForecastGate({
  cleanSampleSize: 149,
  observationWeeks: 2,
  clvMean: 0.01,
  clvCiLower: -0.004,
  clvCiUpper: 0.024,
  calibrationRatio: 1.01,
  calibrationDiffCiUpper: 0.002,
  walkForwardPassed: false
});
assert.equal(notReady.evaluationEligible, false);
assert.equal(notReady.overallStatus, "NOT_READY");
assert.deepEqual(notReady.blockingReasons, [
  "CLEAN_SAMPLE_LT_300",
  "OBSERVATION_WINDOW_LT_6_WEEKS",
  "CLV_CI_LOWER_NOT_POSITIVE",
  "CALIBRATION_NOT_BETTER_THAN_MARKET",
  "CALIBRATION_DIFFERENCE_NOT_SIGNIFICANT",
  "WALK_FORWARD_FAILED"
]);

const observations = Array.from({ length: 300 }, (_, index) => {
  const win = index % 2 === 0;
  return {
    matchId: `match-${index}`,
    entryCapturedAt: new Date(Date.UTC(2026, 0, 1) + index * 4 * 60 * 60 * 1000).toISOString(),
    clvPercent: 0.018 + (index % 5) * 0.001,
    result: win ? "win" : "loss",
    modelPredictedProb: win ? 0.7 : 0.3,
    marketImpliedProb: win ? 0.55 : 0.45,
    walkForwardPassed: true
  };
});
const derived = deriveForecastGateMetrics(observations, 500);
assert.equal(derived.cleanSampleSize, 300);
assert.equal(derived.historicalBacktestSize, 500);
assert.ok(derived.observationWeeks >= 6);
assert.ok(derived.clvCiLower > 0);
assert.ok(derived.calibrationRatio < 1);
assert.ok(derived.calibrationDiffCiUpper < 0);
assert.equal(evaluateForecastGate(derived).overallStatus, "READY");

const evaluationOnly = deriveForecastGateMetrics(observations.slice(0, 150), 500);
assert.equal(evaluationOnly.cleanSampleSize, 150);
assert.equal(evaluateForecastGate(evaluationOnly).evaluationEligible, true);
assert.equal(evaluateForecastGate(evaluationOnly).overallStatus, "NOT_READY");

const firstBootstrap = deterministicBootstrapMeanCi(observations.map((row) => row.clvPercent));
const secondBootstrap = deterministicBootstrapMeanCi(observations.map((row) => row.clvPercent));
assert.deepEqual(firstBootstrap, secondBootstrap);

console.log("forecast gate tests ok");
