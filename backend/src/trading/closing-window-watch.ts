import { getMatchPreflightStatus } from "./match-preflight-engine.js";
import { closingWindowStatusNow, tradingLocalDate } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type ClosingWindowInput = {
  date?: string;
  sport?: string;
  limit?: number;
};

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function normalizeSport(input?: string) {
  const sport = String(input || "all").toLowerCase();
  if (["football", "soccer", "futbol", "fútbol"].includes(sport)) return "soccer";
  if (["baseball", "mlb"].includes(sport)) return "baseball";
  return "all";
}

function watchStatus(row: Record<string, any>, windowStatus: string) {
  const quality = String(row.closing_quality || "");
  if (row.closing_ready || quality === "CAPTURED_ON_TIME") return "CAPTURED_ON_TIME";
  if (quality === "CAPTURED_TOO_EARLY") return "CAPTURED_TOO_EARLY";
  if (quality === "CAPTURED_LATE") return "CAPTURED_LATE";
  return windowStatus;
}

function nextAction(status: string, sport: string) {
  if (status === "IN_VALID_CLOSING_WINDOW") {
    return sport === "baseball"
      ? "Run MLB ForceClosing only with verified market odds."
      : "Capture verified bookmaker closing now; apply only if CAPTURED_ON_TIME.";
  }
  if (status === "MISSED_WINDOW") return "Do not backfill pregame closing; keep post-kickoff audit only.";
  if (status === "CAPTURED_TOO_EARLY") return "Keep visible but exclude from CLV/segments; recapture in valid window if still possible.";
  if (status === "CAPTURED_LATE") return "Keep audit only; exclude from pregame CLV.";
  if (status === "CAPTURED_ON_TIME") return "Wait for verified final result, then settlement.";
  return "Wait for 10-to-3-minute closing window.";
}

function priority(status: string, minutes: number | null, hasPositiveEv: boolean) {
  const statusWeight: Record<string, number> = {
    IN_VALID_CLOSING_WINDOW: 1,
    WAITING_WINDOW: 3,
    CAPTURED_TOO_EARLY: 5,
    CAPTURED_LATE: 7,
    MISSED_WINDOW: 8,
    CAPTURED_ON_TIME: 9
  };
  return (statusWeight[status] || 10) * 1000 + Math.max(0, minutes ?? 240) - (hasPositiveEv ? 100 : 0);
}

export async function getClosingWindowWatch(db: Queryable, input: ClosingWindowInput = {}) {
  const date = localDate(input.date);
  const sport = normalizeSport(input.sport);
  const preflight = await getMatchPreflightStatus(db, {
    date,
    sport,
    limit: input.limit || 120
  });

  const rows = (preflight.rows || [])
    .filter((row: Record<string, any>) => row.paper_trade_id || row.real_paper_snapshot_id || row.financial_ready)
    .map((row: Record<string, any>) => {
      const windowStatus = closingWindowStatusNow(row.kickoff || null);
      const minutes = windowStatus.minutes_until_kickoff;
      const status = watchStatus(row, windowStatus.current_status);
      const hasPositiveEv = Number(row.expected_value || 0) > 0;
      return {
        match_id: row.match_id,
        ticket_id: row.paper_trade_id || row.real_paper_snapshot_id,
        match: row.match,
        sport: row.sport,
        league: row.league,
        kickoff: row.kickoff,
        minutes_until_kickoff: minutes,
        valid_window: windowStatus.valid_window,
        current_status: status,
        tickets: 1,
        market: row.market,
        pick: row.pick,
        entry_odds: row.entry_odds,
        expected_value: row.expected_value,
        closing_quality: row.closing_quality,
        closing_window_start: row.closing_window_start || row.raw_data?.closing_window_start || null,
        closing_window_end: row.closing_window_end || row.raw_data?.closing_window_end || null,
        closing_why_invalid: row.closing_why_invalid || row.raw_data?.closing_why_invalid || null,
        minutes_from_valid_window: row.minutes_from_valid_window ?? row.raw_data?.minutes_from_valid_window ?? null,
        closing_ready: row.closing_ready,
        next_action: nextAction(status, row.sport),
        priority: priority(status, minutes, hasPositiveEv)
      };
    })
    .sort((a: Record<string, any>, b: Record<string, any>) => Number(a.priority) - Number(b.priority));

  const count = (status: string) => rows.filter((row) => row.current_status === status).length;
  return {
    system_status: "CLOSING_WINDOW_WATCH_SAFE_V1",
    date,
    sport,
    persistence_mode: "READ_ONLY",
    scanned: rows.length,
    waiting_window: count("WAITING_WINDOW"),
    in_valid_closing_window: count("IN_VALID_CLOSING_WINDOW"),
    missed_window: count("MISSED_WINDOW"),
    captured_on_time: count("CAPTURED_ON_TIME"),
    captured_too_early: count("CAPTURED_TOO_EARLY"),
    captured_late: count("CAPTURED_LATE"),
    football_waiting_closing: rows.filter((row) => row.sport === "soccer" && ["WAITING_WINDOW", "IN_VALID_CLOSING_WINDOW"].includes(row.current_status)).length,
    mlb_missed_or_waiting_closing: rows.filter((row) => row.sport === "baseball" && ["WAITING_WINDOW", "IN_VALID_CLOSING_WINDOW", "MISSED_WINDOW"].includes(row.current_status)).length,
    rows,
    recommendation: rows.some((row) => row.current_status === "IN_VALID_CLOSING_WINDOW")
      ? "Hay tickets en ventana valida: capturar closing verificable ahora."
      : "No hay closing capturable en este momento; esperar ventana valida o mantener auditoria.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
