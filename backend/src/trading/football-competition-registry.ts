import { FOOTBALL_STANDARD_MARKETS, FootballLeagueConfig, FootballMarketKey } from "./football-leagues.config.js";
import { normalizeFootballLeagueAlias, resolveFootballLeagueId } from "./football-league-aliases.js";

export type FootballTrustStatus = "TRUSTED" | "WATCH" | "NOISY" | "MANUAL_ONLY" | "BLOCKED";
export type FootballCompetitionTier = "TIER_1" | "TIER_2" | "TIER_3" | "WATCH" | "GLOBAL" | "MANUAL_ONLY";

export type FootballCompetitionRegistryRow = {
  id?: string;
  league_id: string;
  canonical_name: string;
  display_name: string;
  confederation: string;
  region: string | null;
  country: string | null;
  competition_type: string;
  tier: FootballCompetitionTier;
  trust_status: FootballTrustStatus;
  trust_score: number;
  priority_score: number;
  enabled: boolean;
  markets_enabled: Record<string, boolean>;
  provider_mappings: Record<string, string>;
  aliases: string[];
  is_domestic: boolean;
  is_continental: boolean;
  is_global: boolean;
  is_friendly: boolean;
  manual_only: boolean;
  notes: string | null;
};

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

const standardMarkets = {
  moneyline_3way: true,
  draw_no_bet: true,
  double_chance: true,
  total_goals_2_5: true,
  btts: false
};

const noisyMarkets = {
  moneyline_3way: false,
  draw_no_bet: true,
  double_chance: false,
  total_goals_2_5: false,
  btts: false
};

const blockedMarkets = {
  moneyline_3way: false,
  draw_no_bet: false,
  double_chance: false,
  total_goals_2_5: false,
  btts: false
};

function competition(input: Omit<FootballCompetitionRegistryRow, "enabled" | "markets_enabled" | "provider_mappings" | "aliases" | "is_domestic" | "is_continental" | "is_global" | "is_friendly" | "manual_only" | "notes"> & Partial<FootballCompetitionRegistryRow>): FootballCompetitionRegistryRow {
  const markets = input.markets_enabled ?? (input.trust_status === "NOISY" ? noisyMarkets : input.trust_status === "MANUAL_ONLY" || input.trust_status === "BLOCKED" ? blockedMarkets : standardMarkets);
  return {
    enabled: true,
    provider_mappings: {},
    aliases: [],
    is_domestic: false,
    is_continental: false,
    is_global: false,
    is_friendly: false,
    manual_only: false,
    notes: null,
    ...input,
    markets_enabled: markets
  };
}

