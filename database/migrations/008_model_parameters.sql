CREATE TABLE IF NOT EXISTS model_parameters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name VARCHAR(80) NOT NULL,
  home_pitching_weight NUMERIC(6, 4) NOT NULL DEFAULT 0.3500,
  home_offense_weight NUMERIC(6, 4) NOT NULL DEFAULT 0.3500,
  home_bullpen_weight NUMERIC(6, 4) NOT NULL DEFAULT 0.2000,
  home_field_weight NUMERIC(6, 4) NOT NULL DEFAULT 0.1000,
  brier_score NUMERIC(10, 6),
  sample_size INTEGER NOT NULL DEFAULT 0,
  accuracy NUMERIC(6, 4),
  bias_home NUMERIC(7, 4),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_model_parameters_active_model
  ON model_parameters(model_name)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_model_parameters_updated
  ON model_parameters(model_name, updated_at DESC);
