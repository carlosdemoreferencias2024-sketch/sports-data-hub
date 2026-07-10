CREATE TABLE IF NOT EXISTS raw_provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name VARCHAR(80) NOT NULL,
  provider_event_id VARCHAR(180) NOT NULL,
  league_name VARCHAR(255),
  home_team_name VARCHAR(255) NOT NULL,
  away_team_name VARCHAR(255) NOT NULL,
  kickoff TIMESTAMPTZ NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'pending_mapping',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider_name, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_provider_events_unmapped
  ON raw_provider_events(provider_name, kickoff)
  WHERE status = 'pending_mapping';

CREATE INDEX IF NOT EXISTS idx_raw_provider_events_lookup
  ON raw_provider_events(provider_name, provider_event_id);
