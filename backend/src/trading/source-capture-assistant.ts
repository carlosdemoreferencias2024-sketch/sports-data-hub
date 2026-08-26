import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { getClosingCaptureDraft } from "./closing-capture-draft.js";
import { getBottleneckBySource } from "./match-preflight-engine.js";
import { getManualVerifiedSource, getManualVerifiedSourceRegistry } from "./source-registry.js";
import { closingWindowDiagnostics, tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type AssistantQuery = {
  date?: string;
  sport?: string;
  limit?: number;
};

type EvidenceInput = {
  match_id?: unknown;
  sport?: unknown;
  capture_type?: unknown;
  source_name?: unknown;
  source_url?: unknown;
  verified_by?: unknown;
  intended_market?: unknown;
  intended_selection?: unknown;
  captured_at?: unknown;
  visible_text?: unknown;
  screenshot_base64?: unknown;
  data?: unknown;
};

const ALLOWED_CAPTURE_TYPES = new Set([
  "closing_odds",
  "current_odds",
  "lineup",
  "goalkeeper",
  "near_start_context",
  "result",
  "match_status",
  "official_inactives",
  "starting_quarterbacks"
]);

const MARKET_CAPTURE_TYPES = new Set(["closing_odds", "current_odds"]);
const MARKET_SOURCES = new Set(["sportsbook_manual_verified", "bookmaker_manual_verified", "sportsdataio_manual_verified"]);
const CONTEXT_ONLY_SOURCES = new Set([
  "365scores_manual_verified",
  "flashscore_manual_verified",
  "espn_manual_verified",
  "foxsports_manual_verified"
]);

function normalizeSport(value?: unknown) {
  const sport = String(value || "all").trim().toLowerCase();
  if (["soccer", "football", "futbol", "fútbol"].includes(sport)) return "soccer";
  if (["baseball", "mlb"].includes(sport)) return "baseball";
  if (["basketball", "nba"].includes(sport)) return "basketball";
  if (["american_football", "american-football", "nfl"].includes(sport)) return "american_football";
  return "all";
}

function normalizeCaptureType(value?: unknown) {
  const captureType = String(value || "").trim().toLowerCase();
  if (!ALLOWED_CAPTURE_TYPES.has(captureType)) throw new Error("capture_type_not_allowed_for_assistant_v1");
  return captureType;
}

function requiredString(value: unknown, key: string) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key}_required`);
  return value.trim();
}

function parseOptionalDate(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return new Date().toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error("captured_at_invalid");
  return parsed.toISOString();
}

function dataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function hashPart(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .slice(0, 80) || "unknown";
}

function safeFilePart(value: unknown) {
  return hashPart(value).replace(/[:]+/g, "_").slice(0, 90);
}

function sha256Hex(value: Buffer | string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function uploadRoot() {
  return path.resolve(process.cwd(), "uploads", "source-captures");
}

function sourceSafety(sourceName: string, captureType: string, sport: string) {
  const source = getManualVerifiedSource(sourceName);
  const reasons: string[] = [];
  if (!source) reasons.push("source_name_not_allowed");
  if (MARKET_CAPTURE_TYPES.has(captureType) && !MARKET_SOURCES.has(sourceName)) {
    reasons.push("market_odds_require_sportsbook_or_authorized_market_source");
  }
  if (MARKET_CAPTURE_TYPES.has(captureType) && CONTEXT_ONLY_SOURCES.has(sourceName)) {
    reasons.push("365scores_flashscore_not_allowed_for_market_odds");
  }
  if (sourceName === "mlb_official_manual_verified" && MARKET_CAPTURE_TYPES.has(captureType)) {
    reasons.push("mlb_official_cannot_provide_market_odds");
  }
  if (sport === "baseball" && captureType === "goalkeeper") {
    reasons.push("goalkeeper_not_valid_for_mlb");
  }
  return {
    safe: reasons.length === 0,
    reasons,
    source
  };
}

function captureTypeFromMissing(row: Record<string, any>) {
  const missing = String(row.missing_field || row.source_needed || "").toLowerCase();
  if (missing.includes("closing")) return "closing_odds";
  if (missing.includes("odds") || missing.includes("market")) return "current_odds";
  if (missing.includes("goalkeeper") || missing.includes("portero")) return "goalkeeper";
  if (missing.includes("lineup") || missing.includes("alineaci") || missing.includes("batting_order")) return "lineup";
  if (missing.includes("inactive")) return "official_inactives";
  if (missing.includes("quarterback") || missing.includes("starting_qb")) return "starting_quarterbacks";
  if (missing.includes("result") || missing.includes("score")) return "result";
  if (missing.includes("status")) return "match_status";
  return "match_status";
}

function suggestedSource(captureType: string, sport: string) {
  if (MARKET_CAPTURE_TYPES.has(captureType)) return "sportsbook_manual_verified";
  if (sport === "baseball" && ["result", "match_status", "lineup"].includes(captureType)) return "mlb_stats_manual_verified";
  if (sport === "american_football" && captureType === "official_inactives") return "nfl_inactives_manual_verified";
  if (sport === "american_football" && ["starting_quarterbacks", "result", "match_status"].includes(captureType)) return "nfl_official_manual_verified";
  if (captureType === "result" || captureType === "match_status") return "official_league_manual_verified";
  if (captureType === "lineup" || captureType === "goalkeeper") return "official_club_manual_verified";
  if (captureType === "near_start_context") return "official_league_manual_verified";
  return "official_league_manual_verified";
}

function baseDraft(input: {
  match_id: unknown;
  sport: string;
  capture_type: string;
  source_name: string;
  source_url?: unknown;
  verified_by?: unknown;
  intended_market?: unknown;
  intended_selection?: unknown;
  captured_at?: unknown;
  data?: Record<string, any>;
}) {
  const capturedAt = String(input.captured_at || "REPLACE_WITH_ACTUAL_CAPTURE_TIMESTAMP_ISO");
  const data = input.data || {};
  return {
    match_id: input.match_id,
    sport: input.sport,
    source_name: input.source_name,
    source_url: input.source_url || "REPLACE_WITH_VISIBLE_SOURCE_URL_OR_manual_verified_screen",
    capture_type: input.capture_type,
    captured_at: capturedAt,
    verified_by: input.verified_by || "Carlos",
    confidence_score: data.confidence_score ?? 85,
    data: {
      market: input.intended_market || data.market || null,
      selection: input.intended_selection || data.selection || null,
      odds: data.odds ?? null,
      closing_odds: input.capture_type === "closing_odds" ? data.closing_odds ?? data.odds ?? "REPLACE_WITH_REAL_CLOSING_ODDS" : undefined,
      odds_timestamp: input.capture_type === "current_odds" ? capturedAt : undefined,
      closing_odds_timestamp: input.capture_type === "closing_odds" ? capturedAt : undefined,
      scheduled_kickoff: data.scheduled_kickoff || null,
      bookmaker: data.bookmaker || null,
      upstream_evidence_id: data.upstream_evidence_id || null,
      upstream_evidence_sha256: data.upstream_evidence_sha256 || null,
      provider_raw_sha256: data.provider_raw_sha256 || null,
      scraper_context: data.normalized_event ? {
        provider: data.provider || null,
        provider_event_id: data.provider_event_id || data.source_event_id || null,
        match_fingerprint: data.match_fingerprint || null,
        competition: data.competition || null,
        normalized_event: data.normalized_event
      } : null,
      status: input.capture_type === "match_status" ? data.status || "REPLACE_WITH_VERIFIED_STATUS" : undefined,
      result_status: input.capture_type === "result" ? data.result_status || "FINAL" : undefined,
      home_score: input.capture_type === "result" ? data.home_score ?? "REPLACE_WITH_HOME_SCORE" : undefined,
      away_score: input.capture_type === "result" ? data.away_score ?? "REPLACE_WITH_AWAY_SCORE" : undefined,
      home_lineup: input.capture_type === "near_start_context" ? data.home_lineup || [] : (input.capture_type === "lineup" ? data.home_lineup || [] : undefined),
      away_lineup: input.capture_type === "near_start_context" ? data.away_lineup || [] : (input.capture_type === "lineup" ? data.away_lineup || [] : undefined),
      formation_home: input.capture_type === "near_start_context" ? data.formation_home || null : undefined,
      formation_away: input.capture_type === "near_start_context" ? data.formation_away || null : undefined,
      goalkeeper_home: input.capture_type === "near_start_context" ? data.goalkeeper_home || null : (input.capture_type === "goalkeeper" ? data.goalkeeper_home || "REPLACE_WITH_HOME_GK" : undefined),
      goalkeeper_away: input.capture_type === "near_start_context" ? data.goalkeeper_away || null : (input.capture_type === "goalkeeper" ? data.goalkeeper_away || "REPLACE_WITH_AWAY_GK" : undefined),
      lineup_status: input.capture_type === "near_start_context" ? data.lineup_status || "UNKNOWN" : undefined,
      goalkeeper_status: input.capture_type === "near_start_context" ? data.goalkeeper_status || "UNKNOWN" : undefined,
      availability_status: input.capture_type === "near_start_context" ? data.availability_status || "SOURCE_NOT_PROVIDED" : undefined,
      player_availability_manual_verified: input.capture_type === "near_start_context" ? data.player_availability_manual_verified === true : undefined,
      unavailable_players: input.capture_type === "near_start_context" ? data.unavailable_players || [] : undefined,
      injuries: input.capture_type === "near_start_context" ? data.injuries || [] : undefined,
      suspensions: input.capture_type === "near_start_context" ? data.suspensions || [] : undefined,
      availability_details: input.capture_type === "near_start_context" ? data.availability_details || [] : undefined,
      availability_provider: input.capture_type === "near_start_context" ? data.availability_provider || null : undefined,
      availability_provider_raw_sha256: input.capture_type === "near_start_context" ? data.availability_provider_raw_sha256 || null : undefined,
      availability_source_url: input.capture_type === "near_start_context" ? data.availability_source_url || null : undefined,
      normalized_event: input.capture_type === "near_start_context" ? data.normalized_event || null : data.normalized_event || undefined,
      official_inactives: input.capture_type === "official_inactives" ? data.official_inactives || [] : undefined,
      official_inactives_confirmed: input.capture_type === "official_inactives" ? data.official_inactives_confirmed ?? true : undefined,
      starting_quarterback_home: input.capture_type === "starting_quarterbacks" ? data.starting_quarterback_home || "REPLACE_WITH_HOME_QB" : undefined,
      starting_quarterback_away: input.capture_type === "starting_quarterbacks" ? data.starting_quarterback_away || "REPLACE_WITH_AWAY_QB" : undefined,
      starting_quarterbacks_confirmed: input.capture_type === "starting_quarterbacks" ? data.starting_quarterbacks_confirmed ?? true : undefined
    }
  };
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefined(entry)])
    );
  }
  return value;
}

function stateForDraft(captureType: string, safe: boolean, windowStatus?: string) {
  if (!safe) return "REJECTED_UNSAFE_SOURCE";
  if (captureType === "closing_odds") {
    if (windowStatus === "CAPTURE_CLOSING_NOW") return "SAFE_TO_POST_MANUAL_VERIFIED";
    if (windowStatus === "MISSED_WINDOW") return "MISSED_WINDOW";
    return "DRAFT_READY";
  }
  return "DRAFT_READY";
}

export async function getSourceCaptureAssistant(db: Queryable, input: AssistantQuery = {}) {
  const date = localDate(input.date);
  const sport = normalizeSport(input.sport);
  const limit = Math.max(1, Math.min(200, Number(input.limit || 120)));
  const [closingDraft, bottlenecks] = await Promise.all([
    getClosingCaptureDraft(db, { date, sport, limit }),
    getBottleneckBySource(db, { date, sport, limit })
  ]);

  const closingRows = (closingDraft.rows || []).map((row: Record<string, any>) => {
    const sourceName = "sportsbook_manual_verified";
    const safety = sourceSafety(sourceName, "closing_odds", String(row.sport || "all").toLowerCase());
    const state = stateForDraft("closing_odds", safety.safe, String(row.state || ""));
    const draft = row.payload_draft || baseDraft({
      match_id: row.match_id,
      sport: String(row.sport || "all").toLowerCase(),
      capture_type: "closing_odds",
      source_name: sourceName,
      intended_market: row.market,
      intended_selection: row.selection,
      data: { scheduled_kickoff: row.scheduled_kickoff }
    });
    return {
      match_id: row.match_id,
      ticket_id: row.ticket_id || null,
      match: row.match,
      sport: row.sport,
      league: row.league || null,
      capture_type: "closing_odds",
      source_name: sourceName,
      source_url: "manual_verified_screen",
      window_status: row.state,
      evidence_status: "DRAFT_ONLY",
      state,
      safe_to_post_now: state === "SAFE_TO_POST_MANUAL_VERIFIED",
      draft_ready: true,
      evidence_captured: false,
      screenshot_path: null,
      intended_market: row.market || null,
      intended_selection: row.selection || null,
      scheduled_kickoff: row.scheduled_kickoff || null,
      next_action: state === "SAFE_TO_POST_MANUAL_VERIFIED"
        ? "Capture screenshot, fill real closing_odds, then human-confirm POST manual_verified."
        : row.action || "Prepare source before the valid window; do not POST yet.",
      safety_reasons: safety.reasons,
      payload_draft: stripUndefined(draft),
      payload_draft_json: JSON.stringify(stripUndefined(draft), null, 2),
      priority: state === "SAFE_TO_POST_MANUAL_VERIFIED" ? 1 : row.priority || 2000
    };
  });

  const bottleneckRows = (bottlenecks.rows || [])
    .filter((row: Record<string, any>) => row.can_be_manual_verified)
    .slice(0, limit)
    .map((row: Record<string, any>) => {
      const captureType = captureTypeFromMissing(row);
      const rowSport = normalizeSport(row.sport);
      const sourceName = suggestedSource(captureType, rowSport);
      const safety = sourceSafety(sourceName, captureType, rowSport);
      const matchId = Array.isArray(row.match_ids) ? row.match_ids[0] : row.match_id || null;
      const draft = baseDraft({
        match_id: matchId || "REPLACE_WITH_MATCH_ID",
        sport: rowSport,
        capture_type: captureType,
        source_name: sourceName
      });
      return {
        match_id: matchId,
        ticket_id: null,
        match: Array.isArray(row.matches_affected) ? row.matches_affected.slice(0, 2).join(" | ") : row.match || "Multiple matches",
        sport: rowSport,
        league: row.league || null,
        capture_type: captureType,
        source_name: sourceName,
        source_url: "REPLACE_WITH_VISIBLE_SOURCE_URL",
        window_status: row.next_run_window || "-",
        evidence_status: "DRAFT_ONLY",
        state: stateForDraft(captureType, safety.safe),
        safe_to_post_now: safety.safe && captureType !== "closing_odds",
        draft_ready: true,
        evidence_captured: false,
        screenshot_path: null,
        intended_market: null,
        intended_selection: null,
        scheduled_kickoff: null,
        next_action: safety.safe
          ? `Capture evidence for ${captureType}; human confirms before manual_verified POST.`
          : "Unsafe source/type combination; choose another verified source.",
        safety_reasons: safety.reasons,
        payload_draft: stripUndefined(draft),
        payload_draft_json: JSON.stringify(stripUndefined(draft), null, 2),
        priority: safety.safe ? 3000 : 9000
      };
    });

  const rows = [...closingRows, ...bottleneckRows]
    .sort((a, b) => Number(a.priority || 9999) - Number(b.priority || 9999))
    .slice(0, limit);
  const count = (state: string) => rows.filter((row) => row.state === state).length;
  return {
    system_status: "SOURCE_CAPTURE_ASSISTANT_SAFE_V1",
    date,
    sport,
    persistence_mode: "EVIDENCE_AND_DRAFT_ONLY",
    nothing_browser_mode: "LOCAL_VISUAL_ASSISTANT_ONLY",
    piggy_daemon: {
      required: false,
      allowed_host: "127.0.0.1",
      allowed_port: 2005,
      remote_access_allowed: false,
      proxy_rotation_allowed: false,
      captcha_solving_allowed: false,
      login_automation_allowed: false,
      auto_post_allowed: false
    },
    scanned: rows.length,
    draft_ready: rows.filter((row) => row.draft_ready).length,
    evidence_captured: rows.filter((row) => row.evidence_captured).length,
    safe_to_post_now: rows.filter((row) => row.safe_to_post_now).length,
    waiting_human_confirmation: count("WAITING_HUMAN_CONFIRMATION"),
    rejected_unsafe_source: count("REJECTED_UNSAFE_SOURCE"),
    rows,
    recommendation: rows.some((row) => row.safe_to_post_now)
      ? "Hay captura segura lista: tomar screenshot, llenar dato real y confirmar manual_verified. No autopost."
      : "Preparar fuentes y drafts; Nothing Browser/Piggy solo debe asistir visualmente, no decidir picks.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true,
      auto_scrape_allowed: false,
      auto_post_allowed: false,
      confirmed_pick: false
    }
  };
}

export async function recordSourceCaptureAssistantEvidence(db: Queryable, body: EvidenceInput = {}) {
  const matchId = requiredString(body.match_id, "match_id");
  const sport = normalizeSport(body.sport);
  if (sport === "all") throw new Error("sport_required");
  const captureType = normalizeCaptureType(body.capture_type);
  const sourceName = requiredString(body.source_name, "source_name");
  const sourceUrl = requiredString(body.source_url, "source_url");
  const verifiedBy = requiredString(body.verified_by, "verified_by");
  const capturedAt = parseOptionalDate(body.captured_at);
  const data = dataObject(body.data);
  const safety = sourceSafety(sourceName, captureType, sport);
  if (!safety.safe) {
    return {
      system_status: "SOURCE_CAPTURE_ASSISTANT_EVIDENCE_SAFE_V1",
      applied: false,
      evidence_status: "REJECTED_UNSAFE_SOURCE",
      rejected: true,
      reason: safety.reasons.join(","),
      guardrails: {
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false,
        kill_switch_enabled: true,
        auto_post_allowed: false
      }
    };
  }

  const match = await db.query(
    `
      SELECT
        m.id,
        m.match_date,
        COALESCE(pem.home_team_name, home_team.name, 'Home') AS home_team_name,
        COALESCE(pem.away_team_name, away_team.name, 'Away') AS away_team_name
      FROM v_valid_matches m
      LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = m.id AND pem.is_active = TRUE
      LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
      LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      WHERE m.id = $1::uuid
      LIMIT 1
    `,
    [matchId]
  );
  if (!match.rows.length) throw new Error("match_id_not_found");
  const kickoff = match.rows[0].match_date ? new Date(match.rows[0].match_date).toISOString() : null;
  const closing = captureType === "closing_odds"
    ? closingWindowDiagnostics(capturedAt, String(data.scheduled_kickoff || kickoff || ""))
    : null;
  const safeToPost = captureType === "closing_odds"
    ? closing?.closing_quality === "CAPTURED_ON_TIME"
    : true;
  const evidenceDate = tradingLocalDateWindow(capturedAt.slice(0, 10)).selectedDate;
  const dir = path.join(uploadRoot(), evidenceDate);
  await fs.mkdir(dir, { recursive: true });
  const idempotencyKey = [
    hashPart(matchId),
    hashPart(captureType),
    hashPart(sourceName),
    hashPart(capturedAt),
    hashPart(verifiedBy)
  ].join("__");
  const fileBase = `${safeFilePart(capturedAt)}__${safeFilePart(captureType)}__${safeFilePart(matchId)}`;
  let screenshotPath: string | null = null;
  let screenshotSha256: string | null = null;
  const screenshotRaw = typeof body.screenshot_base64 === "string" ? body.screenshot_base64.trim() : "";
  if (screenshotRaw) {
    const normalized = screenshotRaw.includes(",") ? screenshotRaw.split(",").pop() || "" : screenshotRaw;
    const buffer = Buffer.from(normalized, "base64");
    screenshotSha256 = sha256Hex(buffer);
    screenshotPath = path.join(dir, `${fileBase}.png`);
    await fs.writeFile(screenshotPath, buffer);
  }
  const visibleText = typeof body.visible_text === "string" ? body.visible_text.slice(0, 6000) : null;
  const evidenceId = sha256Hex([
    idempotencyKey,
    sourceUrl,
    screenshotSha256 || "",
    visibleText || "",
    JSON.stringify(data)
  ].join("|")).slice(0, 32);
  const draft = stripUndefined(baseDraft({
    match_id: matchId,
    sport,
    capture_type: captureType,
    source_name: sourceName,
    source_url: sourceUrl,
    verified_by: verifiedBy,
    intended_market: body.intended_market,
    intended_selection: body.intended_selection,
    captured_at: capturedAt,
    data: {
      ...data,
      scheduled_kickoff: data.scheduled_kickoff || kickoff
    }
  }));
  const evidence = {
    idempotency_key: idempotencyKey,
    match_id: matchId,
    match: `${match.rows[0].home_team_name} vs ${match.rows[0].away_team_name}`,
    sport,
    capture_type: captureType,
    source_name: sourceName,
    source_url: sourceUrl,
    screenshot_path: screenshotPath,
    evidence_path: path.join(dir, `${fileBase}.json`),
    evidence_id: evidenceId,
    upstream_evidence_id: data.upstream_evidence_id || null,
    upstream_evidence_sha256: data.upstream_evidence_sha256 || null,
    bookmaker: data.bookmaker || null,
    scraper_context: data.normalized_event ? {
      provider: data.provider || null,
      provider_event_id: data.provider_event_id || data.source_event_id || null,
      match_fingerprint: data.match_fingerprint || null,
      competition: data.competition || null,
      normalized_event: data.normalized_event
    } : null,
    captured_at: capturedAt,
    created_at: new Date().toISOString(),
    verified_by: verifiedBy,
    screenshot_sha256: screenshotSha256,
    visible_text: visibleText,
    evidence_status: screenshotPath || visibleText ? "EVIDENCE_CAPTURED" : "DRAFT_READY",
    workflow_state: screenshotPath || visibleText ? "WAITING_HUMAN_CONFIRMATION" : "DRAFT_READY",
    safe_to_post_now: safeToPost,
    closing_quality: closing?.closing_quality || null,
    closing_window_start: closing?.closing_window_start || null,
    closing_window_end: closing?.closing_window_end || null,
    closing_why_invalid: closing?.why_invalid || null,
    manual_verified_endpoint: "POST /api/trading/source-capture/manual-verified",
    payload_draft: draft,
    payload_draft_json: JSON.stringify(draft, null, 2),
    auto_posted: false,
    picks_created: 0,
    real_candidate: 0,
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true,
      auto_post_allowed: false,
      auto_scrape_allowed: false
    }
  };
  await fs.writeFile(evidence.evidence_path, JSON.stringify(evidence, null, 2), "utf8");
  return {
    system_status: "SOURCE_CAPTURE_ASSISTANT_EVIDENCE_SAFE_V1",
    applied: true,
    rejected: false,
    ...evidence
  };
}

export function getSourceCaptureAssistantRules() {
  return {
    system_status: "SOURCE_CAPTURE_ASSISTANT_RULES_SAFE_V1",
    allowed_capture_types: Array.from(ALLOWED_CAPTURE_TYPES),
    source_registry: getManualVerifiedSourceRegistry(),
    rules: [
      "Nothing Browser/Piggy is allowed only as a local visual assistant on 127.0.0.1.",
      "No bypass, anti-bot evasion, captcha solving, proxy rotation, login automation, or mass scraping.",
      "Evidence creates screenshot/text/draft only; it never posts manual_verified automatically.",
      "closing_odds/current_odds require sportsbook_manual_verified/bookmaker_manual_verified/sportsdataio_manual_verified.",
      "365Scores/Flashscore are context-only and cannot provide market odds.",
      "MLB official sources cannot provide odds."
    ],
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true,
      auto_post_allowed: false,
      auto_scrape_allowed: false
    }
  };
}
