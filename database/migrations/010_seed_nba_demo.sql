DO $$
DECLARE
  nba_league_id UUID;
  season_id UUID;
  lakers_id UUID;
  celtics_id UUID;
  match_id UUID;
BEGIN
  SELECT id INTO nba_league_id FROM leagues WHERE slug = 'nba';
  IF nba_league_id IS NULL THEN
    RAISE EXCEPTION 'NBA league not found';
  END IF;

  SELECT id INTO season_id
  FROM seasons
  WHERE league_id = nba_league_id AND year = '2026'
  LIMIT 1;

  IF season_id IS NULL THEN
    INSERT INTO seasons (league_id, year, is_current)
    VALUES (nba_league_id, '2026', TRUE)
    RETURNING id INTO season_id;
  END IF;

  SELECT id INTO lakers_id FROM teams WHERE slug = 'los-angeles-lakers';
  SELECT id INTO celtics_id FROM teams WHERE slug = 'boston-celtics';

  IF lakers_id IS NULL OR celtics_id IS NULL THEN
    RAISE EXCEPTION 'NBA demo teams not found';
  END IF;

  DELETE FROM matches
  WHERE league_id = nba_league_id
    AND slug LIKE 'demo-nba-%';

  INSERT INTO matches (league_id, season_id, slug, match_date, status, home_score, away_score)
  VALUES
    (nba_league_id, season_id, 'demo-nba-lakers-celtics-finished-1', NOW() - INTERVAL '3 days', 'finished', 110, 105)
  RETURNING id INTO match_id;
  INSERT INTO match_competitors (match_id, team_id, home_away, score, winner)
  VALUES
    (match_id, lakers_id, 'home', 110, TRUE),
    (match_id, celtics_id, 'away', 105, FALSE);

  INSERT INTO matches (league_id, season_id, slug, match_date, status, home_score, away_score)
  VALUES
    (nba_league_id, season_id, 'demo-nba-celtics-lakers-finished-2', NOW() - INTERVAL '2 days', 'finished', 115, 108)
  RETURNING id INTO match_id;
  INSERT INTO match_competitors (match_id, team_id, home_away, score, winner)
  VALUES
    (match_id, celtics_id, 'home', 115, TRUE),
    (match_id, lakers_id, 'away', 108, FALSE);

  INSERT INTO matches (league_id, season_id, slug, match_date, status, home_score, away_score)
  VALUES
    (nba_league_id, season_id, 'demo-nba-lakers-celtics-finished-3', NOW() - INTERVAL '1 day', 'finished', 105, 100)
  RETURNING id INTO match_id;
  INSERT INTO match_competitors (match_id, team_id, home_away, score, winner)
  VALUES
    (match_id, lakers_id, 'home', 105, TRUE),
    (match_id, celtics_id, 'away', 100, FALSE);

  INSERT INTO matches (league_id, season_id, slug, match_date, status)
  VALUES
    (nba_league_id, season_id, 'demo-nba-lakers-celtics-scheduled', NOW() + INTERVAL '1 day', 'scheduled')
  RETURNING id INTO match_id;
  INSERT INTO match_competitors (match_id, team_id, home_away)
  VALUES
    (match_id, lakers_id, 'home'),
    (match_id, celtics_id, 'away');
END $$;
