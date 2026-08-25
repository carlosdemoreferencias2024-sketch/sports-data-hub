-- Append-only forecast audit chain for PostgreSQL 14+.
-- The operational matches table remains mutable because ingestion legitimately
-- corrects kickoff, provider metadata, scores, and live state. forecast_matches
-- freezes the identity used by the audited forecast chain.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION forecast_block_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Operation % is not allowed on append-only table %', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- 1. Immutable match projection used by the forecast chain.
CREATE TABLE IF NOT EXISTS forecast_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL UNIQUE REFERENCES matches(id) ON DELETE RESTRICT,
  sport_slug varchar(40) NOT NULL,
  league_slug varchar(100) NOT NULL,
  home_team varchar(160) NOT NULL,
  away_team varchar(160) NOT NULL,
  scheduled_start timestamptz NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'live', 'finished', 'postponed', 'cancelled', 'void')),
  source_fingerprint char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forecast_matches_start ON forecast_matches(scheduled_start);
CREATE INDEX IF NOT EXISTS idx_forecast_matches_status ON forecast_matches(status);

CREATE OR REPLACE FUNCTION register_forecast_match(p_match_id uuid)
RETURNS forecast_matches AS $$
DECLARE
  result forecast_matches;
BEGIN
  INSERT INTO forecast_matches (
    match_id, sport_slug, league_slug, home_team, away_team,
    scheduled_start, status, source_fingerprint
  )
  SELECT
    m.id,
    s.slug,
    l.slug,
    home_team.name,
    away_team.name,
    m.match_date,
    m.status::text,
    encode(digest(convert_to(concat_ws('|',
      m.id::text, s.slug, l.slug, home_team.name, away_team.name,
      to_char(m.match_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    ), 'UTF8'), 'sha256'), 'hex')
  FROM matches m
  JOIN leagues l ON l.id = m.league_id
  JOIN sports s ON s.id = l.sport_id
  JOIN match_competitors home_competitor
    ON home_competitor.match_id = m.id AND home_competitor.home_away = 'home'
  JOIN teams home_team ON home_team.id = home_competitor.team_id
  JOIN match_competitors away_competitor
    ON away_competitor.match_id = m.id AND away_competitor.home_away = 'away'
  JOIN teams away_team ON away_team.id = away_competitor.team_id
  WHERE m.id = p_match_id
  ON CONFLICT (match_id) DO NOTHING;

  SELECT * INTO result FROM forecast_matches WHERE match_id = p_match_id;
  IF result.id IS NULL THEN
    RAISE EXCEPTION 'Operational match % does not exist or lacks competitors', p_match_id;
  END IF;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION forecast_match_mutation_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE is not allowed on forecast_matches';
  END IF;
  IF current_setting('forecast.allow_status_update', true) IS DISTINCT FROM 'on'
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.match_id IS DISTINCT FROM NEW.match_id
     OR OLD.sport_slug IS DISTINCT FROM NEW.sport_slug
     OR OLD.league_slug IS DISTINCT FROM NEW.league_slug
     OR OLD.home_team IS DISTINCT FROM NEW.home_team
     OR OLD.away_team IS DISTINCT FROM NEW.away_team
     OR OLD.scheduled_start IS DISTINCT FROM NEW.scheduled_start
     OR OLD.source_fingerprint IS DISTINCT FROM NEW.source_fingerprint
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Only status can change through update_forecast_match_status()';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_forecast_match_mutation_guard ON forecast_matches;
CREATE TRIGGER trg_forecast_match_mutation_guard
  BEFORE UPDATE OR DELETE ON forecast_matches
  FOR EACH ROW EXECUTE FUNCTION forecast_match_mutation_guard();

CREATE OR REPLACE FUNCTION update_forecast_match_status(p_match_id uuid, p_new_status text)
RETURNS forecast_matches AS $$
DECLARE
  current_status text;
  result forecast_matches;
BEGIN
  IF p_new_status NOT IN ('scheduled', 'live', 'finished', 'postponed', 'cancelled', 'void') THEN
    RAISE EXCEPTION 'Invalid forecast match status %', p_new_status;
  END IF;

  SELECT status INTO current_status
  FROM forecast_matches
  WHERE match_id = p_match_id
  FOR UPDATE;

  IF current_status IS NULL THEN
    RAISE EXCEPTION 'Forecast match % does not exist', p_match_id;
  END IF;
  IF current_status = p_new_status THEN
    SELECT * INTO result FROM forecast_matches WHERE match_id = p_match_id;
    RETURN result;
  END IF;
  IF NOT (
    (current_status = 'scheduled' AND p_new_status IN ('live', 'postponed', 'cancelled', 'void'))
    OR (current_status = 'live' AND p_new_status IN ('finished', 'postponed', 'cancelled', 'void'))
    OR (current_status = 'postponed' AND p_new_status IN ('scheduled', 'cancelled', 'void'))
  ) THEN
    RAISE EXCEPTION 'Invalid forecast status transition % -> %', current_status, p_new_status;
  END IF;

  PERFORM set_config('forecast.allow_status_update', 'on', true);
  UPDATE forecast_matches SET status = p_new_status WHERE match_id = p_match_id
  RETURNING * INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 2. Evidence for market entry/closing prices.
CREATE TABLE IF NOT EXISTS forecast_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  odds_snapshot_id uuid REFERENCES odds_snapshots(id) ON DELETE RESTRICT,
  source_type varchar(30) NOT NULL CHECK (source_type IN ('provider_api', 'manual_verified')),
  provider_name varchar(100) NOT NULL,
  bookmaker varchar(120) NOT NULL,
  market_type varchar(40) NOT NULL,
  selection varchar(40) NOT NULL,
  line numeric(10, 3),
  odds_value numeric(14, 4) NOT NULL CHECK (odds_value <> 0),
  odds_format varchar(20) NOT NULL CHECK (odds_format IN ('decimal', 'american', 'fractional')),
  decimal_odds numeric(14, 4) NOT NULL CHECK (decimal_odds > 1),
  captured_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  timing_quality varchar(30) NOT NULL DEFAULT 'UNKNOWN'
    CHECK (timing_quality IN ('CAPTURED_ON_TIME', 'EARLY', 'LATE', 'AUDIT_ONLY', 'UNKNOWN')),
  source_url text,
  screenshot_sha256 char(64),
  verified_by varchar(160),
  verification_notes text,
  raw_payload_hash char(64) NOT NULL,
  CHECK (
    source_type <> 'manual_verified'
    OR (source_url IS NOT NULL AND screenshot_sha256 IS NOT NULL AND verified_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_forecast_evidence_match_capture
  ON forecast_evidence(match_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_evidence_market
  ON forecast_evidence(bookmaker, market_type, selection, captured_at DESC);

-- 3. Immutable context observations. Partial rows remain auditable, but only a
-- complete context row can advance the chain.
CREATE TABLE IF NOT EXISTS forecast_context_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  model_feature_id uuid REFERENCES model_features(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL DEFAULT now(),
  lineup_confirmed boolean NOT NULL DEFAULT false,
  batting_order_complete boolean NOT NULL DEFAULT false,
  pitchers_confirmed boolean NOT NULL DEFAULT false,
  bullpen_context_complete boolean NOT NULL DEFAULT false,
  goalkeeper_confirmed boolean NOT NULL DEFAULT false,
  injuries_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  weather_json jsonb,
  missing_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  completeness_flag varchar(20) NOT NULL DEFAULT 'partial'
    CHECK (completeness_flag IN ('complete', 'partial', 'missing')),
  source_url text,
  source_payload_hash char(64),
  CONSTRAINT forecast_context_complete_integrity CHECK (
    completeness_flag <> 'complete'
    OR (missing_fields_json = '[]'::jsonb AND source_payload_hash IS NOT NULL)
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'forecast_context_complete_integrity'
      AND conrelid = 'forecast_context_snapshots'::regclass
  ) THEN
    ALTER TABLE forecast_context_snapshots
      ADD CONSTRAINT forecast_context_complete_integrity CHECK (
        completeness_flag <> 'complete'
        OR (missing_fields_json = '[]'::jsonb AND source_payload_hash IS NOT NULL)
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_forecast_context_match_capture
  ON forecast_context_snapshots(match_id, captured_at DESC);

-- 4. Model provenance for strict walk-forward auditing.
CREATE TABLE IF NOT EXISTS forecast_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_label varchar(160) NOT NULL UNIQUE,
  sport_slug varchar(40) NOT NULL,
  model_name varchar(100) NOT NULL,
  training_cutoff_date date NOT NULL,
  trained_at timestamptz NOT NULL,
  artifact_sha256 char(64) NOT NULL,
  config_sha256 char(64),
  feature_schema_version varchar(80),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (training_cutoff_date <= trained_at::date)
);

CREATE INDEX IF NOT EXISTS idx_forecast_model_versions_model
  ON forecast_model_versions(sport_slug, model_name, training_cutoff_date DESC);

-- 5. Strict stage chain: fair_odds -> entry -> context -> closing -> result -> clv.
CREATE TABLE IF NOT EXISTS forecast_chain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  stage varchar(20) NOT NULL
    CHECK (stage IN ('fair_odds', 'entry', 'context', 'closing', 'result', 'clv')),
  evidence_id uuid REFERENCES forecast_evidence(id) ON DELETE RESTRICT,
  context_id uuid REFERENCES forecast_context_snapshots(id) ON DELETE RESTRICT,
  model_version_id uuid REFERENCES forecast_model_versions(id) ON DELETE RESTRICT,
  model_quote_id uuid REFERENCES model_quotes(id) ON DELETE RESTRICT,
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  sequence_num integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  chain_hash char(64) NOT NULL,
  prev_chain_hash char(64),
  CHECK (
    (stage = 'fair_odds' AND model_version_id IS NOT NULL AND model_quote_id IS NOT NULL)
    OR (stage IN ('entry', 'closing') AND evidence_id IS NOT NULL)
    OR (stage = 'context' AND context_id IS NOT NULL)
    OR stage IN ('result', 'clv')
  ),
  UNIQUE (match_id, stage),
  UNIQUE (match_id, sequence_num)
);

CREATE INDEX IF NOT EXISTS idx_forecast_chain_match_sequence
  ON forecast_chain(match_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_forecast_chain_stage_created
  ON forecast_chain(stage, created_at DESC);

CREATE OR REPLACE FUNCTION forecast_chain_hash_value(
  p_match_id uuid,
  p_sequence_num integer,
  p_stage text,
  p_evidence_id uuid,
  p_context_id uuid,
  p_model_version_id uuid,
  p_model_quote_id uuid,
  p_value_json jsonb,
  p_created_at timestamptz,
  p_prev_chain_hash text
)
RETURNS text AS $$
  SELECT encode(digest(convert_to(concat_ws(E'\x1f',
    p_match_id::text,
    p_sequence_num::text,
    p_stage,
    COALESCE(p_evidence_id::text, ''),
    COALESCE(p_context_id::text, ''),
    COALESCE(p_model_version_id::text, ''),
    COALESCE(p_model_quote_id::text, ''),
    COALESCE(p_value_json, '{}'::jsonb)::text,
    to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    COALESCE(p_prev_chain_hash, '')
  ), 'UTF8'), 'sha256'), 'hex');
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION forecast_chain_before_insert()
RETURNS trigger AS $$
DECLARE
  previous_stage text;
  previous_sequence integer;
  previous_hash text;
  expected_previous text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.match_id::text, 0));

  IF NOT EXISTS (SELECT 1 FROM forecast_matches WHERE match_id = NEW.match_id) THEN
    RAISE EXCEPTION 'Forecast match % is not registered', NEW.match_id;
  END IF;

  SELECT stage, sequence_num, chain_hash
  INTO previous_stage, previous_sequence, previous_hash
  FROM forecast_chain
  WHERE match_id = NEW.match_id
  ORDER BY sequence_num DESC
  LIMIT 1;

  expected_previous := CASE NEW.stage
    WHEN 'fair_odds' THEN NULL
    WHEN 'entry' THEN 'fair_odds'
    WHEN 'context' THEN 'entry'
    WHEN 'closing' THEN 'context'
    WHEN 'result' THEN 'closing'
    WHEN 'clv' THEN 'result'
  END;

  IF NEW.stage = 'fair_odds' AND previous_stage IS NOT NULL THEN
    RAISE EXCEPTION 'fair_odds must be the first stage for match %', NEW.match_id;
  ELSIF NEW.stage <> 'fair_odds' AND previous_stage IS DISTINCT FROM expected_previous THEN
    RAISE EXCEPTION 'Stage % requires previous stage %, found %', NEW.stage, expected_previous, COALESCE(previous_stage, 'none');
  END IF;

  IF NEW.evidence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM forecast_evidence WHERE id = NEW.evidence_id AND match_id = NEW.match_id
  ) THEN
    RAISE EXCEPTION 'Evidence % does not belong to match %', NEW.evidence_id, NEW.match_id;
  END IF;
  IF NEW.context_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM forecast_context_snapshots
    WHERE id = NEW.context_id AND match_id = NEW.match_id AND completeness_flag = 'complete'
  ) THEN
    RAISE EXCEPTION 'Context % is missing, partial, or belongs to another match', NEW.context_id;
  END IF;
  IF NEW.model_quote_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM model_quotes WHERE id = NEW.model_quote_id AND match_id = NEW.match_id
  ) THEN
    RAISE EXCEPTION 'Model quote % does not belong to match %', NEW.model_quote_id, NEW.match_id;
  END IF;

  NEW.sequence_num := COALESCE(previous_sequence, 0) + 1;
  NEW.prev_chain_hash := previous_hash;
  NEW.created_at := COALESCE(NEW.created_at, now());
  NEW.chain_hash := forecast_chain_hash_value(
    NEW.match_id, NEW.sequence_num, NEW.stage, NEW.evidence_id,
    NEW.context_id, NEW.model_version_id, NEW.model_quote_id,
    NEW.value_json, NEW.created_at, NEW.prev_chain_hash
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_forecast_chain_before_insert ON forecast_chain;
CREATE TRIGGER trg_forecast_chain_before_insert
  BEFORE INSERT ON forecast_chain
  FOR EACH ROW EXECUTE FUNCTION forecast_chain_before_insert();

CREATE OR REPLACE FUNCTION append_forecast_stage(
  p_match_id uuid,
  p_stage text,
  p_value_json jsonb DEFAULT '{}'::jsonb,
  p_evidence_id uuid DEFAULT NULL,
  p_context_id uuid DEFAULT NULL,
  p_model_version_id uuid DEFAULT NULL,
  p_model_quote_id uuid DEFAULT NULL
)
RETURNS forecast_chain AS $$
DECLARE
  result forecast_chain;
BEGIN
  INSERT INTO forecast_chain (
    match_id, stage, evidence_id, context_id, model_version_id,
    model_quote_id, value_json, sequence_num, chain_hash
  )
  VALUES (
    p_match_id, p_stage, p_evidence_id, p_context_id, p_model_version_id,
    p_model_quote_id, COALESCE(p_value_json, '{}'::jsonb), 0, repeat('0', 64)
  )
  RETURNING * INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION verify_forecast_chain(p_match_id uuid)
RETURNS boolean AS $$
  WITH ordered AS (
    SELECT
      chain.*,
      row_number() OVER (ORDER BY sequence_num)::integer AS expected_sequence,
      lag(chain_hash) OVER (ORDER BY sequence_num) AS expected_previous_hash
    FROM forecast_chain chain
    WHERE match_id = p_match_id
  )
  SELECT COUNT(*) > 0 AND bool_and(
    sequence_num = expected_sequence
    AND prev_chain_hash IS NOT DISTINCT FROM expected_previous_hash
    AND chain_hash = forecast_chain_hash_value(
      match_id, sequence_num, stage, evidence_id, context_id,
      model_version_id, model_quote_id, value_json, created_at, prev_chain_hash
    )
  )
  FROM ordered;
$$ LANGUAGE sql STABLE;

-- 6. Derived CLV record tied to the immutable chain.
CREATE TABLE IF NOT EXISTS forecast_clv_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  entry_chain_id uuid NOT NULL REFERENCES forecast_chain(id) ON DELETE RESTRICT,
  closing_chain_id uuid NOT NULL REFERENCES forecast_chain(id) ON DELETE RESTRICT,
  result_chain_id uuid NOT NULL REFERENCES forecast_chain(id) ON DELETE RESTRICT,
  clv_chain_id uuid NOT NULL REFERENCES forecast_chain(id) ON DELETE RESTRICT,
  model_version_id uuid NOT NULL REFERENCES forecast_model_versions(id) ON DELETE RESTRICT,
  entry_odds numeric(14, 4) NOT NULL CHECK (entry_odds > 1),
  closing_odds numeric(14, 4) NOT NULL CHECK (closing_odds > 1),
  clv_percent numeric(12, 8) NOT NULL,
  result varchar(20) NOT NULL CHECK (result IN ('win', 'loss', 'push', 'void')),
  chain_verified boolean NOT NULL,
  clean_sample boolean NOT NULL DEFAULT false,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT clean_sample OR chain_verified)
);

