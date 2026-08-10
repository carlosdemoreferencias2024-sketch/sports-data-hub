import { getClosingWindowWatch } from "./closing-window-watch.js";
import { getMatchPreflightStatus } from "./match-preflight-engine.js";
import { getMlbNearStartSchedule } from "./mlb-near-start-schedule.js";
import { closingWindowStatusNow, tradingLocalDate, TRADING_TIME_ZONE } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type OperationalWindowInput = {
  date?: string;
  sport?: string;
  limit?: number;
};

type QueueRow = {
  match_id: string | null;
  ticket_id: string | null;
  match: string;
  sport: string;
  league: string | null;
  kickoff: string | null;
  minutes_until_start: number | null;
  window: string;
  action: string;
  command: string;
  missing: string[];
  status: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  next_step: string;
  can_be_manual_verified: boolean;
  blocked_by_external_source: boolean;
  closing_status: string | null;
  preflight_status: string | null;
  priority: number;
};

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function normalizeSport(input?: string) {
  const sport = String(input || "all").toLowerCase();
  if (["football", "soccer", "futbol", "fÃºtbol"].includes(sport)) return "soccer";
  if (["baseball", "mlb"].includes(sport)) return "baseball";
  return "all";
}

function localTime(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString("es-MX", {
    timeZone: TRADING_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit"
  });
}

function firstBottleneck(row: Record<string, any>) {
  const details = Array.isArray(row.bottleneck_details) ? row.bottleneck_details : [];
  return details.find((detail) => String(detail.data_status || "") !== "READY") || details[0] || {};
}

function hasManualPath(row: Record<string, any>) {
  const details = Array.isArray(row.bottleneck_details) ? row.bottleneck_details : [];
  return details.some((detail) => Boolean(detail.can_be_manual_verified));
}

function hasExternalBlock(row: Record<string, any>) {
  const details = Array.isArray(row.bottleneck_details) ? row.bottleneck_details : [];
  return details.some((detail) => {
    const level = String(detail.blocking_level || "");
    const source = String(detail.source_needed || "").toLowerCase();
    return level === "SOURCE_MISSING"
      || level === "MANUAL_VERIFICATION_NEEDED"
      || source.includes("manual")
      || source.includes("bookmaker")
      || source.includes("weather api");
  });
}

function riskFor(status: string, row: Record<string, any>, closingStatus?: string | null): "LOW" | "MEDIUM" | "HIGH" {
  const missing = Array.isArray(row.missing) ? row.missing : [];
  if (["MISSED_WINDOW", "POST_KICKOFF_AUDIT_ONLY"].includes(status)) return "HIGH";
  if (closingStatus === "CAPTURED_LATE" || closingStatus === "MISSED_WINDOW") return "HIGH";
  if (missing.includes("odds_model_ev") || missing.includes("ticket")) return "HIGH";
  if (hasExternalBlock(row)) return "HIGH";
  if (["RUN_NEAR_START_NOW", "CAPTURE_CLOSING_NOW", "READY_FOR_SETTLEMENT"].includes(status)) return "MEDIUM";
  return "LOW";
}

function commandFor(status: string, sport: string) {
  if (status === "RUN_NEAR_START_NOW" && sport === "baseball") return "scripts\\run_mlb_near_start_context.cmd -Apply";
  if (status === "RUN_NEAR_START_NOW" && sport === "soccer") return "POST /api/trading/football/lineups/manual-verified";
  if (status === "CAPTURE_CLOSING_NOW" && sport === "baseball") return "scripts\\run_auto_mlb_real_paper.cmd -ForceClosing";
  if (status === "CAPTURE_CLOSING_NOW" && sport === "soccer") return "scripts\\run_football_shadow_settlement.cmd -InputPath <verified_closing.json> -Apply";
  if (status === "READY_FOR_SETTLEMENT" && sport === "soccer") return "POST /api/trading/football/settlement/run?date=YYYY-MM-DD";
  if (status === "READY_FOR_SETTLEMENT" && sport === "baseball") return "Verificar resultado oficial; correr settlement MLB aprobado.";
  return "No ejecutar comando automatico; mantener lectura/auditoria.";
}

