ALTER TABLE real_paper_snapshots
  ADD COLUMN IF NOT EXISTS data_state varchar(20) NOT NULL DEFAULT 'FRESH',
  ADD COLUMN IF NOT EXISTS duplicate_of_id uuid NULL REFERENCES real_paper_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ev_flag varchar(40),
  ADD COLUMN IF NOT EXISTS shadow_kelly_fraction numeric(10, 6),
  ADD COLUMN IF NOT EXISTS shadow_kelly_stake_pct numeric(10, 6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'real_paper_snapshots_data_state_check'
  ) THEN
    ALTER TABLE real_paper_snapshots
      ADD CONSTRAINT real_paper_snapshots_data_state_check
      CHECK (data_state IN ('FRESH', 'STALE', 'ARCHIVED', 'DUPLICATE'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_real_paper_snapshots_data_state
  ON real_paper_snapshots(data_state, entry_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_real_paper_snapshots_duplicate_of
  ON real_paper_snapshots(duplicate_of_id)
  WHERE duplicate_of_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_real_paper_snapshots_ev_flag
  ON real_paper_snapshots(ev_flag, entry_timestamp DESC)
  WHERE ev_flag IS NOT NULL;

CREATE TABLE IF NOT EXISTS data_quality_scores (
  snapshot_id uuid PRIMARY KEY REFERENCES real_paper_snapshots(id) ON DELETE CASCADE,
  sport_slug varchar(40) NOT NULL,
  league_slug varchar(80) NOT NULL,
  market_type varchar(80) NOT NULL,
  component_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_score integer NOT NULL DEFAULT 0 CHECK (total_score >= 0 AND total_score <= 100),
  tier varchar(20) NOT NULL DEFAULT 'WEAK' CHECK (tier IN ('WEAK', 'INCOMPLETE', 'REVIEWABLE', 'STRONG')),
  missing_components text[] NOT NULL DEFAULT ARRAY[]::text[],
  why_not_confirmed text,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_quality_scores_tier
  ON data_quality_scores(tier, total_score DESC, calculated_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_quality_scores_market
  ON data_quality_scores(sport_slug, league_slug, market_type, calculated_at DESC);

DROP TRIGGER IF EXISTS data_quality_scores_updated_at ON data_quality_scores;
CREATE TRIGGER data_quality_scores_updated_at
BEFORE UPDATE ON data_quality_scores
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS pilot_readiness_checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  backtest_positive_ci boolean NOT NULL DEFAULT false,
  min_sample_reached boolean NOT NULL DEFAULT false,
  avg_quality_score_confirmed numeric(8, 3),
  quality_score_passes boolean NOT NULL DEFAULT false,
  zero_duplicate_exposure boolean NOT NULL DEFAULT false,
  provider_scorecard_clean boolean NOT NULL DEFAULT false,
  settlement_clean boolean NOT NULL DEFAULT false,
  all_passed boolean NOT NULL DEFAULT false,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommendation text NOT NULL DEFAULT 'Mantener Real Paper only.',
  guardrails jsonb NOT NULL DEFAULT jsonb_build_object(
    'real_candidate_count', 0,
    'real_money_enabled', false,
    'kelly_enabled', false,
    'telegram_auto_enabled', false,
    'real_paper_only', true
  )
);

CREATE INDEX IF NOT EXISTS idx_pilot_readiness_checklist_checked
  ON pilot_readiness_checklist(checked_at DESC);

CREATE OR REPLACE VIEW backtest_confirmed_vs_ev_dataset AS
SELECT
  rps.id,
  rps.sport_slug,
  rps.league_slug,
  rps.market_type,
  rps.model_name,
  rps.status AS settlement_status,
  COALESCE(rps.data_state, 'FRESH') AS data_state,
  rps.ev_flag,
  rps.entry_odds,
  rps.closing_odds,
  rps.clv,
  rps.result,
  rps.profit_loss,
  rps.model_probability,
  rps.expected_value,
  rps.entry_timestamp,
  dqs.total_score AS data_quality_score,
  dqs.tier AS data_quality_tier,
  COALESCE(
    rps.raw_data->>'final_chain_status',
    rps.raw_data->>'final_operational_status',
    rps.raw_data->>'decision',
    CASE WHEN dqs.tier = 'STRONG' THEN 'BETTABLE_PAPER_CONFIRMED' ELSE 'EV_ONLY' END
  ) AS decision_bucket
FROM real_paper_snapshots rps
LEFT JOIN data_quality_scores dqs ON dqs.snapshot_id = rps.id
WHERE rps.status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')
  AND COALESCE(rps.data_state, 'FRESH') IN ('ARCHIVED', 'FRESH')
  AND rps.duplicate_of_id IS NULL;
