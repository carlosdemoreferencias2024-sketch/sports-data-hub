-- Stable per-day operational focus for the prospective football chain.
-- A focus never moves to another fixture after evidence collection starts.

CREATE TABLE IF NOT EXISTS forecast_operational_focus_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  local_date date NOT NULL,
  sport_slug varchar(40) NOT NULL,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
  status varchar(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'COMPLETED', 'MISSED', 'RELEASED')),
  selection_source varchar(120) NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_until timestamptz NOT NULL,
  completed_at timestamptz,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (local_date, sport_slug)
);

CREATE INDEX IF NOT EXISTS idx_forecast_operational_focus_match
  ON forecast_operational_focus_locks(match_id, status, selected_at DESC);

CREATE INDEX IF NOT EXISTS idx_forecast_operational_focus_active
  ON forecast_operational_focus_locks(sport_slug, local_date, locked_until)
  WHERE status = 'ACTIVE';
