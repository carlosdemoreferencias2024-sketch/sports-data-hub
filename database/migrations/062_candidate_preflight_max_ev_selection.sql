-- Candidate preflight must evaluate every selection in the newest coherent
-- market snapshot before choosing one. Technical identifiers are only stable
-- final tie-breakers after expected value and semantic selection ordering.

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
  selected_evidence_id uuid;
  selected_quote_id uuid;
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

  -- This row establishes evidence presence only. If an exact market pair is
  -- available below, it is replaced with the MAX_EV selection from the whole
  -- latest snapshot. UUID is the final tie-breaker, never the sporting rule.
  SELECT evidence.* INTO evidence_row
  FROM forecast_evidence evidence
  WHERE evidence.match_id = p_match_id
    AND EXISTS (
      SELECT 1
      FROM forecast_evidence_roles role
      WHERE role.evidence_id = evidence.id
        AND role.evidence_role IN ('entry', 'current')
        AND role.assigned_at <= p_decision_as_of
    )
    AND evidence.recorded_at <= p_decision_as_of
    AND evidence.captured_at <= p_decision_as_of
    AND evidence.captured_at < match_row.scheduled_start
    AND evidence.timing_quality NOT IN ('LATE', 'AUDIT_ONLY')
  ORDER BY
    evidence.captured_at DESC,
    evidence.recorded_at DESC,
    evidence.raw_payload_hash ASC,
    lower(evidence.provider_name) ASC,
    lower(evidence.bookmaker) ASC,
    lower(evidence.market_type) ASC,
    CASE lower(evidence.selection)
      WHEN 'home' THEN 1 WHEN 'draw' THEN 2 WHEN 'away' THEN 3
      WHEN 'over' THEN 4 WHEN 'under' THEN 5 ELSE 100
    END,
    lower(evidence.selection) ASC,
    evidence.id ASC
  LIMIT 1;
  IF evidence_row.id IS NULL THEN
    reasons := reasons || jsonb_build_array('ENTRY_EVIDENCE_MISSING_AS_OF');
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

  -- Fair odds existence is independent from entry evidence.
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
    model_quote_row := fair_quote_row;
  END IF;

  IF evidence_row.id IS NOT NULL AND fair_quote_row.id IS NOT NULL THEN
    WITH eligible_evidence AS (
      SELECT evidence.*
      FROM forecast_evidence evidence
      WHERE evidence.match_id = p_match_id
        AND EXISTS (
          SELECT 1
          FROM forecast_evidence_roles role
          WHERE role.evidence_id = evidence.id
            AND role.evidence_role IN ('entry', 'current')
            AND role.assigned_at <= p_decision_as_of
        )
        AND evidence.recorded_at <= p_decision_as_of
        AND evidence.captured_at <= p_decision_as_of
        AND evidence.captured_at < match_row.scheduled_start
        AND evidence.timing_quality NOT IN ('LATE', 'AUDIT_ONLY')
    ),
    latest_capture AS (
      SELECT max(captured_at) AS captured_at FROM eligible_evidence
    ),
    latest_snapshot_evidence AS (
      SELECT evidence.*
      FROM eligible_evidence evidence
      JOIN latest_capture latest ON latest.captured_at = evidence.captured_at
    ),
    coherent_snapshot_groups AS (
      SELECT
        evidence.raw_payload_hash,
        evidence.provider_name,
        evidence.bookmaker,
        evidence.market_type,
        evidence.captured_at
      FROM latest_snapshot_evidence evidence
      GROUP BY
        evidence.raw_payload_hash,
        evidence.provider_name,
        evidence.bookmaker,
        evidence.market_type,
        evidence.captured_at
      HAVING lower(evidence.market_type) <> 'moneyline_3way'
        OR count(DISTINCT lower(evidence.selection)) FILTER (
          WHERE lower(evidence.selection) IN ('home', 'draw', 'away')
        ) = 3
    ),
    coherent_snapshot_evidence AS (
      SELECT evidence.*
      FROM latest_snapshot_evidence evidence
      JOIN coherent_snapshot_groups snapshot
        ON snapshot.raw_payload_hash = evidence.raw_payload_hash
       AND snapshot.provider_name = evidence.provider_name
       AND snapshot.bookmaker = evidence.bookmaker
       AND snapshot.market_type = evidence.market_type
       AND snapshot.captured_at = evidence.captured_at
    ),
    latest_quotes AS (
      SELECT DISTINCT ON (lower(quote.market_type)) quote.*
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
      ORDER BY lower(quote.market_type), quote.generated_at DESC, quote.id DESC
    ),
    evaluated AS (
      SELECT
        evidence.id AS evidence_id,
        quote.id AS quote_id,
        evidence.selection,
        CASE lower(evidence.selection)
          WHEN 'home' THEN quote.home_probability
          WHEN 'away' THEN quote.away_probability
          WHEN 'draw' THEN quote.draw_probability
          WHEN 'over' THEN quote.home_probability
          WHEN 'under' THEN quote.away_probability
          ELSE NULL
        END AS probability,
        evidence.decimal_odds
      FROM coherent_snapshot_evidence evidence
      JOIN latest_quotes quote
        ON lower(quote.market_type) = lower(evidence.market_type)
    )
    SELECT
      evaluated.evidence_id,
      evaluated.quote_id,
      evaluated.probability,
      evaluated.decimal_odds * evaluated.probability - 1
    INTO selected_evidence_id, selected_quote_id, model_probability, expected_value
    FROM evaluated
    WHERE evaluated.probability > 0
      AND evaluated.probability < 1
      AND evaluated.decimal_odds > 1
    ORDER BY
      (evaluated.decimal_odds * evaluated.probability - 1) DESC,
      CASE lower(evaluated.selection)
        WHEN 'home' THEN 1 WHEN 'draw' THEN 2 WHEN 'away' THEN 3
        WHEN 'over' THEN 4 WHEN 'under' THEN 5 ELSE 100
      END,
      lower(evaluated.selection) ASC,
      evaluated.evidence_id ASC,
      evaluated.quote_id ASC
    LIMIT 1;

    IF selected_evidence_id IS NULL OR selected_quote_id IS NULL THEN
      model_quote_row := fair_quote_row;
      reasons := reasons || jsonb_build_array('NO_VALID_MARKET_SELECTIONS');
    ELSE
      SELECT * INTO evidence_row FROM forecast_evidence WHERE id = selected_evidence_id;
      SELECT * INTO model_quote_row FROM model_quotes WHERE id = selected_quote_id;
    END IF;
  END IF;

  IF evidence_row.id IS NOT NULL THEN
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

