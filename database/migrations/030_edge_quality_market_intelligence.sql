ALTER TABLE bet_grades
  ADD COLUMN IF NOT EXISTS edge_quality_score numeric(6,2),
  ADD COLUMN IF NOT EXISTS edge_quality_grade varchar(1) CHECK (edge_quality_grade IS NULL OR edge_quality_grade IN ('A', 'B', 'C', 'D', 'F')),
  ADD COLUMN IF NOT EXISTS explanation_text text;

CREATE INDEX IF NOT EXISTS idx_bet_grades_edge_quality
  ON bet_grades (edge_quality_grade, edge_quality_score DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS auto_research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key varchar(120) NOT NULL,
  sport_slug varchar(40) NOT NULL,
  league_slug varchar(80) NOT NULL,
  market_type varchar(80) NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  results jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommendation varchar(40) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auto_research_runs_market_created
  ON auto_research_runs (sport_slug, league_slug, market_type, created_at DESC);
