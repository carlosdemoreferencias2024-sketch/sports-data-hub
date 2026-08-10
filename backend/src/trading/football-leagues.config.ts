export type FootballLeagueTier = "FAVORITE" | "WATCH" | "GLOBAL" | "MANUAL_ONLY" | "DISABLED";
export type FootballLeaguePriority = FootballLeagueTier;
export type FootballFlow = "shadow_paper" | "real_paper" | "radar_only";
export type FootballMarketKey = "moneyline_3way" | "total_goals_2_5" | "draw_no_bet" | "double_chance" | "btts";

export interface FootballLeagueConfig {
  league_id: string;
  display_name: string;
  country_or_region: string;
  confederation: string;
  tier: FootballLeagueTier;
  priority: FootballLeagueTier;
  priority_score: number;
  sport: "soccer";
  flow: FootballFlow;
  enabled: boolean;
  markets_enabled: FootballMarketKey[];
  min_closed_before_watch: number;
  min_closed_before_review: number;
  min_closed_before_promotion: number;
  provider_required: boolean;
  real_money_allowed: false;
  kelly_allowed: false;
  telegram_auto_allowed: false;
}

export const FOOTBALL_STANDARD_MARKETS: FootballMarketKey[] = [
  "moneyline_3way",
  "total_goals_2_5",
  "draw_no_bet",
  "double_chance",
  "btts"
];

function league(input: {
  league_id: string;
  display_name: string;
  country_or_region: string;
  confederation: string;
  tier: FootballLeagueTier;
  priority_score: number;
  flow?: FootballFlow;
  enabled?: boolean;
  markets_enabled?: FootballMarketKey[];
  min_closed_before_watch?: number;
  min_closed_before_review?: number;
  min_closed_before_promotion?: number;
  provider_required?: boolean;
}): FootballLeagueConfig {
  return {
    sport: "soccer",
    flow: input.flow ?? "shadow_paper",
    enabled: input.enabled ?? true,
    markets_enabled: input.markets_enabled ?? FOOTBALL_STANDARD_MARKETS,
    min_closed_before_watch: input.min_closed_before_watch ?? 20,
    min_closed_before_review: input.min_closed_before_review ?? 50,
    min_closed_before_promotion: input.min_closed_before_promotion ?? 75,
    provider_required: input.provider_required ?? false,
    real_money_allowed: false,
    kelly_allowed: false,
    telegram_auto_allowed: false,
    priority: input.tier,
    ...input
  };
}