-- Replayable audit over append-only evidence, model quotes and candidate
-- snapshots. No duplicate mutable state is introduced.
CREATE OR REPLACE VIEW forecast_candidate_edge_audit AS
SELECT
  snapshot.id AS candidate_snapshot_id,
  snapshot.match_id,
  selected.market_type AS market_key,
  selected.raw_payload_hash AS snapshot_raw_payload_hash,
  selected.captured_at,
  COALESCE(audit.considered, '[]'::jsonb) AS considered,
  snapshot.entry_evidence_id AS selected_selection_id,
  selected.selection AS selected_side,
  snapshot.expected_value AS selected_ev,
  CASE
    WHEN snapshot.entry_evidence_id IS NOT NULL AND snapshot.model_quote_id IS NOT NULL THEN 'MAX_EV'
    ELSE 'NONE_ELIGIBLE'
  END AS selection_rule
FROM forecast_candidate_snapshots snapshot
LEFT JOIN forecast_evidence selected ON selected.id = snapshot.entry_evidence_id
LEFT JOIN model_quotes quote ON quote.id = snapshot.model_quote_id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object(
      'selection_id', evaluated.id,
      'side', evaluated.selection,
      'odds', evaluated.decimal_odds,
      'model_probability', evaluated.probability,
      'ev', evaluated.expected_value
    )
    ORDER BY
      evaluated.expected_value DESC,
      CASE lower(evaluated.selection)
        WHEN 'home' THEN 1 WHEN 'draw' THEN 2 WHEN 'away' THEN 3
        WHEN 'over' THEN 4 WHEN 'under' THEN 5 ELSE 100
      END,
      lower(evaluated.selection),
      evaluated.id
  ) AS considered
  FROM (
    SELECT
      evidence.id,
      evidence.selection,
      evidence.decimal_odds,
      CASE lower(evidence.selection)
        WHEN 'home' THEN quote.home_probability
        WHEN 'away' THEN quote.away_probability
        WHEN 'draw' THEN quote.draw_probability
        WHEN 'over' THEN quote.home_probability
        WHEN 'under' THEN quote.away_probability
        ELSE NULL
      END AS probability,
      evidence.decimal_odds * CASE lower(evidence.selection)
        WHEN 'home' THEN quote.home_probability
        WHEN 'away' THEN quote.away_probability
        WHEN 'draw' THEN quote.draw_probability
        WHEN 'over' THEN quote.home_probability
        WHEN 'under' THEN quote.away_probability
        ELSE NULL
      END - 1 AS expected_value
    FROM forecast_evidence evidence
    WHERE selected.id IS NOT NULL
      AND quote.id IS NOT NULL
      AND evidence.match_id = selected.match_id
      AND evidence.raw_payload_hash = selected.raw_payload_hash
      AND evidence.provider_name = selected.provider_name
      AND evidence.bookmaker = selected.bookmaker
      AND lower(evidence.market_type) = lower(selected.market_type)
      AND evidence.captured_at = selected.captured_at
      AND lower(quote.market_type) = lower(evidence.market_type)
  ) evaluated
  WHERE evaluated.probability > 0
    AND evaluated.probability < 1
    AND evaluated.decimal_odds > 1
) audit ON true;
