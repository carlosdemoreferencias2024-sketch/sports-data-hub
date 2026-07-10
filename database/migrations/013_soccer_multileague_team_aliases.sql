INSERT INTO teams (league_id, slug, name, short_name, abbreviation)
SELECT l.id, team.slug, team.name, team.short_name, team.abbreviation
FROM leagues l
JOIN (
  VALUES
    ('liga-mx', 'monterrey', 'Monterrey', 'Monterrey', 'MTY'),
    ('liga-mx', 'tigres-uanl', 'Tigres UANL', 'Tigres', 'TIG'),
    ('liga-mx', 'toluca', 'Toluca', 'Toluca', 'TOL'),
    ('liga-mx', 'club-leon', 'Club Leon', 'Leon', 'LEO'),
    ('liga-mx', 'pachuca', 'Pachuca', 'Pachuca', 'PAC'),
    ('liga-mx', 'atlas', 'Atlas', 'Atlas', 'ATL'),
    ('premier-league', 'arsenal', 'Arsenal', 'Arsenal', 'ARS'),
    ('premier-league', 'chelsea', 'Chelsea', 'Chelsea', 'CHE'),
    ('premier-league', 'manchester-united', 'Manchester United', 'Man United', 'MUN'),
    ('premier-league', 'tottenham-hotspur', 'Tottenham Hotspur', 'Tottenham', 'TOT'),
    ('premier-league', 'newcastle-united', 'Newcastle United', 'Newcastle', 'NEW'),
    ('premier-league', 'aston-villa', 'Aston Villa', 'Aston Villa', 'AVL'),
    ('la-liga', 'atletico-madrid', 'Atletico Madrid', 'Atletico', 'ATM'),
    ('la-liga', 'sevilla', 'Sevilla', 'Sevilla', 'SEV'),
    ('la-liga', 'villarreal', 'Villarreal', 'Villarreal', 'VIL'),
    ('la-liga', 'athletic-club', 'Athletic Club', 'Athletic', 'ATH'),
    ('serie-a', 'ac-milan', 'AC Milan', 'Milan', 'MIL'),
    ('serie-a', 'napoli', 'Napoli', 'Napoli', 'NAP'),
    ('serie-a', 'roma', 'Roma', 'Roma', 'ROM'),
    ('serie-a', 'lazio', 'Lazio', 'Lazio', 'LAZ'),
    ('serie-a', 'atalanta', 'Atalanta', 'Atalanta', 'ATA'),
    ('bundesliga', 'bayer-leverkusen', 'Bayer Leverkusen', 'Leverkusen', 'B04'),
    ('bundesliga', 'rb-leipzig', 'RB Leipzig', 'RB Leipzig', 'RBL'),
    ('bundesliga', 'eintracht-frankfurt', 'Eintracht Frankfurt', 'Frankfurt', 'SGE'),
    ('ligue-1', 'lyon', 'Lyon', 'Lyon', 'LYO'),
    ('ligue-1', 'monaco', 'Monaco', 'Monaco', 'ASM'),
    ('ligue-1', 'lille', 'Lille', 'Lille', 'LIL'),
    ('mls', 'columbus-crew', 'Columbus Crew', 'Columbus', 'CLB'),
    ('mls', 'atlanta-united', 'Atlanta United FC', 'Atlanta', 'ATL'),
    ('mls', 'philadelphia-union', 'Philadelphia Union', 'Philadelphia', 'PHI'),
    ('mls', 'lafc', 'LAFC', 'LAFC', 'LAFC'),
    ('mls', 'seattle-sounders', 'Seattle Sounders FC', 'Seattle', 'SEA')
) AS team(league_slug, slug, name, short_name, abbreviation) ON team.league_slug = l.slug
ON CONFLICT (slug) DO NOTHING;

INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
SELECT ds.id, t.id, alias.alias, alias.normalized_alias
FROM data_sources ds
JOIN (
  VALUES
    ('espn-mexico', 'monterrey', 'Monterrey', 'monterrey'),
    ('espn-mexico', 'tigres-uanl', 'Tigres UANL', 'tigres uanl'),
    ('espn-mexico', 'tigres-uanl', 'Tigres', 'tigres'),
    ('espn-mexico', 'toluca', 'Toluca', 'toluca'),
    ('espn-mexico', 'club-leon', 'Leon', 'leon'),
    ('espn-mexico', 'club-leon', 'Club Leon', 'club leon'),
    ('espn-mexico', 'pachuca', 'Pachuca', 'pachuca'),
    ('espn-mexico', 'atlas', 'Atlas', 'atlas'),
    ('espn-premier-league', 'arsenal', 'Arsenal', 'arsenal'),
    ('espn-premier-league', 'chelsea', 'Chelsea', 'chelsea'),
    ('espn-premier-league', 'manchester-united', 'Manchester United', 'manchester united'),
    ('espn-premier-league', 'manchester-united', 'Man United', 'man united'),
    ('espn-premier-league', 'tottenham-hotspur', 'Tottenham Hotspur', 'tottenham hotspur'),
    ('espn-premier-league', 'tottenham-hotspur', 'Tottenham', 'tottenham'),
    ('espn-premier-league', 'newcastle-united', 'Newcastle United', 'newcastle united'),
    ('espn-premier-league', 'newcastle-united', 'Newcastle', 'newcastle'),
    ('espn-premier-league', 'aston-villa', 'Aston Villa', 'aston villa'),
    ('espn-la-liga', 'atletico-madrid', 'Atletico Madrid', 'atletico madrid'),
    ('espn-la-liga', 'atletico-madrid', 'Atletico', 'atletico'),
    ('espn-la-liga', 'sevilla', 'Sevilla', 'sevilla'),
    ('espn-la-liga', 'villarreal', 'Villarreal', 'villarreal'),
    ('espn-la-liga', 'athletic-club', 'Athletic Club', 'athletic club'),
    ('espn-la-liga', 'athletic-club', 'Athletic', 'athletic'),
    ('espn-serie-a', 'ac-milan', 'AC Milan', 'ac milan'),
    ('espn-serie-a', 'ac-milan', 'Milan', 'milan'),
    ('espn-serie-a', 'napoli', 'Napoli', 'napoli'),
    ('espn-serie-a', 'roma', 'Roma', 'roma'),
    ('espn-serie-a', 'lazio', 'Lazio', 'lazio'),
    ('espn-serie-a', 'atalanta', 'Atalanta', 'atalanta'),
    ('espn-bundesliga', 'bayer-leverkusen', 'Bayer Leverkusen', 'bayer leverkusen'),
    ('espn-bundesliga', 'bayer-leverkusen', 'Leverkusen', 'leverkusen'),
    ('espn-bundesliga', 'rb-leipzig', 'RB Leipzig', 'rb leipzig'),
    ('espn-bundesliga', 'eintracht-frankfurt', 'Eintracht Frankfurt', 'eintracht frankfurt'),
    ('espn-bundesliga', 'eintracht-frankfurt', 'Frankfurt', 'frankfurt'),
    ('espn-ligue-1', 'lyon', 'Lyon', 'lyon'),
    ('espn-ligue-1', 'monaco', 'Monaco', 'monaco'),
    ('espn-ligue-1', 'lille', 'Lille', 'lille'),
    ('espn-mls', 'columbus-crew', 'Columbus Crew', 'columbus crew'),
    ('espn-mls', 'atlanta-united', 'Atlanta United FC', 'atlanta united fc'),
    ('espn-mls', 'atlanta-united', 'Atlanta United', 'atlanta united'),
    ('espn-mls', 'philadelphia-union', 'Philadelphia Union', 'philadelphia union'),
    ('espn-mls', 'lafc', 'LAFC', 'lafc'),
    ('espn-mls', 'seattle-sounders', 'Seattle Sounders FC', 'seattle sounders fc'),
    ('espn-mls', 'seattle-sounders', 'Seattle Sounders', 'seattle sounders')
) AS alias(source_slug, team_slug, alias, normalized_alias) ON alias.source_slug = ds.slug
JOIN teams t ON t.slug = alias.team_slug
ON CONFLICT (source_id, normalized_alias) DO NOTHING;
