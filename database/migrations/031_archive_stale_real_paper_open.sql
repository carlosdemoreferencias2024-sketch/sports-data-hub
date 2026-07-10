ALTER TABLE real_paper_snapshots
  ADD COLUMN IF NOT EXISTS previous_status VARCHAR(30),
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_real_paper_snapshots_archive
  ON real_paper_snapshots(archived_at DESC)
  WHERE archived_at IS NOT NULL;
