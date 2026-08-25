-- Safe in-place fixture identity repair. No match PK or child FK is moved.
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS data_quality_flag varchar(40) NOT NULL DEFAULT 'AUTHENTIC',
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz,
  ADD COLUMN IF NOT EXISTS invalidated_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'matches_data_quality_flag_check'
      AND conrelid = 'matches'::regclass
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_data_quality_flag_check CHECK (
        data_quality_flag IN (
          'AUTHENTIC',
          'SYNTHETIC_INVALIDATED',
          'AMBIGUOUS_PENDING_REVIEW',
          'UNRESOLVED_PENDING_REVIEW'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_matches_data_quality_flag
  ON matches(data_quality_flag);

CREATE TABLE IF NOT EXISTS fixture_identity_batches (
  batch_id uuid PRIMARY KEY,
  repair_scope varchar(50) NOT NULL,
  status varchar(30) NOT NULL,
  backup_path text NOT NULL,
  backup_sha256 char(64) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (status IN ('RUNNING', 'COMPLETED', 'ROLLED_BACK', 'FAILED'))
);

CREATE TABLE IF NOT EXISTS fixture_identity_log (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES fixture_identity_batches(batch_id) ON DELETE RESTRICT,
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE RESTRICT,
  operation varchar(40) NOT NULL,
  object_name varchar(80) NOT NULL,
  old_value jsonb,
  new_value jsonb,
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, match_id, operation, object_name)
);

CREATE INDEX IF NOT EXISTS idx_fixture_identity_log_batch
  ON fixture_identity_log(batch_id, id);
CREATE INDEX IF NOT EXISTS idx_fixture_identity_log_match
  ON fixture_identity_log(match_id, applied_at DESC);

CREATE OR REPLACE VIEW v_valid_matches AS
SELECT *
FROM matches
WHERE data_quality_flag = 'AUTHENTIC';

CREATE OR REPLACE VIEW v_matches_pending_identity_review AS
SELECT *
FROM matches
WHERE data_quality_flag IN ('AMBIGUOUS_PENDING_REVIEW', 'UNRESOLVED_PENDING_REVIEW');

COMMENT ON COLUMN matches.data_quality_flag IS
  'Identity quality gate. SYNTHETIC_INVALIDATED requires explicit human approval.';
COMMENT ON TABLE fixture_identity_log IS
  'Row-level reversible log for in-place fixture identity repairs; no FK remapping.';
