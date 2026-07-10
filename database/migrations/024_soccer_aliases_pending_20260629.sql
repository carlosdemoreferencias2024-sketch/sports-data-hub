BEGIN;

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, t.slug, t.name, t.short_name, t.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('liga-mx', 'necaxa', 'Necaxa', 'Necaxa', 'NEC'),
    ('liga-mx', 'atlante', 'Atlante', 'Atlante', 'ATL'),
    ('liga-mx', 'tijuana', 'Tijuana', 'Tijuana', 'TIJ'),
    ('mls', 'cf-montreal', 'CF Montreal', 'CF Montreal', 'MTL'),
    ('mls', 'toronto-fc', 'Toronto FC', 'Toronto', 'TOR'),
    ('mls', 'chicago-fire-fc', 'Chicago Fire FC', 'Chicago', 'CHI'),
    ('mls', 'vancouver-whitecaps', 'Vancouver Whitecaps', 'Vancouver', 'VAN'),
    ('mls', 'st-louis-city-sc', 'St. Louis CITY SC', 'St. Louis', 'STL'),
    ('mls', 'sporting-kansas-city', 'Sporting Kansas City', 'Sporting KC', 'SKC'),
    ('mls', 'portland-timbers', 'Portland Timbers', 'Portland', 'POR'),
    ('premier-league', 'coventry-city', 'Coventry City', 'Coventry', 'COV'),
    ('ligue-1', 'le-mans', 'Le Mans', 'Le Mans', 'LEM'),
    ('ligue-1', 'troyes', 'Troyes', 'Troyes', 'TRO')
) AS t(league_slug, slug, name, short_name, abbreviation)
  ON t.league_slug = l.slug
ON CONFLICT (slug) DO UPDATE SET
  league_id = EXCLUDED.league_id,
  name = EXCLUDED.name,
  short_name = EXCLUDED.short_name,
  abbreviation = EXCLUDED.abbreviation;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, tm.id, a.alias, a.normalized_alias
FROM (
  VALUES
    ('espn-mexico', 'necaxa', 'Necaxa', 'necaxa'),
    ('espn-mexico', 'atlante', 'Atlante', 'atlante'),
    ('espn-mexico', 'tijuana', 'Tijuana', 'tijuana'),
    ('espn-mexico', 'tijuana', 'Club Tijuana', 'club tijuana'),
    ('espn-mexico', 'tijuana', 'Xolos', 'xolos'),
    ('espn-mls', 'cf-montreal', 'CF Montreal', 'cf montreal'),
    ('espn-mls', 'cf-montreal', 'Montreal', 'montreal'),
    ('espn-mls', 'toronto-fc', 'Toronto FC', 'toronto fc'),
    ('espn-mls', 'chicago-fire-fc', 'Chicago Fire FC', 'chicago fire fc'),
    ('espn-mls', 'chicago-fire-fc', 'Chicago Fire', 'chicago fire'),
    ('espn-mls', 'vancouver-whitecaps', 'Vancouver Whitecaps', 'vancouver whitecaps'),
    ('espn-mls', 'vancouver-whitecaps', 'Vancouver Whitecaps FC', 'vancouver whitecaps fc'),
    ('espn-mls', 'st-louis-city-sc', 'St. Louis CITY SC', 'st louis city sc'),
    ('espn-mls', 'st-louis-city-sc', 'St. Louis City', 'st louis city'),
    ('espn-mls', 'sporting-kansas-city', 'Sporting Kansas City', 'sporting kansas city'),
    ('espn-mls', 'sporting-kansas-city', 'Sporting KC', 'sporting kc'),
    ('espn-mls', 'portland-timbers', 'Portland Timbers', 'portland timbers'),
    ('espn-premier-league', 'coventry-city', 'Coventry City', 'coventry city'),
    ('espn-ligue-1', 'le-mans', 'Le Mans', 'le mans'),
    ('espn-ligue-1', 'troyes', 'Troyes', 'troyes')
) AS a(source_slug, team_slug, alias, normalized_alias)
JOIN data_sources ds ON ds.slug = a.source_slug
JOIN teams tm ON tm.slug = a.team_slug
ON CONFLICT (source_id, normalized_alias) DO UPDATE SET
  team_id = EXCLUDED.team_id,
  alias = EXCLUDED.alias;

COMMIT;
