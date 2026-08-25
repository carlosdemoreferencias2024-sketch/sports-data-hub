import type { PoolClient } from "pg";
import { db } from "../db/index.js";
import {
  evaluateForecastGate,
  FORECAST_GATE_POLICY,
  type ForecastGateMetrics
} from "./forecast-gate.js";

export { evaluateForecastGate, FORECAST_GATE_POLICY } from "./forecast-gate.js";
export type { ForecastGateMetrics } from "./forecast-gate.js";

export type ForecastStage = "fair_odds" | "entry" | "context" | "closing" | "result" | "clv";
export type JsonObject = Record<string, unknown>;

type TransactionWork<T> = (client: PoolClient) => Promise<T>;

async function withTransaction<T>(work: TransactionWork<T>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function ensureForecastMatch(client: PoolClient, matchId: string) {
  const result = await client.query("SELECT * FROM register_forecast_match($1::uuid)", [matchId]);
  return result.rows[0];
}

function assertSha256(value: string, field: string) {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${field} must be a 64-character SHA-256 hex digest`);
  }
}

export interface ForecastEvidenceInput {
  matchId: string;
  oddsSnapshotId?: string | null;
  sourceType: "provider_api" | "manual_verified";
  providerName: string;
  bookmaker: string;
  marketType: string;
  selection: string;
  line?: number | null;
  oddsValue: number;
  oddsFormat: "decimal" | "american" | "fractional";
  decimalOdds: number;
  capturedAt: string;
  timingQuality?: "CAPTURED_ON_TIME" | "EARLY" | "LATE" | "AUDIT_ONLY" | "UNKNOWN";
  sourceUrl?: string | null;
  screenshotSha256?: string | null;
  verifiedBy?: string | null;
  verificationNotes?: string | null;
  rawPayloadHash: string;
  evidenceRole?: "entry" | "current" | "near_start" | "closing" | "audit_only";
}

export async function recordForecastEvidence(input: ForecastEvidenceInput) {
  assertSha256(input.rawPayloadHash, "rawPayloadHash");
  if (input.screenshotSha256) assertSha256(input.screenshotSha256, "screenshotSha256");

  return withTransaction(async (client) => {
    await ensureForecastMatch(client, input.matchId);
    const existingResult = await client.query(
      `
        SELECT * FROM forecast_evidence
        WHERE match_id = $1::uuid
          AND raw_payload_hash = $2
          AND market_type = $3
          AND selection = $4
          AND captured_at = $5::timestamptz
        ORDER BY recorded_at, id
        LIMIT 1
      `,
      [input.matchId, input.rawPayloadHash, input.marketType, input.selection, input.capturedAt]
    );
    if (existingResult.rows[0]) {
      if (input.evidenceRole) {
        await client.query(
          "SELECT register_forecast_evidence_role($1::uuid, $2, $3::text)",
          [existingResult.rows[0].id, input.evidenceRole, input.verifiedBy || input.providerName]
        );
      }
      return existingResult.rows[0];
    }
    const result = await client.query(
      `
        INSERT INTO forecast_evidence (
          match_id, odds_snapshot_id, source_type, provider_name, bookmaker,
          market_type, selection, line, odds_value, odds_format, decimal_odds,
          captured_at, timing_quality, source_url, screenshot_sha256,
          verified_by, verification_notes, raw_payload_hash
        )
        VALUES (
          $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12::timestamptz, $13, $14, $15, $16, $17, $18
        )
        RETURNING *
      `,
      [
        input.matchId,
        input.oddsSnapshotId ?? null,
        input.sourceType,
        input.providerName,
        input.bookmaker,
        input.marketType,
        input.selection,
        input.line ?? null,
        input.oddsValue,
        input.oddsFormat,
        input.decimalOdds,
        input.capturedAt,
        input.timingQuality ?? "UNKNOWN",
        input.sourceUrl ?? null,
        input.screenshotSha256 ?? null,
        input.verifiedBy ?? null,
        input.verificationNotes ?? null,
        input.rawPayloadHash
      ]
    );
    const evidence = result.rows[0];
    if (input.evidenceRole) {
      await client.query(
        "SELECT register_forecast_evidence_role($1::uuid, $2, $3::text)",
        [evidence.id, input.evidenceRole, input.verifiedBy || input.providerName]
      );
    }
    return evidence;
  });
}

export interface ForecastContextInput {
  matchId: string;
  modelFeatureId?: string | null;
  capturedAt?: string;
  lineupConfirmed?: boolean;
  battingOrderComplete?: boolean;
  pitchersConfirmed?: boolean;
  bullpenContextComplete?: boolean;
  goalkeeperConfirmed?: boolean;
  injuries?: JsonObject;
  weather?: JsonObject | null;
  missingFields?: string[];
  notes?: string | null;
  completeness: "complete" | "partial" | "missing";
  sourceUrl?: string | null;
  sourcePayloadHash?: string | null;
  captureMode?: "LIVE_FORWARD" | "HISTORICAL_REPLAY";
  sourcePublishedAt?: string | null;
  sourceAsOfAt?: string | null;
  replayVerifiedBy?: string | null;
  noPostEventDataAttested?: boolean;
}

export async function recordForecastContext(input: ForecastContextInput) {
  if (input.sourcePayloadHash) assertSha256(input.sourcePayloadHash, "sourcePayloadHash");

  return withTransaction(async (client) => {
    await ensureForecastMatch(client, input.matchId);
    const result = await client.query(
      `
        INSERT INTO forecast_context_snapshots (
          match_id, model_feature_id, captured_at, lineup_confirmed,
          batting_order_complete, pitchers_confirmed, bullpen_context_complete,
          goalkeeper_confirmed, injuries_json, weather_json, missing_fields_json,
          notes, completeness_flag, source_url, source_payload_hash, capture_mode,
          source_published_at, source_as_of_at, replay_verified_by,
          no_post_event_data_attested
        )
        VALUES (
          $1::uuid, $2::uuid, COALESCE($3::timestamptz, now()), $4, $5, $6,
          $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15,
          $16, $17::timestamptz, $18::timestamptz, $19, $20
        )
        RETURNING *
      `,
      [
        input.matchId,
        input.modelFeatureId ?? null,
        input.capturedAt ?? null,
        input.lineupConfirmed ?? false,
        input.battingOrderComplete ?? false,
        input.pitchersConfirmed ?? false,
        input.bullpenContextComplete ?? false,
        input.goalkeeperConfirmed ?? false,
        JSON.stringify(input.injuries ?? {}),
        input.weather === null ? null : JSON.stringify(input.weather ?? {}),
        JSON.stringify(input.missingFields ?? []),
        input.notes ?? null,
        input.completeness,
        input.sourceUrl ?? null,
        input.sourcePayloadHash ?? null,
        input.captureMode ?? "LIVE_FORWARD",
        input.sourcePublishedAt ?? null,
        input.sourceAsOfAt ?? null,
        input.replayVerifiedBy ?? null,
        input.noPostEventDataAttested ?? false
      ]
    );
    return result.rows[0];
  });
}

export interface ForecastModelVersionInput {
  versionLabel: string;
  sportSlug: string;
  modelName: string;
  trainingCutoffDate: string;
  trainedAt: string;
  artifactSha256: string;
  configSha256?: string | null;
  featureSchemaVersion?: string | null;
  notes?: string | null;
}

export async function registerForecastModelVersion(input: ForecastModelVersionInput) {
  assertSha256(input.artifactSha256, "artifactSha256");
  if (input.configSha256) assertSha256(input.configSha256, "configSha256");

  const result = await db.query(
    `
      INSERT INTO forecast_model_versions (
        version_label, sport_slug, model_name, training_cutoff_date, trained_at,
        artifact_sha256, config_sha256, feature_schema_version, notes
      )
      VALUES ($1, $2, $3, $4::date, $5::timestamptz, $6, $7, $8, $9)
      ON CONFLICT (version_label) DO NOTHING
      RETURNING *
    `,
    [
      input.versionLabel,
      input.sportSlug,
      input.modelName,
      input.trainingCutoffDate,
      input.trainedAt,
      input.artifactSha256,
      input.configSha256 ?? null,
      input.featureSchemaVersion ?? null,
      input.notes ?? null
    ]
  );

  if (result.rows[0]) return result.rows[0];
  const existing = await db.query("SELECT * FROM forecast_model_versions WHERE version_label = $1", [input.versionLabel]);
  const row = existing.rows[0];
  const existingCutoffDate = row?.training_cutoff_date instanceof Date
    ? row.training_cutoff_date.toISOString().slice(0, 10)
    : String(row?.training_cutoff_date ?? "").slice(0, 10);
  if (!row
      || row.sport_slug !== input.sportSlug
      || row.model_name !== input.modelName
      || existingCutoffDate !== input.trainingCutoffDate
      || row.artifact_sha256 !== input.artifactSha256) {
    throw new Error(`Model version ${input.versionLabel} already exists with different immutable provenance`);
  }
  return row;
}

export interface AppendForecastStageInput {
  matchId: string;
  stage: ForecastStage;
  value?: JsonObject;
  evidenceId?: string | null;
  contextId?: string | null;
  modelVersionId?: string | null;
  modelQuoteId?: string | null;
}

export async function appendForecastStage(input: AppendForecastStageInput) {
  return withTransaction(async (client) => {
    await ensureForecastMatch(client, input.matchId);
    // PostgreSQL assigns sequence_num, prev_chain_hash, and chain_hash while
    // holding a transaction-scoped advisory lock for this match.
    const result = await client.query(
      `SELECT * FROM append_forecast_stage($1::uuid, $2, $3::jsonb, $4::uuid, $5::uuid, $6::uuid, $7::uuid)`,
      [
        input.matchId,
        input.stage,
        JSON.stringify(input.value ?? {}),
        input.evidenceId ?? null,
        input.contextId ?? null,
        input.modelVersionId ?? null,
        input.modelQuoteId ?? null
      ]
    );
    return result.rows[0];
  });
}

export async function verifyForecastChain(matchId: string) {
  const result = await db.query("SELECT verify_forecast_chain($1::uuid) AS valid", [matchId]);
  return result.rows[0]?.valid === true;
}

export async function recordForecastGateStatus(metrics: ForecastGateMetrics) {
  const decision = evaluateForecastGate(metrics);
  const result = await db.query(
    `
      INSERT INTO forecast_sample_gate_status (
        policy_version, sample_started_at, sample_ended_at, clean_sample_size,
        observation_weeks, required_sample_size, required_min_weeks, clv_mean,
        clv_ci_lower, clv_ci_upper, calibration_ratio,
        calibration_diff_ci_upper, max_calibration_ratio, walk_forward_passed,
        overall_status, blocking_reasons_json, cohort, evaluation_sample_size,
        evaluation_eligible, historical_backtest_size, bootstrap_iterations,
        calculation_seed, human_approval_required, real_candidate_enabled
      )
      VALUES (
        $1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21, $22,
        $23, $24
      )
      RETURNING *
    `,
    [
      decision.policyVersion,
      metrics.sampleStartedAt ?? null,
      metrics.sampleEndedAt ?? null,
      metrics.cleanSampleSize,
      metrics.observationWeeks,
      FORECAST_GATE_POLICY.readySampleSize,
      FORECAST_GATE_POLICY.minimumObservationWeeks,
      metrics.clvMean,
      metrics.clvCiLower,
      metrics.clvCiUpper,
      metrics.calibrationRatio,
      metrics.calibrationDiffCiUpper,
      FORECAST_GATE_POLICY.maximumCalibrationRatio,
      metrics.walkForwardPassed,
      decision.overallStatus,
      JSON.stringify(decision.blockingReasons),
      "PROSPECTIVE_SHADOW",
      FORECAST_GATE_POLICY.evaluationSampleSize,
      decision.evaluationEligible,
      metrics.historicalBacktestSize ?? 0,
      metrics.bootstrapIterations ?? FORECAST_GATE_POLICY.bootstrapIterations,
      metrics.calculationSeed ?? FORECAST_GATE_POLICY.calculationSeed,
      true,
      false
    ]
  );
  return result.rows[0];
}
