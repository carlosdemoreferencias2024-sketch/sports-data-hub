INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('senegal-national-team', 'Senegal', 'Senegal', 'SEN'),
    ('iraq-national-team', 'Iraq', 'Iraq', 'IRQ'),
    ('algeria-national-team', 'Algeria', 'Algeria', 'ALG'),
    ('austria-national-team', 'Austria', 'Austria', 'AUT'),
    ('norway-national-team', 'Norway', 'Norway', 'NOR'),
    ('jordan-national-team', 'Jordan', 'Jordan', 'JOR')
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
    ('senegal-national-team', 'Senegal', 'senegal'),
    ('iraq-national-team', 'Iraq', 'iraq'),
    ('iraq-national-team', 'Irak', 'irak'),
    ('algeria-national-team', 'Algeria', 'algeria'),
    ('algeria-national-team', 'Argelia', 'argelia'),
    ('austria-national-team', 'Austria', 'austria'),
    ('norway-national-team', 'Norway', 'norway'),
    ('norway-national-team', 'Noruega', 'noruega'),
    ('jordan-national-team', 'Jordan', 'jordan'),
    ('jordan-national-team', 'Jordania', 'jordania')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'espn-fifa-world-cup-2026'
ON CONFLICT (source_id, normalized_alias) DO UPDATE SET
  team_id = EXCLUDED.team_id,
  alias = EXCLUDED.alias;
