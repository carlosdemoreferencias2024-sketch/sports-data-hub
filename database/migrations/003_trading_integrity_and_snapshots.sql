ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS odds_source VARCHAR(30);

ALTER TABLE paper_trades
  DROP CONSTRAINT IF EXISTS paper_trades_match_id_key;

ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS market_type VARCHAR(40),
  ADD COLUMN IF NOT EXISTS selection VARCHAR(40),
  ADD COLUMN IF NOT EXISTS model_version VARCHAR(80),
  ADD COLUMN IF NOT EXISTS odds_source VARCHAR(30),
  ADD COLUMN IF NOT EXISTS placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

UPDATE paper_trades
SET
  market_type = COALESCE(market_type, 'moneyline_2way'),
  selection = COALESCE(selection, 'home'),
  model_version = COALESCE(model_version, 'legacy-v1'),
  odds_source = COALESCE(odds_source, 'simulated_odds')
WHERE market_type IS NULL
   OR selection IS NULL
   OR model_version IS NULL
   OR odds_source IS NULL;

ALTER TABLE paper_trades
  ALTER COLUMN market_type SET NOT NULL,
  ALTER COLUMN selection SET NOT NULL,
  ALTER COLUMN model_version SET NOT NULL,
  ALTER COLUMN odds_source SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_paper_trades_market_signal
  ON paper_trades(match_id, market_type, selection, model_version);

CREATE INDEX IF NOT EXISTS idx_paper_trades_odds_source ON paper_trades(odds_source);

CREATE TABLE IF NOT EXISTS team_stat_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  home_away home_away NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL,
  played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  points_for INTEGER NOT NULL DEFAULT 0,
  points_against INTEGER NOT NULL DEFAULT 0,
  form JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_team_stat_snapshots_match ON team_stat_snapshots(match_id);
CREATE INDEX IF NOT EXISTS idx_team_stat_snapshots_team_date ON team_stat_snapshots(team_id, snapshot_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'team_stat_snapshots_updated_at') THEN
    CREATE TRIGGER team_stat_snapshots_updated_at
    BEFORE UPDATE ON team_stat_snapshots
    FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
  END IF;
END $$;
