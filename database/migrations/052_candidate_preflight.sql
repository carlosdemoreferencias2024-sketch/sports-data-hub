-- Candidate preflight evaluated before the entry/ticket chain stage.
-- All decisions are append-only, reproducible as-of, and isolated from future data.

CREATE TABLE IF NOT EXISTS forecast_provider_match_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  provider_name varchar(100) NOT NULL,
  external_match_id varchar(200) NOT NULL,
  evidence_id uuid REFERENCES forecast_evidence(id) ON DELETE RESTRICT,
  verified_by varchar(160) NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_name, external_match_id),
  UNIQUE (match_id, provider_name)
);

CREATE TABLE IF NOT EXISTS forecast_slate_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  validation_type varchar(20) NOT NULL CHECK (validation_type IN ('schedule', 'identity')),
  result varchar(30) NOT NULL CHECK (result IN ('VALID', 'PLACEHOLDER_SCHEDULE', 'ID_MISMATCH', 'PENDING_CHECK')),
  evidence_id uuid REFERENCES forecast_evidence(id) ON DELETE RESTRICT,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_by varchar(160) NOT NULL,
  validated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_forecast_slate_validation_asof
  ON forecast_slate_validations(match_id, validation_type, validated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS forecast_evidence_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL REFERENCES forecast_evidence(id) ON DELETE RESTRICT,
  evidence_role varchar(20) NOT NULL CHECK (evidence_role IN ('entry', 'current', 'near_start', 'closing', 'audit_only')),
  assigned_by varchar(160) NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (evidence_id, evidence_role)
);

CREATE TABLE IF NOT EXISTS forecast_freshness_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version varchar(80) NOT NULL,
  snapshot_type varchar(20) NOT NULL CHECK (snapshot_type IN ('entry', 'current', 'near_start', 'closing')),
  min_lead_minutes integer NOT NULL CHECK (min_lead_minutes >= 0),
  max_lead_minutes integer NOT NULL CHECK (max_lead_minutes >= min_lead_minutes),
  max_age_minutes integer NOT NULL CHECK (max_age_minutes > 0),
  effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (policy_version, snapshot_type, min_lead_minutes, max_lead_minutes)
);

INSERT INTO forecast_freshness_windows (
  policy_version, snapshot_type, min_lead_minutes, max_lead_minutes, max_age_minutes, effective_from
) VALUES
  ('candidate-preflight-v1', 'entry', 15, 1440, 1440, '-infinity'::timestamptz),
  ('candidate-preflight-v1', 'current', 1, 1440, 60, '-infinity'::timestamptz),
  ('candidate-preflight-v1', 'near_start', 60, 90, 45, '-infinity'::timestamptz),
  ('candidate-preflight-v1', 'near_start', 20, 45, 30, '-infinity'::timestamptz),
  ('candidate-preflight-v1', 'closing', 3, 10, 15, '-infinity'::timestamptz)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS forecast_snapshot_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  evidence_id uuid NOT NULL REFERENCES forecast_evidence(id) ON DELETE RESTRICT,
  snapshot_type varchar(20) NOT NULL CHECK (snapshot_type IN ('entry', 'current', 'near_start', 'closing')),
  decision_as_of timestamptz NOT NULL,
  policy_version varchar(80) NOT NULL,
  result varchar(30) NOT NULL CHECK (result IN ('VALID', 'STALE', 'POST_KICKOFF', 'FUTURE_CAPTURE', 'WINDOW_MISMATCH')),
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  validated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (evidence_id, snapshot_type, decision_as_of, policy_version)
);

ALTER TABLE forecast_context_snapshots
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz;

CREATE OR REPLACE FUNCTION forecast_context_recorded_at_guard()
RETURNS trigger AS $$
BEGIN
  NEW.recorded_at := clock_timestamp();
  IF NEW.captured_at > NEW.recorded_at + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Context captured_at cannot be in the future';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_00_forecast_context_recorded_at_guard ON forecast_context_snapshots;
