import { getClosingWindowWatch } from "./closing-window-watch.js";
import { tradingLocalDate } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type ClosingCaptureDraftInput = {
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

function suggestedSourceName(sport: string) {
  return sport === "baseball" ? "sportsbook_manual_verified" : "sportsbook_manual_verified";
}

function suggestedBookmaker(sport: string) {
  return sport === "baseball" ? "SportsDataIO / visible sportsbook" : "Stake / visible bookmaker";
}

function sourceLabel(sport: string) {
  return sport === "baseball" ? "verified MLB market screen/API snapshot" : "verified football market screen";
}

function draftStatus(status: string) {
  if (status === "IN_VALID_CLOSING_WINDOW") return "CAPTURE_CLOSING_NOW";
  if (status === "MISSED_WINDOW") return "MISSED_WINDOW";
  if (status === "CAPTURED_ON_TIME") return "CAPTURED_ON_TIME";
  if (status === "CAPTURED_TOO_EARLY") return "CAPTURED_TOO_EARLY";
  if (status === "CAPTURED_LATE") return "CAPTURED_LATE";
  return "WAITING_WINDOW";
}

function actionFor(status: string) {
  if (status === "CAPTURE_CLOSING_NOW") return "Fill closing_odds, captured_at and source_url, then POST manual_verified.";
  if (status === "WAITING_WINDOW") return "Prepare draft only; do not POST as closing yet.";
  if (status === "MISSED_WINDOW") return "Do not backfill pregame closing; audit only.";
  if (status === "CAPTURED_ON_TIME") return "Closing already captured on time; wait for result.";
  return "Keep visible for audit; do not feed CLV unless CAPTURED_ON_TIME.";
}

function buildPayload(row: Record<string, any>, status: string) {
  const sport = String(row.sport || "unknown").toLowerCase();
  return {
    match_id: row.match_id,
    sport,
    source_name: suggestedSourceName(sport),
    source_url: "REPLACE_WITH_VISIBLE_SOURCE_URL_OR_manual_verified_screen",
    capture_type: "closing_odds",
    captured_at: "REPLACE_WITH_ACTUAL_CAPTURE_TIMESTAMP_ISO",
    verified_by: "Carlos",
    confidence_score: 85,
    data: {
      market: row.market || null,
      selection: row.pick || null,
      closing_odds: "REPLACE_WITH_REAL_CLOSING_ODDS",
      closing_bookmaker: suggestedBookmaker(sport),
      closing_source_label: sourceLabel(sport),
      closing_source_url: "REPLACE_WITH_VISIBLE_SOURCE_URL_OR_manual_verified_screen",
      closing_odds_timestamp: "REPLACE_WITH_ACTUAL_CAPTURE_TIMESTAMP_ISO",
      scheduled_kickoff: row.kickoff || null
    }
  };
}

function priorityFor(status: string, minutes: number | null) {
  const statusWeight: Record<string, number> = {
    CAPTURE_CLOSING_NOW: 1,
    WAITING_WINDOW: 2,
    CAPTURED_ON_TIME: 5,
    CAPTURED_TOO_EARLY: 6,
    CAPTURED_LATE: 8,
    MISSED_WINDOW: 9
  };
  return (statusWeight[status] || 10) * 1000 + Math.max(0, minutes ?? 240);
}

export async function getClosingCaptureDraft(db: Queryable, input: ClosingCaptureDraftInput = {}) {
  const date = localDate(input.date);
  const sport = normalizeSport(input.sport);
  const watch = await getClosingWindowWatch(db, {
    date,
    sport,
    limit: input.limit || 120
  });

  const rows = (watch.rows || []).map((row: Record<string, any>) => {
    const status = draftStatus(String(row.current_status || ""));
    const minutes = row.minutes_until_kickoff === null || row.minutes_until_kickoff === undefined
      ? null
      : Number(row.minutes_until_kickoff);
    const payload = buildPayload(row, status);
    return {
      match_id: row.match_id || null,
      ticket_id: row.ticket_id || null,
      sport: row.sport || "unknown",
      league: row.league || null,
      match: row.match || "Unknown match",
      market: row.market || null,
      selection: row.pick || null,
      entry_odds: row.entry_odds || null,
      expected_value: row.expected_value || null,
      scheduled_kickoff: row.kickoff || null,
      minutes_until_kickoff: minutes,
      closing_window_start: row.valid_window?.start || null,
      closing_window_end: row.valid_window?.end || null,
      closing_why_invalid: row.closing_why_invalid || null,
      minutes_from_valid_window: row.minutes_from_valid_window ?? null,
      source_name_suggested: suggestedSourceName(String(row.sport || "")),
      bookmaker_suggested: suggestedBookmaker(String(row.sport || "")),
      state: status,
      action: actionFor(status),
      manual_verified_endpoint: "POST /api/trading/source-capture/manual-verified",
      payload_draft: payload,
      payload_draft_json: JSON.stringify(payload, null, 2),
      safe_to_post_now: status === "CAPTURE_CLOSING_NOW",
      priority: priorityFor(status, minutes)
    };
  }).sort((a: Record<string, any>, b: Record<string, any>) => Number(a.priority) - Number(b.priority));

  const count = (status: string) => rows.filter((row) => row.state === status).length;
  const ready = rows.find((row) => row.state === "CAPTURE_CLOSING_NOW");
  return {
    system_status: "CLOSING_CAPTURE_DRAFT_SAFE_V1",
    date,
    sport,
    persistence_mode: "READ_ONLY_DRAFTS",
    scanned: rows.length,
    waiting_window: count("WAITING_WINDOW"),
    capture_closing_now: count("CAPTURE_CLOSING_NOW"),
    missed_window: count("MISSED_WINDOW"),
    captured_on_time: count("CAPTURED_ON_TIME"),
    safe_to_post_now: count("CAPTURE_CLOSING_NOW"),
    rows,
    recommendation: ready
      ? `Completar cuota real y timestamp para ${ready.match}; solo POST si la fuente visible esta verificada.`
      : "Preparar borradores; no enviar closing hasta que el estado sea CAPTURE_CLOSING_NOW.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
