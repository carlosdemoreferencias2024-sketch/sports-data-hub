INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('bosnia-and-herzegovina-national-team', 'Bosnia and Herzegovina', 'Bosnia and Herzegovina', 'BIH'),
    ('switzerland-national-team', 'Switzerland', 'Switzerland', 'SUI'),
    ('morocco-national-team', 'Morocco', 'Morocco', 'MAR'),
    ('scotland-national-team', 'Scotland', 'Scotland', 'SCO'),
    ('haiti-national-team', 'Haiti', 'Haiti', 'HAI'),
    ('curacao-national-team', 'Curacao', 'Curacao', 'CUW'),
    ('ivory-coast-national-team', 'Ivory Coast', 'Ivory Coast', 'CIV'),
    ('ecuador-national-team', 'Ecuador', 'Ecuador', 'ECU'),
    ('sweden-national-team', 'Sweden', 'Sweden', 'SWE'),
    ('tunisia-national-team', 'Tunisia', 'Tunisia', 'TUN'),
    ('paraguay-national-team', 'Paraguay', 'Paraguay', 'PAR'),
    ('australia-national-team', 'Australia', 'Australia', 'AUS'),
    ('turkey-national-team', 'Turkey', 'Turkey', 'TUR')
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
    ('bosnia-and-herzegovina-national-team', 'Bosnia and Herzegovina', 'bosnia and herzegovina'),
    ('bosnia-and-herzegovina-national-team', 'Bosnia y Herzegovina', 'bosnia y herzegovina'),
    ('switzerland-national-team', 'Switzerland', 'switzerland'),
    ('switzerland-national-team', 'Suiza', 'suiza'),
    ('morocco-national-team', 'Morocco', 'morocco'),
    ('morocco-national-team', 'Marruecos', 'marruecos'),
    ('scotland-national-team', 'Scotland', 'scotland'),
    ('scotland-national-team', 'Escocia', 'escocia'),
    ('haiti-national-team', 'Haiti', 'haiti'),
    ('curacao-national-team', 'Curacao', 'curacao'),
    ('ivory-coast-national-team', 'Ivory Coast', 'ivory coast'),
    ('ivory-coast-national-team', 'Costa de Marfil', 'costa de marfil'),
    ('ecuador-national-team', 'Ecuador', 'ecuador'),
    ('sweden-national-team', 'Sweden', 'sweden'),
    ('sweden-national-team', 'Suecia', 'suecia'),
    ('tunisia-national-team', 'Tunisia', 'tunisia'),
    ('tunisia-national-team', 'Túnez', 'tunez'),
    ('paraguay-national-team', 'Paraguay', 'paraguay'),
    ('australia-national-team', 'Australia', 'australia'),
    ('turkey-national-team', 'Turkey', 'turkey'),
    ('turkey-national-team', 'Turquía', 'turquia'),
    ('canada-national-team', 'Canada', 'canada'),
    ('brazil-national-team', 'Brazil', 'brazil'),
    ('brazil-national-team', 'Brasil', 'brasil')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'espn-fifa-world-cup-2026'
ON CONFLICT (source_id, normalized_alias) DO UPDATE SET
  team_id = EXCLUDED.team_id,
  alias = EXCLUDED.alias;
