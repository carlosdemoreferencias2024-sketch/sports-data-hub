export const FORECAST_GATE_POLICY = Object.freeze({
  version: "forecast_gate_v2_cohort_isolated",
  evaluationSampleSize: 150,
  readySampleSize: 300,
  minimumObservationWeeks: 6,
  maximumCalibrationRatio: 1,
  bootstrapIterations: 2000,
  calculationSeed: 20260811
});

export interface ForecastGateMetrics {
  cleanSampleSize: number;
  observationWeeks: number;
  clvMean: number | null;
  clvCiLower: number | null;
  clvCiUpper: number | null;
  calibrationRatio: number | null;
  calibrationDiffCiUpper: number | null;
  walkForwardPassed: boolean;
  sampleStartedAt?: string | null;
  sampleEndedAt?: string | null;
  historicalBacktestSize?: number;
  bootstrapIterations?: number;
  calculationSeed?: number;
}

export interface ForecastGateObservation {
  matchId: string;
  entryCapturedAt: string;
  clvPercent: number;
  result: "win" | "loss" | "push" | "void";
  modelPredictedProb: number;
  marketImpliedProb: number;
  walkForwardPassed: boolean;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(values: number[]) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function quantile(sortedValues: number[], probability: number) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export function deterministicBootstrapMeanCi(
  values: number[],
  iterations: number = FORECAST_GATE_POLICY.bootstrapIterations,
  seed: number = FORECAST_GATE_POLICY.calculationSeed
) {
  if (values.length < 30) return { lower: null, upper: null };
  const random = seededRandom(seed);
  const bootstrapMeans: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)];
    }
    bootstrapMeans.push(total / values.length);
  }
  bootstrapMeans.sort((left, right) => left - right);
  return {
    lower: quantile(bootstrapMeans, 0.025),
    upper: quantile(bootstrapMeans, 0.975)
  };
}

export function deriveForecastGateMetrics(
  observations: ForecastGateObservation[],
  historicalBacktestSize: number = 0,
  iterations: number = FORECAST_GATE_POLICY.bootstrapIterations,
  seed: number = FORECAST_GATE_POLICY.calculationSeed
): ForecastGateMetrics {
  const unique = new Map(observations.map((row) => [row.matchId, row]));
  const rows = [...unique.values()];
  const clvValues = rows.map((row) => row.clvPercent).filter(Number.isFinite);
  const clvCi = deterministicBootstrapMeanCi(clvValues, iterations, seed);
  const timestamps = rows
    .map((row) => new Date(row.entryCapturedAt).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const sampleStartedAt = timestamps.length ? new Date(timestamps[0]).toISOString() : null;
  const sampleEndedAt = timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null;
  const observationWeeks = timestamps.length > 1
    ? (timestamps[timestamps.length - 1] - timestamps[0]) / (7 * 24 * 60 * 60 * 1000)
    : 0;

  const scored = rows.filter((row) => row.result === "win" || row.result === "loss");
  const modelErrors: number[] = [];
  const marketErrors: number[] = [];
  const errorDifferences: number[] = [];
  for (const row of scored) {
    const outcome = row.result === "win" ? 1 : 0;
    const modelError = (row.modelPredictedProb - outcome) ** 2;
    const marketError = (row.marketImpliedProb - outcome) ** 2;
    modelErrors.push(modelError);
    marketErrors.push(marketError);
    errorDifferences.push(modelError - marketError);
  }
  const modelBrier = mean(modelErrors);
  const marketBrier = mean(marketErrors);
  const calibrationRatio = modelBrier !== null && marketBrier !== null && marketBrier > 0
    ? modelBrier / marketBrier
    : null;
  const calibrationDiffCi = deterministicBootstrapMeanCi(errorDifferences, iterations, seed + 1);

  return {
    cleanSampleSize: rows.length,
    observationWeeks,
    clvMean: mean(clvValues),
    clvCiLower: clvCi.lower,
    clvCiUpper: clvCi.upper,
    calibrationRatio,
    calibrationDiffCiUpper: calibrationDiffCi.upper,
    walkForwardPassed: rows.length > 0 && rows.every((row) => row.walkForwardPassed),
    sampleStartedAt,
    sampleEndedAt,
    historicalBacktestSize,
    bootstrapIterations: iterations,
    calculationSeed: seed
  };
}

export function evaluateForecastGate(metrics: ForecastGateMetrics) {
  const blockingReasons: string[] = [];
  if (metrics.cleanSampleSize < FORECAST_GATE_POLICY.readySampleSize) blockingReasons.push("CLEAN_SAMPLE_LT_300");
  if (metrics.observationWeeks < FORECAST_GATE_POLICY.minimumObservationWeeks) blockingReasons.push("OBSERVATION_WINDOW_LT_6_WEEKS");
  if (metrics.clvCiLower === null || metrics.clvCiLower <= 0) blockingReasons.push("CLV_CI_LOWER_NOT_POSITIVE");
  if (metrics.calibrationRatio === null || metrics.calibrationRatio >= FORECAST_GATE_POLICY.maximumCalibrationRatio) {
    blockingReasons.push("CALIBRATION_NOT_BETTER_THAN_MARKET");
  }
  if (metrics.calibrationDiffCiUpper === null || metrics.calibrationDiffCiUpper >= 0) {
    blockingReasons.push("CALIBRATION_DIFFERENCE_NOT_SIGNIFICANT");
  }
  if (!metrics.walkForwardPassed) blockingReasons.push("WALK_FORWARD_FAILED");

  return {
    policyVersion: FORECAST_GATE_POLICY.version,
    evaluationEligible: metrics.cleanSampleSize >= FORECAST_GATE_POLICY.evaluationSampleSize,
    overallStatus: blockingReasons.length ? "NOT_READY" as const : "READY" as const,
    blockingReasons
  };
}
