-- Safe alias patch for ESPN LaLiga scraper gaps.
-- Adds only team identity/alias rows; no picks, odds, settlement, or real-money state.

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('la-liga', 'deportivo-alaves', 'Deportivo Alaves', 'Alaves', 'ALA'),
    ('la-liga', 'rayo-vallecano', 'Rayo Vallecano', 'Rayo', 'RAY')
) AS team(league_slug, slug, name, short_name, abbreviation) ON team.league_slug = l.slug
ON CONFLICT (slug) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN (
  VALUES
    ('espn-la-liga', 'deportivo-alaves', 'Alaves', 'alaves'),
    ('espn-la-liga', 'deportivo-alaves', 'Alaves', 'alaves'),
    ('espn-la-liga', 'deportivo-alaves', 'Deportivo Alaves', 'deportivo alaves'),
    ('espn-la-liga', 'deportivo-alaves', 'Deportivo Alaves', 'deportivo alaves'),
    ('espn-la-liga', 'rayo-vallecano', 'Rayo Vallecano', 'rayo vallecano'),
    ('espn-la-liga', 'rayo-vallecano', 'Rayo', 'rayo'),
    ('espn-la-liga', 'rayo-vallecano', 'Rayo V.', 'rayo v'),
    ('espn-la-liga', 'rayo-vallecano', 'Vallecano', 'vallecano')
) AS alias(source_slug, team_slug, alias, normalized_alias) ON alias.source_slug = ds.slug
JOIN teams t ON t.slug = alias.team_slug
ON CONFLICT (source_id, normalized_alias) DO NOTHING;
