import { closingWindowDiagnostics, closingWindowStatusNow, tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";
import { normalizeSportForFilter } from "./sport-taxonomy.js";
import { ALLOWED_MARKET_SOURCES, validateClosingSnapshot, validateEntrySnapshot } from "./market-integrity-policy.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type CacheQuery = {
  date?: string;
  sport?: string;
  limit?: number;
};

type ManualSnapshotInput = {
  match_id?: unknown;
  sport?: unknown;
  league?: unknown;
  market?: unknown;
  market_type?: unknown;
  selection?: unknown;
  odds?: unknown;
  bookmaker?: unknown;
  source_name?: unknown;
  source_url?: unknown;
  captured_at?: unknown;
  expires_at?: unknown;
  verified_by?: unknown;
  snapshot_type?: unknown;
  window_status?: unknown;
  evidence_id?: unknown;
  screenshot_sha256?: unknown;
  line?: unknown;
  raw_data?: unknown;
};

const ALLOWED_SELECTIONS = new Set(["home", "away", "draw", "over", "under", "yes", "no", "home_draw", "home_away", "draw_away"]);
const ALLOWED_SNAPSHOT_TYPES = new Set(["entry", "current", "closing"]);

function requiredString(value: unknown, key: string) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key}_required`);
  return value.trim();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseDate(value: unknown, key: string) {
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) throw new Error(`${key}_invalid`);
  return parsed.toISOString();
}

function parseOptionalDate(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  return parseDate(value, "expires_at");
}

function parseOdds(value: unknown) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds <= 1) throw new Error("odds_invalid");
  return odds;
}

function parseLine(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const line = Number(value);
  if (!Number.isFinite(line)) throw new Error("line_invalid");
  return line;
}

function rawObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function snapshotRole(snapshotType: string) {
  if (snapshotType === "entry") return "entry";
  if (snapshotType === "closing") return "closing";
  return "market";
}

function staleStatus(expiresAt: string | null, capturedAt: string) {
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return "STALE";
  const ageMs = Date.now() - new Date(capturedAt).getTime();
  if (ageMs > 15 * 60000) return "STALE_BY_AGE";
  return "FRESH";
}

function localDate(date?: string) {
  return date || tradingLocalDate();
}

async function matchContext(db: Queryable, matchId: string) {
  const result = await db.query(
    `
      SELECT
        m.id AS match_id,
        m.match_date AS kickoff,
        m.status,
        l.slug AS league_slug,
        CASE
          WHEN l.slug IN ('mlb', 'baseball/mlb') THEN 'baseball'
          WHEN l.slug = 'nba' THEN 'basketball'
          WHEN l.slug LIKE '%world-cup%' OR s.slug = 'soccer' THEN 'soccer'
          ELSE s.slug
        END AS sport_slug
      FROM matches m
      JOIN leagues l ON l.id = m.league_id
      JOIN sports s ON s.id = l.sport_id
      WHERE m.id = $1
      LIMIT 1;
    `,
    [matchId]
  );
  if (!result.rows[0]) throw new Error("match_not_found");
  return result.rows[0];
}

function safetyForSnapshot(input: {
  snapshotType: string;
  sourceName: string;
  capturedAt: string;
  expiresAt: string | null;
  kickoff: string | null;
  requestedWindowStatus: string | null;
  evidenceId: string | null;
  screenshotSha256: string | null;
}) {
  if (!ALLOWED_MARKET_SOURCES.has(input.sourceName)) throw new Error("market_snapshot_source_not_allowed");
  const nowWindow = closingWindowStatusNow(input.kickoff);
  const closingDiagnostics = input.snapshotType === "closing"
    ? closingWindowDiagnostics(input.capturedAt, input.kickoff)
    : null;
  const timingSafeForClosing = input.snapshotType === "closing"
    && closingDiagnostics?.closing_quality === "CAPTURED_ON_TIME"
    && ["CAPTURE_CLOSING_NOW", "IN_VALID_CLOSING_WINDOW", "CAPTURED_ON_TIME"].includes(input.requestedWindowStatus || nowWindow.current_status);
  const kickoffMs = input.kickoff ? new Date(input.kickoff).getTime() : NaN;
  const capturedMs = new Date(input.capturedAt).getTime();
  const timingSafeForEntry = ["entry", "current"].includes(input.snapshotType)
    && Number.isFinite(kickoffMs)
    && capturedMs < kickoffMs;
  const status = staleStatus(input.expiresAt, input.capturedAt);
  const integrityInput = {
    capturedAt: input.capturedAt,
    kickoff: input.kickoff,
    sourceName: input.sourceName,
    evidenceId: input.evidenceId,
    screenshotSha256: input.screenshotSha256,
    snapshotType: input.snapshotType,
    staleStatus: status,
    safeForEntry: timingSafeForEntry,
    safeForClosing: timingSafeForClosing,
    canonicalMatch: true,
    duplicate: false
  };
  const entryDecision = validateEntrySnapshot(integrityInput);
  const closingDecision = validateClosingSnapshot(integrityInput);
  const safeForEntry = ["entry", "current"].includes(input.snapshotType) && entryDecision.eligible;
  const safeForClosing = input.snapshotType === "closing" && closingDecision.eligible;
  const auditOnly = input.snapshotType === "closing" ? !safeForClosing : !safeForEntry || status !== "FRESH";
  const flags = [
    "MANUAL_VERIFIED",
    status,
    auditOnly ? "AUDIT_ONLY" : null,
    safeForClosing ? "SAFE_FOR_CLOSING" : null,
    safeForEntry ? "SAFE_FOR_ENTRY" : null,
    closingDiagnostics?.closing_quality && closingDiagnostics.closing_quality !== "CAPTURED_ON_TIME" ? closingDiagnostics.closing_quality : null
  ].filter(Boolean) as string[];
  return {
    stale_status: status,
    safe_for_entry: safeForEntry,
    safe_for_closing: safeForClosing,
    audit_only: auditOnly,
    window_status: safeForClosing ? "CAPTURE_CLOSING_NOW" : nowWindow.current_status,
    closing_quality: closingDiagnostics?.closing_quality ?? null,
    closing_window_start: closingDiagnostics?.closing_window_start ?? nowWindow.valid_window.start,
    closing_window_end: closingDiagnostics?.closing_window_end ?? nowWindow.valid_window.end,
    closing_why_invalid: closingDiagnostics?.why_invalid ?? null,
    integrity_status: input.snapshotType === "closing" ? closingDecision.status : entryDecision.status,
    integrity_reasons: input.snapshotType === "closing" ? closingDecision.reasons : entryDecision.reasons,
    quality_flags: flags,
    quality_score: safeForClosing || safeForEntry ? 90 : auditOnly ? 55 : 70
  };
}

export async function getOddsSnapshotCache(db: Queryable, input: CacheQuery = {}) {
  const date = localDate(input.date);
  const window = tradingLocalDateWindow(date);
  const sport = normalizeSportForFilter(input.sport);
  const limit = Math.max(1, Math.min(300, Number(input.limit || 120)));
  const result = await db.query(
    `
      SELECT
        os.id AS snapshot_id,
        os.match_id,
        os.sport_slug AS sport,
        os.league_slug AS league,
        os.market_type AS market,
        os.selection,
        os.line,
        os.odds,
        os.bookmaker,
        os.source_name,
        COALESCE(os.raw_data->>'source_url', os.raw_data->>'closing_source_url') AS source_url,
        os.captured_at,
        os.raw_data->>'expires_at' AS expires_at,
        CASE
          WHEN m.match_date <= os.captured_at THEN 'POST_KICKOFF_AUDIT_ONLY'
          WHEN os.raw_data->>'stale_status' IS NOT NULL THEN os.raw_data->>'stale_status'
          WHEN os.captured_at < NOW() - INTERVAL '15 minutes' THEN 'STALE_BY_AGE'
          ELSE 'FRESH'
        END AS stale_status,
        os.raw_data->>'verified_by' AS verified_by,
        COALESCE(os.raw_data->>'snapshot_type', os.snapshot_role) AS snapshot_type,
        os.raw_data->>'window_status' AS window_status,
        COALESCE((os.raw_data->>'safe_for_entry')::boolean, false) AS safe_for_entry,
        COALESCE((os.raw_data->>'safe_for_closing')::boolean, false) AS safe_for_closing,
        CASE
          WHEN m.match_date <= os.captured_at THEN TRUE
          ELSE COALESCE((os.raw_data->>'audit_only')::boolean, false)
        END AS audit_only,
        os.raw_data->>'evidence_id' AS evidence_id,
        os.raw_data->>'screenshot_sha256' AS screenshot_sha256,
        os.raw_data->>'closing_quality' AS closing_quality,
        os.quality_score,
        os.quality_flags,
        m.match_date AS kickoff,
        m.status AS match_status,
        CONCAT(home_team.name, ' @ ', away_team.name) AS match
      FROM odds_snapshots os
      JOIN matches m ON m.id = os.match_id
      LEFT JOIN match_competitors mh ON mh.match_id = m.id AND mh.home_away = 'away'
      LEFT JOIN teams home_team ON home_team.id = mh.team_id
      LEFT JOIN match_competitors ma ON ma.match_id = m.id AND ma.home_away = 'home'
      LEFT JOIN teams away_team ON away_team.id = ma.team_id
      WHERE os.captured_at >= $1::timestamptz
        AND os.captured_at < $2::timestamptz
        AND ($3 = 'all' OR os.sport_slug = $3)
      ORDER BY os.captured_at DESC
      LIMIT $4;
    `,
    [window.start, window.end, sport, limit]
  );
  const rows = result.rows;
  const stale = rows.filter((row) => String(row.stale_status || "").startsWith("STALE")).length;
  return {
    system_status: "ODDS_SNAPSHOT_CACHE_SAFE_V1",
    date,
    sport,
    scanned: rows.length,
    fresh: rows.filter((row) => row.stale_status === "FRESH").length,
    stale,
    safe_for_entry: rows.filter((row) => row.safe_for_entry).length,
    safe_for_closing: rows.filter((row) => row.safe_for_closing).length,
    audit_only: rows.filter((row) => row.audit_only).length,
    rows,
    recommendation: stale > 0
      ? "Hay cuotas viejas: no usarlas como entry/closing sin recaptura."
      : "Cache de cuotas listo para auditoria; no crea picks ni CLV por si solo.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      auto_post_allowed: false,
      picks_created: 0,
      parlays_created: 0,
      kill_switch_enabled: true
    }
  };
}

export async function recordManualOddsSnapshot(db: Queryable, body: ManualSnapshotInput) {
  const matchId = requiredString(body.match_id, "match_id");
  const sourceName = requiredString(body.source_name, "source_name");
  const sourceUrl = requiredString(body.source_url, "source_url");
  const verifiedBy = requiredString(body.verified_by, "verified_by");
  const market = requiredString(body.market ?? body.market_type, "market");
  const selection = requiredString(body.selection, "selection").toLowerCase();
  if (!ALLOWED_SELECTIONS.has(selection)) throw new Error("selection_invalid");
  const snapshotType = requiredString(body.snapshot_type || "current", "snapshot_type").toLowerCase();
  if (!ALLOWED_SNAPSHOT_TYPES.has(snapshotType)) throw new Error("snapshot_type_invalid");
  const odds = parseOdds(body.odds);
  const line = parseLine(body.line);
  const bookmaker = requiredString(body.bookmaker, "bookmaker");
  const capturedAt = parseDate(body.captured_at || new Date().toISOString(), "captured_at");
  const expiresAt = parseOptionalDate(body.expires_at);
  const evidenceId = optionalString(body.evidence_id);
  const screenshotSha256 = optionalString(body.screenshot_sha256);
  const match = await matchContext(db, matchId);
  const safety = safetyForSnapshot({
    snapshotType,
    sourceName,
    capturedAt,
    expiresAt,
    kickoff: match.kickoff || null,
    requestedWindowStatus: optionalString(body.window_status),
    evidenceId,
    screenshotSha256
  });
  const rawData = {
    ...rawObject(body.raw_data),
    odds_snapshot_cache: true,
    snapshot_type: snapshotType,
    source_url: sourceUrl,
    expires_at: expiresAt,
    stale_status: safety.stale_status,
    verified_by: verifiedBy,
    window_status: safety.window_status,
    safe_for_entry: safety.safe_for_entry,
    safe_for_closing: safety.safe_for_closing,
    audit_only: safety.audit_only,
    closing_quality: safety.closing_quality,
    closing_window_start: safety.closing_window_start,
    closing_window_end: safety.closing_window_end,
    closing_why_invalid: safety.closing_why_invalid,
    evidence_id: evidenceId,
    screenshot_sha256: screenshotSha256,
    canonical_match: true,
    duplicate: false,
    integrity_status: safety.integrity_status,
    integrity_reasons: safety.integrity_reasons,
    no_real_money: true,
    auto_post_allowed: false
  };
  let marketQuoteId: string | null = null;
  if (safety.safe_for_entry && ["home", "away", "draw"].includes(selection)) {
    const quote = await db.query(
      `
        INSERT INTO market_quotes (
          match_id, provider_name, market_type, line, home_odds, away_odds,
          draw_odds, captured_at, raw_data, first_seen_at, last_seen_at, seen_count
        )
        VALUES (
          $1, $2, $3, $4,
          CASE WHEN $5 = 'home' THEN $6::numeric ELSE NULL END,
          CASE WHEN $5 = 'away' THEN $6::numeric ELSE NULL END,
          CASE WHEN $5 = 'draw' THEN $6::numeric ELSE NULL END,
          $7::timestamptz, $8::jsonb, $7::timestamptz, $7::timestamptz, 1
        )
        RETURNING id;
      `,
      [matchId, sourceName, market, line, selection, odds, capturedAt, { ...rawData, processed: true }]
    );
    marketQuoteId = quote.rows[0]?.id || null;
  }

  const inserted = await db.query(
    `
      INSERT INTO odds_snapshots (
        market_quote_id, match_id, sport_slug, league_slug, provider_name, source_name, bookmaker,
        market_type, line, selection, odds, snapshot_role, captured_at,
        quality_score, quality_flags, raw_data
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15, $16::jsonb
      )
      RETURNING id AS snapshot_id;
    `,
    [
      marketQuoteId,
      matchId,
      match.sport_slug || normalizeSportForFilter(body.sport),
      match.league_slug || optionalString(body.league),
      sourceName,
      sourceName,
      bookmaker,
      market,
      line,
      selection,
      odds,
      snapshotRole(snapshotType),
      capturedAt,
      safety.quality_score,
      safety.quality_flags,
      rawData
    ]
  );

  return {
    system_status: "ODDS_SNAPSHOT_CACHE_MANUAL_SAFE_V1",
    applied: true,
    picks_created: 0,
    real_candidate_count: 0,
    snapshot_id: inserted.rows[0]?.snapshot_id,
    market_quote_id: marketQuoteId,
    match_id: matchId,
    snapshot_type: snapshotType,
    stale_status: safety.stale_status,
    safe_for_entry: safety.safe_for_entry,
    safe_for_closing: safety.safe_for_closing,
    audit_only: safety.audit_only,
    closing_quality: safety.closing_quality,
    recommendation: safety.safe_for_closing
      ? "Closing on-time guardado. Esperar resultado final antes de settlement/CLV."
      : safety.audit_only
        ? "Snapshot guardado audit_only; no alimenta CLV formal."
        : "Snapshot guardado como contexto de mercado; no crea picks.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      auto_post_allowed: false,
      picks_created: 0,
      parlays_created: 0,
      kill_switch_enabled: true
    }
  };
}
