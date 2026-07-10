CREATE TABLE IF NOT EXISTS provider_event_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  provider_name VARCHAR(80) NOT NULL,
  provider_event_id VARCHAR(180) NOT NULL,
  home_team_name VARCHAR(255) NOT NULL,
  away_team_name VARCHAR(255) NOT NULL,
  kickoff TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_verified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_name, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_event_mappings_lookup
  ON provider_event_mappings(provider_name, provider_event_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_provider_event_mappings_match
  ON provider_event_mappings(hub_match_id);

CREATE INDEX IF NOT EXISTS idx_provider_event_mappings_verified
  ON provider_event_mappings(last_verified DESC);

DROP TRIGGER IF EXISTS provider_event_mappings_updated_at ON provider_event_mappings;
CREATE TRIGGER provider_event_mappings_updated_at
  BEFORE UPDATE ON provider_event_mappings
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
