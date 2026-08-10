CREATE TABLE IF NOT EXISTS football_competition_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id text UNIQUE NOT NULL,
  canonical_name text NOT NULL,
  display_name text NOT NULL,
  confederation text NOT NULL,
  region text,
  country text,
  competition_type text NOT NULL,
  tier text NOT NULL,
  trust_status text NOT NULL,
  trust_score numeric(6,3) NOT NULL,
  priority_score numeric(8,3) NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  markets_enabled jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_mappings jsonb NOT NULL DEFAULT '{}'::jsonb,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_domestic boolean NOT NULL DEFAULT false,
  is_continental boolean NOT NULL DEFAULT false,
  is_global boolean NOT NULL DEFAULT false,
  is_friendly boolean NOT NULL DEFAULT false,
  manual_only boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (competition_type IN ('domestic_league', 'domestic_cup', 'continental_cup', 'global_cup', 'friendly', 'national_team')),
  CHECK (confederation IN ('CONMEBOL', 'CONCACAF', 'UEFA', 'FIFA', 'AFC', 'CAF', 'OFC', 'OTHER')),
  CHECK (trust_status IN ('TRUSTED', 'WATCH', 'NOISY', 'MANUAL_ONLY', 'BLOCKED')),
  CHECK (tier IN ('TIER_1', 'TIER_2', 'TIER_3', 'WATCH', 'GLOBAL', 'MANUAL_ONLY')),
  CHECK (trust_score >= 0 AND trust_score <= 100)
);

CREATE INDEX IF NOT EXISTS idx_football_competition_registry_confederation
  ON football_competition_registry(confederation, region, country);

CREATE INDEX IF NOT EXISTS idx_football_competition_registry_trust
  ON football_competition_registry(trust_status, tier, priority_score DESC);

CREATE INDEX IF NOT EXISTS idx_football_competition_registry_enabled
  ON football_competition_registry(enabled, priority_score DESC);

