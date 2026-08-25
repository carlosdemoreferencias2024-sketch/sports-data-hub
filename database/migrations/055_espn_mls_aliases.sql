BEGIN;

-- Provider identity mappings only; no odds, picks, or tickets.
INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT source.id, team.id, mapping.alias, mapping.normalized_alias
FROM (
  VALUES
    ('espn-mls', 'mls-fc-cincinnati', 'FC Cincinnati', 'fc cincinnati'),
    ('espn-mls', 'mls-minnesota-united-fc', 'Minnesota United FC', 'minnesota united fc')
) AS mapping(source_slug, team_slug, alias, normalized_alias)
JOIN data_sources source ON source.slug = mapping.source_slug
JOIN teams team ON team.slug = mapping.team_slug
ON CONFLICT (source_id, normalized_alias) DO NOTHING;

COMMIT;
