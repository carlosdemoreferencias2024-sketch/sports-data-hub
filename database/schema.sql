CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'match_status') THEN
    CREATE TYPE match_status AS ENUM ('scheduled', 'live', 'finished', 'postponed', 'cancelled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'home_away') THEN
    CREATE TYPE home_away AS ENUM ('home', 'away', 'neutral');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leagues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport_id UUID NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  slug VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  abbreviation VARCHAR(30),
  country VARCHAR(100),
  logo_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  year VARCHAR(30) NOT NULL,
  start_date DATE,
  end_date DATE,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (league_id, year)
);

CREATE TABLE IF NOT EXISTS venues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(120) NOT NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  city VARCHAR(120),
  state VARCHAR(120),
  country VARCHAR(120),
  capacity INTEGER,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  venue_id UUID REFERENCES venues(id),
  slug VARCHAR(120) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  short_name VARCHAR(80),
  abbreviation VARCHAR(20),
  logo_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  slug VARCHAR(160) NOT NULL UNIQUE,
  full_name VARCHAR(180) NOT NULL,
  position VARCHAR(80),
  jersey_number VARCHAR(20),
  birth_date DATE,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id UUID NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  season_id UUID REFERENCES seasons(id) ON DELETE SET NULL,
  venue_id UUID REFERENCES venues(id) ON DELETE SET NULL,
  slug VARCHAR(180) NOT NULL UNIQUE,
  match_date TIMESTAMPTZ NOT NULL,
  status match_status NOT NULL DEFAULT 'scheduled',
  period VARCHAR(60),
  clock VARCHAR(60),
  home_score INTEGER,
  away_score INTEGER,
  home_odds NUMERIC(6,2),
  away_odds NUMERIC(6,2),
  odds_source VARCHAR(30),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  home_away home_away NOT NULL,
  score INTEGER,
  winner BOOLEAN,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, team_id),
  UNIQUE (match_id, home_away)
);

CREATE TABLE IF NOT EXISTS match_statistics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  home_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  away_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS data_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  base_url TEXT,
  source_type VARCHAR(50) NOT NULL DEFAULT 'scraper',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_team_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  alias VARCHAR(180) NOT NULL,
  normalized_alias VARCHAR(180) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, normalized_alias)
);

CREATE TABLE IF NOT EXISTS source_match_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  source_match_id VARCHAR(180) NOT NULL,
  source_url TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, source_match_id)
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  run_type VARCHAR(40) NOT NULL,
  status VARCHAR(40) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  processed_count INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS scrape_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scrape_run_id UUID REFERENCES scrape_runs(id) ON DELETE CASCADE,
  source_id UUID REFERENCES data_sources(id) ON DELETE SET NULL,
  severity VARCHAR(30) NOT NULL DEFAULT 'error',
  message TEXT NOT NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  league_slug VARCHAR(100) NOT NULL,
  league_type VARCHAR(30) NOT NULL,
  home_team VARCHAR(160) NOT NULL,
  away_team VARCHAR(160) NOT NULL,
  pick_executed VARCHAR(180) NOT NULL,
  market_type VARCHAR(40) NOT NULL,
  selection VARCHAR(40) NOT NULL,
  model_version VARCHAR(80) NOT NULL,
  odds_source VARCHAR(30) NOT NULL,
  model_probability NUMERIC(5,4) NOT NULL,
  market_odds NUMERIC(6,2) NOT NULL,
  expected_value NUMERIC(7,4) NOT NULL,
  bankroll_allocation NUMERIC(6,4) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  net_profit NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, market_type, selection, model_version)
);

CREATE TABLE IF NOT EXISTS team_stat_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  home_away home_away NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL,
  played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  points_for INTEGER NOT NULL DEFAULT 0,
  points_against INTEGER NOT NULL DEFAULT 0,
  form JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_leagues_sport ON leagues(sport_id);