export const FALLBACK_FOOTBALL_COMPETITION_REGISTRY: FootballCompetitionRegistryRow[] = [
  competition({ league_id: "fifa-world-cup-2026", canonical_name: "Copa Mundial FIFA", display_name: "Mundial", confederation: "FIFA", region: "Global", country: "Global", competition_type: "global_cup", tier: "TIER_1", trust_status: "TRUSTED", trust_score: 90, priority_score: 100, aliases: ["Mundial", "World Cup", "FIFA World Cup", "Copa del Mundo", "Mundial 2026"], is_global: true }),
  competition({ league_id: "fifa-club-world-cup", canonical_name: "Mundial de Clubes FIFA", display_name: "Mundial de Clubes", confederation: "FIFA", region: "Global", country: "Global", competition_type: "global_cup", tier: "TIER_2", trust_status: "WATCH", trust_score: 80, priority_score: 82, aliases: ["FIFA Club World Cup", "Mundial de Clubes"], is_global: true }),
  competition({ league_id: "fifa-intercontinental-cup", canonical_name: "Copa Intercontinental FIFA", display_name: "Copa Intercontinental", confederation: "FIFA", region: "Global", country: "Global", competition_type: "global_cup", tier: "TIER_2", trust_status: "WATCH", trust_score: 76, priority_score: 78, aliases: ["FIFA Intercontinental Cup", "Copa Intercontinental"], is_global: true }),
  competition({ league_id: "international-friendlies", canonical_name: "Amistosos Internacionales", display_name: "Amistosos", confederation: "OTHER", region: "Global", country: "Global", competition_type: "friendly", tier: "MANUAL_ONLY", trust_status: "MANUAL_ONLY", trust_score: 30, priority_score: 10, aliases: ["Friendlies", "International Friendlies", "Amistoso", "Amistosos"], is_friendly: true, manual_only: true }),
  competition({ league_id: "liga-mx", canonical_name: "Liga MX", display_name: "Liga MX", confederation: "CONCACAF", region: "North America", country: "Mexico", competition_type: "domestic_league", tier: "WATCH", trust_status: "WATCH", trust_score: 78, priority_score: 90, aliases: ["Liga MX", "Mexico Liga MX", "Primera Division de Mexico", "Liga BBVA MX"], is_domestic: true }),
  competition({ league_id: "mls", canonical_name: "Major League Soccer", display_name: "MLS", confederation: "CONCACAF", region: "North America", country: "United States/Canada", competition_type: "domestic_league", tier: "WATCH", trust_status: "WATCH", trust_score: 75, priority_score: 88, aliases: ["MLS", "Major League Soccer", "USA MLS"], is_domestic: true }),
  competition({ league_id: "concacaf-champions-cup", canonical_name: "Copa de Campeones de la Concacaf", display_name: "Concacaf Champions Cup", confederation: "CONCACAF", region: "North America", country: "North America", competition_type: "continental_cup", tier: "WATCH", trust_status: "WATCH", trust_score: 72, priority_score: 72, aliases: ["Concacaf Champions Cup", "Concachampions"], is_continental: true }),
  competition({ league_id: "leagues-cup", canonical_name: "Leagues Cup", display_name: "Leagues Cup", confederation: "CONCACAF", region: "North America", country: "North America", competition_type: "continental_cup", tier: "WATCH", trust_status: "WATCH", trust_score: 70, priority_score: 70, aliases: ["Leagues Cup"], is_continental: true }),
  competition({ league_id: "brasileirao-serie-a", canonical_name: "Brasileirao Serie A", display_name: "Brasileirao Serie A", confederation: "CONMEBOL", region: "South America", country: "Brasil", competition_type: "domestic_league", tier: "WATCH", trust_status: "WATCH", trust_score: 74, priority_score: 80, aliases: ["Brasileirao", "Brazil Serie A", "Campeonato Brasileiro Serie A", "Brazilian Serie A"], is_domestic: true }),
  competition({ league_id: "argentina-primera-division", canonical_name: "Liga Profesional Argentina", display_name: "Argentina Primera", confederation: "CONMEBOL", region: "South America", country: "Argentina", competition_type: "domestic_league", tier: "WATCH", trust_status: "WATCH", trust_score: 72, priority_score: 78, aliases: ["Liga Profesional", "Argentina Primera Division", "Argentine Primera", "argentina-primera"], is_domestic: true }),
  competition({ league_id: "colombia-primera-a", canonical_name: "Categoria Primera A / Liga BetPlay", display_name: "Colombia Primera A", confederation: "CONMEBOL", region: "South America", country: "Colombia", competition_type: "domestic_league", tier: "GLOBAL", trust_status: "WATCH", trust_score: 68, priority_score: 68, aliases: ["Categoria Primera A", "Liga BetPlay", "Colombia Primera A"], is_domestic: true }),
  competition({ league_id: "chile-primera-division", canonical_name: "Primera Division Chile", display_name: "Chile Primera Division", confederation: "CONMEBOL", region: "South America", country: "Chile", competition_type: "domestic_league", tier: "GLOBAL", trust_status: "WATCH", trust_score: 66, priority_score: 66, aliases: ["Chile Primera Division", "Liga Chilena"], is_domestic: true }),
  competition({ league_id: "ecuador-liga-pro", canonical_name: "LigaPro Serie A", display_name: "Ecuador Liga Pro", confederation: "CONMEBOL", region: "South America", country: "Ecuador", competition_type: "domestic_league", tier: "GLOBAL", trust_status: "WATCH", trust_score: 65, priority_score: 65, aliases: ["LigaPro Serie A", "Ecuador LigaPro", "ecuador-ligapro"], is_domestic: true }),
  competition({ league_id: "peru-liga-1", canonical_name: "Liga 1 Peru", display_name: "Peru Liga 1", confederation: "CONMEBOL", region: "South America", country: "Peru", competition_type: "domestic_league", tier: "GLOBAL", trust_status: "WATCH", trust_score: 63, priority_score: 63, aliases: ["Liga 1 Peru", "Liga Peruana"], is_domestic: true }),
  competition({ league_id: "paraguay-primera-division", canonical_name: "Division de Honor Paraguay", display_name: "Paraguay Primera", confederation: "CONMEBOL", region: "South America", country: "Paraguay", competition_type: "domestic_league", tier: "GLOBAL", trust_status: "WATCH", trust_score: 62, priority_score: 62, aliases: ["Division de Honor Paraguay", "paraguay-primera"], is_domestic: true }),
  competition({ league_id: "uruguay-primera-division", canonical_name: "Primera Division Uruguay", display_name: "Uruguay Primera", confederation: "CONMEBOL", region: "South America", country: "Uruguay", competition_type: "domestic_league", tier: "GLOBAL", trust_status: "WATCH", trust_score: 62, priority_score: 62, aliases: ["Primera Division Uruguay", "uruguay-primera"], is_domestic: true }),
  competition({ league_id: "bolivia-primera-division", canonical_name: "Division Profesional Bolivia", display_name: "Bolivia Primera", confederation: "CONMEBOL", region: "South America", country: "Bolivia", competition_type: "domestic_league", tier: "GLOBAL", trust_status: "NOISY", trust_score: 58, priority_score: 58, aliases: ["Division Profesional Bolivia", "bolivia-primera"], is_domestic: true }),
  competition({ league_id: "venezuela-futve", canonical_name: "Liga FUTVE", display_name: "Liga FUTVE", confederation: "CONMEBOL", region: "South America", country: "Venezuela", competition_type: "domestic_league", tier: "GLOBAL", trust_status: "NOISY", trust_score: 56, priority_score: 56, aliases: ["Liga FUTVE", "Venezuela FUTVE"], is_domestic: true }),
  competition({ league_id: "copa-libertadores", canonical_name: "Copa Libertadores", display_name: "Copa Libertadores", confederation: "CONMEBOL", region: "South America", country: "South America", competition_type: "continental_cup", tier: "TIER_1", trust_status: "TRUSTED", trust_score: 82, priority_score: 86, aliases: ["Copa Libertadores", "CONMEBOL Libertadores"], is_continental: true }),
  competition({ league_id: "copa-sudamericana", canonical_name: "Copa Sudamericana", display_name: "Copa Sudamericana", confederation: "CONMEBOL", region: "South America", country: "South America", competition_type: "continental_cup", tier: "TIER_2", trust_status: "WATCH", trust_score: 75, priority_score: 80, aliases: ["Copa Sudamericana", "CONMEBOL Sudamericana"], is_continental: true }),
  competition({ league_id: "recopa-sudamericana", canonical_name: "Recopa Sudamericana", display_name: "Recopa Sudamericana", confederation: "CONMEBOL", region: "South America", country: "South America", competition_type: "continental_cup", tier: "TIER_2", trust_status: "WATCH", trust_score: 70, priority_score: 70, aliases: ["Recopa Sudamericana"], is_continental: true }),
  competition({ league_id: "premier-league", canonical_name: "Premier League", display_name: "Premier League", confederation: "UEFA", region: "Europe", country: "England", competition_type: "domestic_league", tier: "TIER_1", trust_status: "TRUSTED", trust_score: 88, priority_score: 95, aliases: ["EPL", "England Premier League", "Premier League England", "GB1"], provider_mappings: { transfermarkt: "GB1" }, is_domestic: true }),
  competition({ league_id: "la-liga", canonical_name: "LaLiga", display_name: "LaLiga", confederation: "UEFA", region: "Europe", country: "Spain", competition_type: "domestic_league", tier: "TIER_1", trust_status: "TRUSTED", trust_score: 87, priority_score: 94, aliases: ["La Liga", "Primera Division Espana", "Spain LaLiga", "ES1", "laliga"], provider_mappings: { transfermarkt: "ES1" }, is_domestic: true }),
  competition({ league_id: "serie-a", canonical_name: "Serie A", display_name: "Serie A", confederation: "UEFA", region: "Europe", country: "Italy", competition_type: "domestic_league", tier: "TIER_1", trust_status: "TRUSTED", trust_score: 85, priority_score: 92, aliases: ["Italy Serie A", "Serie A Italy", "IT1"], provider_mappings: { transfermarkt: "IT1" }, is_domestic: true }),
  competition({ league_id: "bundesliga", canonical_name: "Bundesliga", display_name: "Bundesliga", confederation: "UEFA", region: "Europe", country: "Germany", competition_type: "domestic_league", tier: "TIER_1", trust_status: "TRUSTED", trust_score: 85, priority_score: 92, aliases: ["Germany Bundesliga", "Bundesliga Germany", "L1"], provider_mappings: { transfermarkt: "L1" }, is_domestic: true }),
  competition({ league_id: "ligue-1", canonical_name: "Ligue 1", display_name: "Ligue 1", confederation: "UEFA", region: "Europe", country: "France", competition_type: "domestic_league", tier: "TIER_1", trust_status: "TRUSTED", trust_score: 82, priority_score: 88, aliases: ["France Ligue 1", "Ligue 1 France", "FR1"], provider_mappings: { transfermarkt: "FR1" }, is_domestic: true }),
  competition({ league_id: "primeira-liga-portugal", canonical_name: "Liga Portugal", display_name: "Liga Portugal", confederation: "UEFA", region: "Europe", country: "Portugal", competition_type: "domestic_league", tier: "WATCH", trust_status: "WATCH", trust_score: 76, priority_score: 76, aliases: ["Liga Portugal", "Primeira Liga", "liga-portugal"], is_domestic: true }),
  competition({ league_id: "eredivisie", canonical_name: "Eredivisie", display_name: "Eredivisie", confederation: "UEFA", region: "Europe", country: "Netherlands", competition_type: "domestic_league", tier: "WATCH", trust_status: "WATCH", trust_score: 75, priority_score: 75, aliases: ["Eredivisie", "Liga Holandesa"], is_domestic: true }),
  competition({ league_id: "turkey-super-lig", canonical_name: "Super Lig", display_name: "Turkey Super Lig", confederation: "UEFA", region: "Europe", country: "Turkey", competition_type: "domestic_league", tier: "WATCH", trust_status: "WATCH", trust_score: 72, priority_score: 72, aliases: ["Super Lig", "Turkey Super Lig"], is_domestic: true }),
  competition({ league_id: "belgium-pro-league", canonical_name: "Jupiler Pro League", display_name: "Belgium Pro League", confederation: "UEFA", region: "Europe", country: "Belgium", competition_type: "domestic_league", tier: "WATCH", trust_status: "WATCH", trust_score: 70, priority_score: 70, aliases: ["Jupiler Pro League", "Belgium Pro League"], is_domestic: true }),
  competition({ league_id: "uefa-champions-league", canonical_name: "UEFA Champions League", display_name: "Champions League", confederation: "UEFA", region: "Europe", country: "Europe", competition_type: "continental_cup", tier: "TIER_1", trust_status: "TRUSTED", trust_score: 90, priority_score: 100, aliases: ["UCL", "UEFA CL", "Champions League"], is_continental: true }),
  competition({ league_id: "europa-league", canonical_name: "UEFA Europa League", display_name: "Europa League", confederation: "UEFA", region: "Europe", country: "Europe", competition_type: "continental_cup", tier: "TIER_2", trust_status: "TRUSTED", trust_score: 84, priority_score: 84, aliases: ["UEL", "UEFA Europa League", "uefa-europa-league"], is_continental: true }),
  competition({ league_id: "conference-league", canonical_name: "UEFA Conference League", display_name: "Conference League", confederation: "UEFA", region: "Europe", country: "Europe", competition_type: "continental_cup", tier: "TIER_3", trust_status: "WATCH", trust_score: 78, priority_score: 78, aliases: ["UECL", "UEFA Conference League", "uefa-conference-league"], is_continental: true }),
  competition({ league_id: "england-league-cup", canonical_name: "EFL League Cup", display_name: "EFL League Cup", confederation: "UEFA", region: "Europe", country: "England", competition_type: "domestic_cup", tier: "WATCH", trust_status: "WATCH", trust_score: 74, priority_score: 74, aliases: ["League Cup", "EFL Cup", "EFL League Cup", "Carabao Cup", "England League Cup"], is_domestic: true, notes: "Shadow/watch only. Domestic cup rotation can be noisy; require lineup/goalkeeper and verified market before review." })
];

