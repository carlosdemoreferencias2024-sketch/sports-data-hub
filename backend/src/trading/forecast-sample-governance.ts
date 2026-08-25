import { db } from "../db/index.js";
import { recordForecastGateStatus } from "./forecast-chain.js";
import {
  deriveForecastGateMetrics,
  FORECAST_GATE_POLICY,
  type ForecastGateObservation
} from "./forecast-gate.js";

export type ForecastCohort = "PROSPECTIVE_SHADOW" | "HISTORICAL_BACKTEST";

export async function recordForecastInclusionDecision(
  matchId: string,
  cohort: ForecastCohort = "PROSPECTIVE_SHADOW"
) {
  const result = await db.query(
    "SELECT * FROM record_forecast_inclusion_decision($1::uuid, $2)",
    [matchId, cohort]
  );
  return result.rows[0];
}

export async function assessForecastSample(
  clvRecordId: string,
  cohort: ForecastCohort = "PROSPECTIVE_SHADOW"
) {
  const result = await db.query(
    "SELECT * FROM assess_forecast_sample($1::uuid, $2)",
    [clvRecordId, cohort]
  );
  return result.rows[0];
}

function asFiniteNumber(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid forecast gate numeric value: ${String(value)}`);
  return parsed;
}

export async function calculateAndRecordForecastGate() {
  const [prospective, historical] = await Promise.all([
    db.query("SELECT * FROM forecast_gate_dataset ORDER BY entry_captured_at, match_id"),
    db.query("SELECT count(*)::int AS count FROM forecast_historical_backtest_dataset")
  ]);
  const observations: ForecastGateObservation[] = prospective.rows.map((row) => ({
    matchId: String(row.match_id),
    entryCapturedAt: new Date(row.entry_captured_at).toISOString(),
    clvPercent: asFiniteNumber(row.clv_percent),
    result: row.result,
    modelPredictedProb: asFiniteNumber(row.model_predicted_prob),
    marketImpliedProb: asFiniteNumber(row.market_implied_prob),
    walkForwardPassed: row.walk_forward_passed === true
  }));
  const metrics = deriveForecastGateMetrics(
    observations,
    Number(historical.rows[0]?.count ?? 0),
    FORECAST_GATE_POLICY.bootstrapIterations,
    FORECAST_GATE_POLICY.calculationSeed
  );
  return recordForecastGateStatus(metrics);
}

export async function getForecastSampleGovernanceStatus() {
  const result = await db.query(`
    SELECT
      (SELECT count(*)::int FROM forecast_inclusion_decisions
        WHERE cohort = 'PROSPECTIVE_SHADOW' AND decision = 'INCLUDED') AS prospective_preregistered,
      (SELECT count(*)::int FROM forecast_sample_assessments
        WHERE cohort = 'PROSPECTIVE_SHADOW' AND ready_gate_eligible) AS prospective_clean,
      (SELECT count(*)::int FROM forecast_sample_assessments
        WHERE cohort = 'HISTORICAL_BACKTEST' AND clean_eligible) AS historical_backtest,
      (SELECT row_to_json(gate) FROM (
        SELECT * FROM forecast_sample_gate_status ORDER BY checked_at DESC LIMIT 1
      ) gate) AS latest_gate
  `);
  return {
    system_status: "FORECAST_SAMPLE_GOVERNANCE_SAFE_V2",
    policy: FORECAST_GATE_POLICY,
    counts: result.rows[0] ?? {},
    historical_policy: "RESEARCH_ONLY_NEVER_COUNTS_TOWARD_READY",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true,
      human_approval_required_after_ready: true
    }
  };
}
