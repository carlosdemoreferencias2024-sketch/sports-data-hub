ALTER TABLE model_quotes
  ADD COLUMN IF NOT EXISTS line NUMERIC(8, 3);

ALTER TABLE market_quotes
  ADD COLUMN IF NOT EXISTS line NUMERIC(8, 3);

ALTER TABLE alpha_opportunities
  ADD COLUMN IF NOT EXISTS line NUMERIC(8, 3);

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS line NUMERIC(8, 3);

ALTER TABLE alpha_opportunities
  DROP CONSTRAINT IF EXISTS alpha_opportunities_market_selection_check;

ALTER TABLE alpha_opportunities
  ADD CONSTRAINT alpha_opportunities_market_selection_check
  CHECK (market_selection IN ('home', 'draw', 'away', 'over', 'under', 'yes', 'no'));

DROP INDEX IF EXISTS uq_alpha_signal;
CREATE UNIQUE INDEX IF NOT EXISTS uq_alpha_signal
  ON alpha_opportunities(model_quote_id, market_quote_id, market_selection, COALESCE(line, -9999));

ALTER TABLE paper_trades
  DROP CONSTRAINT IF EXISTS paper_trades_match_id_market_type_selection_model_version_key;

DROP INDEX IF EXISTS uq_paper_trades_market_signal;
CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_trades_market_signal
  ON paper_trades(match_id, market_type, selection, model_version, COALESCE(line, -9999));

CREATE INDEX IF NOT EXISTS idx_model_quotes_market_line
  ON model_quotes(match_id, model_name, market_type, COALESCE(line, -9999), generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_quotes_market_line
  ON market_quotes(match_id, provider_name, market_type, COALESCE(line, -9999), captured_at DESC);
