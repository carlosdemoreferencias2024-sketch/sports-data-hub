-- Fail-closed controls for one-match historical replay validation.
-- This migration does not enable real candidates or mix historical rows into
-- the prospective gate.

ALTER TABLE forecast_context_snapshots
  ADD COLUMN IF NOT EXISTS capture_mode varchar(30) NOT NULL DEFAULT 'LIVE_FORWARD',
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_as_of_at timestamptz,
  ADD COLUMN IF NOT EXISTS replay_verified_by varchar(160),
  ADD COLUMN IF NOT EXISTS no_post_event_data_attested boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'forecast_context_capture_mode_check'
  ) THEN
    ALTER TABLE forecast_context_snapshots
      ADD CONSTRAINT forecast_context_capture_mode_check
      CHECK (capture_mode IN ('LIVE_FORWARD', 'HISTORICAL_REPLAY'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'forecast_context_historical_provenance_check'
  ) THEN
    ALTER TABLE forecast_context_snapshots
      ADD CONSTRAINT forecast_context_historical_provenance_check
      CHECK (
        capture_mode <> 'HISTORICAL_REPLAY'
        OR (
          source_url IS NOT NULL
          AND source_payload_hash IS NOT NULL
          AND source_published_at IS NOT NULL
          AND source_as_of_at IS NOT NULL
          AND replay_verified_by IS NOT NULL
          AND no_post_event_data_attested
          AND source_published_at <= source_as_of_at
          AND source_as_of_at <= captured_at
        )
      );
  END IF;
END;
$$;

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

ALTER TABLE forecast_clv_records
  ADD COLUMN IF NOT EXISTS clv_formula_version varchar(80)
    NOT NULL DEFAULT 'decimal_price_ratio_v1';

CREATE OR REPLACE FUNCTION forecast_clv_before_insert()
RETURNS trigger AS $$
DECLARE
  entry_evidence forecast_evidence;
  closing_evidence forecast_evidence;
  fair_stage forecast_chain;
  clv_stage forecast_chain;
  expected_clv numeric;
  stage_clv numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM forecast_chain WHERE id = NEW.entry_chain_id AND match_id = NEW.match_id AND stage = 'entry')
     OR NOT EXISTS (SELECT 1 FROM forecast_chain WHERE id = NEW.closing_chain_id AND match_id = NEW.match_id AND stage = 'closing')
     OR NOT EXISTS (SELECT 1 FROM forecast_chain WHERE id = NEW.result_chain_id AND match_id = NEW.match_id AND stage = 'result')
     OR NOT EXISTS (SELECT 1 FROM forecast_chain WHERE id = NEW.clv_chain_id AND match_id = NEW.match_id AND stage = 'clv') THEN
    RAISE EXCEPTION 'CLV chain references are incomplete or belong to another match';
  END IF;

  SELECT evidence.* INTO entry_evidence
  FROM forecast_chain chain
  JOIN forecast_evidence evidence ON evidence.id = chain.evidence_id
  WHERE chain.id = NEW.entry_chain_id;
  SELECT evidence.* INTO closing_evidence
  FROM forecast_chain chain
  JOIN forecast_evidence evidence ON evidence.id = chain.evidence_id
  WHERE chain.id = NEW.closing_chain_id;
  SELECT * INTO fair_stage FROM forecast_chain
  WHERE match_id = NEW.match_id AND stage = 'fair_odds';
  SELECT * INTO clv_stage FROM forecast_chain WHERE id = NEW.clv_chain_id;

  IF NEW.clv_formula_version <> 'decimal_price_ratio_v1' THEN
    RAISE EXCEPTION 'Unsupported CLV formula version %', NEW.clv_formula_version;
  END IF;
  IF NEW.entry_odds IS DISTINCT FROM entry_evidence.decimal_odds
     OR NEW.closing_odds IS DISTINCT FROM closing_evidence.decimal_odds THEN
    RAISE EXCEPTION 'CLV odds must match immutable entry and closing evidence';
  END IF;
  IF NEW.model_version_id IS DISTINCT FROM fair_stage.model_version_id THEN
    RAISE EXCEPTION 'CLV model version must match the fair_odds stage';
  END IF;

  expected_clv := (NEW.entry_odds / NEW.closing_odds) - 1;
  BEGIN
    stage_clv := (clv_stage.value_json->>'clv_percent')::numeric;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'clv stage clv_percent must be numeric';
  END;
  IF clv_stage.value_json->>'clv_formula_version' IS DISTINCT FROM NEW.clv_formula_version
     OR stage_clv IS NULL
     OR abs(stage_clv - expected_clv) > 0.00000001
     OR abs(NEW.clv_percent - expected_clv) > 0.00000001 THEN
    RAISE EXCEPTION 'CLV does not match decimal_price_ratio_v1';
  END IF;

  NEW.chain_verified := verify_forecast_chain(NEW.match_id);
  IF NOT NEW.chain_verified OR (
    SELECT count(*) FROM forecast_chain WHERE match_id = NEW.match_id
  ) <> 6 THEN
    RAISE EXCEPTION 'CLV requires a complete six-stage verified chain';
  END IF;
  IF NEW.clean_sample AND NOT NEW.chain_verified THEN
    RAISE EXCEPTION 'A clean sample requires a valid forecast hash chain';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forecast_cohort_isolation_guard()
