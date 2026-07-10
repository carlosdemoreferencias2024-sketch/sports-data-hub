INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('cape-verde-national-team', 'Cape Verde', 'Cape Verde', 'CPV'),
    ('egypt-national-team', 'Egypt', 'Egypt', 'EGY'),
    ('new-zealand-national-team', 'New Zealand', 'New Zealand', 'NZL')
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
    ('cape-verde-national-team', 'Cape Verde', 'cape verde'),
    ('cape-verde-national-team', 'Cabo Verde', 'cabo verde'),
    ('egypt-national-team', 'Egypt', 'egypt'),
    ('egypt-national-team', 'Egipto', 'egipto'),
    ('new-zealand-national-team', 'New Zealand', 'new zealand'),
    ('new-zealand-national-team', 'Nueva Zelanda', 'nueva zelanda')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'espn-fifa-world-cup-2026'
ON CONFLICT (source_id, normalized_alias) DO UPDATE SET
  team_id = EXCLUDED.team_id,
  alias = EXCLUDED.alias;
