CREATE TABLE IF NOT EXISTS bet_grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES real_paper_snapshots(id) ON DELETE CASCADE,
  sport_slug varchar(40) NOT NULL,
  league_slug varchar(80) NOT NULL,
  market_type varchar(40) NOT NULL,
  pick varchar(40) NOT NULL,
  grade varchar(1) NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  grade_reason text NOT NULL,
  market_status varchar(40),
  provider_status varchar(40),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_bet_grades_grade_market
  ON bet_grades (grade, sport_slug, league_slug, market_type, updated_at DESC);

DROP TRIGGER IF EXISTS bet_grades_updated_at ON bet_grades;
CREATE TRIGGER bet_grades_updated_at
BEFORE UPDATE ON bet_grades
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS model_error_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES real_paper_snapshots(id) ON DELETE CASCADE,
  sport_slug varchar(40) NOT NULL,
  league_slug varchar(80) NOT NULL,
  market_type varchar(40) NOT NULL,
  pick varchar(40) NOT NULL,
  error_type varchar(80) NOT NULL,
  error_reason text NOT NULL,
  severity varchar(20) NOT NULL DEFAULT 'watch',
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_model_error_events_type_market
  ON model_error_events (error_type, sport_slug, league_slug, market_type, updated_at DESC);

DROP TRIGGER IF EXISTS model_error_events_updated_at ON model_error_events;
CREATE TRIGGER model_error_events_updated_at
BEFORE UPDATE ON model_error_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS manual_alert_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type varchar(60) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'generated',
  telegram_mode varchar(30) NOT NULL DEFAULT 'manual_only',
  real_money_enabled boolean NOT NULL DEFAULT false,
  kelly_enabled boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_alert_reports_created
  ON manual_alert_reports (report_type, created_at DESC);
