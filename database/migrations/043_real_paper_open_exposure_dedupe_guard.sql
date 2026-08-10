WITH ranked_open AS (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY match_id, model_name, market_type, COALESCE(line, -9999::numeric), pick, bookmaker
      ORDER BY entry_timestamp ASC, created_at ASC, id ASC
    ) AS canonical_id,
    ROW_NUMBER() OVER (
      PARTITION BY match_id, model_name, market_type, COALESCE(line, -9999::numeric), pick, bookmaker
      ORDER BY entry_timestamp ASC, created_at ASC, id ASC
    ) AS exposure_rank
  FROM real_paper_snapshots
  WHERE status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
    AND duplicate_of_id IS NULL
    AND COALESCE(data_state, 'FRESH') <> 'DUPLICATE'
)
UPDATE real_paper_snapshots rps
SET data_state = 'DUPLICATE',
    duplicate_of_id = ranked_open.canonical_id,
    archive_reason = COALESCE(rps.archive_reason, 'duplicate_open_exposure'),
    last_refreshed_at = COALESCE(rps.last_refreshed_at, rps.entry_timestamp),
    updated_at = NOW()
FROM ranked_open
WHERE rps.id = ranked_open.id
  AND ranked_open.exposure_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_real_paper_snapshots_open_exposure
  ON real_paper_snapshots (
    match_id,
    model_name,
    market_type,
    COALESCE(line, -9999::numeric),
    pick,
    bookmaker
  )
  WHERE status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
    AND duplicate_of_id IS NULL
    AND COALESCE(data_state, 'FRESH') <> 'DUPLICATE';
