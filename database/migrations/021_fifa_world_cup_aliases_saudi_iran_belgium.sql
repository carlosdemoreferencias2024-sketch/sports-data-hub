INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('saudi-arabia-national-team', 'Saudi Arabia', 'Saudi Arabia', 'KSA'),
    ('iran-national-team', 'Iran', 'Iran', 'IRN'),
    ('belgium-national-team', 'Belgium', 'Belgium', 'BEL')
) AS team(slug, name, short_name, abbreviation) ON TRUE
WHERE l.slug = 'fifa-world-cup-2026'
ON CONFLICT (slug) DO UPDATE SET
  league_id = EXCLUDED.league_id,
  name = EXCLUDED.name,
  short_name = EXCLUDED.short_name,
  abbreviation = EXCLUDED.abbreviation,
  updated_at = NOW();

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN (
  VALUES
    ('saudi-arabia-national-team', 'Saudi Arabia', 'saudi arabia'),
    ('saudi-arabia-national-team', 'Arabia Saudita', 'arabia saudita'),
    ('iran-national-team', 'Irán', 'iran'),
    ('belgium-national-team', 'Belgium', 'belgium'),
    ('belgium-national-team', 'Bélgica', 'belgica')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'espn-fifa-world-cup-2026'
ON CONFLICT (source_id, normalized_alias) DO UPDATE SET
  team_id = EXCLUDED.team_id,
  alias = EXCLUDED.alias;
