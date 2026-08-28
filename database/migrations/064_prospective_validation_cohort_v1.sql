BEGIN;

-- Prospective Validation Cohort v1 derives operational sample membership from
-- immutable source rows. No second mutable sample-status table is introduced.

CREATE OR REPLACE FUNCTION forecast_sample_assessment_before_insert()
RETURNS trigger AS $$
DECLARE
  decision_row forecast_inclusion_decisions;
  criteria_row forecast_inclusion_criteria;
  clv_row forecast_clv_records;
  match_row forecast_matches;
  context_row forecast_context_snapshots;
  entry_evidence forecast_evidence;
  closing_evidence forecast_evidence;
  fair_row forecast_chain;
  model_row forecast_model_versions;
  quote_row model_quotes;
  ticket_row paper_trades;
  preflight_row forecast_candidate_snapshots;
  reasons jsonb := '[]'::jsonb;
  closing_lead_minutes numeric;
  context_as_of timestamptz;
BEGIN
  NEW.assessed_at := clock_timestamp();
  SELECT * INTO decision_row FROM forecast_inclusion_decisions WHERE id = NEW.inclusion_decision_id;
  SELECT * INTO criteria_row FROM forecast_inclusion_criteria WHERE id = decision_row.criteria_id;
  SELECT * INTO clv_row FROM forecast_clv_records WHERE id = NEW.clv_record_id;
  SELECT * INTO match_row FROM forecast_matches WHERE match_id = NEW.match_id;
  SELECT fc.* INTO fair_row FROM forecast_chain fc WHERE fc.match_id = NEW.match_id AND fc.stage = 'fair_odds';
  SELECT mv.* INTO model_row FROM forecast_model_versions mv WHERE mv.id = fair_row.model_version_id;
  SELECT mq.* INTO quote_row FROM model_quotes mq WHERE mq.id = fair_row.model_quote_id;
  SELECT context.* INTO context_row
    FROM forecast_chain fc
    JOIN forecast_context_snapshots context ON context.id = fc.context_id
    WHERE fc.match_id = NEW.match_id AND fc.stage = 'context';
  SELECT evidence.* INTO entry_evidence
    FROM forecast_chain fc
    JOIN forecast_evidence evidence ON evidence.id = fc.evidence_id
    WHERE fc.id = clv_row.entry_chain_id;
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

  -- Historical replay has its own provenance guard. These checks are strictly
  -- for observations that claim to have been created prospectively.
  IF NEW.cohort = 'PROSPECTIVE_SHADOW' THEN
    context_as_of := COALESCE(context_row.source_as_of_at, context_row.captured_at);

    IF fair_row.id IS NULL OR quote_row.id IS NULL
       OR fair_row.created_at >= match_row.scheduled_start
       OR quote_row.generated_at >= match_row.scheduled_start THEN
      reasons := reasons || jsonb_build_array('PREDICTION_NOT_CREATED_PRE_KICKOFF');
    END IF;
    IF entry_evidence.id IS NULL OR entry_evidence.captured_at >= match_row.scheduled_start
       OR entry_evidence.recorded_at >= match_row.scheduled_start THEN
      reasons := reasons || jsonb_build_array('ENTRY_NOT_AVAILABLE_PRE_KICKOFF');
    END IF;
    IF context_row.id IS NULL OR context_as_of IS NULL
       OR context_as_of >= match_row.scheduled_start
       OR context_row.recorded_at >= match_row.scheduled_start THEN
      reasons := reasons || jsonb_build_array('CONTEXT_NOT_AVAILABLE_PRE_KICKOFF');
    END IF;
    IF closing_evidence.id IS NULL OR closing_evidence.captured_at >= match_row.scheduled_start
       OR closing_evidence.recorded_at >= match_row.scheduled_start THEN
      reasons := reasons || jsonb_build_array('CLOSING_NOT_AVAILABLE_PRE_KICKOFF');
    END IF;

    SELECT pt.* INTO ticket_row
    FROM paper_trades pt
    WHERE pt.match_id = NEW.match_id
      AND pt.market_type = entry_evidence.market_type
      AND pt.selection = entry_evidence.selection
      AND pt.league_type IN ('football_shadow', 'shadow_paper', 'real_paper')
      AND pt.created_at < match_row.scheduled_start
    ORDER BY pt.created_at DESC, pt.id DESC
    LIMIT 1;

    IF ticket_row.id IS NULL THEN
      reasons := reasons || jsonb_build_array('SHADOW_TICKET_MISSING');
    ELSE
      SELECT snapshot.* INTO preflight_row
      FROM forecast_candidate_snapshots snapshot
      WHERE snapshot.id::text = ticket_row.raw_data->>'preflight_snapshot_id'
        AND snapshot.match_id = NEW.match_id
      LIMIT 1;

      IF ticket_row.raw_data->>'mode' IS DISTINCT FROM 'SHADOW'
         OR ticket_row.raw_data->>'real_eligible' IS DISTINCT FROM 'false' THEN
        reasons := reasons || jsonb_build_array('SHADOW_MODE_NOT_EXPLICIT');
      END IF;
      IF match_row.league_slug = 'liga-mx' AND ticket_row.league_type <> 'football_shadow' THEN
        reasons := reasons || jsonb_build_array('LIGA_MX_SHADOW_ONLY_POLICY_VIOLATION');
      END IF;
      IF ticket_row.status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID') OR ticket_row.settled_at IS NULL THEN
        reasons := reasons || jsonb_build_array('SHADOW_NOT_SETTLED');
      END IF;
      IF preflight_row.id IS NULL OR preflight_row.verdict <> 'PASS'
         OR NOT COALESCE(verify_candidate_snapshot(preflight_row.id), false)
         OR preflight_row.decision_as_of >= match_row.scheduled_start
         OR preflight_row.created_at >= match_row.scheduled_start
         OR preflight_row.created_at > ticket_row.created_at THEN
        reasons := reasons || jsonb_build_array('PREFLIGHT_PASS_NOT_ANCHORED');
      END IF;
    END IF;
  END IF;

  NEW.clean_eligible := jsonb_array_length(reasons) = 0;
  NEW.ready_gate_eligible := NEW.clean_eligible AND NEW.cohort = 'PROSPECTIVE_SHADOW';
  NEW.reasons_json := reasons;
  NEW.entry_captured_at := entry_evidence.captured_at;
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

