CREATE TABLE IF NOT EXISTS model_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name VARCHAR(80) NOT NULL UNIQUE,
  sport_slug VARCHAR(40),
  league_slug VARCHAR(80),
  version_label VARCHAR(80) NOT NULL DEFAULT 'v1',
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  performance_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('active', 'frozen', 'candidate', 'retired'))
);

CREATE INDEX IF NOT EXISTS idx_model_registry_status
  ON model_registry(status, model_name);

INSERT INTO model_registry (
  model_name,
  sport_slug,
  league_slug,
  version_label,
  status,
  parameters,
  performance_summary,
  notes,
  updated_at
)
SELECT
  mp.model_name,
  CASE
    WHEN mp.model_name ILIKE '%mlb%' THEN 'baseball'
    WHEN mp.model_name ILIKE '%football%' THEN 'soccer'
    ELSE NULL
  END AS sport_slug,
  CASE
    WHEN mp.model_name ILIKE '%mlb%' THEN 'mlb'
    WHEN mp.model_name ILIKE '%football%' THEN 'fifa-world-cup-2026'
    ELSE NULL
  END AS league_slug,
  'v1' AS version_label,
  CASE WHEN mp.is_active THEN 'active' ELSE 'frozen' END AS status,
  jsonb_build_object(
    'home_pitching_weight', mp.home_pitching_weight,
    'home_offense_weight', mp.home_offense_weight,
    'home_bullpen_weight', mp.home_bullpen_weight,
    'home_field_weight', mp.home_field_weight
  ) AS parameters,
  jsonb_build_object(
    'brier_score', mp.brier_score,
    'sample_size', mp.sample_size,
    'accuracy', mp.accuracy,
    'bias_home', mp.bias_home
  ) AS performance_summary,
  COALESCE(mp.notes, 'Imported from model_parameters') AS notes,
  mp.updated_at
FROM model_parameters mp
ON CONFLICT (model_name) DO UPDATE SET
  status = EXCLUDED.status,
  parameters = EXCLUDED.parameters,
  performance_summary = EXCLUDED.performance_summary,
  notes = EXCLUDED.notes,
  updated_at = EXCLUDED.updated_at;

INSERT INTO model_registry (model_name, sport_slug, league_slug, version_label, status, notes)
VALUES
  ('carlos_v1_mlb', 'baseball', 'mlb', 'v1', 'active', 'Primary MLB moneyline model.'),
  ('carlos_v2_mlb', 'baseball', 'mlb', 'v2', 'candidate', 'Reserved candidate model for next iteration.'),
  ('carlos_v1_football', 'soccer', 'fifa-world-cup-2026', 'v1', 'active', 'Primary football Poisson-derived model.')
ON CONFLICT (model_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS risk_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key VARCHAR(80) NOT NULL UNIQUE,
  rule_name VARCHAR(160) NOT NULL,
  rule_value JSONB NOT NULL,
  severity VARCHAR(30) NOT NULL DEFAULT 'block',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (severity IN ('info', 'warn', 'block'))
);

INSERT INTO risk_rules (rule_key, rule_name, rule_value, severity, notes)
VALUES
  ('max_daily_stake_fraction', 'Max daily simulated stake fraction', '{"value": 0.03}', 'block', 'Paper and future pilot guardrail.'),
  ('max_sport_stake_fraction', 'Max sport simulated stake fraction', '{"value": 0.02}', 'block', 'Avoid overexposure by sport.'),
  ('max_pick_stake_fraction', 'Max pick simulated stake fraction', '{"value": 0.01}', 'block', 'Flat 1% remains the default.'),
  ('no_duplicate_match', 'No duplicate match exposure', '{"enabled": true}', 'block', 'Avoid repeated exposure on same match.'),
  ('no_correlated_parlays', 'No correlated parlays', '{"enabled": true}', 'block', 'Parlays cannot use correlated legs.'),
  ('stop_loss_virtual', 'Virtual stop loss', '{"daily_loss_fraction": -0.05}', 'block', 'Stops future pilot after drawdown.'),
  ('min_recent_clv', 'Minimum recent CLV', '{"min_avg_clv": 0.0, "lookback_closed": 25}', 'warn', 'Warn if CLV trend turns negative.'),
  ('kelly_disabled', 'Kelly disabled', '{"enabled": false}', 'block', 'Kelly remains off until manual authorization.'),
  ('real_money_disabled', 'Real money disabled', '{"enabled": false}', 'block', 'No real stake execution.')
ON CONFLICT (rule_key) DO UPDATE SET
  rule_value = EXCLUDED.rule_value,
  severity = EXCLUDED.severity,
  notes = EXCLUDED.notes,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_name VARCHAR(160) NOT NULL,
  sport_slug VARCHAR(40),
  league_slug VARCHAR(80),
  market_type VARCHAR(80),
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  results JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_created
  ON backtest_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS candidate_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id UUID,
  source_table VARCHAR(80) NOT NULL,
  event_type VARCHAR(80) NOT NULL,
  audit_status VARCHAR(80) NOT NULL,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_candidate_audit_events_created
  ON candidate_audit_events(created_at DESC);
