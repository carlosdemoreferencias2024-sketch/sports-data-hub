-- Versioned shadow inclusion and cohort-isolated gate evaluation.
-- Historical replay is useful for research, but it can never count toward the
-- prospective READY gate. All policy, decisions, and assessments are append-only.

CREATE OR REPLACE FUNCTION forecast_evidence_recorded_at_guard()
RETURNS trigger AS $$
BEGIN
  NEW.recorded_at := clock_timestamp();
  IF NEW.captured_at > NEW.recorded_at + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'Evidence captured_at cannot be in the future';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_00_forecast_evidence_recorded_at_guard ON forecast_evidence;
CREATE TRIGGER trg_00_forecast_evidence_recorded_at_guard
  BEFORE INSERT ON forecast_evidence
  FOR EACH ROW EXECUTE FUNCTION forecast_evidence_recorded_at_guard();

CREATE OR REPLACE FUNCTION forecast_fair_odds_payload_guard()
RETURNS trigger AS $$
DECLARE
  model_probability numeric;
  market_probability numeric;
BEGIN
  IF NEW.stage <> 'fair_odds' THEN
    RETURN NEW;
  END IF;

  IF NOT (NEW.value_json ? 'model_predicted_prob')
     OR NOT (NEW.value_json ? 'market_implied_prob')
     OR NULLIF(NEW.value_json->>'fair_odds_method_version', '') IS NULL THEN
    RAISE EXCEPTION 'fair_odds requires model_predicted_prob, market_implied_prob, and fair_odds_method_version';
  END IF;

  BEGIN
    model_probability := (NEW.value_json->>'model_predicted_prob')::numeric;
    market_probability := (NEW.value_json->>'market_implied_prob')::numeric;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'fair_odds probabilities must be numeric';
  END;

  IF model_probability <= 0 OR model_probability >= 1
     OR market_probability <= 0 OR market_probability >= 1 THEN
    RAISE EXCEPTION 'fair_odds probabilities must be strictly between 0 and 1';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_00_forecast_fair_odds_payload_guard ON forecast_chain;
CREATE TRIGGER trg_00_forecast_fair_odds_payload_guard
  BEFORE INSERT ON forecast_chain
  FOR EACH ROW EXECUTE FUNCTION forecast_fair_odds_payload_guard();

