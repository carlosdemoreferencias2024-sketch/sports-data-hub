-- SPORTS HISTORICAL TEAM & PLAYER INTELLIGENCE v1
-- This migration extends the existing Sports Intelligence Core without creating picks.

ALTER TABLE sports_match_history
  ADD COLUMN IF NOT EXISTS provider_match_id text,
  ADD COLUMN IF NOT EXISTS canonical_match_id text,
  ADD COLUMN IF NOT EXISTS competition_id text,
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS round text,
  ADD COLUMN IF NOT EXISTS is_official boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_friendly boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_preseason boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_spring_training boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS home_team_id text,
  ADD COLUMN IF NOT EXISTS away_team_id text,
  ADD COLUMN IF NOT EXISTS home_team_name text,
  ADD COLUMN IF NOT EXISTS away_team_name text,
  ADD COLUMN IF NOT EXISTS kickoff timestamptz,
  ADD COLUMN IF NOT EXISTS home_score_extra integer,
  ADD COLUMN IF NOT EXISTS away_score_extra integer,
  ADD COLUMN IF NOT EXISTS result text,
  ADD COLUMN IF NOT EXISTS venue text,
  ADD COLUMN IF NOT EXISTS neutral_venue boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attendance integer,
  ADD COLUMN IF NOT EXISTS match_importance text,
  ADD COLUMN IF NOT EXISTS rotation_risk text,
  ADD COLUMN IF NOT EXISTS source_observed_at timestamptz;

UPDATE sports_match_history
SET
  canonical_match_id = COALESCE(canonical_match_id, match_id),
  home_team_name = COALESCE(home_team_name, home_team),
  away_team_name = COALESCE(away_team_name, away_team),
  kickoff = COALESCE(kickoff, match_date),
  match_importance = COALESCE(match_importance, importance_tag),
  source_observed_at = COALESCE(source_observed_at, updated_at, created_at)
WHERE canonical_match_id IS NULL
   OR home_team_name IS NULL
   OR away_team_name IS NULL
   OR kickoff IS NULL
   OR match_importance IS NULL
   OR source_observed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_match_history_provider_match
  ON sports_match_history(sport, source, provider_match_id)
  WHERE provider_match_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_match_history_canonical_kickoff
  ON sports_match_history(sport, canonical_match_id, kickoff)
  WHERE canonical_match_id IS NOT NULL AND kickoff IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sports_match_history_competition
  ON sports_match_history(sport, league_id, competition_type, season, kickoff DESC);