function normalizeJsonObject(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, raw]) => [key, raw === true || String(raw).toLowerCase() === "true"]));
}

function normalizeJsonStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, raw]) => [key, String(raw)]));
}

function normalizeAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function fromDbRow(row: Record<string, unknown>): FootballCompetitionRegistryRow {
  return {
    id: row.id ? String(row.id) : undefined,
    league_id: String(row.league_id),
    canonical_name: String(row.canonical_name),
    display_name: String(row.display_name),
    confederation: String(row.confederation),
    region: row.region === null || row.region === undefined ? null : String(row.region),
    country: row.country === null || row.country === undefined ? null : String(row.country),
    competition_type: String(row.competition_type),
    tier: String(row.tier) as FootballCompetitionTier,
    trust_status: String(row.trust_status) as FootballTrustStatus,
    trust_score: Number(row.trust_score),
    priority_score: Number(row.priority_score ?? 0),
    enabled: row.enabled !== false,
    markets_enabled: normalizeJsonObject(row.markets_enabled),
    provider_mappings: normalizeJsonStringMap(row.provider_mappings),
    aliases: normalizeAliases(row.aliases),
    is_domestic: row.is_domestic === true,
    is_continental: row.is_continental === true,
    is_global: row.is_global === true,
    is_friendly: row.is_friendly === true,
    manual_only: row.manual_only === true,
    notes: row.notes === null || row.notes === undefined ? null : String(row.notes)
  };
}

