import { getMatchPreflightStatus } from "./match-preflight-engine.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type MatchDataHarvesterInput = {
  date?: string;
  sport?: string;
  window?: string;
  limit?: number;
};

function localDate(date?: string) {
  return date || new Date().toLocaleDateString("en-CA", { timeZone: "America/Matamoros" });
}

function minutesUntilKickoff(kickoff?: string | null) {
  if (!kickoff) return null;
  const timestamp = new Date(kickoff).getTime();
  if (Number.isNaN(timestamp)) return null;
  return Math.round((timestamp - Date.now()) / 60000);
}

function detectWindow(minutesUntil: number | null, requested?: string) {
  const forced = String(requested || "auto").toLowerCase();
  if (forced !== "auto") return forced;
  if (minutesUntil === null) return "unknown";
  if (minutesUntil > 360) return "early";
  if (minutesUntil > 90) return "pre_match";
  if (minutesUntil > 30) return "near_start";
  if (minutesUntil > 10) return "lineup_lock";
  if (minutesUntil >= 3) return "closing_window";
  if (minutesUntil < -120) return "post_match";
  return "post_kickoff_audit";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function actionForRow(row: Record<string, any>, harvestWindow: string) {
  const missing = Array.isArray(row.missing) ? row.missing.map(String) : [];
  const actions: string[] = [];
  if (missing.includes("odds_model_ev")) actions.push("market_quotes_model_ev");
  if (missing.includes("player_intelligence_lineup") || missing.includes("lineup_batting_order")) actions.push("lineup");
  if (missing.includes("home_lineup") || missing.includes("away_lineup") || missing.includes("lineup_context")) actions.push("lineup");
  if (missing.includes("batting_order_complete")) actions.push("batting_order");
  if (missing.includes("goalkeeper")) actions.push("goalkeeper");
  if (missing.includes("pitcher_context") || missing.includes("probable_pitcher_home") || missing.includes("probable_pitcher_away")) actions.push("pitcher");
  if (missing.includes("home_pitcher_stats") || missing.includes("away_pitcher_stats")) actions.push("pitcher_stats");
  if (missing.includes("bullpen_context")) actions.push("bullpen_context");
  if (missing.includes("park_context")) actions.push("park_context");
  if (missing.includes("weather_context")) actions.push("weather_context");
  if (missing.includes("team_intelligence")) actions.push("team_context");
  if (missing.includes("closing_odds_snapshot") && harvestWindow === "closing_window") actions.push("closing_candidate");
  if (missing.includes("result") && ["post_match", "post_kickoff_audit"].includes(harvestWindow)) actions.push("result_candidate");
  return uniqueStrings(actions);
}

function summarize(rows: Array<Record<string, any>>, requestedWindow?: string) {
  const missing: Record<string, number> = {};
  const actions: Record<string, number> = {};
  const harvestRows = rows.map((row) => {
    const minutes_until_kickoff = minutesUntilKickoff(row.kickoff || null);
    const harvest_window = detectWindow(minutes_until_kickoff, requestedWindow);
    const recommended_actions = actionForRow(row, harvest_window);
    recommended_actions.forEach((action) => {
      actions[action] = (actions[action] || 0) + 1;
    });
    (Array.isArray(row.missing) ? row.missing : []).forEach((item: unknown) => {
      const key = String(item);
      missing[key] = (missing[key] || 0) + 1;
    });
    return {
      match_id: row.match_id,
      match: row.match,
      sport: row.sport,
      league: row.league,
      kickoff: row.kickoff,
      minutes_until_kickoff,
      harvest_window,
      preflight_status: row.preflight_status,
      recommended_actions,
      missing: row.missing || [],
      next_action: row.next_action
    };
  });

  return {
    scanned: harvestRows.length,
    updated: 0,
    lineups_updated: 0,
    goalkeepers_updated: 0,
    pitchers_updated: 0,
    results_updated: 0,
    closing_candidates: actions.closing_candidate || 0,
    result_candidates: actions.result_candidate || 0,
    missing,
    action_counts: actions,
    rows: harvestRows
  };
}

export async function getMatchDataHarvesterStatus(db: Queryable, input: MatchDataHarvesterInput = {}) {
  const date = localDate(input.date);
  const preflight = await getMatchPreflightStatus(db, {
    date,
    sport: input.sport || "all",
    limit: input.limit || 120
  });
  const summary = summarize(preflight.rows || [], input.window);
  return {
    system_status: "MATCH_DATA_HARVESTER_SAFE_V1",
    date,
    sport: input.sport || "all",
    window: input.window || "auto",
    persistence_mode: "READ_ONLY_SAFE_V1",
    ...summary,
    errors: [],
    recommendation: summary.closing_candidates > 0
      ? "Hay candidatos para closing; capturar solo si la cuota es verificable y esta en ventana 10 a 3 min."
      : summary.result_candidates > 0
        ? "Hay partidos candidatos a resultado; no correr settlement sin marcador final verificado."
        : "Harvester en modo reporte: muestra faltantes y acciones sin escribir datos.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}

export async function runMatchDataHarvester(db: Queryable, input: MatchDataHarvesterInput = {}) {
  return {
    ...(await getMatchDataHarvesterStatus(db, input)),
    run_mode: "READ_ONLY_SAFE_V1",
    applied: false
  };
}
