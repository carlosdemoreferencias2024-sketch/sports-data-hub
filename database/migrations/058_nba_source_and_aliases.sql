INSERT INTO data_sources (slug, name, base_url, source_type)
VALUES (
  'espn-nba',
  'ESPN NBA Site API',
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba',
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
    ('atlanta-hawks', 'Atlanta Hawks', 'Hawks', 'ATL'),
    ('boston-celtics', 'Boston Celtics', 'Celtics', 'BOS'),
    ('brooklyn-nets', 'Brooklyn Nets', 'Nets', 'BKN'),
    ('charlotte-hornets', 'Charlotte Hornets', 'Hornets', 'CHA'),
    ('chicago-bulls', 'Chicago Bulls', 'Bulls', 'CHI'),
    ('cleveland-cavaliers', 'Cleveland Cavaliers', 'Cavaliers', 'CLE'),
    ('dallas-mavericks', 'Dallas Mavericks', 'Mavericks', 'DAL'),
    ('denver-nuggets', 'Denver Nuggets', 'Nuggets', 'DEN'),
    ('detroit-pistons', 'Detroit Pistons', 'Pistons', 'DET'),
    ('golden-state-warriors', 'Golden State Warriors', 'Warriors', 'GS'),
    ('houston-rockets', 'Houston Rockets', 'Rockets', 'HOU'),
    ('indiana-pacers', 'Indiana Pacers', 'Pacers', 'IND'),
    ('la-clippers', 'LA Clippers', 'Clippers', 'LAC'),
    ('los-angeles-lakers', 'Los Angeles Lakers', 'Lakers', 'LAL'),
    ('memphis-grizzlies', 'Memphis Grizzlies', 'Grizzlies', 'MEM'),
    ('miami-heat', 'Miami Heat', 'Heat', 'MIA'),
    ('milwaukee-bucks', 'Milwaukee Bucks', 'Bucks', 'MIL'),
    ('minnesota-timberwolves', 'Minnesota Timberwolves', 'Timberwolves', 'MIN'),
    ('new-orleans-pelicans', 'New Orleans Pelicans', 'Pelicans', 'NO'),
    ('new-york-knicks', 'New York Knicks', 'Knicks', 'NY'),
    ('oklahoma-city-thunder', 'Oklahoma City Thunder', 'Thunder', 'OKC'),
    ('orlando-magic', 'Orlando Magic', 'Magic', 'ORL'),
    ('philadelphia-76ers', 'Philadelphia 76ers', '76ers', 'PHI'),
    ('phoenix-suns', 'Phoenix Suns', 'Suns', 'PHX'),
    ('portland-trail-blazers', 'Portland Trail Blazers', 'Trail Blazers', 'POR'),
    ('sacramento-kings', 'Sacramento Kings', 'Kings', 'SAC'),
    ('san-antonio-spurs', 'San Antonio Spurs', 'Spurs', 'SA'),
    ('toronto-raptors', 'Toronto Raptors', 'Raptors', 'TOR'),
    ('utah-jazz', 'Utah Jazz', 'Jazz', 'UTAH'),
    ('washington-wizards', 'Washington Wizards', 'Wizards', 'WSH')
) AS team(slug, name, short_name, abbreviation) ON TRUE
WHERE l.slug = 'nba'
ON CONFLICT (slug) DO UPDATE SET
  league_id = EXCLUDED.league_id,
  name = EXCLUDED.name,
  short_name = EXCLUDED.short_name,
  abbreviation = EXCLUDED.abbreviation;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN teams t ON t.league_id = (SELECT id FROM leagues WHERE slug = 'nba')
CROSS JOIN LATERAL (
  VALUES
    (t.name, lower(regexp_replace(t.name, '[^A-Za-z0-9]+', ' ', 'g'))),
    (t.short_name, lower(regexp_replace(t.short_name, '[^A-Za-z0-9]+', ' ', 'g'))),
    (t.abbreviation, lower(regexp_replace(t.abbreviation, '[^A-Za-z0-9]+', ' ', 'g')))
) AS alias(alias, normalized_alias)
WHERE ds.slug = 'espn-nba'
ON CONFLICT (source_id, normalized_alias) DO UPDATE SET
  team_id = EXCLUDED.team_id,
  alias = EXCLUDED.alias;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, 'Los Angeles Clippers', 'los angeles clippers'
FROM data_sources ds
JOIN teams t ON t.slug = 'la-clippers'
WHERE ds.slug = 'espn-nba'
ON CONFLICT (source_id, normalized_alias) DO UPDATE SET
  team_id = EXCLUDED.team_id,
  alias = EXCLUDED.alias;
