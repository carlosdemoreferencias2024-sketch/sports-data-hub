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