CREATE INDEX IF NOT EXISTS idx_forecast_clv_match ON forecast_clv_records(match_id);
CREATE INDEX IF NOT EXISTS idx_forecast_clv_clean ON forecast_clv_records(clean_sample, calculated_at DESC);

CREATE OR REPLACE FUNCTION forecast_clv_before_insert()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM forecast_chain WHERE id = NEW.entry_chain_id AND match_id = NEW.match_id AND stage = 'entry')
     OR NOT EXISTS (SELECT 1 FROM forecast_chain WHERE id = NEW.closing_chain_id AND match_id = NEW.match_id AND stage = 'closing')
     OR NOT EXISTS (SELECT 1 FROM forecast_chain WHERE id = NEW.result_chain_id AND match_id = NEW.match_id AND stage = 'result')
     OR NOT EXISTS (SELECT 1 FROM forecast_chain WHERE id = NEW.clv_chain_id AND match_id = NEW.match_id AND stage = 'clv') THEN
    RAISE EXCEPTION 'CLV chain references are incomplete or belong to another match';
  END IF;
  NEW.chain_verified := verify_forecast_chain(NEW.match_id);
  IF NEW.clean_sample AND NOT NEW.chain_verified THEN
    RAISE EXCEPTION 'A clean sample requires a valid forecast hash chain';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_forecast_clv_before_insert ON forecast_clv_records;
