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
    SELECT m.id AS match_id, mq.id AS model_quote_id
    FROM matches m
    JOIN model_quotes mq ON mq.match_id = m.id
    WHERE m.status = 'scheduled'
    ORDER BY m.match_date, mq.generated_at DESC
    LIMIT 1
  `);
  assert.ok(candidate.rows[0], "a scheduled match with a model quote is required");
  const { match_id: matchId, model_quote_id: modelQuoteId } = candidate.rows[0];

  await client.query("SELECT * FROM register_forecast_match($1::uuid)", [matchId]);
  const versionLabel = `forecast-test-${randomUUID()}`;
  const version = await client.query(
    `
      INSERT INTO forecast_model_versions (
        version_label, sport_slug, model_name, training_cutoff_date,
        trained_at, artifact_sha256, feature_schema_version
      )
      VALUES ($1, 'baseball', 'forecast_test', current_date - 1, now(), $2, 'test-v1')
      RETURNING id
    `,
    [versionLabel, hash(versionLabel)]
  );

  await expectRejected("entry_before_fair", () => client.query(
    "SELECT * FROM append_forecast_stage($1::uuid, 'entry', '{}'::jsonb)",
    [matchId]
  ));

  const fair = await client.query(
    `SELECT * FROM append_forecast_stage($1::uuid, 'fair_odds', $2::jsonb, NULL, NULL, $3::uuid, $4::uuid)`,
    [
      matchId,
      JSON.stringify({
        fair_odds: 1.91,
        model_predicted_prob: 0.52356,
        market_implied_prob: 0.5,
        fair_odds_method_version: "owned_fair_odds_v1"
      }),
      version.rows[0].id,
      modelQuoteId
    ]
  );
  assert.equal(fair.rows[0].sequence_num, 1);
  assert.equal(fair.rows[0].prev_chain_hash, null);

  const entryEvidence = await client.query(
    `
      INSERT INTO forecast_evidence (
        match_id, source_type, provider_name, bookmaker, market_type,
        selection, odds_value, odds_format, decimal_odds, captured_at,
        timing_quality, raw_payload_hash
      )
      VALUES ($1, 'provider_api', 'test_provider', 'test_book', 'moneyline_2way',
        'home', 2.05, 'decimal', 2.05, now(), 'CAPTURED_ON_TIME', $2)
      RETURNING id
    `,
    [matchId, hash(`${versionLabel}-entry`)]
  );
  const entry = await client.query(
    `SELECT * FROM append_forecast_stage($1::uuid, 'entry', $2::jsonb, $3::uuid)`,
    [matchId, JSON.stringify({ decimal_odds: 2.05 }), entryEvidence.rows[0].id]
  );

  const context = await client.query(
    `
      INSERT INTO forecast_context_snapshots (
        match_id, lineup_confirmed, batting_order_complete, pitchers_confirmed,
        bullpen_context_complete, goalkeeper_confirmed, completeness_flag,
        source_payload_hash
      )
      VALUES ($1, true, true, true, true, true, 'complete', $2)
      RETURNING id
    `,
    [matchId, hash(`${versionLabel}-context`)]
  );
  await client.query(
    `SELECT * FROM append_forecast_stage($1::uuid, 'context', '{}'::jsonb, NULL, $2::uuid)`,
    [matchId, context.rows[0].id]
  );

  const closingEvidence = await client.query(
    `
      INSERT INTO forecast_evidence (
        match_id, source_type, provider_name, bookmaker, market_type,
        selection, odds_value, odds_format, decimal_odds, captured_at,
        timing_quality, raw_payload_hash
      )
      VALUES ($1, 'provider_api', 'test_provider', 'test_book', 'moneyline_2way',
        'home', 1.95, 'decimal', 1.95, now(), 'CAPTURED_ON_TIME', $2)
      RETURNING id
    `,
    [matchId, hash(`${versionLabel}-closing`)]
  );
  const closing = await client.query(
    `SELECT * FROM append_forecast_stage($1::uuid, 'closing', $2::jsonb, $3::uuid)`,
    [matchId, JSON.stringify({ decimal_odds: 1.95 }), closingEvidence.rows[0].id]
  );
  const result = await client.query(
    `SELECT * FROM append_forecast_stage($1::uuid, 'result', $2::jsonb)`,
    [matchId, JSON.stringify({ result: "win", verified: true })]
  );
  const clv = await client.query(
    `SELECT * FROM append_forecast_stage($1::uuid, 'clv', $2::jsonb)`,
    [matchId, JSON.stringify({
      clv_percent: 0.05128205128205132,
      clv_formula_version: "decimal_price_ratio_v1"
    })]
  );

  const verified = await client.query("SELECT verify_forecast_chain($1::uuid) AS valid", [matchId]);
  assert.equal(verified.rows[0].valid, true);

  const clvRecord = await client.query(
    `
      INSERT INTO forecast_clv_records (
        match_id, entry_chain_id, closing_chain_id, result_chain_id,
        clv_chain_id, model_version_id, entry_odds, closing_odds,
        clv_percent, result, chain_verified, clean_sample
      )
      VALUES ($1, $2, $3, $4, $5, $6, 2.05, 1.95, 0.05128205, 'win', false, true)
      RETURNING chain_verified, clean_sample
    `,
    [matchId, entry.rows[0].id, closing.rows[0].id, result.rows[0].id, clv.rows[0].id, version.rows[0].id]
  );
  assert.equal(clvRecord.rows[0].chain_verified, true);
  assert.equal(clvRecord.rows[0].clean_sample, true);

  await expectRejected("chain_update", () => client.query(
    "UPDATE forecast_chain SET value_json = '{\"tampered\":true}'::jsonb WHERE match_id = $1",
    [matchId]
  ));
  await expectRejected("match_direct_update", () => client.query(
    "UPDATE forecast_matches SET status = 'live' WHERE match_id = $1",
    [matchId]
  ));

  const status = await client.query("SELECT (update_forecast_match_status($1::uuid, 'live')).status AS status", [matchId]);
  assert.equal(status.rows[0].status, "live");

  await client.query("ROLLBACK");
  console.log("forecast chain database tests ok");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
