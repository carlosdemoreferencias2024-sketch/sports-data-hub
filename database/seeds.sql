INSERT INTO sports (slug, name) VALUES
  ('baseball', 'Baseball'),
  ('basketball', 'Basketball'),
  ('american-football', 'American Football'),
  ('soccer', 'Soccer'),
  ('hockey', 'Hockey')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO leagues (sport_id, slug, name, abbreviation, country)
SELECT id, 'mlb', 'Major League Baseball', 'MLB', 'USA'
FROM sports WHERE slug = 'baseball'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO leagues (sport_id, slug, name, abbreviation, country)
SELECT id, 'nba', 'National Basketball Association', 'NBA', 'USA'
FROM sports WHERE slug = 'basketball'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO leagues (sport_id, slug, name, abbreviation, country)
SELECT id, 'nfl', 'National Football League', 'NFL', 'USA'
FROM sports WHERE slug = 'american-football'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO leagues (sport_id, slug, name, abbreviation, country)
SELECT s.id, league.slug, league.name, league.abbreviation, league.country
FROM sports s
JOIN (
  VALUES
    ('liga-mx', 'Liga MX', 'LMX', 'Mexico'),
    ('premier-league', 'Premier League', 'EPL', 'England'),
    ('la-liga', 'La Liga', 'LL', 'Spain'),
    ('serie-a', 'Serie A', 'SA', 'Italy'),
    ('bundesliga', 'Bundesliga', 'BUN', 'Germany'),
    ('ligue-1', 'Ligue 1', 'L1', 'France'),
    ('mls', 'Major League Soccer', 'MLS', 'USA'),
    ('uefa-champions-league', 'UEFA Champions League', 'UCL', 'Europe')
) AS league(slug, name, abbreviation, country) ON TRUE
WHERE s.slug = 'soccer'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO seasons (league_id, year, start_date, end_date, is_current)
SELECT id, '2026', '2026-01-01', '2026-12-31', TRUE
FROM leagues
WHERE slug IN (
  'mlb',
  'nba',
  'nfl',
  'liga-mx',
  'premier-league',
  'la-liga',
  'serie-a',
  'bundesliga',
  'ligue-1',
  'mls',
  'uefa-champions-league'
)
ON CONFLICT (league_id, year) DO NOTHING;

