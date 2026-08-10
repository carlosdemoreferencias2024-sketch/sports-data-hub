CREATE TABLE IF NOT EXISTS provider_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  sport text NOT NULL,
  league_id text,
  season text,
  data_type text NOT NULL,
  available boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  reason text,
  confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  rate_limit_status text,
  quota_remaining integer,
  checked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (confidence_score >= 0 AND confidence_score <= 100),
  CHECK (status IN ('AVAILABLE', 'PLAN_BLOCKED', 'RATE_LIMITED', 'NO_KEY', 'PROVIDER_ERROR', 'DISABLED', 'FALLBACK_ONLY', 'UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS idx_provider_capabilities_lookup
  ON provider_capabilities(provider, sport, league_id, season, data_type, status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_capabilities_unique
  ON provider_capabilities(provider, sport, COALESCE(league_id, ''), COALESCE(season, ''), data_type);

CREATE TABLE IF NOT EXISTS sports_canonical_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  sport text NOT NULL,
  canonical_id text NOT NULL UNIQUE,
  canonical_name text NOT NULL,
  display_name text,
  league_id text,
  country text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (entity_type IN ('league', 'team', 'player', 'match', 'market', 'provider'))
);

CREATE INDEX IF NOT EXISTS idx_sports_canonical_entities_type_sport
  ON sports_canonical_entities(entity_type, sport, league_id, active);

CREATE TABLE IF NOT EXISTS sports_entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_id text NOT NULL REFERENCES sports_canonical_entities(canonical_id) ON DELETE CASCADE,
  alias text NOT NULL,
  provider text,
  confidence_score numeric(6,3) NOT NULL DEFAULT 80,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_id, lower(alias), COALESCE(provider, '')),
  CHECK (confidence_score >= 0 AND confidence_score <= 100)
);

CREATE INDEX IF NOT EXISTS idx_sports_entity_aliases_alias
  ON sports_entity_aliases(lower(alias), provider);

CREATE TABLE IF NOT EXISTS sports_source_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  sport text NOT NULL,
  league_id text,
  match_id text,
  entity_id text,
  data_type text NOT NULL,
  observed_value jsonb NOT NULL,
  source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL DEFAULT now(),
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_confidence_score >= 0 AND source_confidence_score <= 100)
);

CREATE INDEX IF NOT EXISTS idx_sports_source_observations_match
  ON sports_source_observations(sport, league_id, match_id, data_type, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_sports_source_observations_provider
  ON sports_source_observations(provider, sport, data_type, observed_at DESC);

CREATE TABLE IF NOT EXISTS sports_consensus_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  league_id text,
  match_id text,
  data_type text NOT NULL,
  consensus_verified boolean NOT NULL DEFAULT false,
  consensus_score numeric(6,3) NOT NULL DEFAULT 0,
  selected_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources_missing jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (consensus_score >= 0 AND consensus_score <= 100)
);

CREATE INDEX IF NOT EXISTS idx_sports_consensus_events_match
  ON sports_consensus_events(sport, league_id, match_id, data_type, consensus_verified);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_consensus_events_unique
  ON sports_consensus_events(sport, COALESCE(league_id, ''), COALESCE(match_id, ''), data_type);

CREATE TABLE IF NOT EXISTS match_context_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sport text NOT NULL,
  league_id text,
  match_id text NOT NULL UNIQUE,
  fixture_trust_score numeric(6,3) NOT NULL DEFAULT 0,
  source_consensus_score numeric(6,3) NOT NULL DEFAULT 0,
  odds_quality_score numeric(6,3) NOT NULL DEFAULT 0,
  lineup_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
  team_context_score numeric(6,3) NOT NULL DEFAULT 0,
  player_context_score numeric(6,3) NOT NULL DEFAULT 0,
  market_maturity_score numeric(6,3) NOT NULL DEFAULT 0,
  settlement_readiness_score numeric(6,3) NOT NULL DEFAULT 0,
  overall_context_score numeric(6,3) NOT NULL DEFAULT 0,
  context_status text NOT NULL,
  missing_context_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  block_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (context_status IN ('NO_CONTEXT', 'CONTEXT_GAPS', 'PARTIAL_CONTEXT_REVIEW', 'MATCHUP_CONTEXT_SUPPORTS', 'CONFIRMED_PAPER', 'BLOCKED'))
);

CREATE INDEX IF NOT EXISTS idx_match_context_scores_status
  ON match_context_scores(sport, league_id, context_status, overall_context_score DESC);
