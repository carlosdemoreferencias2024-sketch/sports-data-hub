WITH expanded_quotes AS (
  SELECT
    mq.id AS market_quote_id,
    mq.match_id,
    s.slug AS sport_slug,
    l.slug AS league_slug,
    mq.provider_name,
    COALESCE(NULLIF(mq.raw_data->>'source_name', ''), mq.provider_name) AS source_name,
    NULLIF(mq.raw_data->>'bookmaker', '') AS bookmaker,
    NULLIF(mq.raw_data->>'external_event_id', '') AS external_event_id,
    NULLIF(mq.raw_data->>'bookmaker_event_id', '') AS bookmaker_event_id,
    mq.market_type,
    mq.line,
    selection_rows.selection,
    selection_rows.odds,
    CASE
      WHEN mq.raw_data->>'snapshot_role' IN ('market', 'entry', 'closing', 'live', 'manual_shadow')
        THEN mq.raw_data->>'snapshot_role'
      WHEN lower(mq.provider_name) LIKE '%manual%'
        OR lower(mq.provider_name) LIKE '%shadow%'
        OR lower(mq.provider_name) LIKE '%simulated%'
        THEN 'manual_shadow'
      ELSE 'market'
    END AS snapshot_role,
    mq.captured_at,
    mq.raw_data,
    (
      lower(mq.provider_name) LIKE '%manual%'
      OR lower(mq.provider_name) LIKE '%shadow%'
      OR lower(mq.provider_name) LIKE '%simulated%'
    ) AS is_shadow_provider
  FROM market_quotes mq
  JOIN matches m ON m.id = mq.match_id
  JOIN leagues l ON l.id = m.league_id
  JOIN sports s ON s.id = l.sport_id
  CROSS JOIN LATERAL (
    VALUES
      (
        CASE
          WHEN mq.market_type LIKE 'total_%' THEN 'over'
          WHEN mq.market_type = 'btts' THEN 'yes'
          ELSE 'home'
        END,
        mq.home_odds
      ),
      ('draw', mq.draw_odds),
      (
        CASE
          WHEN mq.market_type LIKE 'total_%' THEN 'under'
          WHEN mq.market_type = 'btts' THEN 'no'
          ELSE 'away'
        END,
        mq.away_odds
      )
  ) AS selection_rows(selection, odds)
  WHERE selection_rows.odds IS NOT NULL
),
scored_quotes AS (
  SELECT
    *,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN is_shadow_provider THEN 'MANUAL_OR_SHADOW' END,
      CASE WHEN raw_data->>'processed' = 'false' THEN 'UNPROCESSED' END,
      CASE WHEN bookmaker IS NULL AND NOT is_shadow_provider THEN 'MISSING_BOOKMAKER' END,
      CASE WHEN odds <= 1.2 OR odds >= 8 THEN 'ODDS_OUTLIER' END,
      CASE WHEN captured_at < NOW() - INTERVAL '900 seconds' AND NOT is_shadow_provider THEN 'STALE_ODDS' END
    ], NULL)::text[] AS quality_flags
  FROM expanded_quotes
)
INSERT INTO odds_snapshots (
  market_quote_id,
  match_id,
  sport_slug,
  league_slug,
  provider_name,
  source_name,
  bookmaker,
  external_event_id,
  bookmaker_event_id,
  market_type,
  line,
  selection,
  odds,
  snapshot_role,
  captured_at,
  received_at,
  quality_score,
  quality_flags,
  raw_data
)
SELECT
  market_quote_id,
  match_id,
  sport_slug,
  league_slug,
  provider_name,
  source_name,
  bookmaker,
  external_event_id,
  bookmaker_event_id,
  market_type,
  line,
  selection,
  odds,
  snapshot_role,
  captured_at,
  NOW(),
  GREATEST(
    0,
    100
      - CASE WHEN 'MANUAL_OR_SHADOW' = ANY(quality_flags) THEN 35 ELSE 0 END
      - CASE WHEN 'UNPROCESSED' = ANY(quality_flags) THEN 25 ELSE 0 END
      - CASE WHEN 'MISSING_BOOKMAKER' = ANY(quality_flags) THEN 15 ELSE 0 END
      - CASE WHEN 'ODDS_OUTLIER' = ANY(quality_flags) THEN 25 ELSE 0 END
      - CASE WHEN 'STALE_ODDS' = ANY(quality_flags) THEN 25 ELSE 0 END
  )::numeric(5, 2) AS quality_score,
  quality_flags,
  raw_data || jsonb_build_object('odds_snapshot_backfilled', true)
FROM scored_quotes
ON CONFLICT DO NOTHING;
