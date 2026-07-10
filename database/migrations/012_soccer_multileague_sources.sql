INSERT INTO data_sources (slug, name, base_url, source_type)
VALUES
  ('espn-premier-league', 'ESPN Soccer Results - Premier League', 'https://www.espn.com.mx/futbol/resultados/_/liga/eng.1', 'scraper'),
  ('espn-la-liga', 'ESPN Soccer Results - La Liga', 'https://www.espn.com.mx/futbol/resultados/_/liga/esp.1', 'scraper'),
  ('espn-serie-a', 'ESPN Soccer Results - Serie A', 'https://www.espn.com.mx/futbol/resultados/_/liga/ita.1', 'scraper'),
  ('espn-bundesliga', 'ESPN Soccer Results - Bundesliga', 'https://www.espn.com.mx/futbol/resultados/_/liga/ger.1', 'scraper'),
  ('espn-ligue-1', 'ESPN Soccer Results - Ligue 1', 'https://www.espn.com.mx/futbol/resultados/_/liga/fra.1', 'scraper'),
  ('espn-mls', 'ESPN Soccer Results - MLS', 'https://www.espn.com.mx/futbol/resultados/_/liga/usa.1', 'scraper'),
  ('espn-uefa-champions-league', 'ESPN Soccer Results - UEFA Champions League', 'https://www.espn.com.mx/futbol/resultados/_/liga/uefa.champions', 'scraper')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  base_url = EXCLUDED.base_url,
  source_type = EXCLUDED.source_type,
  is_active = TRUE,
  updated_at = NOW();

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT target_ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources target_ds
JOIN (
  VALUES
    ('espn-premier-league', 'manchester-city', 'Manchester City', 'manchester city'),
    ('espn-premier-league', 'manchester-city', 'Man City', 'man city'),
    ('espn-premier-league', 'liverpool', 'Liverpool', 'liverpool'),
    ('espn-la-liga', 'real-madrid', 'Real Madrid', 'real madrid'),
    ('espn-la-liga', 'barcelona', 'Barcelona', 'barcelona'),
    ('espn-serie-a', 'inter-milan', 'Inter Milan', 'inter milan'),
    ('espn-serie-a', 'inter-milan', 'Internazionale', 'internazionale'),
    ('espn-serie-a', 'juventus', 'Juventus', 'juventus'),
    ('espn-bundesliga', 'bayern-munich', 'Bayern Munich', 'bayern munich'),
    ('espn-bundesliga', 'bayern-munich', 'Bayern', 'bayern'),
    ('espn-bundesliga', 'borussia-dortmund', 'Borussia Dortmund', 'borussia dortmund'),
    ('espn-bundesliga', 'borussia-dortmund', 'Dortmund', 'dortmund'),
    ('espn-ligue-1', 'paris-saint-germain', 'Paris Saint-Germain', 'paris saint germain'),
    ('espn-ligue-1', 'paris-saint-germain', 'PSG', 'psg'),
    ('espn-ligue-1', 'marseille', 'Marseille', 'marseille'),
    ('espn-mls', 'inter-miami', 'Inter Miami CF', 'inter miami cf'),
    ('espn-mls', 'inter-miami', 'Inter Miami', 'inter miami'),
    ('espn-mls', 'la-galaxy', 'LA Galaxy', 'la galaxy'),
    ('espn-uefa-champions-league', 'ucl-real-madrid', 'Real Madrid', 'real madrid'),
    ('espn-uefa-champions-league', 'ucl-manchester-city', 'Manchester City', 'manchester city'),
    ('espn-uefa-champions-league', 'ucl-manchester-city', 'Man City', 'man city')
) AS alias(source_slug, team_slug, alias, normalized_alias) ON alias.source_slug = target_ds.slug
JOIN teams t ON t.slug = alias.team_slug
ON CONFLICT (source_id, normalized_alias) DO NOTHING;
