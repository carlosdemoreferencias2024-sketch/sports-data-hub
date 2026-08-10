CREATE TABLE IF NOT EXISTS football_league_trust_scores (
  league_id varchar(100) PRIMARY KEY,
  league_name varchar(160) NOT NULL,
  tier varchar(40) NOT NULL DEFAULT 'WATCH',
  trust_score numeric(6,3) NOT NULL DEFAULT 50,
  trust_status varchar(40) NOT NULL DEFAULT 'WATCH',
  min_closed_before_watch integer NOT NULL DEFAULT 20,
  min_closed_before_review integer NOT NULL DEFAULT 50,
  market_allowed_json jsonb NOT NULL DEFAULT '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (trust_score >= 0 AND trust_score <= 100),
  CHECK (trust_status IN ('TRUSTED', 'WATCH', 'NOISY', 'MANUAL_ONLY', 'BLOCKED'))
);

CREATE TABLE IF NOT EXISTS football_team_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid REFERENCES matches(id) ON DELETE CASCADE,
  league_id varchar(100) NOT NULL,
  home_team varchar(160),
  away_team varchar(160),
  form_home_score numeric(8,3),
  form_away_score numeric(8,3),
  home_attack_score numeric(8,3),
  away_attack_score numeric(8,3),
  home_defense_score numeric(8,3),
  away_defense_score numeric(8,3),
  home_recent_goals_for numeric(8,3),
  away_recent_goals_for numeric(8,3),
  home_recent_goals_against numeric(8,3),
  away_recent_goals_against numeric(8,3),
  home_rest_days integer,
  away_rest_days integer,
  home_travel_flag boolean,
  away_travel_flag boolean,
  neutral_venue boolean,
  match_importance varchar(80),
  fixture_congestion_home varchar(80),
  fixture_congestion_away varchar(80),
  team_intelligence_status varchar(60) NOT NULL DEFAULT 'NO_CONTEXT',
  source varchar(120) NOT NULL DEFAULT 'manual_or_derived',
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0.500,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 1),
  CHECK (team_intelligence_status IN ('NO_CONTEXT', 'CONTEXT_GAPS', 'PARTIAL_CONTEXT_REVIEW', 'TEAM_CONTEXT_SUPPORTS', 'TEAM_CONTEXT_CONFLICTS', 'BLOCK_CONFIRMATION', 'REQUIRES_MANUAL_REVIEW'))
);

CREATE INDEX IF NOT EXISTS idx_football_team_intelligence_match
  ON football_team_intelligence(match_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_football_team_intelligence_league_status
  ON football_team_intelligence(league_id, team_intelligence_status, observed_at DESC);

CREATE TABLE IF NOT EXISTS football_player_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid REFERENCES matches(id) ON DELETE CASCADE,
  league_id varchar(100) NOT NULL,
  team varchar(160),
  player_name varchar(160) NOT NULL,
  normalized_player_name varchar(180),
  position varchar(80),
  expected_starting boolean,
  confirmed_starting boolean,
  lineup_status varchar(40) NOT NULL DEFAULT 'UNKNOWN',
  injury_status varchar(40) NOT NULL DEFAULT 'UNKNOWN',
  suspension_status varchar(40) NOT NULL DEFAULT 'UNKNOWN',
  rotation_risk varchar(40),
  minutes_last_5 numeric(8,3),
  goals_last_5 numeric(8,3),
  assists_last_5 numeric(8,3),
  shots_last_5 numeric(8,3),
  shots_on_target_last_5 numeric(8,3),
  goalkeeper_saves_last_5 numeric(8,3),
  key_player_flag boolean NOT NULL DEFAULT false,
  impact_area varchar(80),
  player_intelligence_status varchar(60) NOT NULL DEFAULT 'NO_CONTEXT',
  source varchar(120) NOT NULL DEFAULT 'manual_or_derived',
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0.500,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 1),
  CHECK (lineup_status IN ('UNKNOWN', 'PROBABLE', 'CONFIRMED', 'NOT_STARTING', 'BENCH', 'OUT')),
  CHECK (injury_status IN ('UNKNOWN', 'HEALTHY', 'QUESTIONABLE', 'OUT')),
  CHECK (suspension_status IN ('NONE', 'SUSPENDED', 'RISK', 'UNKNOWN')),
  CHECK (player_intelligence_status IN ('NO_CONTEXT', 'LINEUP_PENDING', 'PLAYER_CONTEXT_SUPPORTS', 'PLAYER_CONTEXT_CONFLICTS', 'BLOCK_CONFIRMATION', 'REQUIRES_MANUAL_REVIEW'))
);

CREATE INDEX IF NOT EXISTS idx_football_player_intelligence_match
  ON football_player_intelligence(match_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_football_player_intelligence_status
  ON football_player_intelligence(league_id, player_intelligence_status, observed_at DESC);

INSERT INTO football_league_trust_scores (
  league_id, league_name, tier, trust_score, trust_status,
  min_closed_before_watch, min_closed_before_review, market_allowed_json, notes
)
VALUES
  ('fifa-world-cup-2026', 'Mundial 2026', 'FAVORITE', 90, 'TRUSTED', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Base mundialista confiable; BTTS separado y bloqueable por performance.'),
  ('uefa-champions-league', 'UEFA Champions League', 'FAVORITE', 90, 'TRUSTED', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Alta calidad de fixture y mercado.'),
  ('premier-league', 'Premier League', 'FAVORITE', 88, 'TRUSTED', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Liga top con mercado eficiente.'),
  ('la-liga', 'La Liga', 'FAVORITE', 87, 'TRUSTED', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Liga top con mercado eficiente.'),
  ('serie-a', 'Serie A', 'FAVORITE', 85, 'TRUSTED', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Liga top con mercado eficiente.'),
  ('bundesliga', 'Bundesliga', 'FAVORITE', 85, 'TRUSTED', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Liga top con mercado eficiente.'),
  ('liga-mx', 'Liga MX', 'FAVORITE', 78, 'WATCH', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Liga prioritaria; requiere muestra y contexto.'),
  ('mls', 'MLS', 'FAVORITE', 75, 'WATCH', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Liga prioritaria; requiere muestra y contexto.'),
  ('brasileirao-serie-a', 'Brasileirao Serie A', 'FAVORITE', 74, 'WATCH', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Buen volumen, revisar viaje y rotacion.'),
  ('argentina-primera-division', 'Argentina Primera Division', 'FAVORITE', 72, 'WATCH', 20, 50, '["moneyline_3way","draw_no_bet","total_goals_2_5"]'::jsonb, 'Buen volumen, revisar contexto local.'),
  ('friendlies', 'Amistosos', 'MANUAL_ONLY', 30, 'MANUAL_ONLY', 50, 75, '[]'::jsonb, 'Amistosos solo observacion o revision manual.')
ON CONFLICT (league_id) DO UPDATE SET
  league_name = EXCLUDED.league_name,
  tier = EXCLUDED.tier,
  trust_score = EXCLUDED.trust_score,
  trust_status = EXCLUDED.trust_status,
  min_closed_before_watch = EXCLUDED.min_closed_before_watch,
  min_closed_before_review = EXCLUDED.min_closed_before_review,
  market_allowed_json = EXCLUDED.market_allowed_json,
  notes = EXCLUDED.notes,
  updated_at = now();