RETURNS trigger AS $$
DECLARE
  match_row forecast_matches;
BEGIN
  SELECT * INTO match_row FROM forecast_matches WHERE match_id = NEW.match_id;
  IF EXISTS (
    SELECT 1 FROM forecast_inclusion_decisions
    WHERE match_id = NEW.match_id AND cohort <> NEW.cohort
  ) THEN
    RAISE EXCEPTION 'A forecast match cannot be assigned to both replay cohorts';
  END IF;
  IF NEW.cohort = 'HISTORICAL_BACKTEST'
     AND (match_row.scheduled_start >= clock_timestamp() OR match_row.status <> 'finished') THEN
    RAISE EXCEPTION 'Historical replay requires a finished match whose start is in the past';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_00a_forecast_cohort_isolation_guard ON forecast_inclusion_decisions;
CREATE TRIGGER trg_00a_forecast_cohort_isolation_guard
  BEFORE INSERT ON forecast_inclusion_decisions
  FOR EACH ROW EXECUTE FUNCTION forecast_cohort_isolation_guard();

CREATE OR REPLACE FUNCTION forecast_historical_assessment_guard()
RETURNS trigger AS $$
DECLARE
  match_row forecast_matches;
  fair_row forecast_chain;
  result_row forecast_chain;
  model_row forecast_model_versions;
  context_row forecast_context_snapshots;
  entry_evidence forecast_evidence;
  closing_evidence forecast_evidence;
  entry_snapshot odds_snapshots;
  closing_snapshot odds_snapshots;
  extra_reasons jsonb := '[]'::jsonb;
BEGIN
  IF NEW.cohort <> 'HISTORICAL_BACKTEST' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO match_row FROM forecast_matches WHERE match_id = NEW.match_id;
  SELECT * INTO fair_row FROM forecast_chain WHERE match_id = NEW.match_id AND stage = 'fair_odds';
  SELECT * INTO result_row FROM forecast_chain WHERE match_id = NEW.match_id AND stage = 'result';
  SELECT * INTO model_row FROM forecast_model_versions WHERE id = fair_row.model_version_id;
  SELECT context.* INTO context_row
  FROM forecast_chain chain
  JOIN forecast_context_snapshots context ON context.id = chain.context_id
  WHERE chain.match_id = NEW.match_id AND chain.stage = 'context';
  SELECT evidence.* INTO entry_evidence
  FROM forecast_chain chain
  JOIN forecast_evidence evidence ON evidence.id = chain.evidence_id
  WHERE chain.match_id = NEW.match_id AND chain.stage = 'entry';
  SELECT evidence.* INTO closing_evidence
  FROM forecast_chain chain
  JOIN forecast_evidence evidence ON evidence.id = chain.evidence_id
  WHERE chain.match_id = NEW.match_id AND chain.stage = 'closing';
  SELECT * INTO entry_snapshot FROM odds_snapshots WHERE id = entry_evidence.odds_snapshot_id;
  SELECT * INTO closing_snapshot FROM odds_snapshots WHERE id = closing_evidence.odds_snapshot_id;

  IF context_row.capture_mode <> 'HISTORICAL_REPLAY'
     OR context_row.source_as_of_at > match_row.scheduled_start
     OR NOT context_row.no_post_event_data_attested THEN
    extra_reasons := extra_reasons || jsonb_build_array('HISTORICAL_CONTEXT_PROVENANCE_INVALID');
  END IF;
  IF model_row.id IS NULL
     OR model_row.training_cutoff_date > entry_evidence.captured_at::date
     OR model_row.trained_at > entry_evidence.captured_at THEN
    extra_reasons := extra_reasons || jsonb_build_array('WALK_FORWARD_ENTRY_CUTOFF_FAILED');
    NEW.walk_forward_passed := false;
  END IF;
  IF entry_snapshot.id IS NULL OR closing_snapshot.id IS NULL
     OR entry_evidence.odds_snapshot_id = closing_evidence.odds_snapshot_id
     OR entry_snapshot.match_id <> NEW.match_id OR closing_snapshot.match_id <> NEW.match_id
     OR entry_snapshot.captured_at IS DISTINCT FROM entry_evidence.captured_at
     OR closing_snapshot.captured_at IS DISTINCT FROM closing_evidence.captured_at
     OR entry_snapshot.bookmaker IS DISTINCT FROM entry_evidence.bookmaker
     OR closing_snapshot.bookmaker IS DISTINCT FROM closing_evidence.bookmaker
     OR entry_snapshot.market_type IS DISTINCT FROM entry_evidence.market_type
     OR closing_snapshot.market_type IS DISTINCT FROM closing_evidence.market_type
     OR entry_snapshot.selection IS DISTINCT FROM entry_evidence.selection
     OR closing_snapshot.selection IS DISTINCT FROM closing_evidence.selection
     OR entry_snapshot.odds IS DISTINCT FROM entry_evidence.decimal_odds
     OR closing_snapshot.odds IS DISTINCT FROM closing_evidence.decimal_odds THEN
    extra_reasons := extra_reasons || jsonb_build_array('ODDS_EVIDENCE_NOT_TRACEABLE');
  END IF;
  IF result_row.value_json->>'verified' <> 'true'
     OR NULLIF(result_row.value_json->>'verified_by', '') IS NULL
     OR NULLIF(result_row.value_json->>'verified_at', '') IS NULL
     OR NULLIF(result_row.value_json->>'source_url', '') IS NULL
     OR (result_row.value_json->>'source_payload_hash') !~ '^[a-fA-F0-9]{64}$' THEN
    extra_reasons := extra_reasons || jsonb_build_array('FINAL_RESULT_NOT_VERIFIABLE');
  END IF;

  IF jsonb_array_length(extra_reasons) > 0 THEN
    NEW.clean_eligible := false;
    NEW.ready_gate_eligible := false;
    NEW.reasons_json := NEW.reasons_json || extra_reasons;
  END IF;
  IF NEW.ready_gate_eligible THEN
    RAISE EXCEPTION 'Historical replay can never be eligible for the prospective gate';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_99_forecast_historical_assessment_guard ON forecast_sample_assessments;
