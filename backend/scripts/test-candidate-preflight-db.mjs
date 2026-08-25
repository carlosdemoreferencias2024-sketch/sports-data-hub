import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
const hash = (value) => createHash("sha256").update(value).digest("hex");

await client.connect();
try {
  await client.query("BEGIN");
  let match = await client.query(`
    SELECT m.id
    FROM matches m
    WHERE m.status = 'scheduled'
      AND m.match_date BETWEEN clock_timestamp() + INTERVAL '30 minutes' AND clock_timestamp() + INTERVAL '23 hours'
      AND NOT EXISTS (
        SELECT 1 FROM forecast_chain chain WHERE chain.match_id = m.id AND chain.stage = 'entry'
      )
    ORDER BY m.match_date
    LIMIT 1
  `);
  if (!match.rows[0]) {
    const fixture = await client.query(`
      SELECT
        m.league_id,
        m.season_id,
        m.venue_id,
        home.team_id AS home_team_id,
        away.team_id AS away_team_id
      FROM matches m
      JOIN match_competitors home
        ON home.match_id = m.id AND home.home_away = 'home'
      JOIN match_competitors away
        ON away.match_id = m.id AND away.home_away = 'away'
      ORDER BY m.created_at
      LIMIT 1
    `);
    assert.ok(fixture.rows[0], "an existing match with home and away teams is required for the transactional fixture");
    const fixtureMatchId = randomUUID();
    const fixtureSlug = `candidate-preflight-test-${fixtureMatchId}`;
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
      fixtureSlug
    ]);
    await client.query(`
      INSERT INTO match_competitors (match_id, team_id, home_away)
      VALUES ($1, $2, 'home'), ($1, $3, 'away')
    `, [fixtureMatchId, fixture.rows[0].home_team_id, fixture.rows[0].away_team_id]);
    match = { rows: [{ id: fixtureMatchId }] };
  }
  const matchId = match.rows[0].id;
  const forecastMatch = await client.query("SELECT * FROM register_forecast_match($1::uuid)", [matchId]);
  const kickoff = new Date(forecastMatch.rows[0].scheduled_start);
  const now = new Date();
  const leadMinutes = (kickoff.getTime() - now.getTime()) / 60_000;
  const capturedAt = new Date(now.getTime() - Math.min(30, Math.max(1, 1440 - leadMinutes)) * 60_000);
  const decisionAsOf = new Date(now.getTime() + 2000);
  const token = randomUUID();
  const evidenceSuffix = token.replaceAll("-", "").slice(0, 12);
  const homeEvidenceId = `00000000-0000-4000-8000-${evidenceSuffix}`;
  const drawEvidenceId = `88888888-8888-4888-8888-${evidenceSuffix}`;
  const awayEvidenceId = `ffffffff-ffff-4fff-bfff-${evidenceSuffix}`;

  await client.query(
    "SELECT * FROM validate_forecast_schedule($1::uuid, false, false, $2::timestamptz, NULL, $3)",
    [matchId, kickoff.toISOString(), "candidate-db-test"]
  );
  await client.query(
    "SELECT * FROM register_forecast_provider_mapping($1::uuid, $2, $3, NULL, $4)",
    [matchId, `test-${token}`, token, "candidate-db-test"]
  );

  const evidence = await client.query(`
    INSERT INTO forecast_evidence (
      id, match_id, source_type, provider_name, bookmaker, market_type, selection,
      odds_value, odds_format, decimal_odds, captured_at, timing_quality,
      source_url, screenshot_sha256, verified_by, raw_payload_hash
    ) VALUES
      ($1, $4, 'manual_verified', $5, 'TestBook', 'moneyline_3way', 'home',
       2.85, 'decimal', 2.85, $6, 'UNKNOWN', 'https://example.test/entry',
       $7, 'candidate-db-test', $8),
      ($2, $4, 'manual_verified', $5, 'TestBook', 'moneyline_3way', 'draw',
       3.25, 'decimal', 3.25, $6, 'UNKNOWN', 'https://example.test/entry',
       $7, 'candidate-db-test', $8),
      ($3, $4, 'manual_verified', $5, 'TestBook', 'moneyline_3way', 'away',
       2.55, 'decimal', 2.55, $6, 'UNKNOWN', 'https://example.test/entry',
       $7, 'candidate-db-test', $8)
    RETURNING id, selection
  `, [
    homeEvidenceId,
    drawEvidenceId,
    awayEvidenceId,
    matchId,
    `test-${token}`,
    capturedAt.toISOString(),
    hash(`${token}-shot`),
    hash(`${token}-raw`)
  ]);
  for (const row of evidence.rows) {
    await client.query(
      "SELECT * FROM register_forecast_evidence_role($1::uuid, 'entry', 'candidate-db-test')",
      [row.id]
    );
  }

  const context = await client.query(`
    INSERT INTO forecast_context_snapshots (
      match_id, captured_at, lineup_confirmed, batting_order_complete,
      pitchers_confirmed, bullpen_context_complete, goalkeeper_confirmed,
      missing_fields_json, completeness_flag, source_url, source_payload_hash
    ) VALUES (
      $1, $2, true, true, true, true, true, '[]'::jsonb, 'complete',
      'https://example.test/context', $3
    ) RETURNING id
  `, [matchId, capturedAt.toISOString(), hash(`${token}-context`)]);
  assert.ok(context.rows[0]);

  const version = await client.query(`
    INSERT INTO forecast_model_versions (
      version_label, sport_slug, model_name, training_cutoff_date, trained_at,
      artifact_sha256, feature_schema_version
    ) VALUES ($1, $2, 'sports_data_hub_football_fair_odds_v3', current_date - 1,
      clock_timestamp() - INTERVAL '1 second', $3, 'football_context_xg_elo_v3')
    RETURNING id
  `, [`candidate-${token}`, forecastMatch.rows[0].sport_slug, hash(`${token}-artifact`)]);
  const quote = await client.query(`
    INSERT INTO model_quotes (
      match_id, model_name, market_type, home_probability, away_probability,
      draw_probability, home_fair_odds, away_fair_odds, draw_fair_odds,
      confidence, generated_at, raw_data
    ) VALUES (
      $1, 'sports_data_hub_football_fair_odds_v3', 'moneyline_3way',
      0.384765, 0.351470, 0.263765, 2.5990, 2.8452, 3.7913, 0.70,
      clock_timestamp(), jsonb_build_object(
        'owned_fair_odds', true,
        'market_inputs_used', false,
        'immutable_candidate_input', true,
        'model_version_id', $2::text
      )
    ) RETURNING id
  `, [matchId, version.rows[0].id]);

  const before = await client.query(
    "SELECT * FROM candidate_preflight($1::uuid, $2::timestamptz)",
    [matchId, decisionAsOf.toISOString()]
  );
  assert.equal(before.rows[0].verdict, "PASS", JSON.stringify(before.rows[0].reasons_json));
  assert.equal(before.rows[0].model_quote_id, quote.rows[0].id);
  assert.equal(before.rows[0].entry_evidence_id, homeEvidenceId);
  assert.equal(Number(before.rows[0].decimal_odds), 2.85);
  assert.equal(Number(before.rows[0].model_probability), 0.384765);
  assert.ok(Math.abs(Number(before.rows[0].expected_value) - 0.09658025) < 1e-8);
  assert.notEqual(before.rows[0].entry_evidence_id, awayEvidenceId, "largest UUID must not win before EV is evaluated");
  const edgeAudit = await client.query(
    "SELECT * FROM forecast_candidate_edge_audit WHERE candidate_snapshot_id = $1::uuid",
    [before.rows[0].id]
  );
  assert.equal(edgeAudit.rows[0].selection_rule, "MAX_EV");
  assert.equal(edgeAudit.rows[0].selected_side, "home");
  assert.equal(edgeAudit.rows[0].considered.length, 3);
  assert.deepEqual(edgeAudit.rows[0].considered.map((row) => row.side), ["home", "away", "draw"]);
  const verified = await client.query("SELECT verify_candidate_snapshot($1::uuid) AS valid", [before.rows[0].id]);
  assert.equal(verified.rows[0].valid, true);

  const sourceFixture = await client.query(`
    SELECT
      m.league_id,
      m.season_id,
      m.venue_id,
      home.team_id AS home_team_id,
      away.team_id AS away_team_id
    FROM matches m
    JOIN match_competitors home
      ON home.match_id = m.id AND home.home_away = 'home'
    JOIN match_competitors away
      ON away.match_id = m.id AND away.home_away = 'away'
    WHERE m.id = $1
  `, [matchId]);
  assert.ok(sourceFixture.rows[0]);
  const noEvidenceMatchId = randomUUID();
  await client.query(`
    INSERT INTO matches (
      id, league_id, season_id, venue_id, slug, match_date, status, raw_data
    ) VALUES (
      $1, $2, $3, $4, $5, $6::timestamptz, 'scheduled',
      jsonb_build_object('test_fixture', true, 'candidate_preflight_no_evidence', true)
    )
  `, [
    noEvidenceMatchId,
    sourceFixture.rows[0].league_id,
    sourceFixture.rows[0].season_id,
    sourceFixture.rows[0].venue_id,
    `candidate-preflight-no-evidence-${noEvidenceMatchId}`,
    kickoff.toISOString()
  ]);
  await client.query(`
    INSERT INTO match_competitors (match_id, team_id, home_away)
    VALUES ($1, $2, 'home'), ($1, $3, 'away')
  `, [noEvidenceMatchId, sourceFixture.rows[0].home_team_id, sourceFixture.rows[0].away_team_id]);
  await client.query("SELECT * FROM register_forecast_match($1::uuid)", [noEvidenceMatchId]);
  await client.query(
    "SELECT * FROM validate_forecast_schedule($1::uuid, false, false, $2::timestamptz, NULL, $3)",
    [noEvidenceMatchId, kickoff.toISOString(), "candidate-db-test"]
  );
  await client.query(
    "SELECT * FROM register_forecast_provider_mapping($1::uuid, $2, $3, NULL, $4)",
    [noEvidenceMatchId, `test-no-evidence-${token}`, randomUUID(), "candidate-db-test"]
  );
  const noEvidenceQuote = await client.query(`
    INSERT INTO model_quotes (
      match_id, model_name, market_type, home_probability, away_probability,
      draw_probability, home_fair_odds, away_fair_odds, draw_fair_odds,
      confidence, generated_at, raw_data
    ) VALUES (
      $1, 'sports_data_hub_football_fair_odds_v3', 'moneyline_2way',
      0.55, 0.45, NULL, 1.8182, 2.2222, NULL, 0.70,
      clock_timestamp(), jsonb_build_object(
        'owned_fair_odds', true,
        'market_inputs_used', false,
        'immutable_candidate_input', true,
        'model_version_id', $2::text
      )
    ) RETURNING id
  `, [noEvidenceMatchId, version.rows[0].id]);
  const noEvidence = await client.query(
    "SELECT * FROM candidate_preflight($1::uuid, $2::timestamptz)",
    [noEvidenceMatchId, new Date(Date.now() + 3000).toISOString()]
  );
  assert.equal(noEvidence.rows[0].verdict, "FAIL");
  assert.ok(noEvidence.rows[0].reasons_json.includes("ENTRY_EVIDENCE_MISSING_AS_OF"));
  assert.ok(noEvidence.rows[0].reasons_json.includes("COMPLETE_CONTEXT_MISSING_AS_OF"));
  assert.ok(!noEvidence.rows[0].reasons_json.includes("FAIR_ODDS_MISSING_AS_OF"));
  assert.ok(!noEvidence.rows[0].reasons_json.includes("MODEL_MARKET_MISMATCH"));
  assert.equal(noEvidence.rows[0].model_quote_id, noEvidenceQuote.rows[0].id);

  await client.query(`
    INSERT INTO forecast_slate_validations (
      match_id, validation_type, result, details_json, verified_by, validated_at
    ) VALUES ($1, 'schedule', 'PLACEHOLDER_SCHEDULE', '{}', 'future-test', clock_timestamp())
  `, [matchId]);
  const after = await client.query(
    "SELECT * FROM candidate_preflight($1::uuid, $2::timestamptz)",
    [matchId, decisionAsOf.toISOString()]
  );
  assert.equal(after.rows[0].id, before.rows[0].id);
  assert.equal(after.rows[0].snapshot_hash, before.rows[0].snapshot_hash);
  assert.deepEqual(after.rows[0].reasons_json, before.rows[0].reasons_json);

  await client.query("SAVEPOINT immutable_quote");
  await assert.rejects(
    () => client.query("UPDATE model_quotes SET confidence = 0.1 WHERE id = $1", [quote.rows[0].id]),
    /append-only/
  );
  await client.query("ROLLBACK TO SAVEPOINT immutable_quote");
  await client.query("RELEASE SAVEPOINT immutable_quote");

  console.log("CANDIDATE_PREFLIGHT_DB_OK");
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
