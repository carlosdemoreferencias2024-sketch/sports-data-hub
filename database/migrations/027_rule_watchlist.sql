CREATE TABLE IF NOT EXISTS backtest_rule_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES backtest_rules(id) ON DELETE CASCADE,
  rule_key VARCHAR(120) NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'watch',
  promoted_reason TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (rule_id),
  CHECK (status IN ('watch', 'reviewed', 'rejected', 'retired'))
);

CREATE INDEX IF NOT EXISTS idx_backtest_rule_watchlist_status
  ON backtest_rule_watchlist(status, promoted_at DESC);
