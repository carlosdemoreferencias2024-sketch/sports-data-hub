CREATE TABLE IF NOT EXISTS odds_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_quote_id UUID REFERENCES market_quotes(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sport_slug VARCHAR(40),
  league_slug VARCHAR(80),
  provider_name VARCHAR(80) NOT NULL,
  source_name VARCHAR(80),
  bookmaker VARCHAR(120),
  external_event_id VARCHAR(180),
  bookmaker_event_id VARCHAR(180),
  market_type VARCHAR(40) NOT NULL,
  line NUMERIC(8, 3),
  selection VARCHAR(40) NOT NULL,
  odds NUMERIC(12, 4) NOT NULL CHECK (odds > 1),
  snapshot_role VARCHAR(30) NOT NULL DEFAULT 'market',
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quality_score NUMERIC(5, 2) NOT NULL DEFAULT 0,
  quality_flags TEXT[] NOT NULL DEFAULT '{}'::text[],
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (selection IN ('home', 'away', 'draw', 'over', 'under', 'yes', 'no')),
  CHECK (snapshot_role IN ('market', 'entry', 'closing', 'live', 'manual_shadow'))
);

CREATE INDEX IF NOT EXISTS idx_odds_snapshots_match_market
  ON odds_snapshots(match_id, market_type, COALESCE(line, -9999), selection, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_odds_snapshots_provider_quality
  ON odds_snapshots(provider_name, snapshot_role, quality_score DESC, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_odds_snapshots_league_market
  ON odds_snapshots(league_slug, market_type, captured_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_snapshots_market_quote_selection
  ON odds_snapshots(market_quote_id, selection)
  WHERE market_quote_id IS NOT NULL;