function fallbackByLeagueId(leagueId: string): FootballCompetitionRegistryRow | null {
  return FALLBACK_FOOTBALL_COMPETITION_REGISTRY.find((competition) => competition.league_id === leagueId) ?? null;
}

export async function getCompetitionRows(db?: Queryable): Promise<FootballCompetitionRegistryRow[]> {
  if (!db) return FALLBACK_FOOTBALL_COMPETITION_REGISTRY;
  try {
    const result = await db.query(
      `
        SELECT *
        FROM football_competition_registry
        ORDER BY priority_score DESC, trust_score DESC, confederation, country, display_name
      `
    );
    return result.rows.map(fromDbRow);
  } catch (error) {
    if (String((error as Error).message || "").includes("football_competition_registry")) {
      return FALLBACK_FOOTBALL_COMPETITION_REGISTRY;
    }
    throw error;
  }
}

export function normalizeCompetitionName(rawName: string, rows = FALLBACK_FOOTBALL_COMPETITION_REGISTRY): string | null {
  const configured = resolveFootballLeagueId(rawName);
  if (configured) return configured;
  const normalized = normalizeFootballLeagueAlias(rawName);
  for (const row of rows) {
    if (normalizeFootballLeagueAlias(row.league_id) === normalized) return row.league_id;
    if (normalizeFootballLeagueAlias(row.canonical_name) === normalized) return row.league_id;
    if (normalizeFootballLeagueAlias(row.display_name) === normalized) return row.league_id;
    if (row.aliases.some((alias) => normalizeFootballLeagueAlias(alias) === normalized)) return row.league_id;
  }
  return null;
}

