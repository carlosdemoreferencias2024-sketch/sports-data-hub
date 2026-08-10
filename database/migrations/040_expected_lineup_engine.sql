CREATE TABLE IF NOT EXISTS sports_expected_lineups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  league_id text NOT NULL DEFAULT '',
  team_name text NOT NULL,
  normalized_team_name text NOT NULL,
  player_name text NOT NULL,
  normalized_player_name text NOT NULL,
  position text,
  expected_role text NOT NULL DEFAULT 'STARTER',
  expected_starting boolean NOT NULL DEFAULT true,
  confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  source text NOT NULL,
  source_reason text,
  sample_size integer NOT NULL DEFAULT 0,
  last_seen_match_id text,
  last_seen_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_expected_lineups_unique
  ON sports_expected_lineups(sport, league_id, normalized_team_name, normalized_player_name);

CREATE INDEX IF NOT EXISTS idx_sports_expected_lineups_lookup
  ON sports_expected_lineups(sport, league_id, normalized_team_name, expected_starting, confidence_score DESC);
