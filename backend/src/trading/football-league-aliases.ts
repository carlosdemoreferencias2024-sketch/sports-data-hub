import { FOOTBALL_LEAGUES } from "./football-leagues.config.js";

const aliasPairs: Array<[string, string]> = [
  ["mundial", "fifa-world-cup-2026"], ["world cup", "fifa-world-cup-2026"], ["fifa world cup", "fifa-world-cup-2026"], ["copa del mundo", "fifa-world-cup-2026"], ["mundial 2026", "fifa-world-cup-2026"], ["fifa-world-cup-2026", "fifa-world-cup-2026"],
  ["brasil", "brasileirao-serie-a"], ["brasileirao", "brasileirao-serie-a"], ["brasileirao serie a", "brasileirao-serie-a"], ["brasileirao serie a", "brasileirao-serie-a"], ["brazil serie a", "brasileirao-serie-a"], ["brasileirao-serie-a", "brasileirao-serie-a"],
  ["brasileirao serie b", "brasileirao-serie-b"], ["brasileirao serie b", "brasileirao-serie-b"], ["brasileirao-serie-b", "brasileirao-serie-b"],
  ["argentina", "argentina-primera-division"], ["liga argentina", "argentina-primera-division"], ["primera argentina", "argentina-primera-division"], ["primera division argentina", "argentina-primera-division"], ["argentina-primera-division", "argentina-primera-division"],
  ["primera nacional argentina", "argentina-primera-nacional"], ["argentina-primera-nacional", "argentina-primera-nacional"],
  ["italia", "serie-a"], ["serie a", "serie-a"], ["italian serie a", "serie-a"], ["liga italiana", "serie-a"], ["serie-a", "serie-a"],
  ["coppa italia", "coppa-italia"], ["copa italia", "coppa-italia"], ["coppa-italia", "coppa-italia"],
  ["alemania", "bundesliga"], ["bundesliga", "bundesliga"], ["german bundesliga", "bundesliga"], ["liga alemana", "bundesliga"],
  ["dfb pokal", "dfb-pokal"], ["copa alemana", "dfb-pokal"], ["dfb-pokal", "dfb-pokal"],
  ["francia", "ligue-1"], ["ligue 1", "ligue-1"], ["liga francesa", "ligue-1"], ["ligue-1", "ligue-1"],
  ["laliga", "la-liga"], ["la liga", "la-liga"], ["liga espanola", "la-liga"], ["spain la liga", "la-liga"], ["la-liga", "la-liga"],
  ["copa del rey", "copa-del-rey"], ["copa-del-rey", "copa-del-rey"],
  ["premier", "premier-league"], ["premier league", "premier-league"], ["epl", "premier-league"], ["liga inglesa", "premier-league"], ["premier-league", "premier-league"],
  ["fa cup", "fa-cup"], ["copa fa", "fa-cup"], ["fa-cup", "fa-cup"],
  ["league cup", "england-league-cup"], ["efl cup", "england-league-cup"], ["efl league cup", "england-league-cup"], ["carabao cup", "england-league-cup"], ["england league cup", "england-league-cup"], ["england-league-cup", "england-league-cup"],
  ["champions", "uefa-champions-league"], ["ucl", "uefa-champions-league"], ["uefa champions league", "uefa-champions-league"], ["uefa-champions-league", "uefa-champions-league"],
  ["europa league", "europa-league"], ["uel", "europa-league"], ["europa-league", "europa-league"],
  ["conference league", "conference-league"], ["uecl", "conference-league"], ["conference-league", "conference-league"],
  ["libertadores", "copa-libertadores"], ["copa libertadores", "copa-libertadores"], ["copa-libertadores", "copa-libertadores"],
  ["sudamericana", "copa-sudamericana"], ["copa sudamericana", "copa-sudamericana"], ["copa-sudamericana", "copa-sudamericana"],
  ["concacaf champions cup", "concacaf-champions-cup"], ["concachampions", "concacaf-champions-cup"], ["concacaf-champions-cup", "concacaf-champions-cup"],
  ["liga mx", "liga-mx"], ["ligamx", "liga-mx"], ["mexico liga mx", "liga-mx"], ["liga-mx", "liga-mx"],
  ["mls", "mls"], ["major league soccer", "mls"],
  ["chile", "chile-primera-division"], ["liga chilena", "chile-primera-division"], ["chile-primera-division", "chile-primera-division"],
  ["colombia", "colombia-primera-a"], ["liga colombiana", "colombia-primera-a"], ["colombia-primera-a", "colombia-primera-a"],
  ["uruguay", "uruguay-primera-division"], ["liga uruguaya", "uruguay-primera-division"], ["uruguay-primera-division", "uruguay-primera-division"],
  ["peru", "peru-liga-1"], ["liga peruana", "peru-liga-1"], ["peru-liga-1", "peru-liga-1"],
  ["ecuador", "ecuador-liga-pro"], ["liga pro ecuador", "ecuador-liga-pro"], ["ecuador-liga-pro", "ecuador-liga-pro"],
  ["paraguay", "paraguay-primera-division"], ["liga paraguaya", "paraguay-primera-division"], ["paraguay-primera-division", "paraguay-primera-division"],
  ["bolivia", "bolivia-primera-division"], ["liga boliviana", "bolivia-primera-division"], ["bolivia-primera-division", "bolivia-primera-division"],
  ["eredivisie", "eredivisie"], ["holanda", "eredivisie"], ["liga holandesa", "eredivisie"],
  ["portugal", "primeira-liga-portugal"], ["primeira liga", "primeira-liga-portugal"], ["primeira-liga-portugal", "primeira-liga-portugal"],
  ["turquia", "turkey-super-lig"], ["super lig", "turkey-super-lig"], ["turkey-super-lig", "turkey-super-lig"],
  ["belgica", "belgium-pro-league"], ["belgium pro league", "belgium-pro-league"], ["belgium-pro-league", "belgium-pro-league"],
  ["escocia", "scotland-premiership"], ["scotland premiership", "scotland-premiership"], ["scotland-premiership", "scotland-premiership"],
  ["j league", "japan-j1"], ["j1", "japan-j1"], ["japan j1", "japan-j1"], ["japan-j1", "japan-j1"],
  ["k league", "korea-k-league"], ["korea k league", "korea-k-league"], ["korea-k-league", "korea-k-league"],
  ["a league", "australia-a-league"], ["australia a league", "australia-a-league"], ["australia-a-league", "australia-a-league"],
  ["austria bundesliga", "austria-bundesliga"], ["austria-bundesliga", "austria-bundesliga"],
  ["swiss super league", "switzerland-super-league"], ["switzerland super league", "switzerland-super-league"], ["switzerland-super-league", "switzerland-super-league"],
  ["denmark superliga", "denmark-superliga"], ["denmark-superliga", "denmark-superliga"],
  ["norway eliteserien", "norway-eliteserien"], ["norway-eliteserien", "norway-eliteserien"],
  ["sweden allsvenskan", "sweden-allsvenskan"], ["allsvenskan", "sweden-allsvenskan"], ["sweden-allsvenskan", "sweden-allsvenskan"]
];

export const FOOTBALL_LEAGUE_ALIAS_MAP = new Map(aliasPairs);

export function normalizeFootballLeagueAlias(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function resolveFootballLeagueId(input: string): string | null {
  const normalized = normalizeFootballLeagueAlias(input);
  const direct = FOOTBALL_LEAGUES.find((league) => normalizeFootballLeagueAlias(league.league_id) === normalized);
  if (direct) return direct.league_id;
  return FOOTBALL_LEAGUE_ALIAS_MAP.get(normalized) ?? null;
}

export function isFavoriteFootballLeague(leagueId: string): boolean {
  return FOOTBALL_LEAGUES.some((league) => league.league_id === leagueId && league.tier === "FAVORITE" && league.enabled);
}