CREATE TABLE IF NOT EXISTS forecast_inclusion_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_label varchar(160) NOT NULL UNIQUE,
  cohort varchar(30) NOT NULL
    CHECK (cohort IN ('PROSPECTIVE_SHADOW', 'HISTORICAL_BACKTEST')),
  sport_slug varchar(40) NOT NULL,
  leagues_json jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(leagues_json) = 'array'),
  markets_json jsonb NOT NULL
    CHECK (jsonb_typeof(markets_json) = 'array' AND jsonb_array_length(markets_json) > 0),
  min_entry_lead_minutes integer NOT NULL CHECK (min_entry_lead_minutes >= 0),
  max_entry_lead_minutes integer NOT NULL CHECK (max_entry_lead_minutes >= min_entry_lead_minutes),
  require_context_complete boolean NOT NULL DEFAULT true,
  require_dual_evidence boolean NOT NULL DEFAULT true,
  dual_evidence_tolerance_minutes integer NOT NULL DEFAULT 10
    CHECK (dual_evidence_tolerance_minutes BETWEEN 0 AND 120),
  fair_odds_method_version varchar(120) NOT NULL,
  fair_odds_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from timestamptz NOT NULL DEFAULT now(),
  supersedes_criteria_id uuid REFERENCES forecast_inclusion_criteria(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  criteria_hash char(64) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_criteria_effective_version
  ON forecast_inclusion_criteria(cohort, sport_slug, effective_from);
CREATE INDEX IF NOT EXISTS idx_forecast_criteria_lookup
  ON forecast_inclusion_criteria(cohort, sport_slug, effective_from DESC, created_at DESC);

CREATE OR REPLACE FUNCTION forecast_inclusion_criteria_before_insert()
RETURNS trigger AS $$
DECLARE
  previous_id uuid;
  previous_effective_from timestamptz;
  previous_cohort text;
  previous_sport text;
BEGIN
  NEW.created_at := COALESCE(NEW.created_at, now());
  IF EXISTS (
    SELECT 1 FROM forecast_inclusion_criteria WHERE version_label = NEW.version_label
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.cohort = 'PROSPECTIVE_SHADOW' AND NEW.effective_from < NEW.created_at THEN
    RAISE EXCEPTION 'Prospective criteria cannot be backdated';
  END IF;

  SELECT id INTO previous_id
  FROM forecast_inclusion_criteria
  WHERE cohort = NEW.cohort AND sport_slug = NEW.sport_slug
  ORDER BY effective_from DESC, created_at DESC
  LIMIT 1;

  IF previous_id IS NOT NULL AND NEW.supersedes_criteria_id IS DISTINCT FROM previous_id THEN
    RAISE EXCEPTION 'Criteria % must supersede latest criteria %', NEW.version_label, previous_id;
  END IF;
  IF previous_id IS NULL AND NEW.supersedes_criteria_id IS NOT NULL THEN
    RAISE EXCEPTION 'First criteria for a cohort and sport cannot supersede another row';
  END IF;

  IF NEW.supersedes_criteria_id IS NOT NULL THEN
    SELECT effective_from, cohort, sport_slug
      INTO previous_effective_from, previous_cohort, previous_sport
    FROM forecast_inclusion_criteria
    WHERE id = NEW.supersedes_criteria_id;
    IF previous_effective_from IS NULL
       OR previous_cohort <> NEW.cohort
       OR previous_sport <> NEW.sport_slug
       OR NEW.effective_from <= previous_effective_from THEN
      RAISE EXCEPTION 'Superseding criteria must preserve cohort/sport and move effective_from forward';
    END IF;
  END IF;

  NEW.criteria_hash := encode(digest(convert_to(concat_ws(E'\x1f',
    NEW.version_label,
    NEW.cohort,
    NEW.sport_slug,
    NEW.leagues_json::text,
    NEW.markets_json::text,
    NEW.min_entry_lead_minutes::text,
    NEW.max_entry_lead_minutes::text,
    NEW.require_context_complete::text,
    NEW.require_dual_evidence::text,
    NEW.dual_evidence_tolerance_minutes::text,
    NEW.fair_odds_method_version,
    NEW.fair_odds_config::text,
    to_char(NEW.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    COALESCE(NEW.supersedes_criteria_id::text, ''),
    to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8'), 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_00_forecast_inclusion_criteria_insert ON forecast_inclusion_criteria;
CREATE TRIGGER trg_00_forecast_inclusion_criteria_insert
  BEFORE INSERT ON forecast_inclusion_criteria
  FOR EACH ROW EXECUTE FUNCTION forecast_inclusion_criteria_before_insert();

CREATE TABLE IF NOT EXISTS forecast_inclusion_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  criteria_id uuid NOT NULL REFERENCES forecast_inclusion_criteria(id) ON DELETE RESTRICT,
  cohort varchar(30) NOT NULL
    CHECK (cohort IN ('PROSPECTIVE_SHADOW', 'HISTORICAL_BACKTEST')),
  entry_chain_id uuid NOT NULL REFERENCES forecast_chain(id) ON DELETE RESTRICT,
  entry_evidence_id uuid NOT NULL REFERENCES forecast_evidence(id) ON DELETE RESTRICT,
  decision varchar(20) NOT NULL CHECK (decision IN ('INCLUDED', 'EXCLUDED')),
  reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  decision_hash char(64) NOT NULL,
  UNIQUE (match_id, cohort)
);

CREATE INDEX IF NOT EXISTS idx_forecast_inclusion_decisions_cohort
  ON forecast_inclusion_decisions(cohort, decision, evaluated_at DESC);

CREATE OR REPLACE FUNCTION forecast_inclusion_decision_before_insert()
RETURNS trigger AS $$
DECLARE
  criteria_row forecast_inclusion_criteria;
  match_row forecast_matches;
  entry_row forecast_chain;
  evidence_row forecast_evidence;
  fair_row forecast_chain;
  reasons jsonb := '[]'::jsonb;
  lead_minutes numeric;
  evidence_count integer := 0;
BEGIN
  NEW.evaluated_at := clock_timestamp();
  SELECT * INTO criteria_row FROM forecast_inclusion_criteria WHERE id = NEW.criteria_id;
  SELECT * INTO match_row FROM forecast_matches WHERE match_id = NEW.match_id;
  SELECT * INTO entry_row FROM forecast_chain WHERE id = NEW.entry_chain_id;
  SELECT * INTO evidence_row FROM forecast_evidence WHERE id = NEW.entry_evidence_id;
  SELECT * INTO fair_row FROM forecast_chain WHERE match_id = NEW.match_id AND stage = 'fair_odds';

  IF criteria_row.id IS NULL OR match_row.id IS NULL OR entry_row.id IS NULL OR evidence_row.id IS NULL THEN
    RAISE EXCEPTION 'Inclusion decision references are incomplete';
  END IF;
  IF NEW.cohort <> criteria_row.cohort THEN
    RAISE EXCEPTION 'Decision cohort does not match criteria cohort';
  END IF;
  IF entry_row.match_id <> NEW.match_id OR entry_row.stage <> 'entry'
     OR entry_row.evidence_id <> NEW.entry_evidence_id
     OR evidence_row.match_id <> NEW.match_id THEN
    RAISE EXCEPTION 'Entry chain/evidence does not belong to the decision match';
  END IF;

  IF NEW.cohort = 'PROSPECTIVE_SHADOW' THEN
    IF match_row.scheduled_start <= NEW.evaluated_at THEN
      RAISE EXCEPTION 'Prospective inclusion must be recorded before scheduled start';
    END IF;
    IF criteria_row.created_at > evidence_row.recorded_at
       OR criteria_row.effective_from > evidence_row.captured_at THEN
      RAISE EXCEPTION 'Prospective criteria must be registered before entry evidence';
    END IF;
    IF EXISTS (SELECT 1 FROM forecast_chain WHERE match_id = NEW.match_id AND stage = 'result') THEN
      RAISE EXCEPTION 'Prospective inclusion cannot be recorded after a result exists';
    END IF;
  END IF;

  IF criteria_row.sport_slug <> match_row.sport_slug THEN
    reasons := reasons || jsonb_build_array('SPORT_NOT_ALLOWED');
  END IF;
  IF criteria_row.leagues_json <> '[]'::jsonb
     AND NOT (criteria_row.leagues_json ? match_row.league_slug) THEN
    reasons := reasons || jsonb_build_array('LEAGUE_NOT_ALLOWED');
  END IF;
  IF NOT (criteria_row.markets_json ? evidence_row.market_type) THEN
    reasons := reasons || jsonb_build_array('MARKET_NOT_ALLOWED');
  END IF;

  lead_minutes := EXTRACT(EPOCH FROM (match_row.scheduled_start - evidence_row.captured_at)) / 60.0;
  IF lead_minutes < criteria_row.min_entry_lead_minutes THEN
    reasons := reasons || jsonb_build_array('ENTRY_TOO_CLOSE_TO_START');
  ELSIF lead_minutes > criteria_row.max_entry_lead_minutes THEN
    reasons := reasons || jsonb_build_array('ENTRY_TOO_EARLY');
  END IF;

  IF fair_row.id IS NULL
     OR fair_row.value_json->>'fair_odds_method_version' IS DISTINCT FROM criteria_row.fair_odds_method_version THEN
    reasons := reasons || jsonb_build_array('FAIR_ODDS_METHOD_MISMATCH');
  END IF;

  IF criteria_row.require_dual_evidence THEN
    SELECT count(DISTINCT concat_ws('|', provider_name, bookmaker))
      INTO evidence_count
    FROM forecast_evidence
    WHERE match_id = NEW.match_id
      AND market_type = evidence_row.market_type
      AND selection = evidence_row.selection
      AND recorded_at <= NEW.evaluated_at
      AND captured_at BETWEEN
        evidence_row.captured_at - make_interval(mins => criteria_row.dual_evidence_tolerance_minutes)
        AND evidence_row.captured_at + make_interval(mins => criteria_row.dual_evidence_tolerance_minutes);
    IF evidence_count < 2 THEN
      reasons := reasons || jsonb_build_array('DUAL_EVIDENCE_MISSING');
    END IF;
  END IF;

  NEW.decision := CASE WHEN jsonb_array_length(reasons) = 0 THEN 'INCLUDED' ELSE 'EXCLUDED' END;
  NEW.reasons_json := reasons;
  NEW.decision_hash := encode(digest(convert_to(concat_ws(E'\x1f',
    NEW.match_id::text,
    NEW.criteria_id::text,
    NEW.cohort,
    NEW.entry_chain_id::text,
    NEW.entry_evidence_id::text,
    NEW.decision,
    NEW.reasons_json::text,
    to_char(NEW.evaluated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8'), 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_00_forecast_inclusion_decision_insert ON forecast_inclusion_decisions;
CREATE TRIGGER trg_00_forecast_inclusion_decision_insert
  BEFORE INSERT ON forecast_inclusion_decisions
  FOR EACH ROW EXECUTE FUNCTION forecast_inclusion_decision_before_insert();

CREATE OR REPLACE FUNCTION record_forecast_inclusion_decision(
  p_match_id uuid,
  p_cohort text DEFAULT 'PROSPECTIVE_SHADOW'
)
RETURNS forecast_inclusion_decisions AS $$
DECLARE
  match_row forecast_matches;
  entry_row forecast_chain;
  evidence_row forecast_evidence;
  criteria_row forecast_inclusion_criteria;
  as_of_time timestamptz;
  result forecast_inclusion_decisions;
BEGIN
  SELECT * INTO match_row FROM forecast_matches WHERE match_id = p_match_id;
  SELECT * INTO entry_row FROM forecast_chain WHERE match_id = p_match_id AND stage = 'entry';
  IF match_row.id IS NULL OR entry_row.id IS NULL THEN
    RAISE EXCEPTION 'Forecast match % lacks a registered entry stage', p_match_id;
  END IF;
  SELECT * INTO evidence_row FROM forecast_evidence WHERE id = entry_row.evidence_id;
  as_of_time := CASE WHEN p_cohort = 'PROSPECTIVE_SHADOW'
    THEN evidence_row.captured_at ELSE match_row.scheduled_start END;

  SELECT * INTO criteria_row
  FROM forecast_inclusion_criteria
  WHERE cohort = p_cohort
    AND sport_slug = match_row.sport_slug
    AND effective_from <= as_of_time
    AND (p_cohort <> 'PROSPECTIVE_SHADOW' OR created_at <= evidence_row.recorded_at)
  ORDER BY effective_from DESC, created_at DESC
  LIMIT 1;
  IF criteria_row.id IS NULL THEN
    RAISE EXCEPTION 'No % inclusion criteria exists for match % at %', p_cohort, p_match_id, as_of_time;
  END IF;

  INSERT INTO forecast_inclusion_decisions (
    match_id, criteria_id, cohort, entry_chain_id, entry_evidence_id,
    decision, reasons_json, decision_hash
  ) VALUES (
    p_match_id, criteria_row.id, p_cohort, entry_row.id, evidence_row.id,
    'EXCLUDED', '[]'::jsonb, repeat('0', 64)
  ) RETURNING * INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION forecast_auto_preregister_entry()
RETURNS trigger AS $$
DECLARE
  match_row forecast_matches;
BEGIN
  IF NEW.stage <> 'entry' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO match_row FROM forecast_matches WHERE match_id = NEW.match_id;
  IF match_row.scheduled_start > clock_timestamp()
     AND EXISTS (
       SELECT 1
       FROM forecast_inclusion_criteria criteria
       WHERE criteria.cohort = 'PROSPECTIVE_SHADOW'
         AND criteria.sport_slug = match_row.sport_slug
     )
     AND NOT EXISTS (
       SELECT 1
       FROM forecast_inclusion_decisions decision
       WHERE decision.match_id = NEW.match_id
         AND decision.cohort = 'PROSPECTIVE_SHADOW'
     ) THEN
    PERFORM record_forecast_inclusion_decision(NEW.match_id, 'PROSPECTIVE_SHADOW');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_forecast_auto_preregister_entry ON forecast_chain;
CREATE TRIGGER trg_forecast_auto_preregister_entry
  AFTER INSERT ON forecast_chain
  FOR EACH ROW EXECUTE FUNCTION forecast_auto_preregister_entry();

CREATE TABLE IF NOT EXISTS forecast_sample_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clv_record_id uuid NOT NULL REFERENCES forecast_clv_records(id) ON DELETE RESTRICT,
  inclusion_decision_id uuid NOT NULL REFERENCES forecast_inclusion_decisions(id) ON DELETE RESTRICT,
  match_id uuid NOT NULL REFERENCES forecast_matches(match_id) ON DELETE RESTRICT,
  cohort varchar(30) NOT NULL
    CHECK (cohort IN ('PROSPECTIVE_SHADOW', 'HISTORICAL_BACKTEST')),
  clean_eligible boolean NOT NULL,
  ready_gate_eligible boolean NOT NULL,
  walk_forward_passed boolean NOT NULL,
  reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  entry_captured_at timestamptz NOT NULL,
  scheduled_start timestamptz NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  assessment_hash char(64) NOT NULL,
  UNIQUE (clv_record_id, cohort),
  CHECK (NOT ready_gate_eligible OR (clean_eligible AND cohort = 'PROSPECTIVE_SHADOW'))
);

CREATE INDEX IF NOT EXISTS idx_forecast_sample_assessments_gate
  ON forecast_sample_assessments(cohort, ready_gate_eligible, entry_captured_at);

CREATE OR REPLACE FUNCTION forecast_sample_assessment_before_insert()
RETURNS trigger AS $$
DECLARE
  decision_row forecast_inclusion_decisions;
  criteria_row forecast_inclusion_criteria;
  clv_row forecast_clv_records;
  match_row forecast_matches;
  context_row forecast_context_snapshots;
  closing_evidence forecast_evidence;
  fair_row forecast_chain;
  model_row forecast_model_versions;
  reasons jsonb := '[]'::jsonb;
  closing_lead_minutes numeric;
BEGIN
  NEW.assessed_at := clock_timestamp();
  SELECT * INTO decision_row FROM forecast_inclusion_decisions WHERE id = NEW.inclusion_decision_id;
  SELECT * INTO criteria_row FROM forecast_inclusion_criteria WHERE id = decision_row.criteria_id;
  SELECT * INTO clv_row FROM forecast_clv_records WHERE id = NEW.clv_record_id;
  SELECT * INTO match_row FROM forecast_matches WHERE match_id = NEW.match_id;
  SELECT fc.* INTO fair_row FROM forecast_chain fc WHERE fc.match_id = NEW.match_id AND fc.stage = 'fair_odds';
  SELECT mv.* INTO model_row FROM forecast_model_versions mv WHERE mv.id = fair_row.model_version_id;
  SELECT context.* INTO context_row
    FROM forecast_chain fc
    JOIN forecast_context_snapshots context ON context.id = fc.context_id
    WHERE fc.match_id = NEW.match_id AND fc.stage = 'context';
  SELECT evidence.* INTO closing_evidence
    FROM forecast_chain fc
    JOIN forecast_evidence evidence ON evidence.id = fc.evidence_id
    WHERE fc.match_id = NEW.match_id AND fc.stage = 'closing';

  IF decision_row.id IS NULL OR clv_row.id IS NULL OR match_row.id IS NULL THEN
    RAISE EXCEPTION 'Sample assessment references are incomplete';
  END IF;
  IF decision_row.match_id <> NEW.match_id OR clv_row.match_id <> NEW.match_id
     OR decision_row.cohort <> NEW.cohort THEN
    RAISE EXCEPTION 'Assessment references do not share match and cohort';
  END IF;

  IF decision_row.decision <> 'INCLUDED' THEN
    reasons := reasons || jsonb_build_array('NOT_PREREGISTERED_FOR_INCLUSION');
  END IF;
  IF NOT clv_row.chain_verified OR NOT verify_forecast_chain(NEW.match_id) THEN
    reasons := reasons || jsonb_build_array('CHAIN_NOT_VERIFIED');
  END IF;
  IF criteria_row.require_context_complete
     AND (context_row.id IS NULL OR context_row.completeness_flag <> 'complete') THEN
    reasons := reasons || jsonb_build_array('CONTEXT_NOT_COMPLETE');
  END IF;
  IF closing_evidence.id IS NULL OR closing_evidence.timing_quality <> 'CAPTURED_ON_TIME' THEN
    reasons := reasons || jsonb_build_array('CLOSING_NOT_CAPTURED_ON_TIME');
  ELSE
    closing_lead_minutes := EXTRACT(EPOCH FROM (match_row.scheduled_start - closing_evidence.captured_at)) / 60.0;
    IF closing_lead_minutes < 3 OR closing_lead_minutes > 10 THEN
      reasons := reasons || jsonb_build_array('CLOSING_OUTSIDE_10_TO_3_MIN_WINDOW');
    END IF;
  END IF;
  IF fair_row.id IS NULL
     OR fair_row.value_json->>'fair_odds_method_version' IS DISTINCT FROM criteria_row.fair_odds_method_version THEN
    reasons := reasons || jsonb_build_array('FAIR_ODDS_METHOD_MISMATCH');
  END IF;

  NEW.walk_forward_passed := COALESCE(model_row.id IS NOT NULL
    AND model_row.training_cutoff_date <= fair_row.created_at::date
    AND model_row.trained_at <= fair_row.created_at, false);
  IF NOT NEW.walk_forward_passed THEN
    reasons := reasons || jsonb_build_array('WALK_FORWARD_FAILED');
  END IF;

  NEW.clean_eligible := jsonb_array_length(reasons) = 0;
  NEW.ready_gate_eligible := NEW.clean_eligible AND NEW.cohort = 'PROSPECTIVE_SHADOW';
  NEW.reasons_json := reasons;
  NEW.entry_captured_at := (
    SELECT evidence.captured_at
    FROM forecast_chain fc
    JOIN forecast_evidence evidence ON evidence.id = fc.evidence_id
    WHERE fc.id = clv_row.entry_chain_id
  );
  NEW.scheduled_start := match_row.scheduled_start;
  NEW.assessment_hash := encode(digest(convert_to(concat_ws(E'\x1f',
    NEW.clv_record_id::text,
    NEW.inclusion_decision_id::text,
    NEW.match_id::text,
    NEW.cohort,
    NEW.clean_eligible::text,
    NEW.ready_gate_eligible::text,
    NEW.walk_forward_passed::text,
    NEW.reasons_json::text,
    to_char(NEW.entry_captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(NEW.scheduled_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(NEW.assessed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8'), 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_00_forecast_sample_assessment_insert ON forecast_sample_assessments;
CREATE TRIGGER trg_00_forecast_sample_assessment_insert
  BEFORE INSERT ON forecast_sample_assessments
  FOR EACH ROW EXECUTE FUNCTION forecast_sample_assessment_before_insert();

CREATE OR REPLACE FUNCTION assess_forecast_sample(
  p_clv_record_id uuid,
  p_cohort text DEFAULT 'PROSPECTIVE_SHADOW'
)
RETURNS forecast_sample_assessments AS $$
DECLARE
  clv_row forecast_clv_records;
  decision_row forecast_inclusion_decisions;
  result forecast_sample_assessments;
BEGIN
  SELECT * INTO clv_row FROM forecast_clv_records WHERE id = p_clv_record_id;
  IF clv_row.id IS NULL THEN
    RAISE EXCEPTION 'CLV record % does not exist', p_clv_record_id;
  END IF;
  SELECT * INTO decision_row
  FROM forecast_inclusion_decisions
  WHERE match_id = clv_row.match_id AND cohort = p_cohort;
  IF decision_row.id IS NULL THEN
    RAISE EXCEPTION 'Match % has no % inclusion decision', clv_row.match_id, p_cohort;
  END IF;

  INSERT INTO forecast_sample_assessments (
    clv_record_id, inclusion_decision_id, match_id, cohort,
    clean_eligible, ready_gate_eligible, walk_forward_passed,
    reasons_json, entry_captured_at, scheduled_start, assessment_hash
  ) VALUES (
    clv_row.id, decision_row.id, clv_row.match_id, p_cohort,
    false, false, false, '[]'::jsonb, now(), now(), repeat('0', 64)
  ) RETURNING * INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

ALTER TABLE forecast_sample_gate_status
  ADD COLUMN IF NOT EXISTS cohort varchar(30) NOT NULL DEFAULT 'PROSPECTIVE_SHADOW',
  ADD COLUMN IF NOT EXISTS evaluation_sample_size integer NOT NULL DEFAULT 150,
  ADD COLUMN IF NOT EXISTS evaluation_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS historical_backtest_size integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bootstrap_iterations integer NOT NULL DEFAULT 2000,
  ADD COLUMN IF NOT EXISTS calculation_seed integer NOT NULL DEFAULT 20260811,
  ADD COLUMN IF NOT EXISTS human_approval_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS real_candidate_enabled boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_gate_cohort_check') THEN
    ALTER TABLE forecast_sample_gate_status
      ADD CONSTRAINT forecast_gate_cohort_check
      CHECK (cohort = 'PROSPECTIVE_SHADOW');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_gate_evaluation_check') THEN
    ALTER TABLE forecast_sample_gate_status
      ADD CONSTRAINT forecast_gate_evaluation_check
      CHECK (
        evaluation_sample_size >= 1
        AND historical_backtest_size >= 0
        AND bootstrap_iterations >= 100
        AND evaluation_eligible = (clean_sample_size >= evaluation_sample_size)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forecast_gate_never_enables_real_candidate') THEN
    ALTER TABLE forecast_sample_gate_status
      ADD CONSTRAINT forecast_gate_never_enables_real_candidate
      CHECK (real_candidate_enabled = false AND human_approval_required = true);
  END IF;
END;
$$;

CREATE OR REPLACE VIEW forecast_gate_dataset AS
SELECT
  assessment.id AS assessment_id,
  assessment.match_id,
  assessment.entry_captured_at,
  assessment.scheduled_start,
  clv.clv_percent,
  clv.result,
  (fair.value_json->>'model_predicted_prob')::numeric AS model_predicted_prob,
  (fair.value_json->>'market_implied_prob')::numeric AS market_implied_prob,
  assessment.walk_forward_passed
FROM forecast_sample_assessments assessment
JOIN forecast_clv_records clv ON clv.id = assessment.clv_record_id
JOIN forecast_chain fair ON fair.match_id = assessment.match_id AND fair.stage = 'fair_odds'
WHERE assessment.cohort = 'PROSPECTIVE_SHADOW'
  AND assessment.ready_gate_eligible;

CREATE OR REPLACE VIEW forecast_historical_backtest_dataset AS
SELECT
  assessment.id AS assessment_id,
  assessment.match_id,
  assessment.entry_captured_at,
  assessment.scheduled_start,
  clv.clv_percent,
  clv.result,
  (fair.value_json->>'model_predicted_prob')::numeric AS model_predicted_prob,
  (fair.value_json->>'market_implied_prob')::numeric AS market_implied_prob,
  assessment.walk_forward_passed
FROM forecast_sample_assessments assessment
JOIN forecast_clv_records clv ON clv.id = assessment.clv_record_id
JOIN forecast_chain fair ON fair.match_id = assessment.match_id AND fair.stage = 'fair_odds'
WHERE assessment.cohort = 'HISTORICAL_BACKTEST'
  AND assessment.clean_eligible;

DO $$
DECLARE
  table_name text;
  trigger_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'forecast_inclusion_criteria',
    'forecast_inclusion_decisions',
    'forecast_sample_assessments'
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
END;
$$;

-- Freeze initial policy definitions. Historical rules may reach backward in
-- event time, but their observations stay isolated from the prospective gate.
INSERT INTO forecast_inclusion_criteria (
  version_label, cohort, sport_slug, leagues_json, markets_json,
  min_entry_lead_minutes, max_entry_lead_minutes,
  require_context_complete, require_dual_evidence,
  dual_evidence_tolerance_minutes, fair_odds_method_version,
  fair_odds_config, effective_from, criteria_hash
)
VALUES
  (
    'mlb_prospective_shadow_v1', 'PROSPECTIVE_SHADOW', 'baseball', '["mlb"]',
    '["moneyline","moneyline_2way"]', 20, 1440, true, true, 10,
    'owned_fair_odds_v1',
    '{"probability_source":"model_quotes","decimal_formula":"1/p","market_probability":"two_way_proportional_devig"}',
    now(), repeat('0', 64)
  ),
  (
    'soccer_prospective_shadow_v1', 'PROSPECTIVE_SHADOW', 'soccer',
    '["uefa-champions-league","uefa-europa-league","england-league-cup","mls","liga-mx"]',
    '["1x2"]', 20, 1440, true, true, 10,
    'owned_fair_odds_v1',
    '{"probability_source":"model_quotes","decimal_formula":"1/p","market_probability":"three_way_proportional_devig"}',
    now(), repeat('0', 64)
  ),
  (
    'mlb_historical_backtest_v1', 'HISTORICAL_BACKTEST', 'baseball', '["mlb"]',
    '["moneyline","moneyline_2way"]', 20, 1440, false, false, 10,
    'owned_fair_odds_v1',
    '{"research_only":true,"probability_source":"walk_forward_replay","market_probability":"two_way_proportional_devig"}',
    '2026-01-01T00:00:00Z', repeat('0', 64)
  ),
  (
    'soccer_historical_backtest_v1', 'HISTORICAL_BACKTEST', 'soccer',
    '["uefa-champions-league","uefa-europa-league","england-league-cup","mls","liga-mx"]',
    '["1x2"]', 20, 1440, false, false, 10,
    'owned_fair_odds_v1',
    '{"research_only":true,"probability_source":"walk_forward_replay","market_probability":"three_way_proportional_devig"}',
    '2026-01-01T00:00:00Z', repeat('0', 64)
  )
ON CONFLICT (version_label) DO NOTHING;

-- Defense in depth: the application should use only the SECURITY DEFINER
-- functions for decision and assessment inserts. No function changes
-- REAL_CANDIDATE or any real-money setting.
