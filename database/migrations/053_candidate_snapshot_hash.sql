BEGIN;

CREATE OR REPLACE FUNCTION forecast_candidate_snapshot_hash(
  p_snapshot forecast_candidate_snapshots
)
RETURNS text AS $$
  SELECT encode(digest(convert_to(concat_ws(E'\x1f',
    p_snapshot.match_id::text,
    to_char(p_snapshot.decision_as_of AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    COALESCE(p_snapshot.schedule_validation_id::text, ''),
    COALESCE(p_snapshot.identity_validation_id::text, ''),
    COALESCE(p_snapshot.freshness_validation_id::text, ''),
    COALESCE(p_snapshot.entry_evidence_id::text, ''),
    COALESCE(p_snapshot.context_id::text, ''),
    COALESCE(p_snapshot.fair_odds_chain_id::text, ''),
    COALESCE(p_snapshot.model_version_id::text, ''),
    COALESCE(p_snapshot.model_quote_id::text, ''),
    COALESCE(to_char(p_snapshot.model_probability, 'FM0.0000000000'), ''),
    COALESCE(to_char(p_snapshot.decimal_odds, 'FM0.0000'), ''),
    COALESCE(to_char(p_snapshot.expected_value, 'FM0.00000000'), ''),
    p_snapshot.verdict,
    p_snapshot.reasons_json::text
  ), 'UTF8'), 'sha256'), 'hex');
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION canonicalize_candidate_snapshot_hash()
RETURNS trigger AS $$
BEGIN
  NEW.snapshot_hash := forecast_candidate_snapshot_hash(NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_canonicalize_candidate_snapshot_hash
  ON forecast_candidate_snapshots;
CREATE TRIGGER trg_canonicalize_candidate_snapshot_hash
  BEFORE INSERT ON forecast_candidate_snapshots
  FOR EACH ROW EXECUTE FUNCTION canonicalize_candidate_snapshot_hash();

CREATE OR REPLACE FUNCTION verify_candidate_snapshot(p_snapshot_id uuid)
RETURNS boolean AS $$
  SELECT snapshot_hash = forecast_candidate_snapshot_hash(snapshot_row)
  FROM forecast_candidate_snapshots snapshot_row
  WHERE id = p_snapshot_id;
$$ LANGUAGE sql STABLE;

COMMIT;
