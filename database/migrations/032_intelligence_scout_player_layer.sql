CREATE TABLE IF NOT EXISTS intelligence_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_slug varchar(40) NOT NULL,
  league_slug varchar(80),
  match_id uuid REFERENCES matches(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  team_name varchar(160),
  player_name varchar(160),
  source varchar(120) NOT NULL,
  source_url text,
  signal_type varchar(80) NOT NULL,
  signal_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity varchar(20) NOT NULL DEFAULT 'info',
  confidence numeric(6,3) NOT NULL DEFAULT 0.500,
  impact varchar(40) NOT NULL DEFAULT 'NEUTRAL',
  recommendation varchar(40) NOT NULL DEFAULT 'OBSERVATION_ONLY',
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  CHECK (confidence >= 0 AND confidence <= 1),
  CHECK (impact IN ('SUPPORTS_PICK', 'WEAK_SUPPORT', 'NEUTRAL', 'CONFLICTS_PICK', 'BLOCKS_CONFIRMATION')),
  CHECK (recommendation IN ('ALLOW_REVIEW', 'MANUAL_REVIEW', 'WAIT_FOR_CONFIRMATION', 'BLOCK_PICK', 'OBSERVATION_ONLY'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_observations_match
  ON intelligence_observations(match_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_observations_signal
  ON intelligence_observations(sport_slug, league_slug, signal_type, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_observations_impact
  ON intelligence_observations(impact, recommendation, observed_at DESC);

CREATE TABLE IF NOT EXISTS player_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_slug varchar(40) NOT NULL,
  league_slug varchar(80),
  match_id uuid REFERENCES matches(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  team_name varchar(160),
  player_name varchar(160) NOT NULL,
  player_id varchar(120),
  position varchar(80),
  role_importance varchar(40) NOT NULL DEFAULT 'rotation',
  status varchar(40) NOT NULL DEFAULT 'unknown',
  minutes_or_usage numeric(10,3),
  impact_score numeric(8,3) NOT NULL DEFAULT 0,
  source varchar(120) NOT NULL,
  source_url text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (role_importance IN ('star', 'starter', 'key_role', 'rotation', 'depth', 'unknown')),
  CHECK (status IN ('available', 'confirmed', 'probable', 'questionable', 'out', 'suspended', 'injured', 'resting', 'missing', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_player_intelligence_match
  ON player_intelligence(match_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_player_intelligence_team_status
  ON player_intelligence(sport_slug, league_slug, team_name, status, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_player_intelligence_impact
  ON player_intelligence(impact_score, role_importance, observed_at DESC);
