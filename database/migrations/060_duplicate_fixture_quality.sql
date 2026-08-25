-- Exact provider-event duplicates remain in place and point to their AUTHENTIC owner.
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS duplicate_of_match_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'matches_duplicate_of_match_id_fkey'
      AND conrelid = 'matches'::regclass
  ) THEN
    ALTER TABLE matches
      ADD CONSTRAINT matches_duplicate_of_match_id_fkey
      FOREIGN KEY (duplicate_of_match_id) REFERENCES matches(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_data_quality_flag_check;
ALTER TABLE matches
  ADD CONSTRAINT matches_data_quality_flag_check CHECK (
    data_quality_flag IN (
      'AUTHENTIC',
      'SYNTHETIC_INVALIDATED',
      'AMBIGUOUS_PENDING_REVIEW',
      'UNRESOLVED_PENDING_REVIEW',
      'DUPLICATE_INVALIDATED'
    )
  );

ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_duplicate_quality_consistency_check;
ALTER TABLE matches
  ADD CONSTRAINT matches_duplicate_quality_consistency_check CHECK (
    (
      data_quality_flag = 'DUPLICATE_INVALIDATED'
      AND duplicate_of_match_id IS NOT NULL
      AND duplicate_of_match_id <> id
    ) OR (
      data_quality_flag <> 'DUPLICATE_INVALIDATED'
      AND duplicate_of_match_id IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_matches_duplicate_of_match_id
  ON matches(duplicate_of_match_id)
  WHERE duplicate_of_match_id IS NOT NULL;

CREATE OR REPLACE VIEW v_duplicate_matches AS
SELECT
  dup.id AS duplicate_match_id,
  dup.raw_data->>'source_match_id' AS duplicate_source_match_id,
  original.id AS original_match_id,
  original.raw_data->>'source_match_id' AS original_source_match_id,
  original.raw_data->>'provider_event_id' AS provider_event_id,
  dup.match_date,
  dup.invalidated_at,
  dup.invalidated_reason
FROM matches dup
JOIN matches original ON original.id = dup.duplicate_of_match_id
WHERE dup.data_quality_flag = 'DUPLICATE_INVALIDATED';

COMMENT ON COLUMN matches.duplicate_of_match_id IS
  'AUTHENTIC owner for a row marked DUPLICATE_INVALIDATED; no child FK is moved.';
