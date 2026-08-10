ALTER TABLE market_quotes
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seen_count INTEGER NOT NULL DEFAULT 1;

UPDATE market_quotes
SET first_seen_at = COALESCE(first_seen_at, captured_at),
    last_seen_at = COALESCE(last_seen_at, captured_at),
    seen_count = GREATEST(seen_count, 1)
WHERE first_seen_at IS NULL
   OR last_seen_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_market_quotes_exact_quote_seen
  ON market_quotes(
    match_id,
    provider_name,
    market_type,
    COALESCE(line, -9999),
    COALESCE(home_odds, -9999),
    COALESCE(away_odds, -9999),
    COALESCE(draw_odds, -9999),
    last_seen_at DESC
  );