INSERT INTO data_sources (slug, name, base_url, source_type)
VALUES ('sample-local', 'Sample Local Fixture', NULL, 'fixture')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO data_sources (slug, name, base_url, source_type)
VALUES ('sample-soccer-local', 'Sample Soccer Fixture', NULL, 'fixture')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO data_sources (slug, name, base_url, source_type)
VALUES ('espn-mexico', 'ESPN Mexico Soccer Results', 'https://www.espn.com.mx/futbol/resultados/_/liga/mex.1', 'scraper')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO data_sources (slug, name, base_url, source_type)
VALUES ('espn-mlb', 'ESPN Mexico MLB Results', 'https://www.espn.com.mx/beisbol/mlb/resultados', 'scraper')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO data_sources (slug, name, base_url, source_type)
VALUES ('sportsapi', 'ESPN Site API Scoreboards', 'https://site.api.espn.com/apis/site/v2/sports', 'scraper')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT id, 'new-york-yankees', 'New York Yankees', 'Yankees', 'NYY'
FROM leagues WHERE slug = 'mlb'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT id, 'boston-red-sox', 'Boston Red Sox', 'Red Sox', 'BOS'
FROM leagues WHERE slug = 'mlb'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('arizona-diamondbacks', 'Arizona Diamondbacks', 'Diamondbacks', 'ARI'),
    ('atlanta-braves', 'Atlanta Braves', 'Braves', 'ATL'),
    ('baltimore-orioles', 'Baltimore Orioles', 'Orioles', 'BAL'),
    ('boston-red-sox', 'Boston Red Sox', 'Red Sox', 'BOS'),
    ('chicago-cubs', 'Chicago Cubs', 'Cubs', 'CHC'),
    ('chicago-white-sox', 'Chicago White Sox', 'White Sox', 'CHW'),
    ('cincinnati-reds', 'Cincinnati Reds', 'Reds', 'CIN'),
    ('cleveland-guardians', 'Cleveland Guardians', 'Guardians', 'CLE'),
    ('colorado-rockies', 'Colorado Rockies', 'Rockies', 'COL'),
    ('detroit-tigers', 'Detroit Tigers', 'Tigers', 'DET'),
    ('houston-astros', 'Houston Astros', 'Astros', 'HOU'),
    ('kansas-city-royals', 'Kansas City Royals', 'Royals', 'KC'),
    ('los-angeles-angels', 'Los Angeles Angels', 'Angels', 'LAA'),
    ('los-angeles-dodgers', 'Los Angeles Dodgers', 'Dodgers', 'LAD'),
    ('miami-marlins', 'Miami Marlins', 'Marlins', 'MIA'),
    ('milwaukee-brewers', 'Milwaukee Brewers', 'Brewers', 'MIL'),
    ('minnesota-twins', 'Minnesota Twins', 'Twins', 'MIN'),
    ('new-york-mets', 'New York Mets', 'Mets', 'NYM'),
    ('new-york-yankees', 'New York Yankees', 'Yankees', 'NYY'),
    ('athletics', 'Athletics', 'Athletics', 'ATH'),
    ('philadelphia-phillies', 'Philadelphia Phillies', 'Phillies', 'PHI'),
    ('pittsburgh-pirates', 'Pittsburgh Pirates', 'Pirates', 'PIT'),
    ('san-diego-padres', 'San Diego Padres', 'Padres', 'SD'),
    ('san-francisco-giants', 'San Francisco Giants', 'Giants', 'SF'),
    ('seattle-mariners', 'Seattle Mariners', 'Mariners', 'SEA'),
    ('st-louis-cardinals', 'St. Louis Cardinals', 'Cardinals', 'STL'),
    ('tampa-bay-rays', 'Tampa Bay Rays', 'Rays', 'TB'),
    ('texas-rangers', 'Texas Rangers', 'Rangers', 'TEX'),
    ('toronto-blue-jays', 'Toronto Blue Jays', 'Blue Jays', 'TOR'),
    ('washington-nationals', 'Washington Nationals', 'Nationals', 'WSH')
) AS team(slug, name, short_name, abbreviation) ON TRUE
WHERE l.slug = 'mlb'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT id, 'los-angeles-lakers', 'Los Angeles Lakers', 'Lakers', 'LAL'
FROM leagues WHERE slug = 'nba'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT id, 'boston-celtics', 'Boston Celtics', 'Celtics', 'BOS'
FROM leagues WHERE slug = 'nba'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('liga-mx', 'club-america', 'Club America', 'America', 'AME'),
    ('liga-mx', 'chivas-guadalajara', 'Chivas Guadalajara', 'Chivas', 'GUA'),
    ('liga-mx', 'pumas-unam', 'Pumas UNAM', 'Pumas', 'PUM'),
    ('liga-mx', 'cruz-azul', 'Cruz Azul', 'Cruz Azul', 'CAZ'),
    ('premier-league', 'manchester-city', 'Manchester City', 'Man City', 'MCI'),
    ('premier-league', 'liverpool', 'Liverpool', 'Liverpool', 'LIV'),
    ('la-liga', 'real-madrid', 'Real Madrid', 'Real Madrid', 'RMA'),
    ('la-liga', 'barcelona', 'Barcelona', 'Barcelona', 'BAR'),
    ('serie-a', 'inter-milan', 'Inter Milan', 'Inter', 'INT'),
    ('serie-a', 'juventus', 'Juventus', 'Juventus', 'JUV'),
    ('bundesliga', 'bayern-munich', 'Bayern Munich', 'Bayern', 'BAY'),
    ('bundesliga', 'borussia-dortmund', 'Borussia Dortmund', 'Dortmund', 'BVB'),
    ('ligue-1', 'paris-saint-germain', 'Paris Saint-Germain', 'PSG', 'PSG'),
    ('ligue-1', 'marseille', 'Marseille', 'Marseille', 'OM'),
    ('mls', 'inter-miami', 'Inter Miami', 'Inter Miami', 'MIA'),
    ('mls', 'la-galaxy', 'LA Galaxy', 'LA Galaxy', 'LAG'),
    ('uefa-champions-league', 'ucl-real-madrid', 'Real Madrid', 'Real Madrid', 'RMA'),
    ('uefa-champions-league', 'ucl-manchester-city', 'Manchester City', 'Man City', 'MCI')
) AS team(league_slug, slug, name, short_name, abbreviation) ON team.league_slug = l.slug
ON CONFLICT (slug) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN (
  VALUES
    ('new-york-yankees', 'NY Yankees', 'ny yankees'),
    ('new-york-yankees', 'New York Yankees', 'new york yankees'),
    ('boston-red-sox', 'Boston Red Sox', 'boston red sox'),
    ('los-angeles-lakers', 'LA Lakers', 'la lakers'),
    ('boston-celtics', 'Boston Celtics', 'boston celtics')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'sample-local'
ON CONFLICT (source_id, normalized_alias) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN (
  VALUES
    ('arizona-diamondbacks', 'Arizona Diamondbacks', 'arizona diamondbacks'),
    ('arizona-diamondbacks', 'Diamondbacks', 'diamondbacks'),
    ('arizona-diamondbacks', 'D-backs', 'd backs'),
    ('atlanta-braves', 'Atlanta Braves', 'atlanta braves'),
    ('atlanta-braves', 'Braves', 'braves'),
    ('baltimore-orioles', 'Baltimore Orioles', 'baltimore orioles'),
    ('baltimore-orioles', 'Orioles', 'orioles'),
    ('boston-red-sox', 'Boston Red Sox', 'boston red sox'),
    ('boston-red-sox', 'Red Sox', 'red sox'),
    ('chicago-cubs', 'Chicago Cubs', 'chicago cubs'),
    ('chicago-cubs', 'Cubs', 'cubs'),
    ('chicago-white-sox', 'Chicago White Sox', 'chicago white sox'),
    ('chicago-white-sox', 'White Sox', 'white sox'),
    ('cincinnati-reds', 'Cincinnati Reds', 'cincinnati reds'),
    ('cincinnati-reds', 'Reds', 'reds'),
    ('cleveland-guardians', 'Cleveland Guardians', 'cleveland guardians'),
    ('cleveland-guardians', 'Guardians', 'guardians'),
    ('colorado-rockies', 'Colorado Rockies', 'colorado rockies'),
    ('colorado-rockies', 'Rockies', 'rockies'),
    ('detroit-tigers', 'Detroit Tigers', 'detroit tigers'),
    ('detroit-tigers', 'Tigers', 'tigers'),
    ('houston-astros', 'Houston Astros', 'houston astros'),
    ('houston-astros', 'Astros', 'astros'),
    ('kansas-city-royals', 'Kansas City Royals', 'kansas city royals'),
    ('kansas-city-royals', 'Royals', 'royals'),
    ('los-angeles-angels', 'Los Angeles Angels', 'los angeles angels'),
    ('los-angeles-angels', 'Angels', 'angels'),
    ('los-angeles-dodgers', 'Los Angeles Dodgers', 'los angeles dodgers'),
    ('los-angeles-dodgers', 'Dodgers', 'dodgers'),
    ('miami-marlins', 'Miami Marlins', 'miami marlins'),
    ('miami-marlins', 'Marlins', 'marlins'),
    ('milwaukee-brewers', 'Milwaukee Brewers', 'milwaukee brewers'),
    ('milwaukee-brewers', 'Brewers', 'brewers'),
    ('minnesota-twins', 'Minnesota Twins', 'minnesota twins'),
    ('minnesota-twins', 'Twins', 'twins'),
    ('new-york-mets', 'New York Mets', 'new york mets'),
    ('new-york-mets', 'Mets', 'mets'),
    ('new-york-yankees', 'New York Yankees', 'new york yankees'),
    ('new-york-yankees', 'NY Yankees', 'ny yankees'),
    ('new-york-yankees', 'Yankees', 'yankees'),
    ('athletics', 'Athletics', 'athletics'),
    ('athletics', 'A''s', 'a s'),
    ('philadelphia-phillies', 'Philadelphia Phillies', 'philadelphia phillies'),
    ('philadelphia-phillies', 'Phillies', 'phillies'),
    ('pittsburgh-pirates', 'Pittsburgh Pirates', 'pittsburgh pirates'),
    ('pittsburgh-pirates', 'Pirates', 'pirates'),
    ('san-diego-padres', 'San Diego Padres', 'san diego padres'),
    ('san-diego-padres', 'Padres', 'padres'),
    ('san-francisco-giants', 'San Francisco Giants', 'san francisco giants'),
    ('san-francisco-giants', 'Giants', 'giants'),
    ('seattle-mariners', 'Seattle Mariners', 'seattle mariners'),
    ('seattle-mariners', 'Mariners', 'mariners'),
    ('st-louis-cardinals', 'St. Louis Cardinals', 'st louis cardinals'),
    ('st-louis-cardinals', 'Cardinals', 'cardinals'),
    ('tampa-bay-rays', 'Tampa Bay Rays', 'tampa bay rays'),
    ('tampa-bay-rays', 'Rays', 'rays'),
    ('texas-rangers', 'Texas Rangers', 'texas rangers'),
    ('texas-rangers', 'Rangers', 'rangers'),
    ('toronto-blue-jays', 'Toronto Blue Jays', 'toronto blue jays'),
    ('toronto-blue-jays', 'Blue Jays', 'blue jays'),
    ('washington-nationals', 'Washington Nationals', 'washington nationals'),
    ('washington-nationals', 'Nationals', 'nationals')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'espn-mlb'
ON CONFLICT (source_id, normalized_alias) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN (
  VALUES
    ('club-america', 'Club America', 'club america'),
    ('club-america', 'America', 'america'),
    ('chivas-guadalajara', 'Chivas Guadalajara', 'chivas guadalajara'),
    ('chivas-guadalajara', 'Chivas', 'chivas'),
    ('chivas-guadalajara', 'Guadalajara', 'guadalajara'),
    ('pumas-unam', 'Pumas UNAM', 'pumas unam'),
    ('pumas-unam', 'Pumas', 'pumas'),
    ('cruz-azul', 'Cruz Azul', 'cruz azul'),
    ('manchester-city', 'Manchester City', 'manchester city'),
    ('manchester-city', 'Man City', 'man city'),
    ('liverpool', 'Liverpool', 'liverpool'),
    ('real-madrid', 'Real Madrid', 'real madrid'),
    ('barcelona', 'Barcelona', 'barcelona'),
    ('inter-milan', 'Inter Milan', 'inter milan'),
    ('inter-milan', 'Inter', 'inter'),
    ('juventus', 'Juventus', 'juventus'),
    ('bayern-munich', 'Bayern Munich', 'bayern munich'),
    ('bayern-munich', 'Bayern', 'bayern'),
    ('borussia-dortmund', 'Borussia Dortmund', 'borussia dortmund'),
    ('borussia-dortmund', 'Dortmund', 'dortmund'),
    ('paris-saint-germain', 'Paris Saint-Germain', 'paris saint germain'),
    ('paris-saint-germain', 'PSG', 'psg'),
    ('marseille', 'Marseille', 'marseille'),
    ('inter-miami', 'Inter Miami', 'inter miami'),
    ('la-galaxy', 'LA Galaxy', 'la galaxy')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'sample-soccer-local'
ON CONFLICT (source_id, normalized_alias) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN (
  VALUES
    ('club-america', 'Club America', 'club america'),
    ('club-america', 'America', 'america'),
    ('club-america', 'Las Aguilas', 'las aguilas'),
    ('chivas-guadalajara', 'Chivas Guadalajara', 'chivas guadalajara'),
    ('chivas-guadalajara', 'Chivas', 'chivas'),
    ('chivas-guadalajara', 'Guadalajara', 'guadalajara'),
    ('pumas-unam', 'Pumas UNAM', 'pumas unam'),
    ('pumas-unam', 'Pumas', 'pumas'),
    ('cruz-azul', 'Cruz Azul', 'cruz azul'),
    ('manchester-city', 'Manchester City', 'manchester city'),
    ('manchester-city', 'Man City', 'man city'),
    ('liverpool', 'Liverpool', 'liverpool'),
    ('real-madrid', 'Real Madrid', 'real madrid'),
    ('barcelona', 'Barcelona', 'barcelona')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'espn-mexico'
ON CONFLICT (source_id, normalized_alias) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN (
  VALUES
    ('club-america', 'Club America', 'club america'),
    ('club-america', 'Club América', 'club america'),
    ('club-america', 'America', 'america'),
    ('club-america', 'América', 'america'),
    ('chivas-guadalajara', 'Chivas Guadalajara', 'chivas guadalajara'),
    ('chivas-guadalajara', 'Guadalajara', 'guadalajara'),
    ('pumas-unam', 'Pumas UNAM', 'pumas unam'),
    ('pumas-unam', 'Pumas', 'pumas'),
    ('cruz-azul', 'Cruz Azul', 'cruz azul'),
    ('manchester-city', 'Manchester City', 'manchester city'),
    ('manchester-city', 'Man City', 'man city'),
    ('liverpool', 'Liverpool', 'liverpool'),
    ('real-madrid', 'Real Madrid', 'real madrid'),
    ('barcelona', 'Barcelona', 'barcelona'),
    ('inter-milan', 'Inter Milan', 'inter milan'),
    ('inter-milan', 'Internazionale', 'internazionale'),
    ('juventus', 'Juventus', 'juventus'),
    ('bayern-munich', 'Bayern Munich', 'bayern munich'),
    ('borussia-dortmund', 'Borussia Dortmund', 'borussia dortmund'),
    ('paris-saint-germain', 'Paris Saint-Germain', 'paris saint germain'),
    ('paris-saint-germain', 'PSG', 'psg'),
    ('inter-miami', 'Inter Miami CF', 'inter miami cf'),
    ('inter-miami', 'Inter Miami', 'inter miami'),
    ('la-galaxy', 'LA Galaxy', 'la galaxy')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'sportsapi'
ON CONFLICT (source_id, normalized_alias) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT target_ds.id, sta.team_id, sta.alias, sta.normalized_alias
FROM source_team_aliases sta
JOIN data_sources source_ds ON source_ds.id = sta.source_id
JOIN data_sources target_ds ON target_ds.slug = 'sportsapi'
WHERE source_ds.slug IN ('espn-mlb', 'espn-mexico', 'sample-soccer-local')
ON CONFLICT (source_id, normalized_alias) DO NOTHING;

WITH league AS (
  SELECT l.id AS league_id, s.id AS season_id
  FROM leagues l
  JOIN seasons s ON s.league_id = l.id AND s.year = '2026'
  WHERE l.slug = 'mlb'
),
inserted_match AS (
  INSERT INTO matches (league_id, season_id, slug, match_date, status, home_score, away_score)
  SELECT league_id, season_id, '2026-05-25-boston-red-sox-new-york-yankees', '2026-05-25T23:05:00Z', 'scheduled', NULL, NULL
  FROM league
  ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
  RETURNING id
)
INSERT INTO match_competitors (match_id, team_id, home_away)
SELECT im.id, t.id, side.home_away::home_away
FROM inserted_match im
JOIN (
  VALUES
    ('boston-red-sox', 'home'),
    ('new-york-yankees', 'away')
) AS side(team_slug, home_away) ON TRUE
JOIN teams t ON t.slug = side.team_slug
ON CONFLICT (match_id, team_id) DO NOTHING;

WITH league AS (
  SELECT l.id AS league_id, s.id AS season_id
  FROM leagues l
  JOIN seasons s ON s.league_id = l.id AND s.year = '2026'
  WHERE l.slug = 'liga-mx'
),
inserted_match AS (
  INSERT INTO matches (league_id, season_id, slug, match_date, status, period, home_score, away_score, raw_data)
  SELECT
    league_id,
    season_id,
    '2026-05-25-sample-soccer-ligamx-001',
    '2026-05-25T20:00:00Z',
    'live',
    '65''',
    2,
    1,
    '{"source":"seed","source_match_id":"sample-soccer-ligamx-001"}'::jsonb
  FROM league
  ON CONFLICT (slug) DO UPDATE SET
    status = EXCLUDED.status,
    period = EXCLUDED.period,
    home_score = EXCLUDED.home_score,
    away_score = EXCLUDED.away_score,
    raw_data = EXCLUDED.raw_data
  RETURNING id
)
INSERT INTO match_competitors (match_id, team_id, home_away, score)
SELECT im.id, t.id, side.home_away::home_away, side.score
FROM inserted_match im
JOIN (
  VALUES
    ('club-america', 'home', 2),
    ('chivas-guadalajara', 'away', 1)
) AS side(team_slug, home_away, score) ON TRUE
JOIN teams t ON t.slug = side.team_slug
ON CONFLICT (match_id, team_id) DO UPDATE SET
  home_away = EXCLUDED.home_away,
  score = EXCLUDED.score;
