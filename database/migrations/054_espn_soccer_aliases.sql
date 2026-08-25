BEGIN;

-- Team identity only. This migration does not create odds, picks, or tickets.
INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT league.id, 'getafe', 'Getafe', 'Getafe', 'GET'
FROM leagues league
WHERE league.slug = 'la-liga'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT source.id, team.id, mapping.alias, mapping.normalized_alias
FROM (
  VALUES
    ('espn-mexico', 'liga-mx-fc-juarez', 'FC Juarez', 'fc juarez'),
    ('espn-mls', 'mls-new-york-red-bulls', 'Red Bull New York', 'red bull new york'),
    ('espn-mls', 'mls-dc-united', 'D.C. United', 'd c united'),
    ('espn-mls', 'mls-charlotte', 'Charlotte FC', 'charlotte fc'),
    ('espn-mls', 'mls-orlando-city-sc', 'Orlando City SC', 'orlando city sc'),
    ('espn-mls', 'mls-new-england-revolution', 'New England Revolution', 'new england revolution'),
    ('espn-mls', 'mls-houston-dynamo', 'Houston Dynamo FC', 'houston dynamo fc'),
    ('espn-mls', 'mls-nashville-sc', 'Nashville SC', 'nashville sc'),
    ('espn-mls', 'mls-colorado-rapids', 'Colorado Rapids', 'colorado rapids'),
    ('espn-mls', 'mls-real-salt-lake', 'Real Salt Lake', 'real salt lake'),
    ('espn-mls', 'mls-san-diego', 'San Diego FC', 'san diego fc'),
    ('espn-mls', 'mls-san-jose-earthquakes', 'San Jose Earthquakes', 'san jose earthquakes'),
    ('espn-la-liga', 'getafe', 'Getafe', 'getafe')
) AS mapping(source_slug, team_slug, alias, normalized_alias)
JOIN data_sources source ON source.slug = mapping.source_slug
JOIN teams team ON team.slug = mapping.team_slug
ON CONFLICT (source_id, normalized_alias) DO NOTHING;

COMMIT;