CREATE OR REPLACE VIEW forecast_prospective_validation_cohort_v1 AS
WITH chain_rows AS (
  SELECT
    decision.id AS forecast_id,
    decision.match_id,
    decision.cohort,
    decision.decision AS inclusion_decision,
    decision.reasons_json AS inclusion_reasons,
    decision.evaluated_at AS preregistered_at,
    match.sport_slug AS sport,
    match.league_slug AS league,
    match.home_team,
    match.away_team,
    match.scheduled_start AS kickoff,
    fair.id AS fair_odds_chain_id,
    fair.created_at AS prediction_created_at,
    fair.model_quote_id,
    model.version_label AS model_version,
    model.feature_schema_version AS feature_version,
    quote.generated_at AS model_generated_at,
    entry_evidence.id AS entry_evidence_id,
    entry_evidence.market_type,
    entry_evidence.selection,
    entry_evidence.decimal_odds AS market_odds_entry,
    entry_evidence.captured_at AS entry_odds_timestamp,
    entry_evidence.recorded_at AS entry_recorded_at,
    context.id AS context_id,
    COALESCE(context.source_as_of_at, context.captured_at) AS context_as_of,
    context.recorded_at AS context_recorded_at,
    context.completeness_flag = 'complete' AS context_complete,
    closing_evidence.id AS closing_evidence_id,
    closing_evidence.decimal_odds AS closing_odds,
    closing_evidence.captured_at AS closing_captured_at,
    closing_evidence.recorded_at AS closing_recorded_at,
    closing_evidence.timing_quality AS closing_timing_quality,
    assessment.id AS assessment_id,
    assessment.clean_eligible,
    assessment.ready_gate_eligible,
    assessment.reasons_json AS assessment_reasons,
    clv.id AS clv_record_id,
    clv.result,
    clv.clv_percent AS clv,
    clv.calculated_at AS clv_calculated_at
  FROM forecast_inclusion_decisions decision
  JOIN forecast_matches match ON match.match_id = decision.match_id
  LEFT JOIN forecast_chain fair ON fair.match_id = decision.match_id AND fair.stage = 'fair_odds'
  LEFT JOIN forecast_model_versions model ON model.id = fair.model_version_id
  LEFT JOIN model_quotes quote ON quote.id = fair.model_quote_id
  LEFT JOIN forecast_chain entry ON entry.match_id = decision.match_id AND entry.stage = 'entry'
  LEFT JOIN forecast_evidence entry_evidence ON entry_evidence.id = entry.evidence_id
  LEFT JOIN forecast_chain context_stage ON context_stage.match_id = decision.match_id AND context_stage.stage = 'context'
  LEFT JOIN forecast_context_snapshots context ON context.id = context_stage.context_id
  LEFT JOIN forecast_chain closing ON closing.match_id = decision.match_id AND closing.stage = 'closing'
  LEFT JOIN forecast_evidence closing_evidence ON closing_evidence.id = closing.evidence_id
  LEFT JOIN forecast_sample_assessments assessment
    ON assessment.inclusion_decision_id = decision.id
  LEFT JOIN forecast_clv_records clv ON clv.id = assessment.clv_record_id
), anchored_ticket AS (
  SELECT DISTINCT ON (rows.forecast_id)
    rows.forecast_id AS anchor_forecast_id,
    ticket.id AS shadow_ticket_id,
    ticket.league_type AS shadow_ticket_type,
    ticket.created_at AS shadow_created_at,
    ticket.settled_at,
    ticket.status AS shadow_status,
    ticket.net_profit,
    ticket.raw_data->>'preflight_snapshot_id' AS preflight_snapshot_id,
    ticket.raw_data->>'mode' AS ticket_mode,
    ticket.raw_data->>'real_eligible' AS ticket_real_eligible,
    preflight.verdict AS preflight_verdict,
    preflight.decision_as_of AS preflight_as_of,
    preflight.created_at AS preflight_created_at,
    COALESCE(verify_candidate_snapshot(preflight.id), false) AS preflight_hash_valid,
    preflight.model_probability,
    preflight.decimal_odds,
    preflight.expected_value
  FROM chain_rows rows
  LEFT JOIN paper_trades ticket
    ON ticket.match_id = rows.match_id
   AND ticket.market_type = rows.market_type
   AND ticket.selection = rows.selection
   AND ticket.league_type IN ('football_shadow', 'shadow_paper', 'real_paper')
  LEFT JOIN forecast_candidate_snapshots preflight
    ON preflight.id::text = ticket.raw_data->>'preflight_snapshot_id'
   AND preflight.match_id = rows.match_id
  ORDER BY rows.forecast_id, ticket.created_at DESC NULLS LAST, ticket.id DESC NULLS LAST
), classified AS (
  SELECT
    rows.*,
    ticket.*,
    CASE
      WHEN rows.cohort = 'HISTORICAL_BACKTEST' THEN 'REPLAY_RESEARCH'
      WHEN rows.ready_gate_eligible
       AND ticket.shadow_ticket_id IS NOT NULL
       AND ticket.preflight_verdict = 'PASS'
       AND ticket.preflight_hash_valid
       AND ticket.ticket_mode = 'SHADOW'
       AND ticket.ticket_real_eligible = 'false'
      THEN 'PROSPECTIVE_CLEAN'
      ELSE 'PROSPECTIVE_INCOMPLETE'
    END AS sample_class
  FROM chain_rows rows
  LEFT JOIN anchored_ticket ticket ON ticket.anchor_forecast_id = rows.forecast_id
)
SELECT
  classified.*,
  CASE WHEN model_probability > 0 THEN 1 / model_probability ELSE NULL END AS fair_odds,
  CASE WHEN market_odds_entry > 1 THEN 1 / market_odds_entry ELSE NULL END AS market_implied_probability,
  NULL::numeric AS market_no_vig_probability,
  expected_value AS ev_at_entry,
  (prediction_created_at < kickoff AND model_generated_at < kickoff) AS prediction_pre_kickoff,
  (entry_odds_timestamp < kickoff AND entry_recorded_at < kickoff) AS entry_pre_kickoff,
  (context_as_of < kickoff AND context_recorded_at < kickoff) AS context_pre_kickoff,
  (closing_captured_at < kickoff AND closing_recorded_at < kickoff) AS closing_pre_kickoff,
  COALESCE(assessment_reasons, '[]'::jsonb) AS classification_reasons
FROM classified;

CREATE OR REPLACE VIEW forecast_operational_metrics_dataset_v1 AS
SELECT *
FROM forecast_prospective_validation_cohort_v1
WHERE sample_class = 'PROSPECTIVE_CLEAN';

CREATE OR REPLACE VIEW forecast_replay_research_dataset_v1 AS
SELECT *
FROM forecast_prospective_validation_cohort_v1
WHERE sample_class = 'REPLAY_RESEARCH';

COMMIT;
