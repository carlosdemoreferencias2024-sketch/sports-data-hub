import { getMatchPreflightStatus } from "./match-preflight-engine.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type ScheduleInput = {
  date?: string;
  limit?: number;
};

function localDate(date?: string) {
  return date || new Date().toLocaleDateString("en-CA", { timeZone: "America/Matamoros" });
}

function minutesUntil(kickoff?: string | null) {
  if (!kickoff) return null;
  const parsed = new Date(kickoff);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.round((parsed.getTime() - Date.now()) / 60000);
}

function addMinutesIso(kickoff: string | null | undefined, minutes: number) {
  if (!kickoff) return null;
  const parsed = new Date(kickoff);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() + minutes * 60000).toISOString();
}

function currentWindow(minutes: number | null) {
  if (minutes === null) return "UNKNOWN";
  if (minutes > 90) return "WAITING_90_60";
  if (minutes >= 60) return "WINDOW_90_60";
  if (minutes > 45) return "BETWEEN_WINDOWS";
  if (minutes >= 20) return "WINDOW_45_20";
  if (minutes > 10) return "FINAL_GUARD";
  if (minutes >= 3) return "WINDOW_10_3";
  if (minutes >= 0) return "TOO_CLOSE_NO_AUTOMATION";
  return "POST_KICKOFF_AUDIT_ONLY";
}

function nextAction(row: Record<string, any>, win: string) {
  if (win === "POST_KICKOFF_AUDIT_ONLY") return "No ejecutar captura pregame fuera de ventana.";
  if (win === "WINDOW_10_3") return "Permitir ForceClosing si la cuota es verificable.";
  if (win === "WINDOW_45_20") return "Correr scripts\\run_mlb_near_start_context.cmd -Apply para lineups/batting order.";
  if (win === "WINDOW_90_60") return "Correr scripts\\run_mlb_near_start_context.cmd -Apply para pitchers/bullpen/contexto inicial.";
  if (!row.pitcher_ready || !row.bullpen_context_ready) return "Esperar ventana 90-60 para pitchers/bullpen.";
  if (!row.lineup_ready || !row.batting_order_complete) return "Esperar ventana 45-20 para lineups/batting order.";
  if (!row.closing_ready) return "Esperar ventana 10-3 para closing valido.";
  return "Mantener auditoria; no activar dinero real.";
}

export async function getMlbNearStartSchedule(db: Queryable, input: ScheduleInput = {}) {
  const date = localDate(input.date);
  const preflight = await getMatchPreflightStatus(db, {
    date,
    sport: "baseball",
    limit: input.limit || 120
  });
  const rows = (preflight.rows || []).map((row: Record<string, any>) => {
    const minutes = minutesUntil(row.kickoff || null);
    const win = currentWindow(minutes);
    return {
      match_id: row.match_id,
      snapshot_id: row.real_paper_snapshot_id,
      teams: row.match,
      kickoff: row.kickoff,
      first_pitch: row.kickoff,
      minutes_until_first_pitch: minutes,
      window_90_60: {
        start: addMinutesIso(row.kickoff, -90),
        end: addMinutesIso(row.kickoff, -60)
      },
      window_45_20: {
        start: addMinutesIso(row.kickoff, -45),
        end: addMinutesIso(row.kickoff, -20)
      },
      window_10_3: {
        start: addMinutesIso(row.kickoff, -10),
        end: addMinutesIso(row.kickoff, -3)
      },
      current_window: win,
      next_action: nextAction(row, win),
      pitcher_ready: Boolean(row.pitcher_ready),
      pitcher_stats_ready: Boolean(row.pitcher_stats_ready),
      lineup_ready: Boolean(row.lineup_ready),
      batting_order_complete: Boolean(row.batting_order_complete),
      park_ready: Boolean(row.park_context_ready),
      weather_ready: Boolean(row.weather_context_ready),
      bullpen_ready: Boolean(row.bullpen_context_ready),
      closing_ready: Boolean(row.closing_ready),
      preflight_status: row.preflight_status,
      missing: row.missing || []
    };
  });

  return {
    system_status: "MLB_NEAR_START_SCHEDULE_SAFE_V1",
    date,
    persistence_mode: "READ_ONLY_ORCHESTRATION",
    scanned: rows.length,
    in_window_90_60: rows.filter((row) => row.current_window === "WINDOW_90_60").length,
    in_window_45_20: rows.filter((row) => row.current_window === "WINDOW_45_20").length,
    in_window_10_3: rows.filter((row) => row.current_window === "WINDOW_10_3").length,
    post_kickoff_audit_only: rows.filter((row) => row.current_window === "POST_KICKOFF_AUDIT_ONLY").length,
    rows,
    recommendation: rows.some((row) => row.current_window === "WINDOW_10_3")
      ? "Hay juego MLB en ventana 10-3: permitir ForceClosing solo con cuota verificable."
      : rows.some((row) => row.current_window === "WINDOW_45_20" || row.current_window === "WINDOW_90_60")
        ? "Hay ventana MLB near-start activa: correr contexto verificado, no confirmar sin closing."
        : "No hay ventana MLB activa; esperar la siguiente ventana.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}

export async function runMlbNearStartSchedule(db: Queryable, input: ScheduleInput = {}) {
  return {
    ...(await getMlbNearStartSchedule(db, input)),
    run_mode: "SAFE_SCHEDULER_NO_SHELL",
    applied: false,
    note: "Este endpoint agenda/recomienda ventanas. No ejecuta scripts, no captura closing y no activa apuestas reales."
  };
}
