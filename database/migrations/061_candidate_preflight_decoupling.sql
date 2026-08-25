-- Candidate preflight must evaluate owned fair odds independently from entry
-- evidence. Evidence is only required when matching the quote market and
-- calculating selection-level probability and edge.

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
  fair_quote_row model_quotes;
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

  -- First establish whether any eligible owned quote exists. This lookup must
  -- not inherit the state or market type of entry evidence.
  SELECT quote.* INTO fair_quote_row
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
    AND version.trained_at <= p_decision_as_of
    AND version.training_cutoff_date <= p_decision_as_of::date
  ORDER BY quote.generated_at DESC, quote.id DESC LIMIT 1;

  IF fair_quote_row.id IS NULL THEN
    reasons := reasons || jsonb_build_array('FAIR_ODDS_MISSING_AS_OF');
  ELSE
    -- Preserve a quote reference even when evidence is absent so the snapshot
    -- records that fair odds existed as of the decision time.
    model_quote_row := fair_quote_row;
  END IF;

  IF evidence_row.id IS NOT NULL AND fair_quote_row.id IS NOT NULL THEN
    -- Prefer the newest quote compatible with the captured market. A mismatch
    -- is reported only when both requirements exist but cannot be paired.
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

    IF model_quote_row.id IS NULL THEN
      model_quote_row := fair_quote_row;
      reasons := reasons || jsonb_build_array('MODEL_MARKET_MISMATCH');
    ELSE
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
  END IF;

  IF model_quote_row.id IS NOT NULL THEN
    SELECT * INTO model_row
    FROM forecast_model_versions
    WHERE id = CASE
      WHEN model_quote_row.raw_data->>'model_version_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (model_quote_row.raw_data->>'model_version_id')::uuid
      ELSE NULL
    END;
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
