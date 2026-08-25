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
  let candidate = await client.query(`
    SELECT m.id AS match_id, mq.id AS model_quote_id
    FROM matches m
    JOIN leagues l ON l.id = m.league_id
    JOIN sports s ON s.id = l.sport_id
    JOIN model_quotes mq ON mq.match_id = m.id
    WHERE m.status = 'scheduled'
      AND s.slug = 'baseball'
      AND l.slug = 'mlb'
      AND m.match_date BETWEEN now() + INTERVAL '20 minutes' AND now() + INTERVAL '24 hours'
    ORDER BY m.match_date, mq.generated_at DESC
    LIMIT 1
  `);
  if (!candidate.rows[0]) {
    const fixture = await client.query(`
      SELECT
        m.id AS source_match_id,
        m.league_id,
        m.season_id,
        m.venue_id,
        mq.id AS source_quote_id,
        home.team_id AS home_team_id,
        away.team_id AS away_team_id
      FROM matches m
      JOIN leagues l ON l.id = m.league_id
      JOIN sports s ON s.id = l.sport_id
      JOIN model_quotes mq ON mq.match_id = m.id
      JOIN match_competitors home
        ON home.match_id = m.id AND home.home_away = 'home'
      JOIN match_competitors away
        ON away.match_id = m.id AND away.home_away = 'away'
      WHERE s.slug = 'baseball' AND l.slug = 'mlb'
      ORDER BY mq.generated_at DESC
      LIMIT 1
    `);
    assert.ok(fixture.rows[0], "an existing MLB match and model quote are required for the transactional fixture");
    const fixtureMatchId = randomUUID();
    await client.query(`
      INSERT INTO matches (
        id, league_id, season_id, venue_id, slug, match_date, status, raw_data
      ) VALUES (
        $1, $2, $3, $4, $5, clock_timestamp() + INTERVAL '2 hours', 'scheduled',
        jsonb_build_object('test_fixture', true, 'transactional', true)
      )
    `, [
      fixtureMatchId,
      fixture.rows[0].league_id,
      fixture.rows[0].season_id,
      fixture.rows[0].venue_id,
      `forecast-inclusion-test-${fixtureMatchId}`
    ]);
    await client.query(`
      INSERT INTO match_competitors (match_id, team_id, home_away)
      VALUES ($1, $2, 'home'), ($1, $3, 'away')
    `, [fixtureMatchId, fixture.rows[0].home_team_id, fixture.rows[0].away_team_id]);
    const fixtureQuote = await client.query(`
      INSERT INTO model_quotes (
        match_id, model_name, market_type, home_probability, away_probability,
        draw_probability, home_fair_odds, away_fair_odds, draw_fair_odds,
        confidence, generated_at, raw_data
      )
      SELECT
        $1, model_name, market_type, home_probability, away_probability,
        draw_probability, home_fair_odds, away_fair_odds, draw_fair_odds,
        confidence, clock_timestamp(), raw_data || '{"test_fixture":true}'::jsonb
      FROM model_quotes
      WHERE id = $2
      RETURNING id
    `, [fixtureMatchId, fixture.rows[0].source_quote_id]);
    candidate = { rows: [{ match_id: fixtureMatchId, model_quote_id: fixtureQuote.rows[0].id }] };
  }
  const { match_id: matchId, model_quote_id: modelQuoteId } = candidate.rows[0];
  await client.query("SELECT * FROM register_forecast_match($1::uuid)", [matchId]);

  const versionLabel = `inclusion-test-${randomUUID()}`;
  const version = await client.query(`
    INSERT INTO forecast_model_versions (
      version_label, sport_slug, model_name, training_cutoff_date,
      trained_at, artifact_sha256, feature_schema_version
    ) VALUES ($1, 'baseball', 'inclusion_test', current_date - 1, now(), $2, 'test-v1')
    RETURNING id
  `, [versionLabel, hash(versionLabel)]);

  await expectRejected("fair_odds_missing_probabilities", () => client.query(
    `SELECT * FROM append_forecast_stage($1::uuid, 'fair_odds', '{"fair_odds":1.9}'::jsonb, NULL, NULL, $2::uuid, $3::uuid)`,
    [matchId, version.rows[0].id, modelQuoteId]
  ));

  await client.query(
    `SELECT * FROM append_forecast_stage($1::uuid, 'fair_odds', $2::jsonb, NULL, NULL, $3::uuid, $4::uuid)`,
    [matchId, JSON.stringify({
      fair_odds: 1.9,
      model_predicted_prob: 0.52631579,
      market_implied_prob: 0.5,
      fair_odds_method_version: "owned_fair_odds_v1"
    }), version.rows[0].id, modelQuoteId]
  );

  const primary = await client.query(`
    INSERT INTO forecast_evidence (
      match_id, source_type, provider_name, bookmaker, market_type,
      selection, odds_value, odds_format, decimal_odds, captured_at,
      timing_quality, raw_payload_hash
    ) VALUES ($1, 'provider_api', 'provider_a', 'book_a', 'moneyline_2way',
      'home', 2.0, 'decimal', 2.0, now(), 'UNKNOWN', $2)
    RETURNING id
  `, [matchId, hash(`${versionLabel}-primary`)]);
  await client.query(`
    INSERT INTO forecast_evidence (
      match_id, source_type, provider_name, bookmaker, market_type,
      selection, odds_value, odds_format, decimal_odds, captured_at,
      timing_quality, raw_payload_hash
    ) VALUES ($1, 'provider_api', 'provider_b', 'book_b', 'moneyline_2way',
      'home', 2.02, 'decimal', 2.02, now(), 'UNKNOWN', $2)
  `, [matchId, hash(`${versionLabel}-secondary`)]);
  await client.query(
    `SELECT * FROM append_forecast_stage($1::uuid, 'entry', '{"decimal_odds":2.0}'::jsonb, $2::uuid)`,
    [matchId, primary.rows[0].id]
  );

  const prospective = await client.query(`
    SELECT * FROM forecast_inclusion_decisions
    WHERE match_id = $1 AND cohort = 'PROSPECTIVE_SHADOW'
  `, [matchId]);
  assert.equal(
    prospective.rows[0].decision,
    "INCLUDED",
    `unexpected exclusion reasons: ${JSON.stringify(prospective.rows[0].reasons_json)}`
  );
  assert.deepEqual(prospective.rows[0].reasons_json, []);

  await expectRejected("future_match_as_historical", () => client.query(
    "SELECT * FROM record_forecast_inclusion_decision($1::uuid, 'HISTORICAL_BACKTEST')",
    [matchId]
  ));

  const latestCriteria = await client.query(`
    SELECT id FROM forecast_inclusion_criteria
    WHERE cohort = 'PROSPECTIVE_SHADOW' AND sport_slug = 'baseball'
    ORDER BY effective_from DESC LIMIT 1
  `);
  await expectRejected("backdated_prospective_criteria", () => client.query(`
    INSERT INTO forecast_inclusion_criteria (
      version_label, cohort, sport_slug, leagues_json, markets_json,
      min_entry_lead_minutes, max_entry_lead_minutes,
      fair_odds_method_version, effective_from, supersedes_criteria_id, criteria_hash
    ) VALUES ($1, 'PROSPECTIVE_SHADOW', 'baseball', '["mlb"]', '["moneyline_2way"]',
      20, 1440, 'owned_fair_odds_v1', now() - INTERVAL '1 day', $2, $3)
  `, [`backdated-${randomUUID()}`, latestCriteria.rows[0].id, hash("placeholder") ]));

  await expectRejected("decision_update", () => client.query(
    "UPDATE forecast_inclusion_decisions SET decision = 'EXCLUDED' WHERE id = $1",
    [prospective.rows[0].id]
  ));

  const gateCount = await client.query("SELECT count(*)::int AS count FROM forecast_gate_dataset");
  assert.equal(gateCount.rows[0].count, 0);

  await client.query("ROLLBACK");
  console.log("forecast inclusion database tests ok");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