CREATE TRIGGER trg_99_forecast_historical_assessment_guard
  BEFORE INSERT ON forecast_sample_assessments
  FOR EACH ROW EXECUTE FUNCTION forecast_historical_assessment_guard();

INSERT INTO forecast_inclusion_criteria (
  version_label, cohort, sport_slug, leagues_json, markets_json,
  min_entry_lead_minutes, max_entry_lead_minutes,
  require_context_complete, require_dual_evidence,
  dual_evidence_tolerance_minutes, fair_odds_method_version,
  fair_odds_config, effective_from, supersedes_criteria_id, criteria_hash
)
SELECT
  policy.version_label,
  'HISTORICAL_BACKTEST',
  policy.sport_slug,
  policy.leagues_json::jsonb,
  policy.markets_json::jsonb,
  20,
  1440,
  true,
  true,
  10,
  'owned_fair_odds_v1',
  policy.config::jsonb,
  '2026-01-01T00:00:01Z'::timestamptz,
  prior.id,
  repeat('0', 64)
FROM (VALUES
  (
    'mlb_historical_backtest_v2',
    'baseball',
    '["mlb"]',
    '["moneyline","moneyline_2way"]',
    '{"research_only":true,"probability_source":"walk_forward_replay","market_probability":"two_way_proportional_devig","context_as_of_required":true,"dual_evidence_required":true,"clv_formula_version":"decimal_price_ratio_v1"}'
  ),
  (
    'soccer_historical_backtest_v2',
    'soccer',
    '["uefa-champions-league","uefa-europa-league","england-league-cup","mls","liga-mx"]',
    '["1x2"]',
    '{"research_only":true,"probability_source":"walk_forward_replay","market_probability":"three_way_proportional_devig","context_as_of_required":true,"dual_evidence_required":true,"clv_formula_version":"decimal_price_ratio_v1"}'
  )
) AS policy(version_label, sport_slug, leagues_json, markets_json, config)
JOIN forecast_inclusion_criteria prior
  ON prior.version_label = CASE policy.sport_slug
    WHEN 'baseball' THEN 'mlb_historical_backtest_v1'
    ELSE 'soccer_historical_backtest_v1'
  END
ON CONFLICT (version_label) DO NOTHING;

-- Historical assessments remain physically isolated from the READY dataset.
-- No statement in this migration changes real_candidate_enabled.