WITH seed AS (
  SELECT *
  FROM jsonb_to_recordset($$[
    {"league_id":"fifa-world-cup-2026","canonical_name":"Copa Mundial FIFA","display_name":"Mundial","confederation":"FIFA","region":"Global","country":"Global","competition_type":"global_cup","tier":"TIER_1","trust_status":"TRUSTED","trust_score":90,"priority_score":100,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"provider_mappings":{"manual":"fifa-world-cup-2026"},"aliases":["Mundial","World Cup","FIFA World Cup","Copa del Mundo","Mundial 2026"],"is_global":true},
    {"league_id":"fifa-club-world-cup","canonical_name":"Mundial de Clubes FIFA","display_name":"Mundial de Clubes","confederation":"FIFA","region":"Global","country":"Global","competition_type":"global_cup","tier":"TIER_2","trust_status":"WATCH","trust_score":80,"priority_score":82,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["FIFA Club World Cup","Mundial de Clubes"],"is_global":true},
    {"league_id":"fifa-intercontinental-cup","canonical_name":"Copa Intercontinental FIFA","display_name":"Copa Intercontinental","confederation":"FIFA","region":"Global","country":"Global","competition_type":"global_cup","tier":"TIER_2","trust_status":"WATCH","trust_score":76,"priority_score":78,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["FIFA Intercontinental Cup","Copa Intercontinental"],"is_global":true},
    {"league_id":"international-friendlies","canonical_name":"Amistosos Internacionales","display_name":"Amistosos","confederation":"OTHER","region":"Global","country":"Global","competition_type":"friendly","tier":"MANUAL_ONLY","trust_status":"MANUAL_ONLY","trust_score":30,"priority_score":10,"enabled":true,"markets_enabled":{"moneyline_3way":false,"draw_no_bet":false,"total_goals_2_5":false,"btts":false},"aliases":["Friendlies","International Friendlies","Amistoso","Amistosos"],"is_friendly":true,"manual_only":true},
    {"league_id":"liga-mx","canonical_name":"Liga MX","display_name":"Liga MX","confederation":"CONCACAF","region":"North America","country":"Mexico","competition_type":"domestic_league","tier":"WATCH","trust_status":"WATCH","trust_score":78,"priority_score":90,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"provider_mappings":{"manual":"liga-mx"},"aliases":["Liga MX","Mexico Liga MX","Primera Division de Mexico","Liga BBVA MX"],"is_domestic":true},
    {"league_id":"mls","canonical_name":"Major League Soccer","display_name":"MLS","confederation":"CONCACAF","region":"North America","country":"United States/Canada","competition_type":"domestic_league","tier":"WATCH","trust_status":"WATCH","trust_score":75,"priority_score":88,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"provider_mappings":{"manual":"mls"},"aliases":["MLS","Major League Soccer","USA MLS"],"is_domestic":true},
    {"league_id":"concacaf-champions-cup","canonical_name":"Copa de Campeones de la Concacaf","display_name":"Concacaf Champions Cup","confederation":"CONCACAF","region":"North America","country":"North America","competition_type":"continental_cup","tier":"WATCH","trust_status":"WATCH","trust_score":72,"priority_score":72,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Concacaf Champions Cup","Concachampions"],"is_continental":true},
    {"league_id":"leagues-cup","canonical_name":"Leagues Cup","display_name":"Leagues Cup","confederation":"CONCACAF","region":"North America","country":"North America","competition_type":"continental_cup","tier":"WATCH","trust_status":"WATCH","trust_score":70,"priority_score":70,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Leagues Cup"],"is_continental":true},
    {"league_id":"brasileirao-serie-a","canonical_name":"Brasileirao Serie A","display_name":"Brasileirao Serie A","confederation":"CONMEBOL","region":"South America","country":"Brasil","competition_type":"domestic_league","tier":"WATCH","trust_status":"WATCH","trust_score":74,"priority_score":80,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Brasileirao","Brazil Serie A","Campeonato Brasileiro Serie A","Brazilian Serie A"],"is_domestic":true},
    {"league_id":"argentina-primera-division","canonical_name":"Liga Profesional Argentina","display_name":"Argentina Primera","confederation":"CONMEBOL","region":"South America","country":"Argentina","competition_type":"domestic_league","tier":"WATCH","trust_status":"WATCH","trust_score":72,"priority_score":78,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Liga Profesional","Argentina Primera Division","Argentine Primera","argentina-primera"],"is_domestic":true},
    {"league_id":"colombia-primera-a","canonical_name":"Categoria Primera A / Liga BetPlay","display_name":"Colombia Primera A","confederation":"CONMEBOL","region":"South America","country":"Colombia","competition_type":"domestic_league","tier":"GLOBAL","trust_status":"WATCH","trust_score":68,"priority_score":68,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Categoria Primera A","Liga BetPlay","Colombia Primera A"],"is_domestic":true},
    {"league_id":"chile-primera-division","canonical_name":"Primera Division Chile","display_name":"Chile Primera Division","confederation":"CONMEBOL","region":"South America","country":"Chile","competition_type":"domestic_league","tier":"GLOBAL","trust_status":"WATCH","trust_score":66,"priority_score":66,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Chile Primera Division","Liga Chilena"],"is_domestic":true},
    {"league_id":"ecuador-liga-pro","canonical_name":"LigaPro Serie A","display_name":"Ecuador Liga Pro","confederation":"CONMEBOL","region":"South America","country":"Ecuador","competition_type":"domestic_league","tier":"GLOBAL","trust_status":"WATCH","trust_score":65,"priority_score":65,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["LigaPro Serie A","Ecuador LigaPro","ecuador-ligapro"],"is_domestic":true},
    {"league_id":"peru-liga-1","canonical_name":"Liga 1 Peru","display_name":"Peru Liga 1","confederation":"CONMEBOL","region":"South America","country":"Peru","competition_type":"domestic_league","tier":"GLOBAL","trust_status":"WATCH","trust_score":63,"priority_score":63,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Liga 1 Peru","Liga Peruana"],"is_domestic":true},
    {"league_id":"paraguay-primera-division","canonical_name":"Division de Honor Paraguay","display_name":"Paraguay Primera","confederation":"CONMEBOL","region":"South America","country":"Paraguay","competition_type":"domestic_league","tier":"GLOBAL","trust_status":"WATCH","trust_score":62,"priority_score":62,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Division de Honor Paraguay","paraguay-primera"],"is_domestic":true},
    {"league_id":"uruguay-primera-division","canonical_name":"Primera Division Uruguay","display_name":"Uruguay Primera","confederation":"CONMEBOL","region":"South America","country":"Uruguay","competition_type":"domestic_league","tier":"GLOBAL","trust_status":"WATCH","trust_score":62,"priority_score":62,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Primera Division Uruguay","uruguay-primera"],"is_domestic":true},
    {"league_id":"bolivia-primera-division","canonical_name":"Division Profesional Bolivia","display_name":"Bolivia Primera","confederation":"CONMEBOL","region":"South America","country":"Bolivia","competition_type":"domestic_league","tier":"GLOBAL","trust_status":"NOISY","trust_score":58,"priority_score":58,"enabled":true,"markets_enabled":{"moneyline_3way":false,"draw_no_bet":true,"total_goals_2_5":false,"btts":false},"aliases":["Division Profesional Bolivia","bolivia-primera"],"is_domestic":true},
    {"league_id":"venezuela-futve","canonical_name":"Liga FUTVE","display_name":"Liga FUTVE","confederation":"CONMEBOL","region":"South America","country":"Venezuela","competition_type":"domestic_league","tier":"GLOBAL","trust_status":"NOISY","trust_score":56,"priority_score":56,"enabled":true,"markets_enabled":{"moneyline_3way":false,"draw_no_bet":true,"total_goals_2_5":false,"btts":false},"aliases":["Liga FUTVE","Venezuela FUTVE"],"is_domestic":true},
    {"league_id":"copa-libertadores","canonical_name":"Copa Libertadores","display_name":"Copa Libertadores","confederation":"CONMEBOL","region":"South America","country":"South America","competition_type":"continental_cup","tier":"TIER_1","trust_status":"TRUSTED","trust_score":82,"priority_score":86,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Copa Libertadores","CONMEBOL Libertadores"],"is_continental":true},
    {"league_id":"copa-sudamericana","canonical_name":"Copa Sudamericana","display_name":"Copa Sudamericana","confederation":"CONMEBOL","region":"South America","country":"South America","competition_type":"continental_cup","tier":"TIER_2","trust_status":"WATCH","trust_score":75,"priority_score":80,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Copa Sudamericana","CONMEBOL Sudamericana"],"is_continental":true},
    {"league_id":"recopa-sudamericana","canonical_name":"Recopa Sudamericana","display_name":"Recopa Sudamericana","confederation":"CONMEBOL","region":"South America","country":"South America","competition_type":"continental_cup","tier":"TIER_2","trust_status":"WATCH","trust_score":70,"priority_score":70,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Recopa Sudamericana"],"is_continental":true},
    {"league_id":"premier-league","canonical_name":"Premier League","display_name":"Premier League","confederation":"UEFA","region":"Europe","country":"England","competition_type":"domestic_league","tier":"TIER_1","trust_status":"TRUSTED","trust_score":88,"priority_score":95,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"provider_mappings":{"transfermarkt":"GB1"},"aliases":["EPL","England Premier League","Premier League England","GB1"],"is_domestic":true},
    {"league_id":"la-liga","canonical_name":"LaLiga","display_name":"LaLiga","confederation":"UEFA","region":"Europe","country":"Spain","competition_type":"domestic_league","tier":"TIER_1","trust_status":"TRUSTED","trust_score":87,"priority_score":94,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"provider_mappings":{"transfermarkt":"ES1"},"aliases":["La Liga","Primera Division Espana","Spain LaLiga","ES1","laliga"],"is_domestic":true},
    {"league_id":"serie-a","canonical_name":"Serie A","display_name":"Serie A","confederation":"UEFA","region":"Europe","country":"Italy","competition_type":"domestic_league","tier":"TIER_1","trust_status":"TRUSTED","trust_score":85,"priority_score":92,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"provider_mappings":{"transfermarkt":"IT1"},"aliases":["Italy Serie A","Serie A Italy","IT1"],"is_domestic":true},
    {"league_id":"bundesliga","canonical_name":"Bundesliga","display_name":"Bundesliga","confederation":"UEFA","region":"Europe","country":"Germany","competition_type":"domestic_league","tier":"TIER_1","trust_status":"TRUSTED","trust_score":85,"priority_score":92,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"provider_mappings":{"transfermarkt":"L1"},"aliases":["Germany Bundesliga","Bundesliga Germany","L1"],"is_domestic":true},
    {"league_id":"ligue-1","canonical_name":"Ligue 1","display_name":"Ligue 1","confederation":"UEFA","region":"Europe","country":"France","competition_type":"domestic_league","tier":"TIER_1","trust_status":"TRUSTED","trust_score":82,"priority_score":88,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"provider_mappings":{"transfermarkt":"FR1"},"aliases":["France Ligue 1","Ligue 1 France","FR1"],"is_domestic":true},
    {"league_id":"primeira-liga-portugal","canonical_name":"Liga Portugal","display_name":"Liga Portugal","confederation":"UEFA","region":"Europe","country":"Portugal","competition_type":"domestic_league","tier":"WATCH","trust_status":"WATCH","trust_score":76,"priority_score":76,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Liga Portugal","Primeira Liga","liga-portugal"],"is_domestic":true},
    {"league_id":"eredivisie","canonical_name":"Eredivisie","display_name":"Eredivisie","confederation":"UEFA","region":"Europe","country":"Netherlands","competition_type":"domestic_league","tier":"WATCH","trust_status":"WATCH","trust_score":75,"priority_score":75,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Eredivisie","Liga Holandesa"],"is_domestic":true},
    {"league_id":"turkey-super-lig","canonical_name":"Super Lig","display_name":"Turkey Super Lig","confederation":"UEFA","region":"Europe","country":"Turkey","competition_type":"domestic_league","tier":"WATCH","trust_status":"WATCH","trust_score":72,"priority_score":72,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Super Lig","Turkey Super Lig"],"is_domestic":true},
    {"league_id":"belgium-pro-league","canonical_name":"Jupiler Pro League","display_name":"Belgium Pro League","confederation":"UEFA","region":"Europe","country":"Belgium","competition_type":"domestic_league","tier":"WATCH","trust_status":"WATCH","trust_score":70,"priority_score":70,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["Jupiler Pro League","Belgium Pro League"],"is_domestic":true},
    {"league_id":"uefa-champions-league","canonical_name":"UEFA Champions League","display_name":"Champions League","confederation":"UEFA","region":"Europe","country":"Europe","competition_type":"continental_cup","tier":"TIER_1","trust_status":"TRUSTED","trust_score":90,"priority_score":100,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["UCL","UEFA CL","Champions League"],"is_continental":true},
    {"league_id":"europa-league","canonical_name":"UEFA Europa League","display_name":"Europa League","confederation":"UEFA","region":"Europe","country":"Europe","competition_type":"continental_cup","tier":"TIER_2","trust_status":"TRUSTED","trust_score":84,"priority_score":84,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["UEL","UEFA Europa League","uefa-europa-league"],"is_continental":true},
    {"league_id":"conference-league","canonical_name":"UEFA Conference League","display_name":"Conference League","confederation":"UEFA","region":"Europe","country":"Europe","competition_type":"continental_cup","tier":"TIER_3","trust_status":"WATCH","trust_score":78,"priority_score":78,"enabled":true,"markets_enabled":{"moneyline_3way":true,"draw_no_bet":true,"total_goals_2_5":true,"btts":false},"aliases":["UECL","UEFA Conference League","uefa-conference-league"],"is_continental":true}
  ]$$::jsonb) AS x(
    league_id text, canonical_name text, display_name text, confederation text,
    region text, country text, competition_type text, tier text, trust_status text,
    trust_score numeric, priority_score numeric, enabled boolean, markets_enabled jsonb,
    provider_mappings jsonb, aliases jsonb, is_domestic boolean, is_continental boolean,
    is_global boolean, is_friendly boolean, manual_only boolean, notes text
  )
)
INSERT INTO football_competition_registry (
  league_id, canonical_name, display_name, confederation, region, country,
  competition_type, tier, trust_status, trust_score, priority_score, enabled,
  markets_enabled, provider_mappings, aliases, is_domestic, is_continental,
  is_global, is_friendly, manual_only, notes
)
SELECT
  league_id, canonical_name, display_name, confederation, region, country,
  competition_type, tier, trust_status, trust_score, COALESCE(priority_score, 0), COALESCE(enabled, true),
  COALESCE(markets_enabled, '{}'::jsonb), COALESCE(provider_mappings, '{}'::jsonb), COALESCE(aliases, '[]'::jsonb),
  COALESCE(is_domestic, false), COALESCE(is_continental, false), COALESCE(is_global, false),
  COALESCE(is_friendly, false), COALESCE(manual_only, false), notes
FROM seed
ON CONFLICT (league_id) DO UPDATE SET
  canonical_name = EXCLUDED.canonical_name,
  display_name = EXCLUDED.display_name,
  confederation = EXCLUDED.confederation,
  region = EXCLUDED.region,
  country = EXCLUDED.country,
  competition_type = EXCLUDED.competition_type,
  tier = EXCLUDED.tier,
  trust_status = EXCLUDED.trust_status,
  trust_score = EXCLUDED.trust_score,
  priority_score = EXCLUDED.priority_score,
  enabled = EXCLUDED.enabled,
  markets_enabled = EXCLUDED.markets_enabled,
  provider_mappings = EXCLUDED.provider_mappings,
  aliases = EXCLUDED.aliases,
  is_domestic = EXCLUDED.is_domestic,
  is_continental = EXCLUDED.is_continental,
  is_global = EXCLUDED.is_global,
  is_friendly = EXCLUDED.is_friendly,
  manual_only = EXCLUDED.manual_only,
  notes = EXCLUDED.notes,
  updated_at = now();