export const FOOTBALL_LEAGUES: FootballLeagueConfig[] = [
  league({ league_id: "fifa-world-cup-2026", display_name: "Mundial 2026", country_or_region: "Global", confederation: "FIFA", tier: "FAVORITE", priority_score: 100 }),
  league({ league_id: "liga-mx", display_name: "Liga MX", country_or_region: "Mexico", confederation: "CONCACAF", tier: "FAVORITE", priority_score: 96 }),
  league({ league_id: "mls", display_name: "MLS", country_or_region: "United States/Canada", confederation: "CONCACAF", tier: "FAVORITE", priority_score: 94 }),
  league({ league_id: "uefa-champions-league", display_name: "UEFA Champions League", country_or_region: "Europe", confederation: "UEFA", tier: "FAVORITE", priority_score: 98 }),
  league({ league_id: "premier-league", display_name: "Premier League", country_or_region: "England", confederation: "UEFA", tier: "FAVORITE", priority_score: 97 }),
  league({ league_id: "la-liga", display_name: "La Liga", country_or_region: "Spain", confederation: "UEFA", tier: "FAVORITE", priority_score: 95 }),
  league({ league_id: "serie-a", display_name: "Serie A", country_or_region: "Italy", confederation: "UEFA", tier: "FAVORITE", priority_score: 93 }),
  league({ league_id: "bundesliga", display_name: "Bundesliga", country_or_region: "Germany", confederation: "UEFA", tier: "FAVORITE", priority_score: 92 }),
  league({ league_id: "brasileirao-serie-a", display_name: "Brasileirao Serie A", country_or_region: "Brazil", confederation: "CONMEBOL", tier: "FAVORITE", priority_score: 91 }),
  league({ league_id: "argentina-primera-division", display_name: "Argentina Primera Division", country_or_region: "Argentina", confederation: "CONMEBOL", tier: "FAVORITE", priority_score: 90 }),

  league({ league_id: "ligue-1", display_name: "Ligue 1", country_or_region: "France", confederation: "UEFA", tier: "WATCH", priority_score: 82 }),
  league({ league_id: "eredivisie", display_name: "Eredivisie", country_or_region: "Netherlands", confederation: "UEFA", tier: "WATCH", priority_score: 78 }),
  league({ league_id: "primeira-liga-portugal", display_name: "Primeira Liga Portugal", country_or_region: "Portugal", confederation: "UEFA", tier: "WATCH", priority_score: 77 }),
  league({ league_id: "copa-libertadores", display_name: "Copa Libertadores", country_or_region: "South America", confederation: "CONMEBOL", tier: "WATCH", priority_score: 86 }),
  league({ league_id: "copa-sudamericana", display_name: "Copa Sudamericana", country_or_region: "South America", confederation: "CONMEBOL", tier: "WATCH", priority_score: 80 }),
  league({ league_id: "europa-league", display_name: "Europa League", country_or_region: "Europe", confederation: "UEFA", tier: "WATCH", priority_score: 84 }),
  league({ league_id: "conference-league", display_name: "Conference League", country_or_region: "Europe", confederation: "UEFA", tier: "WATCH", priority_score: 74 }),
  league({ league_id: "concacaf-champions-cup", display_name: "Concacaf Champions Cup", country_or_region: "North America", confederation: "CONCACAF", tier: "WATCH", priority_score: 79 }),
  league({ league_id: "fa-cup", display_name: "FA Cup", country_or_region: "England", confederation: "UEFA", tier: "WATCH", priority_score: 76 }),
  league({ league_id: "england-league-cup", display_name: "EFL League Cup", country_or_region: "England", confederation: "UEFA", tier: "WATCH", priority_score: 74 }),
  league({ league_id: "copa-del-rey", display_name: "Copa del Rey", country_or_region: "Spain", confederation: "UEFA", tier: "WATCH", priority_score: 75 }),
  league({ league_id: "coppa-italia", display_name: "Coppa Italia", country_or_region: "Italy", confederation: "UEFA", tier: "WATCH", priority_score: 73 }),
  league({ league_id: "dfb-pokal", display_name: "DFB-Pokal", country_or_region: "Germany", confederation: "UEFA", tier: "WATCH", priority_score: 72 }),

  league({ league_id: "brasileirao-serie-b", display_name: "Brasileirao Serie B", country_or_region: "Brazil", confederation: "CONMEBOL", tier: "GLOBAL", priority_score: 60 }),
  league({ league_id: "argentina-primera-nacional", display_name: "Argentina Primera Nacional", country_or_region: "Argentina", confederation: "CONMEBOL", tier: "GLOBAL", priority_score: 58 }),
  league({ league_id: "chile-primera-division", display_name: "Chile Primera Division", country_or_region: "Chile", confederation: "CONMEBOL", tier: "GLOBAL", priority_score: 57 }),
  league({ league_id: "colombia-primera-a", display_name: "Colombia Primera A", country_or_region: "Colombia", confederation: "CONMEBOL", tier: "GLOBAL", priority_score: 57 }),
  league({ league_id: "uruguay-primera-division", display_name: "Uruguay Primera Division", country_or_region: "Uruguay", confederation: "CONMEBOL", tier: "GLOBAL", priority_score: 56 }),
  league({ league_id: "peru-liga-1", display_name: "Peru Liga 1", country_or_region: "Peru", confederation: "CONMEBOL", tier: "GLOBAL", priority_score: 55 }),
  league({ league_id: "ecuador-liga-pro", display_name: "Ecuador Liga Pro", country_or_region: "Ecuador", confederation: "CONMEBOL", tier: "GLOBAL", priority_score: 55 }),
  league({ league_id: "paraguay-primera-division", display_name: "Paraguay Primera Division", country_or_region: "Paraguay", confederation: "CONMEBOL", tier: "GLOBAL", priority_score: 54 }),
  league({ league_id: "bolivia-primera-division", display_name: "Bolivia Primera Division", country_or_region: "Bolivia", confederation: "CONMEBOL", tier: "GLOBAL", priority_score: 52 }),
  league({ league_id: "japan-j1", display_name: "Japan J1", country_or_region: "Japan", confederation: "AFC", tier: "GLOBAL", priority_score: 62 }),
  league({ league_id: "korea-k-league", display_name: "Korea K League", country_or_region: "South Korea", confederation: "AFC", tier: "GLOBAL", priority_score: 61 }),
  league({ league_id: "australia-a-league", display_name: "Australia A-League", country_or_region: "Australia", confederation: "AFC", tier: "GLOBAL", priority_score: 53 }),
  league({ league_id: "turkey-super-lig", display_name: "Turkey Super Lig", country_or_region: "Turkey", confederation: "UEFA", tier: "GLOBAL", priority_score: 64 }),
  league({ league_id: "belgium-pro-league", display_name: "Belgium Pro League", country_or_region: "Belgium", confederation: "UEFA", tier: "GLOBAL", priority_score: 63 }),
  league({ league_id: "scotland-premiership", display_name: "Scotland Premiership", country_or_region: "Scotland", confederation: "UEFA", tier: "GLOBAL", priority_score: 59 }),
  league({ league_id: "austria-bundesliga", display_name: "Austria Bundesliga", country_or_region: "Austria", confederation: "UEFA", tier: "GLOBAL", priority_score: 58 }),
  league({ league_id: "switzerland-super-league", display_name: "Switzerland Super League", country_or_region: "Switzerland", confederation: "UEFA", tier: "GLOBAL", priority_score: 58 }),
  league({ league_id: "denmark-superliga", display_name: "Denmark Superliga", country_or_region: "Denmark", confederation: "UEFA", tier: "GLOBAL", priority_score: 57 }),
  league({ league_id: "norway-eliteserien", display_name: "Norway Eliteserien", country_or_region: "Norway", confederation: "UEFA", tier: "GLOBAL", priority_score: 56 }),
  league({ league_id: "sweden-allsvenskan", display_name: "Sweden Allsvenskan", country_or_region: "Sweden", confederation: "UEFA", tier: "GLOBAL", priority_score: 56 })
];