function nextStepFor(status: string, sport: string, row: Record<string, any>, bottleneck: Record<string, any>) {
  if (status === "CAPTURE_CLOSING_NOW") {
    return sport === "baseball"
      ? "Capturar closing MLB solo con cuota verificable y antes del first pitch."
      : "Capturar cuota real verificada ahora; aplicar solo si queda CAPTURED_ON_TIME.";
  }
  if (status === "RUN_NEAR_START_NOW") {
    return sport === "baseball"
      ? "Actualizar pitchers, lineups, batting order, bullpen, park/weather; no confirmar sin closing."
      : "Cargar lineup/portero/bajas con fuente oficial o manual_verified confiable.";
  }
  if (status === "READY_FOR_SETTLEMENT") return "Verificar resultado final antes de liquidar; no settlement con marcador dudoso.";
  if (status === "WAITING_RESULT") return "Esperar marcador final verificado; closing ya debe estar on-time.";
  if (status === "MISSED_WINDOW") return "No rescatar como pregame; conservar solo auditoria post-kickoff.";
  if (status === "POST_KICKOFF_AUDIT_ONLY") return "Partido iniciado o ventana perdida; no modificar snapshot pregame.";
  if (String(row.preflight_status || "") === "NO_FINANCIAL_BET") return "Cargar cuotas reales + timestamp + model_probability + EV; no crear pick sin mercado.";
  return bottleneck.recommended_action || row.next_action || "Esperar la siguiente ventana operativa.";
}

function deriveStatus(
  row: Record<string, any>,
  closingRow: Record<string, any> | undefined,
  mlbRow: Record<string, any> | undefined
) {
  const sport = String(row.sport || "");
  const minutes = closingWindowStatusNow(row.kickoff || null).minutes_until_kickoff;
  const preflightStatus = String(row.preflight_status || "");
  const closingStatus = closingRow ? String(closingRow.current_status || "") : null;
  const missing = Array.isArray(row.missing) ? row.missing : [];

  if (preflightStatus === "POST_KICKOFF_AUDIT_ONLY") return "POST_KICKOFF_AUDIT_ONLY";
  if (closingStatus === "MISSED_WINDOW" || (minutes !== null && minutes < 3 && !row.closing_ready)) return "MISSED_WINDOW";
  if (closingStatus === "IN_VALID_CLOSING_WINDOW") return "CAPTURE_CLOSING_NOW";
  if (row.settlement_ready) return "READY_FOR_SETTLEMENT";
  if (row.closing_ready && missing.includes("result")) return "WAITING_RESULT";

  if (sport === "baseball") {
    const win = String(mlbRow?.current_window || "");
    if (["WINDOW_90_60", "WINDOW_45_20"].includes(win)) return "RUN_NEAR_START_NOW";
    if (win === "WINDOW_10_3") return row.context_ready ? "CAPTURE_CLOSING_NOW" : "RUN_NEAR_START_NOW";
    if (win === "POST_KICKOFF_AUDIT_ONLY") return "POST_KICKOFF_AUDIT_ONLY";
  }

  if (sport === "soccer") {
    const needsLineup = missing.includes("player_intelligence_lineup") || missing.includes("goalkeeper");
    if (needsLineup && minutes !== null && minutes <= 60 && minutes >= 15) return "RUN_NEAR_START_NOW";
  }

  return "WAITING_WINDOW";
}

function priorityFor(status: string, minutes: number | null, risk: string) {
  const statusWeight: Record<string, number> = {
    CAPTURE_CLOSING_NOW: 1,
    RUN_NEAR_START_NOW: 2,
    READY_FOR_SETTLEMENT: 3,
    WAITING_RESULT: 4,
    WAITING_WINDOW: 5,
    MISSED_WINDOW: 8,
    POST_KICKOFF_AUDIT_ONLY: 9
  };
  const riskPenalty = risk === "HIGH" ? -60 : risk === "MEDIUM" ? -30 : 0;
  return (statusWeight[status] || 10) * 1000 + Math.max(0, minutes ?? 240) + riskPenalty;
}

