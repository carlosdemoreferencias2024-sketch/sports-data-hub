INSERT INTO data_sources (slug, name, base_url, source_type)
VALUES (
  'espn-nfl',
  'ESPN NFL Site API',
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl',
  'api'
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  base_url = EXCLUDED.base_url,
  source_type = EXCLUDED.source_type;

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('arizona-cardinals', 'Arizona Cardinals', 'Cardinals', 'ARI'),
    ('atlanta-falcons', 'Atlanta Falcons', 'Falcons', 'ATL'),
    ('baltimore-ravens', 'Baltimore Ravens', 'Ravens', 'BAL'),
    ('buffalo-bills', 'Buffalo Bills', 'Bills', 'BUF'),
    ('carolina-panthers', 'Carolina Panthers', 'Panthers', 'CAR'),
    ('chicago-bears', 'Chicago Bears', 'Bears', 'CHI'),
    ('cincinnati-bengals', 'Cincinnati Bengals', 'Bengals', 'CIN'),
    ('cleveland-browns', 'Cleveland Browns', 'Browns', 'CLE'),
    ('dallas-cowboys', 'Dallas Cowboys', 'Cowboys', 'DAL'),
    ('denver-broncos', 'Denver Broncos', 'Broncos', 'DEN'),
    ('detroit-lions', 'Detroit Lions', 'Lions', 'DET'),
    ('green-bay-packers', 'Green Bay Packers', 'Packers', 'GB'),
    ('houston-texans', 'Houston Texans', 'Texans', 'HOU'),
    ('indianapolis-colts', 'Indianapolis Colts', 'Colts', 'IND'),
    ('jacksonville-jaguars', 'Jacksonville Jaguars', 'Jaguars', 'JAX'),
    ('kansas-city-chiefs', 'Kansas City Chiefs', 'Chiefs', 'KC'),
    ('las-vegas-raiders', 'Las Vegas Raiders', 'Raiders', 'LV'),
    ('los-angeles-chargers', 'Los Angeles Chargers', 'Chargers', 'LAC'),
    ('los-angeles-rams', 'Los Angeles Rams', 'Rams', 'LAR'),
    ('miami-dolphins', 'Miami Dolphins', 'Dolphins', 'MIA'),
    ('minnesota-vikings', 'Minnesota Vikings', 'Vikings', 'MIN'),
    ('new-england-patriots', 'New England Patriots', 'Patriots', 'NE'),
    ('new-orleans-saints', 'New Orleans Saints', 'Saints', 'NO'),
    ('new-york-giants', 'New York Giants', 'Giants', 'NYG'),
    ('new-york-jets', 'New York Jets', 'Jets', 'NYJ'),
    ('philadelphia-eagles', 'Philadelphia Eagles', 'Eagles', 'PHI'),
    ('pittsburgh-steelers', 'Pittsburgh Steelers', 'Steelers', 'PIT'),
    ('san-francisco-49ers', 'San Francisco 49ers', '49ers', 'SF'),
    ('seattle-seahawks', 'Seattle Seahawks', 'Seahawks', 'SEA'),
    ('tampa-bay-buccaneers', 'Tampa Bay Buccaneers', 'Buccaneers', 'TB'),
    ('tennessee-titans', 'Tennessee Titans', 'Titans', 'TEN'),
    ('washington-commanders', 'Washington Commanders', 'Commanders', 'WSH')
) AS team(slug, name, short_name, abbreviation) ON TRUE
WHERE l.slug = 'nfl'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN teams t ON t.league_id = (SELECT id FROM leagues WHERE slug = 'nfl')
CROSS JOIN LATERAL (
  VALUES
    (t.name, lower(regexp_replace(t.name, '[^A-Za-z0-9]+', ' ', 'g'))),
    (t.short_name, lower(regexp_replace(t.short_name, '[^A-Za-z0-9]+', ' ', 'g'))),
    (t.abbreviation, lower(regexp_replace(t.abbreviation, '[^A-Za-z0-9]+', ' ', 'g')))
) AS alias(alias, normalized_alias)
WHERE ds.slug = 'espn-nfl'
ON CONFLICT (source_id, normalized_alias) DO UPDATE SET
  team_id = EXCLUDED.team_id,
  alias = EXCLUDED.alias;