export function getCompetitionByLeagueIdFromRows(leagueId: string, rows = FALLBACK_FOOTBALL_COMPETITION_REGISTRY): FootballCompetitionRegistryRow | null {
  return rows.find((row) => row.league_id === leagueId) ?? fallbackByLeagueId(leagueId);
}

export function getProviderMappingFromRows(leagueId: string, provider: string, rows = FALLBACK_FOOTBALL_COMPETITION_REGISTRY): string | null {
  const row = getCompetitionByLeagueIdFromRows(leagueId, rows);
  return row?.provider_mappings?.[provider] ?? null;
}

export function getMarketsEnabledFromRows(leagueId: string, rows = FALLBACK_FOOTBALL_COMPETITION_REGISTRY): Record<string, boolean> {
  return getCompetitionByLeagueIdFromRows(leagueId, rows)?.markets_enabled ?? {};
}

export function isCompetitionTrustedFromRows(leagueId: string, rows = FALLBACK_FOOTBALL_COMPETITION_REGISTRY): boolean {
  const row = getCompetitionByLeagueIdFromRows(leagueId, rows);
  return Boolean(row?.enabled && ["TRUSTED", "WATCH"].includes(row.trust_status) && row.trust_score >= 70 && !row.manual_only && !row.is_friendly);
}

export function isMarketEnabledForCompetitionRow(row: FootballCompetitionRegistryRow | null | undefined, market: string, manualReview = false): boolean {
  if (!row || !row.enabled || row.trust_status === "BLOCKED") return false;
  if ((row.manual_only || row.trust_status === "MANUAL_ONLY" || row.is_friendly) && !manualReview) return false;
  if (market === "btts" && manualReview) return true;
  return row.markets_enabled?.[market] === true;
}