ALTER TABLE sports_team_match_stats
  ADD COLUMN IF NOT EXISTS team_id text,
  ADD COLUMN IF NOT EXISTS opponent_team_id text,
  ADD COLUMN IF NOT EXISTS season text,
  ADD COLUMN IF NOT EXISTS is_neutral boolean,
  ADD COLUMN IF NOT EXISTS goals_or_runs_for integer,
  ADD COLUMN IF NOT EXISTS goals_or_runs_against integer,
  ADD COLUMN IF NOT EXISTS won boolean,
  ADD COLUMN IF NOT EXISTS drew boolean,
  ADD COLUMN IF NOT EXISTS lost boolean,
  ADD COLUMN IF NOT EXISTS possession numeric,
  ADD COLUMN IF NOT EXISTS shots integer,
  ADD COLUMN IF NOT EXISTS shots_on_target integer,
  ADD COLUMN IF NOT EXISTS shots_off_target integer,
  ADD COLUMN IF NOT EXISTS blocked_shots integer,
  ADD COLUMN IF NOT EXISTS big_chances integer,
  ADD COLUMN IF NOT EXISTS corners integer,
  ADD COLUMN IF NOT EXISTS offsides integer,
  ADD COLUMN IF NOT EXISTS fouls integer,
  ADD COLUMN IF NOT EXISTS yellow_cards integer,
  ADD COLUMN IF NOT EXISTS red_cards integer,
  ADD COLUMN IF NOT EXISTS passes integer,
  ADD COLUMN IF NOT EXISTS pass_accuracy numeric,
  ADD COLUMN IF NOT EXISTS xg numeric,
  ADD COLUMN IF NOT EXISTS xga numeric,
  ADD COLUMN IF NOT EXISTS clean_sheet boolean,
  ADD COLUMN IF NOT EXISTS btts boolean,
  ADD COLUMN IF NOT EXISTS over_1_5 boolean,
  ADD COLUMN IF NOT EXISTS over_2_5 boolean,
  ADD COLUMN IF NOT EXISTS over_3_5 boolean,
  ADD COLUMN IF NOT EXISTS first_half_goals_for integer,
  ADD COLUMN IF NOT EXISTS first_half_goals_against integer,
  ADD COLUMN IF NOT EXISTS hits integer,
  ADD COLUMN IF NOT EXISTS errors integer,
  ADD COLUMN IF NOT EXISTS home_runs integer,
  ADD COLUMN IF NOT EXISTS walks integer,
  ADD COLUMN IF NOT EXISTS strikeouts integer,
  ADD COLUMN IF NOT EXISTS left_on_base integer,
  ADD COLUMN IF NOT EXISTS batting_average numeric,
  ADD COLUMN IF NOT EXISTS on_base_percentage numeric,
  ADD COLUMN IF NOT EXISTS slugging_percentage numeric,
  ADD COLUMN IF NOT EXISTS ops numeric,
  ADD COLUMN IF NOT EXISTS runs_first_five integer,
  ADD COLUMN IF NOT EXISTS runs_last_four integer,
  ADD COLUMN IF NOT EXISTS bullpen_runs_allowed integer,
  ADD COLUMN IF NOT EXISTS bullpen_innings numeric,
  ADD COLUMN IF NOT EXISTS bullpen_pitches integer,
  ADD COLUMN IF NOT EXISTS bullpen_usage_score numeric,
  ADD COLUMN IF NOT EXISTS starting_pitcher_id text,
  ADD COLUMN IF NOT EXISTS starting_pitcher_confirmed boolean;

UPDATE sports_team_match_stats
SET
  goals_or_runs_for = COALESCE(goals_or_runs_for, points_for::integer),
  goals_or_runs_against = COALESCE(goals_or_runs_against, points_against::integer),
  possession = COALESCE(possession, possession_pct),
  xg = COALESCE(xg, xg_for),
  xga = COALESCE(xga, xg_against)
WHERE goals_or_runs_for IS NULL
   OR goals_or_runs_against IS NULL
   OR possession IS NULL
   OR xg IS NULL
   OR xga IS NULL;

CREATE TABLE IF NOT EXISTS sports_team_season_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  league_id text,
  season text NOT NULL,
  team_id text NOT NULL,
  canonical_team_name text,
  matches_played integer,
  wins integer,
  draws integer,
  losses integer,
  points numeric,
  position integer,
  goals_or_runs_for integer,
  goals_or_runs_against integer,
  home_record jsonb NOT NULL DEFAULT '{}'::jsonb,
  away_record jsonb NOT NULL DEFAULT '{}'::jsonb,
  neutral_record jsonb NOT NULL DEFAULT '{}'::jsonb,
  recent_form jsonb NOT NULL DEFAULT '{}'::jsonb,
  attack_score numeric,
  defense_score numeric,
  home_strength_score numeric,
  away_strength_score numeric,
  consistency_score numeric,
  volatility_score numeric,
  strength_of_schedule_score numeric,
  roster_continuity_score numeric,
  coaching_continuity_score numeric,
  historical_relevance_score numeric,
  source_consensus_score numeric,
  data_completeness_score numeric,
  calculation_version text,
  inputs_used jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_team_season_profiles_unique
  ON sports_team_season_profiles(sport, COALESCE(league_id, ''), season, team_id);