export async function getOperationalWindowQueue(db: Queryable, input: OperationalWindowInput = {}) {
  const date = localDate(input.date);
  const sport = normalizeSport(input.sport);
  const limit = Math.max(1, Math.min(300, Number(input.limit || 120)));
  const [preflight, closingWatch, mlbSchedule] = await Promise.all([
    getMatchPreflightStatus(db, { date, sport, limit }),
    getClosingWindowWatch(db, { date, sport, limit }),
    sport === "soccer"
      ? Promise.resolve({ rows: [] as Record<string, any>[] })
      : getMlbNearStartSchedule(db, { date, limit })
  ]);

  const closingByKey = new Map<string, Record<string, any>>();
  for (const row of closingWatch.rows || []) {
    if (row.ticket_id) closingByKey.set(String(row.ticket_id), row);
    if (row.match_id) closingByKey.set(String(row.match_id), row);
  }
  const mlbByMatch = new Map<string, Record<string, any>>();
  for (const row of mlbSchedule.rows || []) {
    if (row.match_id) mlbByMatch.set(String(row.match_id), row);
  }

  const rows: QueueRow[] = (preflight.rows || []).map((row: Record<string, any>) => {
    const key = row.paper_trade_id || row.real_paper_snapshot_id || row.match_id;
    const closingRow = key ? closingByKey.get(String(key)) || closingByKey.get(String(row.match_id || "")) : undefined;
    const mlbRow = row.match_id ? mlbByMatch.get(String(row.match_id)) : undefined;
    const bottleneck = firstBottleneck(row);
    const status = deriveStatus(row, closingRow, mlbRow);
    const minutes = closingWindowStatusNow(row.kickoff || null).minutes_until_kickoff;
    const risk = riskFor(status, row, closingRow?.current_status);
    const window = status === "CAPTURE_CLOSING_NOW"
      ? "10-to-3 closing"
      : status === "RUN_NEAR_START_NOW"
        ? (row.sport === "baseball" ? String(mlbRow?.current_window || "near-start") : "football 60-to-15")
        : closingRow?.current_status || mlbRow?.current_window || bottleneck.next_run_window || "waiting";

    return {
      match_id: row.match_id || null,
      ticket_id: row.paper_trade_id || row.real_paper_snapshot_id || null,
      match: row.match || "Unknown match",
      sport: row.sport || "unknown",
      league: row.league || null,
      kickoff: row.kickoff || null,
      minutes_until_start: minutes,
      window,
      action: status,
      command: commandFor(status, row.sport || "unknown"),
      missing: Array.isArray(row.missing) ? row.missing.slice(0, 10) : [],
      status,
      risk,
      next_step: nextStepFor(status, row.sport || "unknown", row, bottleneck),
      can_be_manual_verified: hasManualPath(row),
      blocked_by_external_source: hasExternalBlock(row),
      closing_status: closingRow?.current_status || null,
      preflight_status: row.preflight_status || null,
      priority: priorityFor(status, minutes, risk)
    };
  }).sort((a, b) => a.priority - b.priority);

  const count = (status: string) => rows.filter((row) => row.status === status).length;
  const manualCount = rows.filter((row) => row.can_be_manual_verified).length;
  const blockedCount = rows.filter((row) => row.blocked_by_external_source).length;
  const nextNow = rows.find((row) => ["CAPTURE_CLOSING_NOW", "RUN_NEAR_START_NOW", "READY_FOR_SETTLEMENT"].includes(row.status));

  return {
    system_status: "OPERATIONAL_WINDOW_ORCHESTRATOR_SAFE_V1",
    date,
    sport,
    persistence_mode: "READ_ONLY_ORCHESTRATION",
    scanned: rows.length,
    current_time: new Date().toISOString(),
    summary: {
      run_near_start_now: count("RUN_NEAR_START_NOW"),
      capture_closing_now: count("CAPTURE_CLOSING_NOW"),
      waiting_window: count("WAITING_WINDOW"),
      missed_window: count("MISSED_WINDOW"),
      ready_for_settlement: count("READY_FOR_SETTLEMENT"),
      waiting_result: count("WAITING_RESULT"),
      post_kickoff_audit_only: count("POST_KICKOFF_AUDIT_ONLY"),
      manual_verified_available: manualCount,
      external_source_blocked: blockedCount
    },
    rows,
    recommendation: nextNow
      ? `Accion inmediata: ${nextNow.status} para ${nextNow.match}. ${nextNow.next_step}`
      : "No hay accion inmediata; esperar ventanas o cargar fuentes verificadas pendientes.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
