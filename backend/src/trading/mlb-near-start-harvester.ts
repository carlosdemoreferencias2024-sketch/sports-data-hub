import { getMatchPreflightStatus } from "./match-preflight-engine.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type MlbNearStartHarvesterInput = {
  date?: string;
  apply?: boolean;
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

function windowLabel(minutes: number | null) {
  if (minutes === null) return "UNKNOWN";
  if (minutes > 360) return "EARLY_FIXTURE_MARKET";
  if (minutes > 90) return "PITCHER_BULLPEN_PREMATCH";
  if (minutes > 45) return "LINEUP_WATCH_90_45";
  if (minutes > 20) return "LINEUP_LOCK_45_20";
  if (minutes >= 3) return "CLOSING_WINDOW_10_3";
  if (minutes < 0) return "POST_KICKOFF_AUDIT_ONLY";
  return "FINAL_PREGAME_GUARD";
}

function recommendedActions(row: Record<string, any>, window: string) {
  const missing = Array.isArray(row.missing) ? row.missing.map(String) : [];
  const actions: string[] = [];
  if (missing.includes("probable_pitcher_home") || missing.includes("probable_pitcher_away")) actions.push("fetch_probable_pitchers");
  if (missing.includes("home_pitcher_stats") || missing.includes("away_pitcher_stats")) actions.push("hydrate_pitcher_stats");
  if (missing.includes("home_lineup") || missing.includes("away_lineup") || missing.includes("lineup_batting_order")) actions.push("fetch_lineups");
  if (missing.includes("batting_order_complete")) actions.push("verify_batting_order");
  if (missing.includes("bullpen_context")) actions.push("hydrate_bullpen_72h");
  if (missing.includes("park_context") || missing.includes("weather_context")) actions.push("run_park_weather_context");
  if (missing.includes("closing_odds_snapshot") && window === "CLOSING_WINDOW_10_3") actions.push("capture_closing_odds");
  return [...new Set(actions)];
}

export async function getMlbNearStartHarvesterStatus(db: Queryable, input: MlbNearStartHarvesterInput = {}) {
  const date = localDate(input.date);
  const preflight = await getMatchPreflightStatus(db, {
    date,
    sport: "baseball",
    limit: input.limit || 120
  });
  const rows = (preflight.rows || []).map((row: Record<string, any>) => {
    const minutes_until_kickoff = minutesUntilKickoff(row.kickoff || null);
    const harvest_window = windowLabel(minutes_until_kickoff);
    return {
      match_id: row.match_id,
      snapshot_id: row.real_paper_snapshot_id,
      match: row.match,
      kickoff: row.kickoff,
      minutes_until_kickoff,
      harvest_window,
      preflight_status: row.preflight_status,
      pitcher_ready: row.pitcher_ready,
      pitcher_stats_ready: row.pitcher_stats_ready,
      lineup_ready: row.lineup_ready,
      batting_order_complete: row.batting_order_complete,
      bullpen_ready: row.bullpen_context_ready,
      park_ready: row.park_context_ready,
      weather_ready: row.weather_context_ready,
      closing_ready: row.closing_ready,
      missing: row.missing || [],
      recommended_actions: recommendedActions(row, harvest_window),
      next_command: ["LINEUP_WATCH_90_45", "LINEUP_LOCK_45_20", "PITCHER_BULLPEN_PREMATCH"].includes(harvest_window)
        ? "scripts\\run_mlb_near_start_context.cmd -Apply"
        : (harvest_window === "CLOSING_WINDOW_10_3"
          ? "scripts\\run_auto_mlb_real_paper.cmd -ForceClosing"
          : "No ejecutar captura pregame fuera de ventana.")
    };
  });
  const count = (predicate: (row: Record<string, any>) => boolean) => rows.filter(predicate).length;
  return {
    system_status: "MLB_NEAR_START_HARVESTER_SAFE_V1",
    date,
    persistence_mode: "READ_ONLY_ORCHESTRATION",
    scanned: rows.length,
    pitcher_ready: count((row) => row.pitcher_ready),
    lineup_ready: count((row) => row.lineup_ready),
    batting_order_complete: count((row) => row.batting_order_complete),
    bullpen_ready: count((row) => row.bullpen_ready),
    park_weather_ready: count((row) => row.park_ready && row.weather_ready),
    waiting_valid_closing: count((row) => row.preflight_status === "WAITING_VALID_CLOSING"),
    post_kickoff_audit_only: count((row) => row.preflight_status === "POST_KICKOFF_AUDIT_ONLY"),
    ready_for_settlement: count((row) => row.preflight_status === "READY_FOR_SETTLEMENT"),
    confirmed_paper: 0,
    real_candidate: 0,
    rows,
    recommendation: rows.some((row) => row.harvest_window === "LINEUP_LOCK_45_20" || row.harvest_window === "LINEUP_WATCH_90_45")
      ? "Correr near-start MLB para lineups/batting order. No confirmar sin closing valido."
      : "No hay ventana near-start MLB activa; mantener auditoria segura.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}

export async function runMlbNearStartHarvester(db: Queryable, input: MlbNearStartHarvesterInput = {}) {
  return {
    ...(await getMlbNearStartHarvesterStatus(db, input)),
    run_mode: "READ_ONLY_ORCHESTRATION",
    applied: false,
    note: "Este endpoint no inventa datos ni ejecuta scripts externos; usa scripts\\run_mlb_near_start_context.cmd -Apply durante la ventana correcta."
  };
}