CREATE TRIGGER trg_forecast_clv_before_insert
  BEFORE INSERT ON forecast_clv_records
  FOR EACH ROW EXECUTE FUNCTION forecast_clv_before_insert();

-- 7. Append-only gate decisions. Policy thresholds are stored in every row so
-- future policy changes cannot rewrite why an old gate was READY/NOT_READY.
CREATE TABLE IF NOT EXISTS forecast_sample_gate_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version varchar(80) NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  sample_started_at timestamptz,
  sample_ended_at timestamptz,
  clean_sample_size integer NOT NULL CHECK (clean_sample_size >= 0),
  observation_weeks numeric(8, 3) NOT NULL DEFAULT 0 CHECK (observation_weeks >= 0),
  required_sample_size integer NOT NULL DEFAULT 300 CHECK (required_sample_size >= 1),
  required_min_weeks numeric(8, 3) NOT NULL DEFAULT 6 CHECK (required_min_weeks >= 0),
  clv_mean numeric(12, 8),
  clv_ci_lower numeric(12, 8),
  clv_ci_upper numeric(12, 8),
  calibration_ratio numeric(12, 8),
  calibration_diff_ci_upper numeric(12, 8),
  max_calibration_ratio numeric(12, 8) NOT NULL DEFAULT 1.0,
  walk_forward_passed boolean NOT NULL DEFAULT false,
  overall_status varchar(20) NOT NULL CHECK (overall_status IN ('READY', 'NOT_READY')),
  blocking_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  CHECK (
    overall_status <> 'READY'
    OR (
      clean_sample_size >= required_sample_size
      AND observation_weeks >= required_min_weeks
      AND clv_ci_lower > 0
      AND calibration_ratio < max_calibration_ratio
      AND calibration_diff_ci_upper < 0
      AND walk_forward_passed
      AND blocking_reasons_json = '[]'::jsonb
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_forecast_gate_checked
  ON forecast_sample_gate_status(checked_at DESC);

DO $$
DECLARE
  table_name text;
  trigger_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'forecast_evidence',
    'forecast_context_snapshots',
    'forecast_model_versions',
    'forecast_chain',
    'forecast_clv_records',
    'forecast_sample_gate_status'
  ]
  LOOP
    trigger_name := 'trg_' || table_name || '_append_only';
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = trigger_name) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forecast_block_mutation()',
        trigger_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

-- Defense-in-depth role template. The live deployment role should receive
-- SELECT/INSERT only for evidence, context, model versions, CLV, and gate rows.
-- forecast_chain INSERT should be revoked and append_forecast_stage EXECUTE
-- granted instead. forecast_matches UPDATE should be revoked and only
-- update_forecast_match_status EXECUTE granted.
--
-- REVOKE UPDATE, DELETE ON forecast_evidence, forecast_context_snapshots,
--   forecast_model_versions, forecast_chain, forecast_clv_records,
--   forecast_sample_gate_status, forecast_matches FROM forecast_app;
-- REVOKE INSERT ON forecast_chain FROM forecast_app;
-- GRANT EXECUTE ON FUNCTION append_forecast_stage(uuid, text, jsonb, uuid, uuid, uuid, uuid) TO forecast_app;
-- GRANT EXECUTE ON FUNCTION update_forecast_match_status(uuid, text) TO forecast_app;