export function getMarketBlockReasonForCompetition(row: FootballCompetitionRegistryRow | null | undefined, market: string, manualReview = false): string | null {
  if (!row) return "UNKNOWN_COMPETITION";
  if (!row.enabled) return "COMPETITION_DISABLED";
  if (row.trust_status === "BLOCKED") return "COMPETITION_BLOCKED";
  if ((row.manual_only || row.trust_status === "MANUAL_ONLY" || row.is_friendly) && !manualReview) return "MANUAL_ONLY_COMPETITION";
  if (market === "btts" && row.markets_enabled?.btts !== true && !manualReview) return "BTTS_MARKET_DISABLED";
  if (row.markets_enabled?.[market] !== true && !(market === "btts" && manualReview)) return "MARKET_NOT_ENABLED";
  return null;
}

export function competitionToLeagueConfig(row: FootballCompetitionRegistryRow): FootballLeagueConfig {
  const tier = row.tier === "MANUAL_ONLY" ? "MANUAL_ONLY" : row.tier === "GLOBAL" ? "GLOBAL" : row.priority_score >= 88 ? "FAVORITE" : "WATCH";
  const markets = FOOTBALL_STANDARD_MARKETS.filter((market) => row.markets_enabled?.[market] === true);
  return {
    league_id: row.league_id,
    display_name: row.display_name,
    country_or_region: row.country ?? row.region ?? "Global",
    confederation: row.confederation,
    tier,
    priority: tier,
    priority_score: row.priority_score,
    sport: "soccer",
    flow: "shadow_paper",
    enabled: row.enabled && row.trust_status !== "BLOCKED",
    markets_enabled: markets as FootballMarketKey[],
    min_closed_before_watch: 20,
    min_closed_before_review: 50,
    min_closed_before_promotion: 75,
    provider_required: row.trust_status === "WATCH" || row.trust_status === "NOISY",
    real_money_allowed: false,
    kelly_allowed: false,
    telegram_auto_allowed: false
  };
}

function countBy(rows: FootballCompetitionRegistryRow[], field: keyof FootballCompetitionRegistryRow) {
  return rows.reduce((acc: Record<string, number>, row) => {
    const key = String(row[field] ?? "UNKNOWN");
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

export function getDashboardCompetitionGroups(rows: FootballCompetitionRegistryRow[]) {
  const favorites = rows
    .filter((row) => row.enabled && row.priority_score >= 78)
    .sort((a, b) => b.priority_score - a.priority_score || b.trust_score - a.trust_score);
  return {
    favorites,
    groups: [
      { group: "America Latina / CONMEBOL", rows: rows.filter((row) => row.confederation === "CONMEBOL") },
      { group: "America Latina / CONCACAF", rows: rows.filter((row) => row.confederation === "CONCACAF") },
      { group: "Europa / Top 5", rows: rows.filter((row) => row.confederation === "UEFA" && row.tier === "TIER_1" && row.competition_type === "domestic_league") },
      { group: "Europa / UEFA Cups", rows: rows.filter((row) => row.confederation === "UEFA" && row.competition_type === "continental_cup") },
      { group: "Global / FIFA", rows: rows.filter((row) => row.confederation === "FIFA") },
      { group: "Manual Only / Friendlies", rows: rows.filter((row) => row.manual_only || row.is_friendly || row.trust_status === "MANUAL_ONLY") }
    ]
  };
}

export async function getFootballCompetitionRegistry(db: Queryable) {
  const rows = await getCompetitionRows(db);
  const priority = rows
    .filter((row) => row.enabled && row.priority_score >= 70)
    .sort((a, b) => b.priority_score - a.priority_score || b.trust_score - a.trust_score);
  return {
    system_status: "FOOTBALL_COMPETITION_REGISTRY_READ_ONLY",
    total: rows.length,
    by_confederation: countBy(rows, "confederation"),
    by_region: countBy(rows, "region"),
    by_country: countBy(rows, "country"),
    by_trust_status: countBy(rows, "trust_status"),
    by_tier: countBy(rows, "tier"),
    by_competition_type: countBy(rows, "competition_type"),
    priority_competitions: priority,
    dashboard_groups: getDashboardCompetitionGroups(rows),
    rows,
    recommendation: "Usar registry como compuerta primaria: liga desconocida queda OBSERVATION_ONLY, BTTS bloqueado salvo manual review, y amistosos son manual only.",
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
