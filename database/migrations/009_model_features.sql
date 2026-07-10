CREATE TABLE IF NOT EXISTS model_features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sport_slug VARCHAR(40) NOT NULL,
  model_name VARCHAR(80) NOT NULL,
  feature_set JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_features_match_generated
  ON model_features(match_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_model_features_sport_model
  ON model_features(sport_slug, model_name, generated_at DESC);