CREATE INDEX IF NOT EXISTS idx_teams_league ON teams(league_id);
CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(match_date);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_league_date ON matches(league_id, match_date);
CREATE INDEX IF NOT EXISTS idx_source_alias_normalized ON source_team_aliases(normalized_alias);
CREATE INDEX IF NOT EXISTS idx_paper_trades_league ON paper_trades(league_slug);
CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_odds_source ON paper_trades(odds_source);
CREATE INDEX IF NOT EXISTS idx_team_stat_snapshots_match ON team_stat_snapshots(match_id);
CREATE INDEX IF NOT EXISTS idx_team_stat_snapshots_team_date ON team_stat_snapshots(team_id, snapshot_at);

CREATE TABLE IF NOT EXISTS market_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  provider_name VARCHAR(80) NOT NULL,
  market_type VARCHAR(40) NOT NULL DEFAULT 'moneyline_2way',
  home_odds NUMERIC(12, 4),
  away_odds NUMERIC(12, 4),
  draw_odds NUMERIC(12, 4),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (home_odds IS NULL OR home_odds > 1),
  CHECK (away_odds IS NULL OR away_odds > 1),
  CHECK (draw_odds IS NULL OR draw_odds > 1),
  CHECK (home_odds IS NOT NULL OR away_odds IS NOT NULL OR draw_odds IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_market_quotes_match_captured
  ON market_quotes(match_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_quotes_provider_market_captured
  ON market_quotes(provider_name, market_type, captured_at DESC);

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

CREATE TABLE IF NOT EXISTS model_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  model_name VARCHAR(80) NOT NULL DEFAULT 'fair_odds_v1',
  market_type VARCHAR(40) NOT NULL DEFAULT 'moneyline_2way',
  home_probability NUMERIC(7, 6) NOT NULL,
  away_probability NUMERIC(7, 6) NOT NULL,
  draw_probability NUMERIC(7, 6),
  home_fair_odds NUMERIC(12, 4) NOT NULL,
  away_fair_odds NUMERIC(12, 4) NOT NULL,
  draw_fair_odds NUMERIC(12, 4),
  confidence NUMERIC(5, 4) NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (home_probability > 0 AND home_probability < 1),
  CHECK (away_probability > 0 AND away_probability < 1),
  CHECK (draw_probability IS NULL OR (draw_probability > 0 AND draw_probability < 1)),
  CHECK (home_fair_odds > 1),
  CHECK (away_fair_odds > 1),
  CHECK (draw_fair_odds IS NULL OR draw_fair_odds > 1),
  CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_model_quotes_match_generated
  ON model_quotes(match_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_quotes_model_freshness
  ON model_quotes(model_name, generated_at DESC, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_model_quotes_confidence
  ON model_quotes(confidence DESC, generated_at DESC);

CREATE TABLE IF NOT EXISTS model_parameters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name VARCHAR(80) NOT NULL,
  home_pitching_weight NUMERIC(6, 4) NOT NULL DEFAULT 0.3500,
  home_offense_weight NUMERIC(6, 4) NOT NULL DEFAULT 0.3500,
  home_bullpen_weight NUMERIC(6, 4) NOT NULL DEFAULT 0.2000,
  home_field_weight NUMERIC(6, 4) NOT NULL DEFAULT 0.1000,
  brier_score NUMERIC(10, 6),
  sample_size INTEGER NOT NULL DEFAULT 0,
  accuracy NUMERIC(6, 4),
  bias_home NUMERIC(7, 4),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_model_parameters_active_model
  ON model_parameters(model_name)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_model_parameters_updated
  ON model_parameters(model_name, updated_at DESC);

CREATE TABLE IF NOT EXISTS model_features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sport_slug VARCHAR(40) NOT NULL,
  model_name VARCHAR(80) NOT NULL,
  feature_set JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_features_match_generated
  ON model_features(match_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_features_sport_model
  ON model_features(sport_slug, model_name, generated_at DESC);

CREATE TABLE IF NOT EXISTS alpha_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  model_quote_id UUID NOT NULL REFERENCES model_quotes(id) ON DELETE CASCADE,
  market_quote_id UUID NOT NULL REFERENCES market_quotes(id) ON DELETE CASCADE,
  sport_slug VARCHAR(40) NOT NULL,
  league_slug VARCHAR(80) NOT NULL,
  model_name VARCHAR(80) NOT NULL,
  provider_name VARCHAR(80) NOT NULL,
  market_type VARCHAR(40) NOT NULL,
  market_selection VARCHAR(20) NOT NULL,
  model_probability NUMERIC(7, 6) NOT NULL,
  model_fair_odds NUMERIC(12, 4) NOT NULL,
  market_odds NUMERIC(12, 4) NOT NULL,
  expected_value NUMERIC(10, 6) NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (market_selection IN ('home', 'draw', 'away')),
  CHECK (model_probability > 0 AND model_probability < 1),
  CHECK (market_odds > 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_alpha_signal
  ON alpha_opportunities(model_quote_id, market_quote_id, market_selection);
CREATE INDEX IF NOT EXISTS idx_alpha_opportunities_unprocessed
  ON alpha_opportunities(processed, expected_value DESC, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_alpha_opportunities_model
  ON alpha_opportunities(model_name, sport_slug, detected_at DESC);

CREATE TABLE IF NOT EXISTS real_paper_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  model_quote_id UUID NOT NULL REFERENCES model_quotes(id) ON DELETE CASCADE,
  market_quote_id UUID NOT NULL REFERENCES market_quotes(id) ON DELETE CASCADE,
  sport_slug VARCHAR(40) NOT NULL,
  league_slug VARCHAR(80) NOT NULL,
  model_name VARCHAR(80) NOT NULL,
  market_type VARCHAR(40) NOT NULL,
  line NUMERIC(10, 3),
  pick VARCHAR(40) NOT NULL,
  bookmaker VARCHAR(80) NOT NULL,
  entry_odds NUMERIC(12, 4) NOT NULL,
  entry_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model_probability NUMERIC(7, 6) NOT NULL,
  implied_probability NUMERIC(7, 6) NOT NULL,
  expected_value NUMERIC(10, 6) NOT NULL,
  stake_fraction NUMERIC(7, 6) NOT NULL DEFAULT 0.010000,
  closing_odds NUMERIC(12, 4),
  clv NUMERIC(10, 6),
  result VARCHAR(20),
  profit_loss NUMERIC(12, 4),
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
  previous_status VARCHAR(30),
  archived_at TIMESTAMPTZ,
  archive_reason TEXT,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_quote_id, market_quote_id, pick)
);
CREATE INDEX IF NOT EXISTS idx_real_paper_snapshots_status
  ON real_paper_snapshots(status, entry_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_real_paper_snapshots_archive
  ON real_paper_snapshots(archived_at DESC)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_real_paper_snapshots_market
  ON real_paper_snapshots(sport_slug, league_slug, market_type, entry_timestamp DESC);

CREATE TRIGGER sports_updated_at BEFORE UPDATE ON sports FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER leagues_updated_at BEFORE UPDATE ON leagues FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER seasons_updated_at BEFORE UPDATE ON seasons FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER venues_updated_at BEFORE UPDATE ON venues FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER teams_updated_at BEFORE UPDATE ON teams FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER players_updated_at BEFORE UPDATE ON players FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER matches_updated_at BEFORE UPDATE ON matches FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER match_competitors_updated_at BEFORE UPDATE ON match_competitors FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER match_statistics_updated_at BEFORE UPDATE ON match_statistics FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER data_sources_updated_at BEFORE UPDATE ON data_sources FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER source_match_refs_updated_at BEFORE UPDATE ON source_match_refs FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER paper_trades_updated_at BEFORE UPDATE ON paper_trades FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER team_stat_snapshots_updated_at BEFORE UPDATE ON team_stat_snapshots FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER provider_event_mappings_updated_at BEFORE UPDATE ON provider_event_mappings FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE TRIGGER real_paper_snapshots_updated_at BEFORE UPDATE ON real_paper_snapshots FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

