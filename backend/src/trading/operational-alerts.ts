import { getOperationalWindowQueue } from "./operational-window-orchestrator.js";
import { closingWindowStatusNow, tradingLocalDate } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type OperationalAlertsInput = {
  date?: string;
  sport?: string;
  limit?: number;
};

type AlertRow = {
  match_id: string | null;
  ticket_id: string | null;
  match: string;
  sport: string;
  kickoff: string | null;
  alert_type: string;
  alert_time: string | null;
  minutes_until_alert: number | null;
  minutes_until_kickoff: number | null;
  window_status: string;
  action: string;
  severity: "INFO" | "WATCH" | "NOW" | "MISSED";
  source_needed: string;
  safe_to_post_now: boolean;
  no_real_money: true;
  command: string;
  next_step: string;
};

const ALERT_MILESTONES = [
  {
    minutesBeforeKickoff: 30,
    alertType: "PREPARE_SOURCE",
    action: "Preparar fuente visible y dashboard.",
    severity: "INFO" as const
  },
  {
    minutesBeforeKickoff: 15,
    alertType: "OPEN_DASHBOARD_SOURCE",
    action: "Abrir dashboard y fuente verificable.",
    severity: "WATCH" as const
  },
  {
    minutesBeforeKickoff: 10,
    alertType: "PREPARE_SCREENSHOT",
    action: "Preparar screenshot/evidencia; no capturar closing antes de ventana.",
    severity: "WATCH" as const
  },
  {
    minutesBeforeKickoff: 7,
    alertType: "CAPTURE_CLOSING_NOW",
    action: "Capturar closing real verificado ahora si la fuente es valida.",
    severity: "NOW" as const
  },
  {
    minutesBeforeKickoff: 3,
    alertType: "LAST_CALL_CLOSING",
    action: "Ultimo aviso: cerrar captura pregame; despues sera audit only.",
    severity: "NOW" as const
  },
  {
    minutesBeforeKickoff: 0,
    alertType: "KICKOFF_AUDIT_ONLY",
    action: "Cerrar ventana; desde kickoff solo auditoria.",
    severity: "MISSED" as const
  }
];

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function normalizeSport(input?: string) {
  const sport = String(input || "all").toLowerCase();
  if (["football", "soccer", "futbol", "fútbol"].includes(sport)) return "soccer";
  if (["baseball", "mlb"].includes(sport)) return "baseball";
  return "all";
}

function addMinutesIso(timestamp: string | null | undefined, minutes: number) {
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() + minutes * 60000).toISOString();
}

function minutesUntil(iso: string | null) {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return Number(((parsed.getTime() - Date.now()) / 60000).toFixed(3));
}

function sourceNeededFor(row: Record<string, any>, alertType: string) {
  const missing = Array.isArray(row.missing) ? row.missing.map((item) => String(item).toLowerCase()) : [];
  const sport = String(row.sport || "").toLowerCase();
  if (alertType.includes("CLOSING")) {
    return sport === "baseball"
      ? "sportsbook_manual_verified / sportsdataio / bookmaker_verified"
      : "sportsbook_manual_verified / bookmaker_verified";
  }
  if (sport === "baseball" && missing.some((item) => item.includes("pitcher") || item.includes("lineup") || item.includes("batting_order"))) {
    return "mlb_stats_manual_verified / mlb_official_manual_verified";
  }
  if (sport === "soccer" && missing.some((item) => item.includes("goalkeeper") || item.includes("lineup"))) {
    return "official_lineup / 365scores_manual_verified / flashscore_manual_verified";
  }
  if (missing.some((item) => item.includes("result"))) return "official_result_manual_verified";
  return row.blocked_by_external_source ? "manual_verified_source" : "dashboard_review";
}

function statusForRow(row: Record<string, any>) {
  const status = String(row.status || row.action || "");
  if (status === "CAPTURE_CLOSING_NOW") return "CAPTURE_CLOSING_NOW";
  if (status === "RUN_NEAR_START_NOW") return "RUN_NEAR_START_NOW";
  if (status === "READY_FOR_SETTLEMENT") return "READY_FOR_SETTLEMENT";
  if (status === "MISSED_WINDOW") return "MISSED_WINDOW";
  if (status === "POST_KICKOFF_AUDIT_ONLY") return "POST_KICKOFF_AUDIT_ONLY";
  return closingWindowStatusNow(row.kickoff || null).current_status;
}

function rowPriority(row: AlertRow) {
  const severityWeight: Record<string, number> = { NOW: 0, WATCH: 1, INFO: 2, MISSED: 4 };
  const alertDistance = row.minutes_until_alert === null ? 9999 : Math.abs(row.minutes_until_alert);
  const latePenalty = row.minutes_until_alert !== null && row.minutes_until_alert < -2 ? 500 : 0;
  return (severityWeight[row.severity] ?? 3) * 1000 + alertDistance + latePenalty;
}

