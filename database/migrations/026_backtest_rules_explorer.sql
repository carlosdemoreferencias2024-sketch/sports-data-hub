CREATE TABLE IF NOT EXISTS backtest_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key VARCHAR(120) NOT NULL UNIQUE,
  rule_name VARCHAR(220) NOT NULL,
  sport_slug VARCHAR(40) NOT NULL,
  league_slug VARCHAR(80) NOT NULL,
  market_type VARCHAR(80) NOT NULL,
  min_model_probability NUMERIC(7, 6) NOT NULL DEFAULT 0,
  min_ev NUMERIC(10, 6) NOT NULL DEFAULT 0,
  min_odds NUMERIC(12, 4) NOT NULL DEFAULT 1.0000,
  max_odds NUMERIC(12, 4),
  pick VARCHAR(40),
  bookmaker VARCHAR(120),
  min_closed INTEGER NOT NULL DEFAULT 50,
  sample_limit INTEGER NOT NULL DEFAULT 1000,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backtest_rules_active
  ON backtest_rules(is_active, sport_slug, league_slug, market_type);

INSERT INTO backtest_rules (
  rule_key,
  rule_name,
  sport_slug,
  league_slug,
  market_type,
  min_model_probability,
  min_ev,
  min_odds,
  max_odds,
  pick,
  min_closed,
  sample_limit,
  notes
)
VALUES
  ('mlb_ml_prob60_ev5_odds201', 'MLB ML prob >= 60%, EV >= 5%, odds >= 2.01', 'baseball', 'mlb', 'moneyline_2way', 0.600000, 0.050000, 2.0100, NULL, NULL, 50, 1000, 'Aggressive value dog/pickem screen.'),
  ('mlb_ml_prob55_ev5_odds201', 'MLB ML prob >= 55%, EV >= 5%, odds >= 2.01', 'baseball', 'mlb', 'moneyline_2way', 0.550000, 0.050000, 2.0100, NULL, NULL, 50, 1000, 'Broader plus-money value screen.'),
  ('mlb_ml_prob60_ev10_any_odds', 'MLB ML prob >= 60%, EV >= 10%, any odds', 'baseball', 'mlb', 'moneyline_2way', 0.600000, 0.100000, 1.0100, NULL, NULL, 50, 1000, 'High-confidence, high-edge regardless of price.'),
  ('mlb_ml_home_prob55_ev5', 'MLB ML home prob >= 55%, EV >= 5%', 'baseball', 'mlb', 'moneyline_2way', 0.550000, 0.050000, 1.0100, NULL, 'home', 50, 1000, 'Home-only exposure test.'),
  ('mlb_ml_away_prob55_ev5', 'MLB ML away prob >= 55%, EV >= 5%', 'baseball', 'mlb', 'moneyline_2way', 0.550000, 0.050000, 1.0100, NULL, 'away', 50, 1000, 'Away-only exposure test.'),
  ('mlb_ml_favorites_ev5', 'MLB ML favorites EV >= 5%', 'baseball', 'mlb', 'moneyline_2way', 0.520000, 0.050000, 1.0100, 1.9499, NULL, 50, 1000, 'Favorite price bucket.'),
  ('mlb_ml_pickem_ev5', 'MLB ML pickem EV >= 5%', 'baseball', 'mlb', 'moneyline_2way', 0.520000, 0.050000, 1.9500, 2.0500, NULL, 50, 1000, 'Pickem price bucket.'),
  ('mlb_ml_underdogs_ev5', 'MLB ML underdogs EV >= 5%', 'baseball', 'mlb', 'moneyline_2way', 0.520000, 0.050000, 2.0501, NULL, NULL, 50, 1000, 'Underdog price bucket.'),
  ('mlb_ml_prob60_clv_candidate', 'MLB ML prob >= 60%, EV >= 5%, all odds', 'baseball', 'mlb', 'moneyline_2way', 0.600000, 0.050000, 1.0100, NULL, NULL, 50, 1000, 'Candidate rule for CLV trend validation.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name,
  sport_slug = EXCLUDED.sport_slug,
  league_slug = EXCLUDED.league_slug,
  market_type = EXCLUDED.market_type,
  min_model_probability = EXCLUDED.min_model_probability,
  min_ev = EXCLUDED.min_ev,
  min_odds = EXCLUDED.min_odds,
  max_odds = EXCLUDED.max_odds,
  pick = EXCLUDED.pick,
  min_closed = EXCLUDED.min_closed,
  sample_limit = EXCLUDED.sample_limit,
  notes = EXCLUDED.notes,
  updated_at = NOW();
