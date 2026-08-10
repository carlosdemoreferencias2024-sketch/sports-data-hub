ALTER TABLE player_intelligence
  ADD COLUMN IF NOT EXISTS probable_home_pitcher varchar(160),
  ADD COLUMN IF NOT EXISTS probable_away_pitcher varchar(160),
  ADD COLUMN IF NOT EXISTS confirmed_home_pitcher varchar(160),
  ADD COLUMN IF NOT EXISTS confirmed_away_pitcher varchar(160),
  ADD COLUMN IF NOT EXISTS pitcher_change_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lineup_home_confirmed boolean,
  ADD COLUMN IF NOT EXISTS lineup_away_confirmed boolean,
  ADD COLUMN IF NOT EXISTS top_hitters_home_available boolean,
  ADD COLUMN IF NOT EXISTS top_hitters_away_available boolean,
  ADD COLUMN IF NOT EXISTS bullpen_home_fatigue_score numeric(8,3),
  ADD COLUMN IF NOT EXISTS bullpen_away_fatigue_score numeric(8,3),
  ADD COLUMN IF NOT EXISTS key_injuries_home jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS key_injuries_away jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rest_travel_home_status varchar(80),
  ADD COLUMN IF NOT EXISTS rest_travel_away_status varchar(80),
  ADD COLUMN IF NOT EXISTS weather_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_confidence_score numeric(6,3) NOT NULL DEFAULT 0.500,
  ADD COLUMN IF NOT EXISTS raw_data jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_player_intelligence_mlb_context
  ON player_intelligence(match_id, source_confidence_score DESC, observed_at DESC)
  WHERE sport_slug = 'baseball' AND league_slug = 'mlb';

CREATE INDEX IF NOT EXISTS idx_player_intelligence_pitcher_change
  ON player_intelligence(pitcher_change_detected, observed_at DESC)
  WHERE sport_slug = 'baseball' AND league_slug = 'mlb';
