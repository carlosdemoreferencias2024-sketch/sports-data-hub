CREATE TABLE IF NOT EXISTS sports_team_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  league_id text NOT NULL DEFAULT '',
  team_id text,
  team_name text NOT NULL,
  normalized_team_name text NOT NULL,
  country text,
  home_venue text,
  profile_status text NOT NULL DEFAULT 'ACTIVE',
  source text NOT NULL,
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_team_profiles_unique
  ON sports_team_profiles(sport, league_id, normalized_team_name);

CREATE INDEX IF NOT EXISTS idx_sports_team_profiles_lookup
  ON sports_team_profiles(sport, league_id, profile_status, source_confidence_score DESC);

CREATE TABLE IF NOT EXISTS sports_player_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  league_id text NOT NULL DEFAULT '',
  team_id text,
  team_name text,
  normalized_team_name text,
  player_id text,
  player_name text NOT NULL,
  normalized_player_name text NOT NULL,
  position text,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL,
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_player_profiles_unique
  ON sports_player_profiles(sport, league_id, COALESCE(normalized_team_name, ''), normalized_player_name);

CREATE INDEX IF NOT EXISTS idx_sports_player_profiles_lookup
  ON sports_player_profiles(sport, league_id, normalized_team_name, active, source_confidence_score DESC);

CREATE TABLE IF NOT EXISTS sports_match_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id text NOT NULL UNIQUE,
  sport text NOT NULL,
  league_id text NOT NULL DEFAULT '',
  season text,
  match_date timestamptz,
  home_team text NOT NULL,
  away_team text NOT NULL,
  normalized_home_team text NOT NULL,
  normalized_away_team text NOT NULL,
  home_score numeric(8,3),
  away_score numeric(8,3),
  status text NOT NULL DEFAULT 'SCHEDULED',
  competition_type text NOT NULL DEFAULT 'official',
  importance_tag text NOT NULL DEFAULT 'normal',
  source text NOT NULL,
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 100)
);

CREATE INDEX IF NOT EXISTS idx_sports_match_history_team_date
  ON sports_match_history(sport, league_id, normalized_home_team, normalized_away_team, match_date DESC);

CREATE INDEX IF NOT EXISTS idx_sports_match_history_importance
  ON sports_match_history(sport, league_id, competition_type, importance_tag, match_date DESC);

CREATE TABLE IF NOT EXISTS sports_team_match_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id text NOT NULL,
  sport text NOT NULL,
  league_id text NOT NULL DEFAULT '',
  team_name text NOT NULL,
  normalized_team_name text NOT NULL,
  opponent_team text,
  is_home boolean,
  result text,
  points_for numeric(8,3),
  points_against numeric(8,3),
  xg_for numeric(8,3),
  xg_against numeric(8,3),
  shots_for numeric(8,3),
  shots_against numeric(8,3),
  possession_pct numeric(8,3),
  rest_days numeric(8,3),
  travel_status text,
  source text NOT NULL,
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_team_match_stats_unique
  ON sports_team_match_stats(match_id, normalized_team_name);

CREATE INDEX IF NOT EXISTS idx_sports_team_match_stats_lookup
  ON sports_team_match_stats(sport, league_id, normalized_team_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS sports_match_lineups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id text NOT NULL,
  sport text NOT NULL,
  league_id text NOT NULL DEFAULT '',
  team_name text NOT NULL,
  normalized_team_name text NOT NULL,
  lineup_status text NOT NULL DEFAULT 'UNKNOWN',
  formation text,
  starters jsonb NOT NULL DEFAULT '[]'::jsonb,
  bench jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_players jsonb NOT NULL DEFAULT '[]'::jsonb,
  key_players_available boolean,
  source text NOT NULL,
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 100),
  CHECK (lineup_status IN ('UNKNOWN', 'PENDING', 'PROJECTED', 'CONFIRMED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_match_lineups_unique
  ON sports_match_lineups(match_id, normalized_team_name);

CREATE INDEX IF NOT EXISTS idx_sports_match_lineups_status
  ON sports_match_lineups(sport, league_id, lineup_status, observed_at DESC);

CREATE TABLE IF NOT EXISTS sports_player_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id text NOT NULL,
  sport text NOT NULL,
  league_id text NOT NULL DEFAULT '',
  team_name text NOT NULL,
  normalized_team_name text NOT NULL,
  player_name text NOT NULL,
  normalized_player_name text NOT NULL,
  status text NOT NULL DEFAULT 'UNKNOWN',
  reason text,
  expected_minutes numeric(8,3),
  key_player_flag boolean NOT NULL DEFAULT false,
  impact_score numeric(6,3) NOT NULL DEFAULT 0,
  source text NOT NULL,
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 100),
  CHECK (impact_score >= 0 AND impact_score <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_player_availability_unique
  ON sports_player_availability(match_id, normalized_team_name, normalized_player_name);

CREATE INDEX IF NOT EXISTS idx_sports_player_availability_status
  ON sports_player_availability(sport, league_id, status, key_player_flag, observed_at DESC);
