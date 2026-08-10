BEGIN;

DO $$
DECLARE
  safety_ok boolean;
BEGIN
  SELECT
    cl.slug = dl.slug
    AND cm.match_date = dm.match_date
    AND lower(cht.name) = lower(dht.name)
    AND lower(cat.name) = lower(dat.name)
    AND NOT EXISTS (
      SELECT 1
      FROM model_quotes
      WHERE match_id = 'e3d3d762-e5a6-5afe-b955-1feb0104239c'::uuid
    )
    AND NOT EXISTS (
      SELECT 1
      FROM market_quotes
      WHERE match_id = 'e3d3d762-e5a6-5afe-b955-1feb0104239c'::uuid
    )
    AND NOT EXISTS (
      SELECT 1
      FROM paper_trades
      WHERE match_id = 'e3d3d762-e5a6-5afe-b955-1feb0104239c'::uuid
    )
  INTO safety_ok
  FROM matches cm
  JOIN matches dm ON dm.id = 'e3d3d762-e5a6-5afe-b955-1feb0104239c'::uuid
  JOIN leagues cl ON cl.id = cm.league_id
  JOIN leagues dl ON dl.id = dm.league_id
  LEFT JOIN match_competitors chmc ON chmc.match_id = cm.id AND chmc.home_away = 'home'
  LEFT JOIN teams cht ON cht.id = chmc.team_id
  LEFT JOIN match_competitors camc ON camc.match_id = cm.id AND camc.home_away = 'away'
  LEFT JOIN teams cat ON cat.id = camc.team_id
  LEFT JOIN match_competitors dhmc ON dhmc.match_id = dm.id AND dhmc.home_away = 'home'
  LEFT JOIN teams dht ON dht.id = dhmc.team_id
  LEFT JOIN match_competitors damc ON damc.match_id = dm.id AND damc.home_away = 'away'
  LEFT JOIN teams dat ON dat.id = damc.team_id
  WHERE cm.id = '91fdd84c-53e7-5762-a7d9-767975cd87b5'::uuid;

  IF NOT COALESCE(safety_ok, false) THEN
    RAISE EXCEPTION 'Coritiba vs Cruzeiro dedupe safety check failed; no changes applied.';
  END IF;
END $$;

UPDATE football_player_intelligence
SET
  match_id = '91fdd84c-53e7-5762-a7d9-767975cd87b5'::uuid,
  raw_data = raw_data || jsonb_build_object(
    'dedupe_moved_from_match_id', 'e3d3d762-e5a6-5afe-b955-1feb0104239c',
    'dedupe_canonical_match_id', '91fdd84c-53e7-5762-a7d9-767975cd87b5',
    'dedupe_reason', 'Coritiba vs Cruzeiro logical duplicate 2026-07-30',
    'dedupe_moved_at', NOW()
  ),
  updated_at = NOW()
WHERE match_id = 'e3d3d762-e5a6-5afe-b955-1feb0104239c'::uuid;

UPDATE football_team_intelligence
SET
  match_id = '91fdd84c-53e7-5762-a7d9-767975cd87b5'::uuid,
  raw_data = raw_data || jsonb_build_object(
    'dedupe_moved_from_match_id', 'e3d3d762-e5a6-5afe-b955-1feb0104239c',
    'dedupe_canonical_match_id', '91fdd84c-53e7-5762-a7d9-767975cd87b5',
    'dedupe_reason', 'Coritiba vs Cruzeiro logical duplicate 2026-07-30',
    'dedupe_moved_at', NOW()
  ),
  updated_at = NOW()
WHERE match_id = 'e3d3d762-e5a6-5afe-b955-1feb0104239c'::uuid;

UPDATE matches
SET
  status = 'cancelled',
  raw_data = raw_data || jsonb_build_object(
    'duplicate_resolution', 'ARCHIVED_DUPLICATE',
    'canonical_match_id', '91fdd84c-53e7-5762-a7d9-767975cd87b5',
    'duplicate_match_id', 'e3d3d762-e5a6-5afe-b955-1feb0104239c',
    'duplicate_group', 'soccer|brasileirao-serie-a|2026-07-30|coritiba|cruzeiro|2026-07-31T00:30:00Z',
    'archived_reason', 'Logical duplicate created by manual_verified_json after api_football match already existed',
    'archived_at', NOW(),
    'real_money_enabled', false,
    'kelly_enabled', false,
    'telegram_auto_enabled', false
  ),
  updated_at = NOW()
WHERE id = 'e3d3d762-e5a6-5afe-b955-1feb0104239c'::uuid;

COMMIT;
