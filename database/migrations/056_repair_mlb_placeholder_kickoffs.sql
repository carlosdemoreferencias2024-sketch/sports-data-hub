BEGIN;

-- One-time repair for records created by the retired 12:00Z fallback.
-- Exact timestamps come from the public ESPN page payload captured in source_match_refs.raw_data.
WITH corrections(source_match_id, exact_start) AS (
  VALUES
    ('espn-mlb-2026-08-13-tigers-guardians', '2026-08-13T17:10:00Z'::timestamptz),
    ('espn-mlb-2026-08-13-marlins-pirates', '2026-08-13T17:10:00Z'::timestamptz),
    ('espn-mlb-2026-08-13-yankees-mariners', '2026-08-13T17:35:00Z'::timestamptz),
    ('espn-mlb-2026-08-13-white-sox-reds', '2026-08-13T17:10:00Z'::timestamptz),
    ('espn-mlb-2026-08-13-blue-jays-red-sox', '2026-08-13T19:07:00Z'::timestamptz),
    ('espn-mlb-2026-08-13-nationals-cubs', '2026-08-13T20:05:00Z'::timestamptz),
    ('espn-mlb-2026-08-13-twins-phillies', '2026-08-13T23:30:00Z'::timestamptz)
)
UPDATE matches m
SET
  match_date = correction.exact_start,
  raw_data = m.raw_data || jsonb_build_object(
    'schedule_repaired_at', clock_timestamp(),
    'schedule_repair_source', 'espn_embedded_event_date',
    'previous_match_date', m.match_date
  )
FROM corrections correction
JOIN source_match_refs source_ref ON source_ref.source_match_id = correction.source_match_id
JOIN data_sources source ON source.id = source_ref.source_id AND source.slug = 'espn-mlb'
WHERE m.id = source_ref.match_id
  AND m.match_date = '2026-08-13T12:00:00Z'::timestamptz
  AND correction.exact_start = (source_ref.raw_data->>'match_date')::timestamptz;

-- These two placeholder rows refer to games whose real UTC date is Aug 14.
-- Exact Aug 14 rows already exist, so retain the bad rows only as cancelled audit records.
UPDATE matches m
SET
  status = 'cancelled',
  raw_data = m.raw_data || jsonb_build_object(
    'schedule_repaired_at', clock_timestamp(),
    'schedule_repair_source', 'superseded_by_exact_utc_date',
    'invalid_placeholder', true
  )
FROM source_match_refs source_ref
JOIN data_sources source ON source.id = source_ref.source_id AND source.slug = 'espn-mlb'
WHERE m.id = source_ref.match_id
  AND m.match_date = '2026-08-13T12:00:00Z'::timestamptz
  AND source_ref.source_match_id IN (
    'espn-mlb-2026-08-13-angels-rangers',
    'espn-mlb-2026-08-13-dodgers-brewers'
  );

COMMIT;
