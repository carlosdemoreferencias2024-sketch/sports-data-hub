import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function expectRejected(name, work) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    await work();
    assert.fail(`${name} should have been rejected`);
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") throw error;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}

await client.connect();
try {
  await client.query("BEGIN");
  const candidate = await client.query(`
    SELECT m.id AS match_id, m.match_date, mq.id AS model_quote_id
    FROM matches m
    JOIN leagues l ON l.id = m.league_id
    JOIN sports s ON s.id = l.sport_id
    JOIN model_quotes mq ON mq.match_id = m.id
    WHERE m.status = 'finished'
      AND s.slug = 'baseball'
      AND l.slug = 'mlb'
      AND m.match_date > '2026-01-02'::timestamptz
    ORDER BY m.match_date DESC, mq.generated_at DESC
    LIMIT 1
  `);
  assert.ok(candidate.rows[0], "a finished MLB match with a model quote is required");
  const { match_id: matchId, match_date: matchDate, model_quote_id: modelQuoteId } = candidate.rows[0];
  const kickoff = new Date(matchDate);
  const atMinutesBefore = (minutes) => new Date(kickoff.getTime() - minutes * 60_000).toISOString();
  const versionLabel = `historical-db-test-${randomUUID()}`;

  await client.query("SELECT * FROM register_forecast_match($1::uuid)", [matchId]);
  const model = await client.query(`
    INSERT INTO forecast_model_versions (
      version_label, sport_slug, model_name, training_cutoff_date,
      trained_at, artifact_sha256, feature_schema_version
    ) VALUES ($1, 'baseball', 'historical_db_test', $2::date, $3::timestamptz, $4, 'test-v1')
    RETURNING id
  `, [
    versionLabel,
    new Date(kickoff.getTime() - 3 * 86_400_000).toISOString().slice(0, 10),
    new Date(kickoff.getTime() - 2 * 86_400_000).toISOString(),
    hash(versionLabel)
  ]);

  await client.query(`
    SELECT * FROM append_forecast_stage(
      $1::uuid, 'fair_odds', $2::jsonb, NULL, NULL, $3::uuid, $4::uuid
    )
  `, [matchId, JSON.stringify({
    fair_odds: 1.88679245,
    model_predicted_prob: 0.53,
    market_implied_prob: 0.5,
    fair_odds_method_version: "owned_fair_odds_v1"
  }), model.rows[0].id, modelQuoteId]);

  async function addEvidence(label, provider, bookmaker, odds, capturedAt, role, timingQuality) {
    const snapshot = await client.query(`
      INSERT INTO odds_snapshots (
        match_id, sport_slug, league_slug, provider_name, source_name,
        bookmaker, market_type, selection, odds, snapshot_role,
        captured_at, quality_score, raw_data
      ) VALUES (
        $1, 'baseball', 'mlb', $2, $2, $3, 'moneyline_2way',
        'home', $4, $5, $6::timestamptz, 100, $7::jsonb
      ) RETURNING id
    `, [matchId, provider, bookmaker, odds, role, capturedAt, JSON.stringify({ label })]);
    const evidence = await client.query(`
      INSERT INTO forecast_evidence (
        match_id, odds_snapshot_id, source_type, provider_name, bookmaker,
        market_type, selection, odds_value, odds_format, decimal_odds,
        captured_at, timing_quality, raw_payload_hash
      ) VALUES (
        $1, $2, 'provider_api', $3, $4, 'moneyline_2way', 'home',
        $5, 'decimal', $5, $6::timestamptz, $7, $8
      ) RETURNING id
    `, [matchId, snapshot.rows[0].id, provider, bookmaker, odds, capturedAt, timingQuality, hash(label)]);
    return evidence.rows[0].id;
  }

  const entryPrimary = await addEvidence("entry-primary", "provider_a", "book_a", 2.05, atMinutesBefore(90), "entry", "CAPTURED_ON_TIME");
  await addEvidence("entry-secondary", "provider_b", "book_b", 2.04, atMinutesBefore(88), "entry", "CAPTURED_ON_TIME");
  const entry = await client.query(`
    SELECT * FROM append_forecast_stage($1::uuid, 'entry', '{"decimal_odds":2.05}'::jsonb, $2::uuid)
  `, [matchId, entryPrimary]);

  const decision = await client.query(`
    SELECT * FROM record_forecast_inclusion_decision($1::uuid, 'HISTORICAL_BACKTEST')
  `, [matchId]);
  assert.equal(decision.rows[0].decision, "INCLUDED", JSON.stringify(decision.rows[0].reasons_json));

  const context = await client.query(`
    INSERT INTO forecast_context_snapshots (
      match_id, captured_at, lineup_confirmed, batting_order_complete,
      pitchers_confirmed, bullpen_context_complete, completeness_flag,
      source_url, source_payload_hash, capture_mode, source_published_at,
      source_as_of_at, replay_verified_by, no_post_event_data_attested
    ) VALUES (
      $1, $2::timestamptz, true, true, true, true, 'complete',
      'https://example.test/context', $3, 'HISTORICAL_REPLAY',
      $4::timestamptz, $5::timestamptz, 'db-test-reviewer', true
    ) RETURNING id
  `, [matchId, atMinutesBefore(30), hash("context"), atMinutesBefore(45), atMinutesBefore(40)]);
  await client.query(`
    SELECT * FROM append_forecast_stage($1::uuid, 'context', '{}'::jsonb, NULL, $2::uuid)
  `, [matchId, context.rows[0].id]);

  const closingPrimary = await addEvidence("closing-primary", "provider_a", "book_a", 1.95, atMinutesBefore(6), "closing", "CAPTURED_ON_TIME");
  await addEvidence("closing-secondary", "provider_b", "book_b", 1.96, atMinutesBefore(5), "closing", "CAPTURED_ON_TIME");
  const closing = await client.query(`
    SELECT * FROM append_forecast_stage($1::uuid, 'closing', '{"decimal_odds":1.95}'::jsonb, $2::uuid)
  `, [matchId, closingPrimary]);
  const result = await client.query(`
    SELECT * FROM append_forecast_stage($1::uuid, 'result', $2::jsonb)
  `, [matchId, JSON.stringify({
    result: "win",
    verified: true,
    verified_by: "db-test-reviewer",
    verified_at: new Date(kickoff.getTime() + 3 * 60 * 60_000).toISOString(),
    source_url: "https://example.test/final",
    source_payload_hash: hash("final")
  })]);
  const expectedClv = 2.05 / 1.95 - 1;
  const clvStage = await client.query(`
    SELECT * FROM append_forecast_stage($1::uuid, 'clv', $2::jsonb)
  `, [matchId, JSON.stringify({
    clv_percent: expectedClv,
    clv_formula_version: "decimal_price_ratio_v1"
  })]);
  const clv = await client.query(`
    INSERT INTO forecast_clv_records (
      match_id, entry_chain_id, closing_chain_id, result_chain_id,
      clv_chain_id, model_version_id, entry_odds, closing_odds,
      clv_percent, clv_formula_version, result, chain_verified, clean_sample
    ) VALUES (
      $1, $2, $3, $4, $5, $6, 2.05, 1.95, $7,
      'decimal_price_ratio_v1', 'win', false, true
    ) RETURNING id, chain_verified
  `, [
    matchId,
    entry.rows[0].id,
    closing.rows[0].id,
    result.rows[0].id,
    clvStage.rows[0].id,
    model.rows[0].id,
    expectedClv
  ]);
  assert.equal(clv.rows[0].chain_verified, true);

  const assessment = await client.query(`
    SELECT * FROM assess_forecast_sample($1::uuid, 'HISTORICAL_BACKTEST')
  `, [clv.rows[0].id]);
  assert.equal(assessment.rows[0].clean_eligible, true, JSON.stringify(assessment.rows[0].reasons_json));
  assert.equal(assessment.rows[0].walk_forward_passed, true);
  assert.equal(assessment.rows[0].ready_gate_eligible, false);
  assert.deepEqual(assessment.rows[0].reasons_json, []);

  await expectRejected("cross_cohort_contamination", () => client.query(`
    SELECT * FROM record_forecast_inclusion_decision($1::uuid, 'PROSPECTIVE_SHADOW')
  `, [matchId]));

  await client.query("ROLLBACK");
  console.log("historical replay database tests ok");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
