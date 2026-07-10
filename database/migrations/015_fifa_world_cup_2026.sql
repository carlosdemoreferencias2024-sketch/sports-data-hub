INSERT INTO leagues (sport_id, slug, name, abbreviation, country)
SELECT s.id, 'fifa-world-cup-2026', 'FIFA World Cup 2026', 'FWC26', 'International'
FROM sports s
WHERE s.slug = 'soccer'
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  abbreviation = EXCLUDED.abbreviation,
  country = EXCLUDED.country,
  is_active = TRUE,
  updated_at = NOW();

INSERT INTO seasons (league_id, year, start_date, end_date, is_current)
SELECT l.id, '2026', '2026-06-11', '2026-07-19', TRUE
FROM leagues l
WHERE l.slug = 'fifa-world-cup-2026'
ON CONFLICT (league_id, year) DO UPDATE SET
  start_date = EXCLUDED.start_date,
  end_date = EXCLUDED.end_date,
  is_current = TRUE,
  updated_at = NOW();

INSERT INTO data_sources (slug, name, base_url, source_type)
VALUES (
  'espn-fifa-world-cup-2026',
  'ESPN Soccer Results - FIFA World Cup 2026',
  'https://www.espn.com.mx/futbol/resultados/_/liga/fifa.world',
  'scraper'
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  base_url = EXCLUDED.base_url,
  source_type = EXCLUDED.source_type,
  is_active = TRUE,
  updated_at = NOW();

INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('mexico-national-team', 'Mexico', 'Mexico', 'MEX'),
    ('south-africa-national-team', 'South Africa', 'South Africa', 'RSA'),
    ('south-korea-national-team', 'South Korea', 'South Korea', 'KOR'),
    ('czechia-national-team', 'Czechia', 'Czechia', 'CZE'),
    ('canada-national-team', 'Canada', 'Canada', 'CAN'),
    ('united-states-national-team', 'United States', 'United States', 'USA'),
    ('argentina-national-team', 'Argentina', 'Argentina', 'ARG'),
    ('brazil-national-team', 'Brazil', 'Brazil', 'BRA'),
    ('spain-national-team', 'Spain', 'Spain', 'ESP'),
    ('france-national-team', 'France', 'France', 'FRA'),
    ('england-national-team', 'England', 'England', 'ENG'),
    ('portugal-national-team', 'Portugal', 'Portugal', 'POR'),
    ('germany-national-team', 'Germany', 'Germany', 'GER'),
    ('netherlands-national-team', 'Netherlands', 'Netherlands', 'NED'),
    ('italy-national-team', 'Italy', 'Italy', 'ITA'),
    ('uruguay-national-team', 'Uruguay', 'Uruguay', 'URU'),
    ('colombia-national-team', 'Colombia', 'Colombia', 'COL'),
    ('japan-national-team', 'Japan', 'Japan', 'JPN')
) AS team(slug, name, short_name, abbreviation) ON TRUE
WHERE l.slug = 'fifa-world-cup-2026'
ON CONFLICT (slug) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN (
  VALUES
    ('mexico-national-team', 'Mexico', 'mexico'),
    ('mexico-national-team', 'México', 'mexico'),
    ('south-africa-national-team', 'South Africa', 'south africa'),
    ('south-africa-national-team', 'Sudáfrica', 'sudafrica'),
    ('south-africa-national-team', 'Sudafrica', 'sudafrica'),
    ('south-korea-national-team', 'South Korea', 'south korea'),
    ('south-korea-national-team', 'Corea del Sur', 'corea del sur'),
    ('czechia-national-team', 'Czechia', 'czechia'),
    ('czechia-national-team', 'Chequia', 'chequia'),
    ('canada-national-team', 'Canada', 'canada'),
    ('canada-national-team', 'Canadá', 'canada'),
    ('united-states-national-team', 'United States', 'united states'),
    ('united-states-national-team', 'Estados Unidos', 'estados unidos'),
    ('argentina-national-team', 'Argentina', 'argentina'),
    ('brazil-national-team', 'Brazil', 'brazil'),
    ('brazil-national-team', 'Brasil', 'brasil'),
    ('spain-national-team', 'Spain', 'spain'),
    ('spain-national-team', 'España', 'espana'),
    ('france-national-team', 'France', 'france'),
    ('france-national-team', 'Francia', 'francia'),
    ('england-national-team', 'England', 'england'),
    ('england-national-team', 'Inglaterra', 'inglaterra'),
    ('portugal-national-team', 'Portugal', 'portugal'),
    ('germany-national-team', 'Germany', 'germany'),
    ('germany-national-team', 'Alemania', 'alemania'),
    ('netherlands-national-team', 'Netherlands', 'netherlands'),
    ('netherlands-national-team', 'Países Bajos', 'paises bajos'),
    ('netherlands-national-team', 'Paises Bajos', 'paises bajos'),
    ('italy-national-team', 'Italy', 'italy'),
    ('italy-national-team', 'Italia', 'italia'),
    ('uruguay-national-team', 'Uruguay', 'uruguay'),
    ('colombia-national-team', 'Colombia', 'colombia'),
    ('japan-national-team', 'Japan', 'japan'),
    ('japan-national-team', 'Japón', 'japon')
) AS alias(team_slug, alias, normalized_alias) ON TRUE
JOIN teams t ON t.slug = alias.team_slug
WHERE ds.slug = 'espn-fifa-world-cup-2026'
ON CONFLICT (source_id, normalized_alias) DO NOTHING;
