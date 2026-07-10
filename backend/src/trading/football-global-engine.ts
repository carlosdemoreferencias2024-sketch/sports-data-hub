import { FOOTBALL_LEAGUES, FOOTBALL_STANDARD_MARKETS, FootballLeagueConfig, FootballMarketKey } from "./football-leagues.config.js";
import { getFootballMarketLab } from "./football-market-lab.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export type FootballMarketStatus = "ACCUMULATING_EARLY" | "ACCUMULATING" | "WATCH" | "READY_FOR_REVIEW" | "COOLING" | "BLOCKED" | "DISABLED";

type PerformanceRow = {
  league_id: string;
  league_display_name: string;
  tier: FootballLeagueConfig["tier"];
  priority: FootballLeagueConfig["priority"];
  country_or_region: string;
  confederation: string;
  flow: FootballLeagueConfig["flow"];
  market: FootballMarketKey;
  total: number;
  closed: number;
  open: number;
  pending_results: number;
  wins: number;
  losses: number;
  pushes: number;
  win_rate: number | null;
  profit_units: number;
  avg_clv: number | null;
  latest_activity: string | null;
  status: FootballMarketStatus;
  recommendation: string;
};

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getFootballLeagues() {
  return FOOTBALL_LEAGUES;
}

export function getFavoriteFootballLeagues() {
  return FOOTBALL_LEAGUES.filter((league) => league.priority === "FAVORITE" && league.enabled);
}

export function getFootballMarketStatus(leagueId: string, market: FootballMarketKey): FootballMarketStatus {
  const league = FOOTBALL_LEAGUES.find((item) => item.league_id === leagueId);
  if (!league || !league.enabled || league.priority === "DISABLED") return "DISABLED";
  if (!league.markets_enabled.includes(market)) return "DISABLED";
  if (leagueId === "fifa-world-cup-2026" && market === "btts") return "BLOCKED";
  return "ACCUMULATING";
}

function statusRecommendation(status: FootballMarketStatus, row: Pick<PerformanceRow, "league_display_name" | "market" | "closed" | "pending_results">): string {
  if (status === "BLOCKED") return "Mantener bloqueado; no usar para picks hasta nueva auditoria.";
  if (status === "DISABLED") return "Mercado apagado para esta liga.";
  if (status === "READY_FOR_REVIEW") return "Listo para revision formal; mantener Shadow Paper only.";
  if (status === "WATCH") return "Buena senal inicial; seguir acumulando sin promover.";
  if (status === "COOLING") return "Enfriandose; revisar antes de alimentar mas decision.";
  if (status === "ACCUMULATING_EARLY") return "Muestra temprana; acumular hasta 20 cerradas.";
  if (row.pending_results > 0) return "Correr settlement cuando haya resultados finales.";
  return `Acumular muestra para ${row.league_display_name} ${row.market}: ${row.closed}/20 cerradas.`;
}

export function promoteOrBlockFootballMarket(league: FootballLeagueConfig, market: FootballMarketKey, metrics: { closed: number; wins: number; losses: number; profit_units: number; avg_clv: number | null }): FootballMarketStatus {
  if (!league.enabled || league.priority === "DISABLED") return "DISABLED";
  if (!league.markets_enabled.includes(market)) return "DISABLED";
  if (league.league_id === "fifa-world-cup-2026" && market === "btts") return "BLOCKED";

  const decisions = metrics.wins + metrics.losses;
  const winRate = decisions > 0 ? metrics.wins / decisions : null;
  if (metrics.closed < league.min_closed_before_watch) return "ACCUMULATING_EARLY";
  if (metrics.closed < league.min_closed_before_review) return "ACCUMULATING";
  if (metrics.closed >= league.min_closed_before_promotion && metrics.profit_units > 0 && (metrics.avg_clv === null || metrics.avg_clv >= 0)) return "READY_FOR_REVIEW";
  if (metrics.profit_units > 0) return "WATCH";
  if (winRate !== null && winRate < 0.45) return "BLOCKED";
  return "COOLING";
}