CREATE TRIGGER trg_00_forecast_context_recorded_at_guard
  BEFORE INSERT ON forecast_context_snapshots
  FOR EACH ROW EXECUTE FUNCTION forecast_context_recorded_at_guard();

CREATE TABLE IF NOT EXISTS forecast_candidate_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  decision_as_of timestamptz NOT NULL,
  schedule_validation_id uuid REFERENCES forecast_slate_validations(id) ON DELETE RESTRICT,
  identity_validation_id uuid REFERENCES forecast_slate_validations(id) ON DELETE RESTRICT,
  freshness_validation_id uuid REFERENCES forecast_snapshot_validations(id) ON DELETE RESTRICT,
  entry_evidence_id uuid REFERENCES forecast_evidence(id) ON DELETE RESTRICT,
  context_id uuid REFERENCES forecast_context_snapshots(id) ON DELETE RESTRICT,
  fair_odds_chain_id uuid REFERENCES forecast_chain(id) ON DELETE RESTRICT,
  model_version_id uuid REFERENCES forecast_model_versions(id) ON DELETE RESTRICT,
  model_quote_id uuid REFERENCES model_quotes(id) ON DELETE RESTRICT,
  model_probability numeric(12, 10),
  decimal_odds numeric(14, 4),
  expected_value numeric(14, 8),
  verdict varchar(10) NOT NULL CHECK (verdict IN ('PASS', 'FAIL')),
  reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons_json) = 'array'),
  snapshot_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (match_id, decision_as_of),
  CHECK (
    verdict = 'FAIL'
    OR (
      schedule_validation_id IS NOT NULL
      AND identity_validation_id IS NOT NULL
      AND freshness_validation_id IS NOT NULL
      AND entry_evidence_id IS NOT NULL
      AND context_id IS NOT NULL
      AND model_version_id IS NOT NULL
      AND model_quote_id IS NOT NULL
      AND model_probability > 0 AND model_probability < 1
      AND decimal_odds > 1
      AND expected_value >= 0.03
      AND reasons_json = '[]'::jsonb
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_forecast_candidate_match_created
  ON forecast_candidate_snapshots(match_id, created_at DESC);

CREATE OR REPLACE FUNCTION forecast_v3_model_quote_mutation_guard()
RETURNS trigger AS $$
BEGIN
  IF OLD.model_name = 'sports_data_hub_football_fair_odds_v3'
     OR OLD.raw_data->>'immutable_candidate_input' = 'true' THEN
    RAISE EXCEPTION 'Owned fair odds v3 model quotes are append-only';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_forecast_v3_model_quote_mutation_guard ON model_quotes;
CREATE TRIGGER trg_forecast_v3_model_quote_mutation_guard
  BEFORE UPDATE OR DELETE ON model_quotes
  FOR EACH ROW EXECUTE FUNCTION forecast_v3_model_quote_mutation_guard();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'forecast_provider_match_mappings',
    'forecast_slate_validations',
    'forecast_evidence_roles',
    'forecast_freshness_windows',
    'forecast_snapshot_validations',
    'forecast_candidate_snapshots'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_block_mutation_' || table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forecast_block_mutation()',
      'trg_block_mutation_' || table_name,
      table_name
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION validate_forecast_schedule(
  p_match_id uuid,
  p_provider_documents_current_value_as_sentinel boolean,
  p_official_time_missing boolean,
  p_canonical_scheduled_start timestamptz,
  p_evidence_id uuid,
  p_verified_by text
)
RETURNS forecast_slate_validations AS $$
DECLARE
  match_row forecast_matches;
  validation_result text := 'VALID';
  details jsonb := '{}'::jsonb;
  result_row forecast_slate_validations;
BEGIN
  SELECT * INTO match_row FROM forecast_matches WHERE match_id = p_match_id;
  IF match_row.id IS NULL THEN
    RAISE EXCEPTION 'Forecast match % is not registered', p_match_id;
  END IF;
  IF NULLIF(trim(p_verified_by), '') IS NULL THEN
    RAISE EXCEPTION 'verified_by is required';
  END IF;

  IF p_canonical_scheduled_start IS NOT NULL
     AND abs(EXTRACT(EPOCH FROM (p_canonical_scheduled_start - match_row.scheduled_start))) > 60 THEN
    validation_result := 'PLACEHOLDER_SCHEDULE';
    details := jsonb_build_object(
      'reason', 'CANONICAL_SOURCE_TIME_MISMATCH',
      'stored_start', match_row.scheduled_start,
      'canonical_start', p_canonical_scheduled_start
    );
  ELSIF p_provider_documents_current_value_as_sentinel THEN
    validation_result := 'PLACEHOLDER_SCHEDULE';
    details := jsonb_build_object('reason', 'PROVIDER_DOCUMENTED_SENTINEL');
  ELSIF p_official_time_missing THEN
    validation_result := 'PENDING_CHECK';
    details := jsonb_build_object('reason', 'OFFICIAL_TIME_MISSING');
  END IF;

  INSERT INTO forecast_slate_validations (
    match_id, validation_type, result, evidence_id, details_json, verified_by
  ) VALUES (
    p_match_id, 'schedule', validation_result, p_evidence_id, details, p_verified_by
  ) RETURNING * INTO result_row;
  RETURN result_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION register_forecast_provider_mapping(
  p_match_id uuid,
  p_provider_name text,
  p_external_match_id text,
  p_evidence_id uuid,
  p_verified_by text
)
RETURNS forecast_provider_match_mappings AS $$
DECLARE
  result_row forecast_provider_match_mappings;
BEGIN
  IF NULLIF(trim(p_provider_name), '') IS NULL
     OR NULLIF(trim(p_external_match_id), '') IS NULL
     OR NULLIF(trim(p_verified_by), '') IS NULL THEN
    RAISE EXCEPTION 'provider, external_match_id, and verified_by are required';
  END IF;
  INSERT INTO forecast_provider_match_mappings (
    match_id, provider_name, external_match_id, evidence_id, verified_by
  ) VALUES (
    p_match_id, lower(trim(p_provider_name)), trim(p_external_match_id), p_evidence_id, p_verified_by
  )
  ON CONFLICT (provider_name, external_match_id) DO NOTHING
  RETURNING * INTO result_row;

  IF result_row.id IS NULL THEN
    SELECT * INTO result_row
    FROM forecast_provider_match_mappings
    WHERE provider_name = lower(trim(p_provider_name))
      AND external_match_id = trim(p_external_match_id);
    IF result_row.match_id <> p_match_id THEN
      RAISE EXCEPTION 'Provider event %:% is already mapped to another match', p_provider_name, p_external_match_id;
    END IF;
  END IF;

  INSERT INTO forecast_slate_validations (
    match_id, validation_type, result, evidence_id, details_json, verified_by
  ) VALUES (
    p_match_id,
    'identity',
    'VALID',
    p_evidence_id,
    jsonb_build_object('provider_name', result_row.provider_name, 'external_match_id', result_row.external_match_id),
    p_verified_by
  );
  RETURN result_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION validate_forecast_freshness(
  p_match_id uuid,
  p_evidence_id uuid,
  p_snapshot_type text,
  p_decision_as_of timestamptz,
  p_policy_version text DEFAULT 'candidate-preflight-v1'
)
RETURNS forecast_snapshot_validations AS $$
DECLARE
  existing_row forecast_snapshot_validations;
  match_row forecast_matches;
  evidence_row forecast_evidence;
  validation_result text := 'VALID';
  age_minutes numeric;
  lead_minutes numeric;
  details jsonb;
BEGIN
  SELECT * INTO existing_row
  FROM forecast_snapshot_validations
  WHERE evidence_id = p_evidence_id
    AND snapshot_type = p_snapshot_type
    AND decision_as_of = p_decision_as_of
    AND policy_version = p_policy_version;
  IF existing_row.id IS NOT NULL THEN RETURN existing_row; END IF;

  IF p_decision_as_of IS NULL OR p_snapshot_type NOT IN ('entry', 'current', 'near_start', 'closing') THEN
    RAISE EXCEPTION 'Valid decision_as_of and snapshot_type are required';
  END IF;
  SELECT * INTO match_row FROM forecast_matches WHERE match_id = p_match_id;
  SELECT * INTO evidence_row FROM forecast_evidence WHERE id = p_evidence_id AND match_id = p_match_id;
  IF match_row.id IS NULL OR evidence_row.id IS NULL THEN
    RAISE EXCEPTION 'Match/evidence relationship is invalid';
  END IF;

  age_minutes := EXTRACT(EPOCH FROM (p_decision_as_of - evidence_row.captured_at)) / 60.0;
  lead_minutes := EXTRACT(EPOCH FROM (match_row.scheduled_start - evidence_row.captured_at)) / 60.0;
  IF evidence_row.captured_at > p_decision_as_of THEN
    validation_result := 'FUTURE_CAPTURE';
  ELSIF evidence_row.captured_at >= match_row.scheduled_start THEN
    validation_result := 'POST_KICKOFF';
  ELSIF age_minutes < 0 THEN
    validation_result := 'FUTURE_CAPTURE';
  ELSIF NOT EXISTS (
    SELECT 1
    FROM forecast_freshness_windows fw
    WHERE fw.policy_version = p_policy_version
      AND fw.snapshot_type = p_snapshot_type
      AND fw.effective_from <= p_decision_as_of
      AND lead_minutes BETWEEN fw.min_lead_minutes AND fw.max_lead_minutes
  ) THEN
    validation_result := 'WINDOW_MISMATCH';
  ELSIF NOT EXISTS (
    SELECT 1
    FROM forecast_freshness_windows fw
    WHERE fw.policy_version = p_policy_version
      AND fw.snapshot_type = p_snapshot_type
      AND fw.effective_from <= p_decision_as_of
      AND age_minutes <= fw.max_age_minutes
      AND lead_minutes BETWEEN fw.min_lead_minutes AND fw.max_lead_minutes
  ) THEN
    validation_result := 'STALE';
  END IF;
  details := jsonb_build_object('age_minutes', age_minutes, 'lead_minutes', lead_minutes);

  INSERT INTO forecast_snapshot_validations (
    match_id, evidence_id, snapshot_type, decision_as_of, policy_version, result, details_json
  ) VALUES (
    p_match_id, p_evidence_id, p_snapshot_type, p_decision_as_of, p_policy_version, validation_result, details
  ) RETURNING * INTO existing_row;
  RETURN existing_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION register_forecast_evidence_role(
  p_evidence_id uuid,
  p_evidence_role text,
  p_assigned_by text
)
RETURNS forecast_evidence_roles AS $$
DECLARE
  evidence_row forecast_evidence;
  result_row forecast_evidence_roles;
BEGIN
  SELECT * INTO evidence_row FROM forecast_evidence WHERE id = p_evidence_id;
  IF evidence_row.id IS NULL THEN RAISE EXCEPTION 'Evidence % does not exist', p_evidence_id; END IF;
  IF p_evidence_role NOT IN ('entry', 'current', 'near_start', 'closing', 'audit_only') THEN
    RAISE EXCEPTION 'Invalid evidence role %', p_evidence_role;
  END IF;
  IF NULLIF(trim(p_assigned_by), '') IS NULL THEN RAISE EXCEPTION 'assigned_by is required'; END IF;
  IF evidence_row.captured_at >= (
    SELECT scheduled_start FROM forecast_matches WHERE match_id = evidence_row.match_id
  ) AND p_evidence_role <> 'audit_only' THEN
    RAISE EXCEPTION 'Post-kickoff evidence can only be audit_only';
  END IF;
  INSERT INTO forecast_evidence_roles (evidence_id, evidence_role, assigned_by)
  VALUES (p_evidence_id, p_evidence_role, p_assigned_by)
  ON CONFLICT (evidence_id, evidence_role) DO NOTHING;
  SELECT * INTO result_row
  FROM forecast_evidence_roles
  WHERE evidence_id = p_evidence_id AND evidence_role = p_evidence_role;
  RETURN result_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION candidate_preflight(
  p_match_id uuid,
  p_decision_as_of timestamptz DEFAULT clock_timestamp()
)
RETURNS forecast_candidate_snapshots AS $$
DECLARE
  existing_row forecast_candidate_snapshots;
  match_row forecast_matches;
  schedule_row forecast_slate_validations;
  identity_row forecast_slate_validations;
  evidence_row forecast_evidence;
  freshness_row forecast_snapshot_validations;
  context_row forecast_context_snapshots;
  fair_row forecast_chain;
  model_row forecast_model_versions;
  model_quote_row model_quotes;
  reasons jsonb := '[]'::jsonb;
  model_probability numeric;
  expected_value numeric;
  verdict_value text;
  hash_value text;
BEGIN
  SELECT * INTO existing_row
  FROM forecast_candidate_snapshots
  WHERE match_id = p_match_id AND decision_as_of = p_decision_as_of;
  IF existing_row.id IS NOT NULL THEN RETURN existing_row; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_match_id::text || p_decision_as_of::text, 0));
  SELECT * INTO existing_row
  FROM forecast_candidate_snapshots
  WHERE match_id = p_match_id AND decision_as_of = p_decision_as_of;
  IF existing_row.id IS NOT NULL THEN RETURN existing_row; END IF;

  SELECT * INTO match_row FROM forecast_matches WHERE match_id = p_match_id;
  IF match_row.id IS NULL THEN RAISE EXCEPTION 'Forecast match % is not registered', p_match_id; END IF;
  IF p_decision_as_of > clock_timestamp() + INTERVAL '5 minutes' THEN
    reasons := reasons || jsonb_build_array('DECISION_AS_OF_IN_FUTURE');
  END IF;
  IF p_decision_as_of >= match_row.scheduled_start THEN
    reasons := reasons || jsonb_build_array('DECISION_NOT_PREGAME');
  END IF;
  IF clock_timestamp() >= match_row.scheduled_start THEN
    reasons := reasons || jsonb_build_array('PROSPECTIVE_WINDOW_CLOSED');
  END IF;

  SELECT * INTO schedule_row
  FROM forecast_slate_validations
  WHERE match_id = p_match_id AND validation_type = 'schedule' AND validated_at <= p_decision_as_of
  ORDER BY validated_at DESC, id DESC LIMIT 1;
  IF schedule_row.id IS NULL OR schedule_row.result <> 'VALID' THEN
    reasons := reasons || jsonb_build_array('SCHEDULE_NOT_VALID_AS_OF');
  END IF;

  SELECT * INTO identity_row
  FROM forecast_slate_validations
  WHERE match_id = p_match_id AND validation_type = 'identity' AND validated_at <= p_decision_as_of
  ORDER BY validated_at DESC, id DESC LIMIT 1;
  IF identity_row.id IS NULL OR identity_row.result <> 'VALID' THEN
    reasons := reasons || jsonb_build_array('IDENTITY_NOT_VALID_AS_OF');
  END IF;

  SELECT evidence.* INTO evidence_row
  FROM forecast_evidence evidence
  JOIN forecast_evidence_roles role ON role.evidence_id = evidence.id
  WHERE evidence.match_id = p_match_id
    AND role.evidence_role IN ('entry', 'current')
    AND role.assigned_at <= p_decision_as_of
    AND evidence.recorded_at <= p_decision_as_of
    AND evidence.captured_at <= p_decision_as_of
    AND evidence.captured_at < match_row.scheduled_start
    AND evidence.timing_quality NOT IN ('LATE', 'AUDIT_ONLY')
  ORDER BY evidence.captured_at DESC, evidence.id DESC LIMIT 1;
  IF evidence_row.id IS NULL THEN
    reasons := reasons || jsonb_build_array('ENTRY_EVIDENCE_MISSING_AS_OF');
  ELSE
    freshness_row := validate_forecast_freshness(
      p_match_id,
      evidence_row.id,
      CASE WHEN EXISTS (
        SELECT 1 FROM forecast_evidence_roles
        WHERE evidence_id = evidence_row.id AND evidence_role = 'entry'
      ) THEN 'entry' ELSE 'current' END,
      p_decision_as_of
    );
    IF freshness_row.result <> 'VALID' THEN
      reasons := reasons || jsonb_build_array('ENTRY_EVIDENCE_NOT_FRESH');
    END IF;
  END IF;

  SELECT * INTO context_row
  FROM forecast_context_snapshots
  WHERE match_id = p_match_id
    AND recorded_at IS NOT NULL AND recorded_at <= p_decision_as_of
    AND captured_at <= p_decision_as_of
    AND captured_at < match_row.scheduled_start
    AND completeness_flag = 'complete'
  ORDER BY captured_at DESC, id DESC LIMIT 1;
  IF context_row.id IS NULL THEN
    reasons := reasons || jsonb_build_array('COMPLETE_CONTEXT_MISSING_AS_OF');
  END IF;

  SELECT quote.* INTO model_quote_row
  FROM model_quotes quote
  JOIN forecast_model_versions version
    ON version.id = CASE
      WHEN quote.raw_data->>'model_version_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (quote.raw_data->>'model_version_id')::uuid
      ELSE NULL
    END
  WHERE quote.match_id = p_match_id
    AND quote.generated_at <= p_decision_as_of
    AND quote.raw_data->>'owned_fair_odds' = 'true'
    AND quote.raw_data->>'market_inputs_used' = 'false'
    AND quote.raw_data->>'immutable_candidate_input' = 'true'
    AND (
      lower(quote.market_type) = lower(evidence_row.market_type)
      OR (lower(quote.market_type) LIKE 'moneyline%' AND lower(evidence_row.market_type) LIKE 'moneyline%')
    )
    AND version.trained_at <= p_decision_as_of
    AND version.training_cutoff_date <= p_decision_as_of::date
  ORDER BY quote.generated_at DESC, quote.id DESC LIMIT 1;
  IF model_quote_row.id IS NOT NULL THEN
    SELECT * INTO model_row
    FROM forecast_model_versions
    WHERE id = CASE
      WHEN model_quote_row.raw_data->>'model_version_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (model_quote_row.raw_data->>'model_version_id')::uuid
      ELSE NULL
    END;
  END IF;
  IF model_quote_row.id IS NULL THEN
    reasons := reasons || jsonb_build_array('FAIR_ODDS_MISSING_AS_OF');
  END IF;

  IF evidence_row.id IS NOT NULL AND model_quote_row.id IS NOT NULL THEN
    IF lower(evidence_row.market_type) <> lower(model_quote_row.market_type)
       AND NOT (lower(evidence_row.market_type) LIKE 'moneyline%' AND lower(model_quote_row.market_type) LIKE 'moneyline%') THEN
      reasons := reasons || jsonb_build_array('MODEL_MARKET_MISMATCH');
    END IF;
    model_probability := CASE lower(evidence_row.selection)
      WHEN 'home' THEN model_quote_row.home_probability
      WHEN 'away' THEN model_quote_row.away_probability
      WHEN 'draw' THEN model_quote_row.draw_probability
      WHEN 'over' THEN model_quote_row.home_probability
      WHEN 'under' THEN model_quote_row.away_probability
      ELSE NULL
    END;
    IF model_probability IS NULL OR model_probability <= 0 OR model_probability >= 1 THEN
      reasons := reasons || jsonb_build_array('MODEL_PROBABILITY_INVALID_FOR_SELECTION');
    END IF;
  END IF;

  IF evidence_row.id IS NOT NULL AND model_probability IS NOT NULL THEN
    expected_value := evidence_row.decimal_odds * model_probability - 1;
    IF expected_value < 0.03 THEN
      reasons := reasons || jsonb_build_array('EDGE_BELOW_THRESHOLD');
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM forecast_chain WHERE match_id = p_match_id AND stage = 'entry') THEN
    reasons := reasons || jsonb_build_array('ENTRY_OR_TICKET_ALREADY_EXISTS');
  END IF;

  verdict_value := CASE WHEN jsonb_array_length(reasons) = 0 THEN 'PASS' ELSE 'FAIL' END;
  hash_value := encode(digest(convert_to(concat_ws(E'\x1f',
    p_match_id::text,
    to_char(p_decision_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    COALESCE(schedule_row.id::text, ''),
    COALESCE(identity_row.id::text, ''),
    COALESCE(freshness_row.id::text, ''),
    COALESCE(evidence_row.id::text, ''),
    COALESCE(context_row.id::text, ''),
    '',
    COALESCE(model_row.id::text, ''),
    COALESCE(model_quote_row.id::text, ''),
    COALESCE(model_probability::text, ''),
    COALESCE(evidence_row.decimal_odds::text, ''),
    COALESCE(expected_value::text, ''),
    verdict_value,
    reasons::text
  ), 'UTF8'), 'sha256'), 'hex');

  INSERT INTO forecast_candidate_snapshots (
    match_id, decision_as_of, schedule_validation_id, identity_validation_id,
    freshness_validation_id, entry_evidence_id, context_id, fair_odds_chain_id,
    model_version_id, model_quote_id, model_probability, decimal_odds,
    expected_value, verdict, reasons_json, snapshot_hash
  ) VALUES (
    p_match_id, p_decision_as_of, schedule_row.id, identity_row.id,
    freshness_row.id, evidence_row.id, context_row.id, NULL,
    model_row.id, model_quote_row.id, model_probability, evidence_row.decimal_odds,
    expected_value, verdict_value, reasons, hash_value
  ) RETURNING * INTO existing_row;
  RETURN existing_row;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION verify_candidate_snapshot(p_snapshot_id uuid)
RETURNS boolean AS $$
  SELECT snapshot_hash = encode(digest(convert_to(concat_ws(E'\x1f',
    match_id::text,
    to_char(decision_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    COALESCE(schedule_validation_id::text, ''),
    COALESCE(identity_validation_id::text, ''),
    COALESCE(freshness_validation_id::text, ''),
    COALESCE(entry_evidence_id::text, ''),
    COALESCE(context_id::text, ''),
    COALESCE(fair_odds_chain_id::text, ''),
    COALESCE(model_version_id::text, ''),
    COALESCE(model_quote_id::text, ''),
    COALESCE(model_probability::text, ''),
    COALESCE(decimal_odds::text, ''),
    COALESCE(expected_value::text, ''),
    verdict,
    reasons_json::text
  ), 'UTF8'), 'sha256'), 'hex')
  FROM forecast_candidate_snapshots
  WHERE id = p_snapshot_id;
$$ LANGUAGE sql STABLE;

-- App roles should receive EXECUTE on these functions, not direct INSERT.
-- REVOKE INSERT, UPDATE, DELETE ON forecast_candidate_snapshots FROM forecast_app;
-- GRANT EXECUTE ON FUNCTION candidate_preflight(uuid, timestamptz) TO forecast_app;