function buildAlertsForQueueRow(row: Record<string, any>): AlertRow[] {
  const kickoff = row.kickoff ? String(row.kickoff) : null;
  const minutesUntilKickoff = row.minutes_until_start === null || row.minutes_until_start === undefined
    ? closingWindowStatusNow(kickoff).minutes_until_kickoff
    : Number(row.minutes_until_start);
  const windowStatus = statusForRow(row);
  const alerts: AlertRow[] = [];

  if (windowStatus === "READY_FOR_SETTLEMENT") {
    alerts.push({
      match_id: row.match_id || null,
      ticket_id: row.ticket_id || null,
      match: row.match || "Unknown match",
      sport: row.sport || "unknown",
      kickoff,
      alert_type: "READY_FOR_SETTLEMENT",
      alert_time: new Date().toISOString(),
      minutes_until_alert: 0,
      minutes_until_kickoff: minutesUntilKickoff,
      window_status: "READY_FOR_SETTLEMENT",
      action: "Verificar resultado final y correr settlement solo si esta confirmado.",
      severity: "NOW",
      source_needed: "official_result_manual_verified",
      safe_to_post_now: false,
      no_real_money: true,
      command: row.command || "POST settlement solo con resultado verificado",
      next_step: row.next_step || "Esperar resultado final verificable."
    });
    return alerts;
  }

  if (["MISSED_WINDOW", "POST_KICKOFF_AUDIT_ONLY"].includes(windowStatus)) {
    alerts.push({
      match_id: row.match_id || null,
      ticket_id: row.ticket_id || null,
      match: row.match || "Unknown match",
      sport: row.sport || "unknown",
      kickoff,
      alert_type: windowStatus,
      alert_time: kickoff,
      minutes_until_alert: minutesUntilKickoff,
      minutes_until_kickoff: minutesUntilKickoff,
      window_status: windowStatus,
      action: "No rescatar como pregame; conservar solo auditoria.",
      severity: "MISSED",
      source_needed: "audit_only",
      safe_to_post_now: false,
      no_real_money: true,
      command: "No ejecutar closing ni near-start tardio.",
      next_step: row.next_step || "Esperar siguiente slate."
    });
    return alerts;
  }

  for (const milestone of ALERT_MILESTONES) {
    const alertTime = addMinutesIso(kickoff, -milestone.minutesBeforeKickoff);
    const minutesUntilAlert = minutesUntil(alertTime);
    const currentWindowStatus = milestone.alertType === "CAPTURE_CLOSING_NOW"
      ? (windowStatus === "CAPTURE_CLOSING_NOW" || windowStatus === "IN_VALID_CLOSING_WINDOW" ? "CAPTURE_CLOSING_NOW" : windowStatus)
      : windowStatus;
    alerts.push({
      match_id: row.match_id || null,
      ticket_id: row.ticket_id || null,
      match: row.match || "Unknown match",
      sport: row.sport || "unknown",
      kickoff,
      alert_type: milestone.alertType,
      alert_time: alertTime,
      minutes_until_alert: minutesUntilAlert,
      minutes_until_kickoff: minutesUntilKickoff,
      window_status: currentWindowStatus,
      action: milestone.action,
      severity: milestone.severity,
      source_needed: sourceNeededFor(row, milestone.alertType),
      safe_to_post_now: milestone.alertType === "CAPTURE_CLOSING_NOW" && currentWindowStatus === "CAPTURE_CLOSING_NOW",
      no_real_money: true,
      command: milestone.alertType === "CAPTURE_CLOSING_NOW" ? row.command || "POST manual_verified solo con evidencia" : "No ejecutar apuestas.",
      next_step: row.next_step || "Esperar ventana operativa."
    });
  }

  return alerts;
}

export async function getOperationalAlerts(db: Queryable, input: OperationalAlertsInput = {}) {
  const date = localDate(input.date);
  const sport = normalizeSport(input.sport);
  const limit = Math.max(1, Math.min(300, Number(input.limit || 120)));
  const queue = await getOperationalWindowQueue(db, { date, sport, limit });
  const allAlerts = (queue.rows || [])
    .flatMap(buildAlertsForQueueRow)
    .filter((row) => {
      if (row.minutes_until_alert === null) return true;
      return row.minutes_until_alert <= 45 && row.minutes_until_alert >= -30;
    })
    .sort((a, b) => rowPriority(a) - rowPriority(b))
    .slice(0, limit);

  const count = (alertType: string) => allAlerts.filter((row) => row.alert_type === alertType).length;
  const nowAlerts = allAlerts.filter((row) => row.severity === "NOW").length;
  const missedAlerts = allAlerts.filter((row) => row.severity === "MISSED").length;
  const safeToPost = allAlerts.filter((row) => row.safe_to_post_now).length;

  return {
    system_status: "OPERATIONAL_ALERTS_SAFE_V1",
    date,
    sport,
    persistence_mode: "READ_ONLY_DASHBOARD_AND_INTERNAL_LOG",
    scanned: queue.rows?.length || 0,
    alerts: allAlerts.length,
    summary: {
      prepare_source: count("PREPARE_SOURCE"),
      open_dashboard_source: count("OPEN_DASHBOARD_SOURCE"),
      prepare_screenshot: count("PREPARE_SCREENSHOT"),
      capture_closing_now: count("CAPTURE_CLOSING_NOW"),
      last_call_closing: count("LAST_CALL_CLOSING"),
      kickoff_audit_only: count("KICKOFF_AUDIT_ONLY"),
      ready_for_settlement: count("READY_FOR_SETTLEMENT"),
      missed_window: count("MISSED_WINDOW") + count("POST_KICKOFF_AUDIT_ONLY"),
      now_alerts: nowAlerts,
      missed_alerts: missedAlerts,
      safe_to_post_now: safeToPost
    },
    rows: allAlerts,
    recommendation: safeToPost > 0
      ? "Hay alerta CAPTURE_CLOSING_NOW: capturar evidencia/cuota solo si la fuente es valida."
      : nowAlerts > 0
        ? "Hay alerta operativa inmediata; revisar fuente o settlement sin apostar."
        : "No hay alerta inmediata; preparar fuentes y esperar ventana.",
    telegram: {
      allowed: process.env.TELEGRAM_ALERTS_ONLY === "true",
      mode: process.env.TELEGRAM_ALERTS_ONLY === "true" ? "ALERTS_ONLY_NO_PICKS" : "OFF",
      picks_allowed: false
    },
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      auto_post_allowed: false,
      picks_created: 0,
      parlays_created: 0,
      no_real_money: true,
      kill_switch_enabled: true
    }
  };
}
