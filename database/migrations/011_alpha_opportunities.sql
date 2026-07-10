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
