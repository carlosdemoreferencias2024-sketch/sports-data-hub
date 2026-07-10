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
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_quote_id, market_quote_id, pick)
);

CREATE INDEX IF NOT EXISTS idx_real_paper_snapshots_status
  ON real_paper_snapshots(status, entry_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_real_paper_snapshots_market
  ON real_paper_snapshots(sport_slug, league_slug, market_type, entry_timestamp DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'real_paper_snapshots_updated_at'
  ) THEN
    CREATE TRIGGER real_paper_snapshots_updated_at
      BEFORE UPDATE ON real_paper_snapshots
      FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
  END IF;
END $$;
