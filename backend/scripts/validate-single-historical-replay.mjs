import pg from "pg";
import { validateHistoricalReplay } from "../dist/trading/historical-replay-validator.js";

const { Client } = pg;
const args = process.argv.slice(2);
const matchIndex = args.indexOf("--match-id");
const matchId = matchIndex >= 0 ? args[matchIndex + 1] : process.env.HISTORICAL_REPLAY_MATCH_ID;

if (!matchId || !/^[a-f0-9-]{36}$/i.test(matchId)) {
  console.error("Usage: node scripts/validate-single-historical-replay.mjs --match-id <operational-match-uuid>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query("BEGIN TRANSACTION READ ONLY");
  const matchResult = await client.query(`
    SELECT match_id, sport_slug, status, scheduled_start
    FROM forecast_matches WHERE match_id = $1::uuid
  `, [matchId]);
  if (!matchResult.rows[0]) {
    console.log(JSON.stringify({
      checklistVersion: "historical_replay_single_match_v1",
      matchId,
      status: "BLOCKED",
      checks: [],
      blockingReasons: ["FORECAST_MATCH_NOT_REGISTERED"]
    }, null, 2));
    process.exitCode = 1;
  } else {
    const [decisionResult, prospectiveResult, chainResult, evidenceResult, contextResult, modelResult, clvResult, assessmentResult, verifyResult] = await Promise.all([
      client.query(`
        SELECT decision.decision, decision.reasons_json, criteria.*
        FROM forecast_inclusion_decisions decision
        JOIN forecast_inclusion_criteria criteria ON criteria.id = decision.criteria_id
        WHERE decision.match_id = $1::uuid AND decision.cohort = 'HISTORICAL_BACKTEST'
      `, [matchId]),
      client.query(`SELECT count(*)::int AS count FROM forecast_inclusion_decisions WHERE match_id = $1::uuid AND cohort = 'PROSPECTIVE_SHADOW'`, [matchId]),
      client.query(`SELECT * FROM forecast_chain WHERE match_id = $1::uuid ORDER BY sequence_num`, [matchId]),
      client.query(`
        SELECT evidence.*,
          snapshot.id AS snapshot_id,
          snapshot.match_id AS snapshot_match_id,
          snapshot.provider_name AS snapshot_provider_name,
          snapshot.bookmaker AS snapshot_bookmaker,
          snapshot.market_type AS snapshot_market_type,
          snapshot.selection AS snapshot_selection,
          snapshot.odds AS snapshot_odds,
          snapshot.captured_at AS snapshot_captured_at
        FROM forecast_evidence evidence
        LEFT JOIN odds_snapshots snapshot ON snapshot.id = evidence.odds_snapshot_id
        WHERE evidence.match_id = $1::uuid
      `, [matchId]),
      client.query(`
        SELECT context.* FROM forecast_chain chain
        JOIN forecast_context_snapshots context ON context.id = chain.context_id
        WHERE chain.match_id = $1::uuid AND chain.stage = 'context'
      `, [matchId]),
      client.query(`
        SELECT model.* FROM forecast_chain chain
        JOIN forecast_model_versions model ON model.id = chain.model_version_id
        WHERE chain.match_id = $1::uuid AND chain.stage = 'fair_odds'
      `, [matchId]),
      client.query(`SELECT * FROM forecast_clv_records WHERE match_id = $1::uuid ORDER BY calculated_at DESC LIMIT 1`, [matchId]),
      client.query(`SELECT * FROM forecast_sample_assessments WHERE match_id = $1::uuid AND cohort = 'HISTORICAL_BACKTEST' ORDER BY assessed_at DESC LIMIT 1`, [matchId]),
      client.query(`SELECT verify_forecast_chain($1::uuid) AS valid`, [matchId])
    ]);

    const chain = chainResult.rows.map((row) => ({
      id: row.id,
      stage: row.stage,
      sequenceNum: row.sequence_num,
      evidenceId: row.evidence_id,
      contextId: row.context_id,
      modelVersionId: row.model_version_id,
      modelQuoteId: row.model_quote_id,
      value: row.value_json
    }));
    const evidence = evidenceResult.rows.map((row) => ({
      id: row.id,
      oddsSnapshotId: row.odds_snapshot_id,
      providerName: row.provider_name,
      bookmaker: row.bookmaker,
      marketType: row.market_type,
      selection: row.selection,
      decimalOdds: Number(row.decimal_odds),
      capturedAt: row.captured_at.toISOString(),
      timingQuality: row.timing_quality,
      rawPayloadHash: row.raw_payload_hash,
      snapshot: row.snapshot_id ? {
        id: row.snapshot_id,
        matchId: row.snapshot_match_id,
        providerName: row.snapshot_provider_name,
        bookmaker: row.snapshot_bookmaker,
        marketType: row.snapshot_market_type,
        selection: row.snapshot_selection,
        odds: Number(row.snapshot_odds),
        capturedAt: row.snapshot_captured_at.toISOString()
      } : null
    }));
    const decision = decisionResult.rows[0];
    const context = contextResult.rows[0];
    const model = modelResult.rows[0];
    const clv = clvResult.rows[0];
    const assessment = assessmentResult.rows[0];
    const match = matchResult.rows[0];

    const report = validateHistoricalReplay({
      match: {
        matchId: match.match_id,
        sportSlug: match.sport_slug,
        status: match.status,
        scheduledStart: match.scheduled_start.toISOString()
      },
      criteria: decision ? {
        cohort: decision.cohort,
        requireContextComplete: decision.require_context_complete,
        requireDualEvidence: decision.require_dual_evidence,
        dualEvidenceToleranceMinutes: decision.dual_evidence_tolerance_minutes,
        fairOddsMethodVersion: decision.fair_odds_method_version
      } : null,
      historicalDecision: decision ? { decision: decision.decision, reasons: decision.reasons_json } : null,
      prospectiveDecisionCount: prospectiveResult.rows[0].count,
      chainValid: verifyResult.rows[0].valid === true,
      chain,
      evidence,
      context: context ? {
        completeness: context.completeness_flag,
        captureMode: context.capture_mode,
        capturedAt: context.captured_at.toISOString(),
        sourceUrl: context.source_url,
        sourcePayloadHash: context.source_payload_hash,
        sourcePublishedAt: context.source_published_at?.toISOString(),
        sourceAsOfAt: context.source_as_of_at?.toISOString(),
        replayVerifiedBy: context.replay_verified_by,
        noPostEventDataAttested: context.no_post_event_data_attested
      } : null,
      modelVersion: model ? {
        id: model.id,
        sportSlug: model.sport_slug,
        trainingCutoffDate: model.training_cutoff_date.toISOString().slice(0, 10),
        trainedAt: model.trained_at.toISOString(),
        artifactSha256: model.artifact_sha256
      } : null,
      clvRecord: clv ? {
        entryOdds: Number(clv.entry_odds),
        closingOdds: Number(clv.closing_odds),
        clvPercent: Number(clv.clv_percent),
        formulaVersion: clv.clv_formula_version,
        chainVerified: clv.chain_verified
      } : null,
      assessment: assessment ? {
        cohort: assessment.cohort,
        cleanEligible: assessment.clean_eligible,
        readyGateEligible: assessment.ready_gate_eligible,
        walkForwardPassed: assessment.walk_forward_passed,
        reasons: assessment.reasons_json
      } : null
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  }
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