ALTER TABLE sports_player_profiles
  ADD COLUMN IF NOT EXISTS canonical_player_id text,
  ADD COLUMN IF NOT EXISTS canonical_player_name text,
  ADD COLUMN IF NOT EXISTS provider_player_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS current_team_id text,
  ADD COLUMN IF NOT EXISTS birth_date date,
  ADD COLUMN IF NOT EXISTS age integer,
  ADD COLUMN IF NOT EXISTS nationality text,
  ADD COLUMN IF NOT EXISTS bats text,
  ADD COLUMN IF NOT EXISTS throws text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE sports_player_profiles
SET
  canonical_player_id = COALESCE(canonical_player_id, player_id, normalized_player_name),
  canonical_player_name = COALESCE(canonical_player_name, player_name),
  current_team_id = COALESCE(current_team_id, team_id)
WHERE canonical_player_id IS NULL
   OR canonical_player_name IS NULL
   OR current_team_id IS NULL;

CREATE TABLE IF NOT EXISTS sports_player_season_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  player_id text NOT NULL,
  team_id text,
  league_id text,
  season text NOT NULL,
  competition_type text,
  appearances integer,
  starts integer,
  minutes_or_innings numeric,
  source text,
  source_confidence_score numeric,
  data_completeness_score numeric,
  raw_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  minutes_played integer,
  goals integer,
  assists integer,
  shots integer,
  shots_on_target integer,
  key_passes integer,
  expected_goals numeric,
  expected_assists numeric,
  yellow_cards integer,
  red_cards integer,
  tackles integer,
  interceptions integer,
  saves integer,
  goals_prevented numeric,
  clean_sheets integer,
  player_form_score numeric,
  availability_rate numeric,
  starting_rate numeric,
  plate_appearances integer,
  at_bats integer,
  hits integer,
  doubles integer,
  triples integer,
  home_runs integer,
  runs integer,
  rbi integer,
  walks integer,
  strikeouts integer,
  stolen_bases integer,
  batting_average numeric,
  on_base_percentage numeric,
  slugging_percentage numeric,
  ops numeric,
  woba numeric,
  wrc_plus numeric,
  splits_vs_lhp jsonb NOT NULL DEFAULT '{}'::jsonb,
  splits_vs_rhp jsonb NOT NULL DEFAULT '{}'::jsonb,
  games integer,
  games_started integer,
  innings_pitched numeric,
  wins integer,
  losses integer,
  era numeric,
  whip numeric,
  home_runs_allowed integer,
  fip numeric,
  xfip numeric,
  pitch_count_average numeric,
  recent_pitch_counts jsonb NOT NULL DEFAULT '[]'::jsonb,
  days_rest integer,
  splits_home jsonb NOT NULL DEFAULT '{}'::jsonb,
  splits_away jsonb NOT NULL DEFAULT '{}'::jsonb,
  splits_vs_lhb jsonb NOT NULL DEFAULT '{}'::jsonb,
  splits_vs_rhb jsonb NOT NULL DEFAULT '{}'::jsonb,
  recent_form_score numeric,
  calculation_version text,
  inputs_used jsonb NOT NULL DEFAULT '{}'::jsonb,
  calculated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score IS NULL OR (source_confidence_score >= 0 AND source_confidence_score <= 100)),
  CHECK (data_completeness_score IS NULL OR (data_completeness_score >= 0 AND data_completeness_score <= 100))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_player_season_stats_unique
  ON sports_player_season_stats(sport, player_id, COALESCE(team_id, ''), COALESCE(league_id, ''), season, COALESCE(competition_type, ''));

CREATE INDEX IF NOT EXISTS idx_sports_player_season_stats_lookup
  ON sports_player_season_stats(sport, league_id, season, team_id, player_id);

