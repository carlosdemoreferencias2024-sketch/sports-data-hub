ALTER TABLE backtest_rule_watchlist
  DROP CONSTRAINT IF EXISTS backtest_rule_watchlist_status_check;

ALTER TABLE backtest_rule_watchlist
  ADD CONSTRAINT backtest_rule_watchlist_status_check
  CHECK (status IN ('watch', 'hot', 'cooling', 'rejected', 'ready_for_real_paper_plus', 'reviewed', 'retired'));

CREATE TABLE IF NOT EXISTS market_promotion_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key VARCHAR(140) NOT NULL UNIQUE,
  sport_slug VARCHAR(80) NOT NULL,
  league_slug VARCHAR(80) NOT NULL,
  market_type VARCHAR(80) NOT NULL,
  segment VARCHAR(80) NOT NULL DEFAULT 'overall',
  status VARCHAR(60) NOT NULL,
  required_closed INTEGER NOT NULL DEFAULT 50,
  current_closed INTEGER NOT NULL DEFAULT 0,
  min_profit_units NUMERIC(14,4) NOT NULL DEFAULT 0,
  min_avg_clv NUMERIC(12,6) NOT NULL DEFAULT 0,
  recommendation TEXT NOT NULL,
  guardrail_reason TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('READY_FOR_REVIEW', 'WAITING_SAMPLE', 'ACCUMULATING', 'BLOCKED', 'WATCHLIST_READY', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_market_promotion_rules_status
  ON market_promotion_rules(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS no_bet_intelligence_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(80) NOT NULL DEFAULT 'audit',
  sport_slug VARCHAR(80),
  league_slug VARCHAR(80),
  market_type VARCHAR(80),
  reason_code VARCHAR(80) NOT NULL,
  reason_label TEXT NOT NULL,
  severity VARCHAR(40) NOT NULL DEFAULT 'info',
  occurrences INTEGER NOT NULL DEFAULT 0,
  sample JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, sport_slug, league_slug, market_type, reason_code),
  CHECK (severity IN ('info', 'watch', 'block'))
);

CREATE INDEX IF NOT EXISTS idx_no_bet_intelligence_market
  ON no_bet_intelligence_events(sport_slug, league_slug, market_type, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS clv_drift_monitor_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(40) NOT NULL,
  entity_key VARCHAR(160) NOT NULL,
  sport_slug VARCHAR(80),
  league_slug VARCHAR(80),
  market_type VARCHAR(80),
  status VARCHAR(60) NOT NULL,
  current_avg_clv NUMERIC(12,6),
  previous_avg_clv NUMERIC(12,6),
  delta_clv NUMERIC(12,6),
  sample_size INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_type, entity_key),
  CHECK (status IN ('CLV_STABLE', 'CLV_COOLING', 'CLV_NEGATIVE', 'CLV_IMPROVING', 'INSUFFICIENT_SAMPLE'))
);

CREATE INDEX IF NOT EXISTS idx_clv_drift_monitor_status
  ON clv_drift_monitor_events(status, created_at DESC);

CREATE TABLE IF NOT EXISTS pilot_real_guardrails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key VARCHAR(120) NOT NULL UNIQUE,
  status VARCHAR(40) NOT NULL DEFAULT 'blocked',
  max_daily_stake_units NUMERIC(12,4) NOT NULL DEFAULT 0,
  max_pick_stake_units NUMERIC(12,4) NOT NULL DEFAULT 0,
  kill_switch_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  manual_confirmation_required BOOLEAN NOT NULL DEFAULT TRUE,
  telegram_mode VARCHAR(40) NOT NULL DEFAULT 'manual_only',
  real_money_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  kelly_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('blocked', 'paper_only', 'manual_review_only')),
  CHECK (telegram_mode IN ('off', 'manual_only'))
);

INSERT INTO pilot_real_guardrails (
  rule_key,
  status,
  max_daily_stake_units,
  max_pick_stake_units,
  kill_switch_enabled,
  manual_confirmation_required,
  telegram_mode,
  real_money_enabled,
  kelly_enabled,
  notes
)
VALUES (
  'global_minimum_pilot_blocked',
  'blocked',
  0,
  0,
  TRUE,
  TRUE,
  'manual_only',
  FALSE,
  FALSE,
  'Infraestructura preparada, pero dinero real y Kelly siguen apagados hasta autorizacion explicita.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  status = EXCLUDED.status,
  max_daily_stake_units = EXCLUDED.max_daily_stake_units,
  max_pick_stake_units = EXCLUDED.max_pick_stake_units,
  kill_switch_enabled = EXCLUDED.kill_switch_enabled,
  manual_confirmation_required = EXCLUDED.manual_confirmation_required,
  telegram_mode = EXCLUDED.telegram_mode,
  real_money_enabled = EXCLUDED.real_money_enabled,
  kelly_enabled = EXCLUDED.kelly_enabled,
  notes = EXCLUDED.notes,
  updated_at = NOW();
