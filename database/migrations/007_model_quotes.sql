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