CREATE TABLE IF NOT EXISTS sports_player_match_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  match_id text NOT NULL,
  player_id text NOT NULL,
  team_id text,
  opponent_team_id text,
  started boolean,
  substitute boolean,
  source text,
  source_confidence_score numeric,
  raw_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  minutes_played integer,
  position text,
  goals integer,
  assists integer,
  shots integer,
  shots_on_target integer,
  key_passes integer,
  passes integer,
  pass_accuracy numeric,
  tackles integer,
  interceptions integer,
  fouls_committed integer,
  fouls_drawn integer,
  yellow_cards integer,
  red_cards integer,
  saves integer,
  rating numeric,
  lineup_position integer,
  plate_appearances integer,
  at_bats integer,
  hits integer,
  home_runs integer,
  rbi integer,
  walks integer,
  strikeouts integer,
  pitcher_role text,
  innings_pitched numeric,
  pitches integer,
  strikes integer,
  hits_allowed integer,
  runs_allowed integer,
  earned_runs integer,
  home_runs_allowed integer,
  decision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score IS NULL OR (source_confidence_score >= 0 AND source_confidence_score <= 100))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_player_match_stats_unique
  ON sports_player_match_stats(sport, match_id, player_id, COALESCE(team_id, ''));

CREATE INDEX IF NOT EXISTS idx_sports_player_match_stats_lookup
  ON sports_player_match_stats(sport, match_id, team_id, player_id);

ALTER TABLE sports_match_lineups
  ADD COLUMN IF NOT EXISTS team_id text,
  ADD COLUMN IF NOT EXISTS substitutes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS batting_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS starting_pitcher_id text,
  ADD COLUMN IF NOT EXISTS starting_pitcher_status text,
  ADD COLUMN IF NOT EXISTS doubtful_players jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rested_players jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS goalkeeper_status text,
  ADD COLUMN IF NOT EXISTS supersedes_lineup_id uuid;

UPDATE sports_match_lineups
SET substitutes = COALESCE(substitutes, bench, '[]'::jsonb)
WHERE substitutes IS NULL OR substitutes = '[]'::jsonb;

ALTER TABLE sports_player_availability
  ADD COLUMN IF NOT EXISTS season text,
  ADD COLUMN IF NOT EXISTS team_id text,
  ADD COLUMN IF NOT EXISTS player_id text,
  ADD COLUMN IF NOT EXISTS player_name_extended text,
  ADD COLUMN IF NOT EXISTS availability_status text,
  ADD COLUMN IF NOT EXISTS injury_type text,
  ADD COLUMN IF NOT EXISTS suspension_reason text,
  ADD COLUMN IF NOT EXISTS injury_start_date date,
  ADD COLUMN IF NOT EXISTS expected_return_date date,
  ADD COLUMN IF NOT EXISTS confirmed_out boolean NOT NULL DEFAULT false;

UPDATE sports_player_availability
SET availability_status = COALESCE(availability_status, status)
WHERE availability_status IS NULL;

ALTER TABLE match_context_scores
  ADD COLUMN IF NOT EXISTS historical_data_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_season_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recent_form_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS home_away_context_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS strength_of_schedule_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lineup_quality_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS roster_continuity_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS injury_availability_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pitcher_context_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bullpen_context_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS batting_matchup_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS friendly_or_preseason_penalty numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS historical_uncertainty_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS historical_context_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS data_freshness_score numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scoring_version text,
  ADD COLUMN IF NOT EXISTS score_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS penalties_applied jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sample_sizes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS calculated_at timestamptz;

CREATE TABLE IF NOT EXISTS sports_historical_backfill_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  league_id text,
  season text,
  source text NOT NULL,
  job_type text NOT NULL,
  resume_cursor text,
  status text NOT NULL DEFAULT 'PENDING',
  dry_run boolean NOT NULL DEFAULT true,
  inserted_count integer NOT NULL DEFAULT 0,
  updated_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_historical_backfill_checkpoints_unique
  ON sports_historical_backfill_checkpoints(sport, COALESCE(league_id, ''), COALESCE(season, ''), source, job_type, COALESCE(resume_cursor, ''));

CREATE INDEX IF NOT EXISTS idx_sports_historical_backfill_status
  ON sports_historical_backfill_checkpoints(sport, league_id, season, source, job_type, status, updated_at DESC);