export async function calculateFootballLeagueMarketPerformance(db: Queryable): Promise<PerformanceRow[]> {
  const leagueIds = FOOTBALL_LEAGUES.map((league) => league.league_id);
  const result = await db.query(
    `
      SELECT
        league_slug,
        market_type,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED'))::int AS closed,
        COUNT(*) FILTER (WHERE status IN ('OPEN'))::int AS open,
        COUNT(*) FILTER (WHERE status IN ('PENDING', 'PENDING_RESULT', 'PENDING_RESULTS'))::int AS pending_results,
        COUNT(*) FILTER (WHERE status = 'WIN')::int AS wins,
        COUNT(*) FILTER (WHERE status = 'LOSS')::int AS losses,
        COUNT(*) FILTER (WHERE status = 'PUSH')::int AS pushes,
        ROUND(COALESCE(SUM(net_profit) FILTER (WHERE status IN ('WIN', 'LOSS', 'PUSH', 'SETTLED')), 0)::numeric, 4) AS profit_units,
        MAX(COALESCE(settled_at, placed_at, updated_at, created_at)) AS latest_activity
      FROM paper_trades
      WHERE league_slug = ANY($1::text[])
        AND market_type = ANY($2::text[])
      GROUP BY league_slug, market_type
    `,
    [leagueIds, FOOTBALL_STANDARD_MARKETS]
  );

  const metricsByKey = new Map<string, Record<string, unknown>>();
  for (const row of result.rows) {
    metricsByKey.set(`${String(row.league_slug)}:${String(row.market_type)}`, row);
  }

  const rows: PerformanceRow[] = [];
  for (const league of FOOTBALL_LEAGUES) {
    for (const market of league.markets_enabled) {
      const raw = metricsByKey.get(`${league.league_id}:${market}`);
      const wins = toNumber(raw?.wins);
      const losses = toNumber(raw?.losses);
      const closed = toNumber(raw?.closed);
      const winRate = wins + losses > 0 ? wins / (wins + losses) : null;
      const avgClv = toNullableNumber(raw?.avg_clv);
      const base = {
        league_id: league.league_id,
        league_display_name: league.display_name,
        tier: league.tier,
        priority: league.priority,
        country_or_region: league.country_or_region,
        confederation: league.confederation,
        flow: league.flow,
        market,
        total: toNumber(raw?.total),
        closed,
        open: toNumber(raw?.open),
        pending_results: toNumber(raw?.pending_results),
        wins,
        losses,
        pushes: toNumber(raw?.pushes),
        win_rate: winRate,
        profit_units: toNumber(raw?.profit_units),
        avg_clv: avgClv,
        latest_activity: raw?.latest_activity ? String(raw.latest_activity) : null
      };
      const status = promoteOrBlockFootballMarket(league, market, base);
      rows.push({
        ...base,
        status,
        recommendation: statusRecommendation(status, base)
      });
    }
  }

  return rows.sort((a, b) => {
    const priorityOrder = { FAVORITE: 0, WATCH: 1, GLOBAL: 2, MANUAL_ONLY: 3, DISABLED: 4 } as const;
    return priorityOrder[a.priority] - priorityOrder[b.priority]
      || b.profit_units - a.profit_units
      || b.closed - a.closed
      || a.league_display_name.localeCompare(b.league_display_name)
      || a.market.localeCompare(b.market);
  });
}

function pickBest(rows: PerformanceRow[]) {
  return rows
    .filter((row) => row.closed > 0 && row.status !== "BLOCKED" && row.status !== "DISABLED")
    .sort((a, b) => b.profit_units - a.profit_units || b.closed - a.closed)[0] ?? null;
}

function pickWorst(rows: PerformanceRow[]) {
  return rows
    .filter((row) => row.closed > 0)
    .sort((a, b) => a.profit_units - b.profit_units || b.closed - a.closed)[0] ?? null;
}

function buildRecommendedAction(rows: PerformanceRow[]) {
  const pending = rows.reduce((sum, row) => sum + row.pending_results, 0);
  const ready = rows.filter((row) => row.status === "READY_FOR_REVIEW");
  const accumulating = rows.filter((row) => (row.status === "ACCUMULATING" || row.status === "ACCUMULATING_EARLY") && row.priority === "FAVORITE");
  if (pending > 0) return "Correr settlement de futbol cuando los partidos esten finished; seguir sin dinero real.";
  if (ready.length > 0) return "Revisar mercados READY_FOR_REVIEW por liga, pero mantener Shadow Paper only.";
  if (accumulating.length > 0) return "Alimentar ligas favoritas y acumular minimo 20 cerradas por mercado.";
  return "Mantener observacion global y revisar bloqueos por mercado.";
}

export async function getFootballCommandCenter(db: Queryable) {
  const rows = await calculateFootballLeagueMarketPerformance(db);
  const marketLab = await getFootballMarketLab(db);
  const best = pickBest(rows);
  const worst = pickWorst(rows);
  const favoriteLeagues = FOOTBALL_LEAGUES.filter((league) => league.priority === "FAVORITE");
  const watchLeagues = FOOTBALL_LEAGUES.filter((league) => league.tier === "WATCH");
  const globalLeagues = FOOTBALL_LEAGUES.filter((league) => league.tier === "GLOBAL");
  return {
    system_status: "FOOTBALL_GLOBAL_SHADOW_PAPER_ONLY",
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    real_candidate_count: 0,
    shadow_paper_only: true,
    real_paper_only: false,
    favorite_leagues: favoriteLeagues,
    watch_leagues: watchLeagues,
    global_leagues: globalLeagues,
    global_leagues_collapsed: marketLab.global_leagues_collapsed,
    blocked_markets: rows.filter((row) => row.status === "BLOCKED"),
    league_market_performance: rows,
    best_current_market: best,
    worst_current_market: worst,
    favorite_leagues_without_data: marketLab.favorite_leagues_without_data,
    next_closest_to_50: marketLab.next_closest_to_50,
    recommended_action: buildRecommendedAction(rows),
    next_goal: "20 cerradas para salir de muestra temprana; 50 para WATCH; 75 para READY_FOR_REVIEW.",
    guardrails: {
      real_candidate_must_remain_zero: true,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };
}






