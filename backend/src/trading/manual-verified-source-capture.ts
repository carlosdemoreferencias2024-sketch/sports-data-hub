import { getManualVerifiedSource } from "./source-registry.js";
import { closingWindowDiagnostics, tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";
import { recordForecastContext, recordForecastEvidence } from "./forecast-chain.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type ManualVerifiedCaptureInput = {
  match_id?: unknown;
  sport?: unknown;
  source_name?: unknown;
  source_url?: unknown;
  capture_type?: unknown;
  captured_at?: unknown;
  verified_by?: unknown;
  confidence_score?: unknown;
  data?: unknown;
};

const ALLOWED_CAPTURE_TYPES = new Set([
  "lineup",
  "goalkeeper",
  "injuries",
  "suspensions",
  "match_status",
  "result",
  "current_odds",
  "closing_odds",
  "stats",
  "cards",
  "corners",
  "xg",
  "weather",
  "pitcher"
]);

const CLOSED_TICKET_STATUSES = ["WIN", "LOSS", "PUSH", "VOID", "SETTLED", "ARCHIVED"];
const ODDS_CAPTURE_TYPES = new Set(["current_odds", "closing_odds"]);

function requiredString(body: ManualVerifiedCaptureInput, key: keyof ManualVerifiedCaptureInput) {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${String(key)}_required`);
  return value.trim();
}

function normalizedSport(value: unknown) {
  const sport = String(value || "").trim().toLowerCase();
  if (["soccer", "football", "futbol", "fútbol"].includes(sport)) return "soccer";
  if (["baseball", "mlb"].includes(sport)) return "baseball";
  if (["nfl", "american-football", "american_football", "american football"].includes(sport)) return "american_football";
  throw new Error("sport_invalid");
}

function parseDate(value: unknown, key: string) {
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) throw new Error(`${key}_invalid`);
  return parsed.toISOString();
}

function parseConfidence(value: unknown, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error("confidence_score_invalid");
  return parsed;
}

function dataObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function decimalOdds(value: unknown, format: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) return null;
  const normalizedFormat = String(format || "").toLowerCase();
  const american = normalizedFormat === "american"
    || numeric <= -100
    || (typeof value === "string" && value.trim().startsWith("+"));
  if (american && numeric >= 100) return 1 + numeric / 100;
  if (american && numeric <= -100) return 1 + 100 / Math.abs(numeric);
  if (numeric > 1) return numeric;
  return null;
}

function normalizedMarketRows(data: Record<string, any>, sport: string) {
  const direct = Array.isArray(data.odds) ? data.odds : [];
  const normalized = Array.isArray(data.normalized_event?.odds) ? data.normalized_event.odds : [];
  const rows = [...direct, ...normalized];
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const selection = String(row.selection || row.side || row.outcome || row.name || "").trim().toLowerCase();
    if (!selection || !["home", "draw", "away", "over", "under"].includes(selection)) return [];
    const rawOdds = row.decimal_odds ?? row.odds ?? row.price ?? row.value;
    const parsed = decimalOdds(rawOdds, row.odds_format || row.format);
    if (!parsed || parsed <= 1) return [];
    const marketType = String(row.market_type || row.market || (sport === "soccer" ? "moneyline_3way" : "moneyline_2way"));
    const key = `${marketType}:${selection}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      marketType,
      selection,
      decimalOdds: parsed,
      line: Number.isFinite(Number(row.line)) ? Number(row.line) : null
    }];
  });
}

function boolReady(value: unknown) {
  return value === true || ["true", "1", "yes", "confirmed", "complete", "ready"].includes(String(value || "").toLowerCase());
}

function normalizeLineup(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function finalResultStatus(value: unknown) {
  return ["FINAL", "FINISHED", "FT"].includes(String(value || "").trim().toUpperCase());
}

function statusAllowed(value: unknown) {
  return ["scheduled", "live", "halftime", "finished", "postponed", "cancelled"].includes(String(value || "").trim().toLowerCase());
}

function hashPart(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .slice(0, 80) || "unknown";
}

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function localDateWindow(date?: string) {
  return tradingLocalDateWindow(date);
}

function computeCapturePatch(
  sport: string,
  captureType: string,
  data: Record<string, any>,
  capturedAt: string,
  kickoff: string | null
) {
  const patch: Record<string, any> = {
    manual_verified_capture_present: true
  };
  const missingResolved: string[] = [];
  let dataStatus = "ACCEPTED";
  let usedByPreflight = true;
  let quality: string | null = null;
  const notes: string[] = [];

  if (captureType === "lineup") {
    const homeLineup = normalizeLineup(data.home_lineup);
    const awayLineup = normalizeLineup(data.away_lineup);
    const homeReady = sport === "soccer" ? homeLineup.length >= 11 : homeLineup.length > 0;
    const awayReady = sport === "soccer" ? awayLineup.length >= 11 : awayLineup.length > 0;
    patch.home_lineup = homeLineup;
    patch.away_lineup = awayLineup;
    patch.formation_home = data.formation_home || null;
    patch.formation_away = data.formation_away || null;
    patch.lineup_ready = homeReady && awayReady;
    patch.lineup_status = homeReady && awayReady ? "MANUAL_VERIFIED_COMPLETE" : "MANUAL_VERIFIED_PARTIAL";
    if (sport === "baseball") {
      patch.home_lineup_confirmed = homeReady;
      patch.away_lineup_confirmed = awayReady;
      patch.home_batting_order = data.home_batting_order || data.home_lineup || [];
      patch.away_batting_order = data.away_batting_order || data.away_lineup || [];
      patch.home_batting_order_complete = boolReady(data.home_batting_order_complete) || homeLineup.length >= 9;
      patch.away_batting_order_complete = boolReady(data.away_batting_order_complete) || awayLineup.length >= 9;
      patch.batting_order_complete = patch.home_batting_order_complete && patch.away_batting_order_complete;
      patch.lineup_context = data.lineup_context || { source: "manual_verified_fallback", status: patch.lineup_status };
    }
    if (homeReady && awayReady) missingResolved.push(sport === "baseball" ? "lineup_batting_order" : "player_intelligence_lineup");
    else dataStatus = "PARTIAL_ACCEPTED";
  }

  if (captureType === "goalkeeper") {
    patch.goalkeeper_home = typeof data.goalkeeper_home === "string" ? data.goalkeeper_home.trim() : null;
    patch.goalkeeper_away = typeof data.goalkeeper_away === "string" ? data.goalkeeper_away.trim() : null;
    patch.goalkeeper_ready = Boolean(patch.goalkeeper_home && patch.goalkeeper_away);
    patch.goalkeeper_status = patch.goalkeeper_ready ? "MANUAL_VERIFIED_COMPLETE" : "MANUAL_VERIFIED_PARTIAL";
    patch.home_goalkeeper_status = data.home_goalkeeper_status || (patch.goalkeeper_home ? "confirmed_starting" : "unknown");
    patch.away_goalkeeper_status = data.away_goalkeeper_status || (patch.goalkeeper_away ? "confirmed_starting" : "unknown");
    patch.home_goalkeeper_impact = data.home_goalkeeper_impact ?? null;
    patch.away_goalkeeper_impact = data.away_goalkeeper_impact ?? null;
    if (patch.goalkeeper_ready) missingResolved.push("goalkeeper");
    else dataStatus = "PARTIAL_ACCEPTED";
  }

  if (captureType === "injuries" || captureType === "suspensions") {
    patch[captureType] = data[captureType] || data.unavailable_players || [];
    patch.unavailable_players = data.unavailable_players || patch[captureType] || [];
    patch.player_availability_manual_verified = true;
    patch.home_absence_impact = data.home_absence_impact ?? null;
    patch.away_absence_impact = data.away_absence_impact ?? null;
    dataStatus = Number(data.confidence_score || 0) < 70 ? "STORED_FOR_AUDIT_ONLY" : "ACCEPTED";
    usedByPreflight = dataStatus === "ACCEPTED";
    missingResolved.push("player_availability_context");
  }

  if (captureType === "match_status") {
    const status = String(data.status || "").trim().toLowerCase();
    if (!statusAllowed(status)) throw new Error("match_status_invalid");
    patch.manual_verified_match_status = status;
    patch.match_status_ready = true;
    if (data.knockout && typeof data.knockout === "object") patch.knockout = data.knockout;
    if (Number.isFinite(Number(data.competition_strength))) patch.competition_strength = Number(data.competition_strength);
    const schedule = data.normalized_event?.schedule_context;
    if (schedule && typeof schedule === "object") {
      patch.home_rest_days = schedule.home_rest_days ?? null;
      patch.away_rest_days = schedule.away_rest_days ?? null;
    }
    missingResolved.push("match_status");
  }

  if (captureType === "result") {
    const resultStatus = String(data.result_status || "").trim().toUpperCase();
    patch.home_score = data.home_score ?? null;
    patch.away_score = data.away_score ?? null;
    patch.result_status = resultStatus || null;
    patch.manual_verified_result = true;
    patch.result_ready = finalResultStatus(resultStatus);
    if (patch.result_ready) missingResolved.push("result");
    else {
      dataStatus = "STORED_FOR_AUDIT_ONLY";
      usedByPreflight = false;
      notes.push("Result is not final; stored as live/status audit only.");
    }
  }

  if (captureType === "current_odds") {
    patch.current_market_odds = {
      market: data.market || null,
      selection: data.selection || null,
      odds: data.odds ?? null,
      bookmaker: data.bookmaker || null,
      odds_timestamp: data.odds_timestamp || capturedAt
    };
    patch.current_odds_ready = true;
    usedByPreflight = false;
    dataStatus = "STORED_FOR_AUDIT_ONLY";
    notes.push("Current odds snapshot stored for audit; it does not feed CLV.");
  }

  if (captureType === "closing_odds") {
    const timestamp = parseDate(data.closing_odds_timestamp || data.odds_timestamp || capturedAt, "closing_odds_timestamp");
    const scheduled = data.scheduled_kickoff ? parseDate(data.scheduled_kickoff, "scheduled_kickoff") : kickoff;
    const closingWindow = closingWindowDiagnostics(timestamp, scheduled);
    quality = closingWindow.closing_quality;
    patch.closing_odds = data.closing_odds ?? data.odds ?? null;
    patch.closing_bookmaker = data.closing_bookmaker || data.bookmaker || null;
    patch.closing_source_label = data.closing_source_label || null;
    patch.closing_source_url = data.closing_source_url || null;
    patch.closing_timestamp = timestamp;
    patch.closing_odds_timestamp = timestamp;
    patch.scheduled_kickoff_for_closing = scheduled;
    patch.closing_window_start = closingWindow.closing_window_start;
    patch.closing_window_end = closingWindow.closing_window_end;
    patch.minutes_before_kickoff = closingWindow.minutes_before_kickoff;
    patch.minutes_from_valid_window = closingWindow.minutes_from_valid_window;
    patch.closing_why_invalid = closingWindow.why_invalid;
    patch.closing_quality = quality;
    patch.closing_ready = quality === "CAPTURED_ON_TIME";
    if (patch.closing_ready) missingResolved.push("closing_odds_snapshot", "clv_valid_for_segments");
    else {
      dataStatus = quality || "UNKNOWN";
      usedByPreflight = false;
      notes.push(closingWindow.why_invalid || "Closing is visible but excluded from formal CLV/segments unless CAPTURED_ON_TIME.");
    }
  }

  if (captureType === "weather") {
    patch.weather_context = {
      ...(data.weather_context && typeof data.weather_context === "object" ? data.weather_context : data),
      source: "manual_verified",
      captured_at: capturedAt
    };
    patch.weather_ready = true;
    missingResolved.push("weather_context");
  }

  if (captureType === "pitcher") {
    if (sport !== "baseball") throw new Error("pitcher_only_allowed_for_mlb");
    patch.probable_pitcher_home = data.probable_pitcher_home || data.home_starting_pitcher || null;
    patch.probable_pitcher_away = data.probable_pitcher_away || data.away_starting_pitcher || null;
    patch.home_pitcher_stats = data.home_pitcher_stats || {};
    patch.away_pitcher_stats = data.away_pitcher_stats || {};
    patch.pitcher_manual_verified_fallback = true;
    if (patch.probable_pitcher_home) missingResolved.push("probable_pitcher_home");
    if (patch.probable_pitcher_away) missingResolved.push("probable_pitcher_away");
    if (Object.keys(patch.home_pitcher_stats).length) missingResolved.push("home_pitcher_stats");
    if (Object.keys(patch.away_pitcher_stats).length) missingResolved.push("away_pitcher_stats");
    if (!patch.probable_pitcher_home || !patch.probable_pitcher_away) dataStatus = "PARTIAL_ACCEPTED";
  }

  if (["stats", "cards", "corners", "xg"].includes(captureType)) {
    patch[`manual_verified_${captureType}`] = data;
    patch[`${captureType}_context_ready`] = true;
    dataStatus = "STORED_FOR_AUDIT_ONLY";
    usedByPreflight = false;
    notes.push(`${captureType} is stored as context/audit and does not confirm picks.`);
  }

  patch.manual_verified_missing_resolved = [...new Set(missingResolved)];
  patch.manual_verified_used_by_preflight = usedByPreflight;

  return {
    patch,
    missingResolved: [...new Set(missingResolved)],
    dataStatus,
    usedByPreflight,
    closing_quality: quality,
    notes
  };
}

async function updateJsonbRawData(db: Queryable, table: string, idColumn: string, idValue: string, patch: Record<string, any>, history: Record<string, any>) {
  const sql = `
    UPDATE ${table}
    SET raw_data =
      jsonb_set(
        COALESCE(raw_data, '{}'::jsonb),
        '{manual_verified_source_captures}',
        COALESCE(raw_data->'manual_verified_source_captures', '{}'::jsonb) || $2::jsonb,
        true
      ) || $3::jsonb
    WHERE ${idColumn} = $1::uuid
    RETURNING id, raw_data
  `;
  return db.query(sql, [idValue, JSON.stringify(history), JSON.stringify(patch)]);
}

async function updateFootballTickets(db: Queryable, matchId: string, patch: Record<string, any>, history: Record<string, any>) {
  const sql = `
    UPDATE paper_trades
    SET raw_data =
      jsonb_set(
        COALESCE(raw_data, '{}'::jsonb),
        '{manual_verified_source_captures}',
        COALESCE(raw_data->'manual_verified_source_captures', '{}'::jsonb) || $2::jsonb,
        true
      ) || $3::jsonb,
      updated_at = NOW()
    WHERE match_id = $1::uuid
      AND league_type = 'football_shadow'
      AND status <> ALL($4::text[])
    RETURNING id, match_id, home_team, away_team, market_type, selection, status
  `;
  return db.query(sql, [matchId, JSON.stringify(history), JSON.stringify(patch), CLOSED_TICKET_STATUSES]);
}

async function updateMlbSnapshots(db: Queryable, matchId: string, patch: Record<string, any>, history: Record<string, any>) {
  const sql = `
    UPDATE real_paper_snapshots
    SET raw_data =
      jsonb_set(
        COALESCE(raw_data, '{}'::jsonb),
        '{manual_verified_source_captures}',
        COALESCE(raw_data->'manual_verified_source_captures', '{}'::jsonb) || $2::jsonb,
        true
      ) || $3::jsonb
    WHERE match_id = $1::uuid
      AND sport_slug = 'baseball'
      AND league_slug = 'mlb'
      AND COALESCE(data_state, 'FRESH') = 'FRESH'
      AND status <> ALL($4::text[])
    RETURNING id, match_id, market_type, pick, status
  `;
  return db.query(sql, [matchId, JSON.stringify(history), JSON.stringify(patch), CLOSED_TICKET_STATUSES]);
}

export async function recordManualVerifiedSourceCapture(db: Queryable, body: ManualVerifiedCaptureInput = {}) {
  const matchId = requiredString(body, "match_id");
  const sport = normalizedSport(body.sport);
  const sourceName = requiredString(body, "source_name");
  const source = getManualVerifiedSource(sourceName);
  if (!source) throw new Error("source_name_not_allowed");
  const sourceUrl = requiredString(body, "source_url");
  const captureType = requiredString(body, "capture_type").toLowerCase();
  if (!ALLOWED_CAPTURE_TYPES.has(captureType)) throw new Error("capture_type_invalid");
  if (sourceName === "mlb_official_manual_verified" && ODDS_CAPTURE_TYPES.has(captureType)) {
    throw new Error("mlb_official_cannot_provide_market_odds");
  }
  const capturedAt = parseDate(requiredString(body, "captured_at"), "captured_at");
  const verifiedBy = requiredString(body, "verified_by");
  const confidenceScore = parseConfidence(body.confidence_score, source.default_confidence_score);
  const data = dataObject(body.data);

  const match = await db.query(
    `SELECT id, match_date, status FROM v_valid_matches WHERE id = $1::uuid LIMIT 1`,
    [matchId]
  );
  if (!match.rows.length) throw new Error("match_id_not_found");
  const kickoff = match.rows[0].match_date ? new Date(match.rows[0].match_date).toISOString() : null;
  const prospectiveCapture = [
    "lineup", "goalkeeper", "injuries", "suspensions", "match_status",
    "current_odds", "closing_odds", "weather", "pitcher"
  ].includes(captureType);
  if (kickoff && prospectiveCapture) {
    const kickoffMs = new Date(kickoff).getTime();
    if (new Date(capturedAt).getTime() >= kickoffMs) throw new Error("post_kickoff_capture_rejected");
    if (Date.now() >= kickoffMs) throw new Error("prospective_window_closed");
  }
  const computed = computeCapturePatch(sport, captureType, data, capturedAt, kickoff);
  const fingerprint = [
    hashPart(matchId),
    hashPart(captureType),
    hashPart(sourceName),
    hashPart(capturedAt),
    hashPart(verifiedBy)
  ].join("__");
  const captureRecord = {
    idempotency_key: fingerprint,
    match_id: matchId,
    sport,
    source_name: sourceName,
    source_url: sourceUrl,
    capture_type: captureType,
    captured_at: capturedAt,
    verified_by: verifiedBy,
    confidence_score: confidenceScore,
    data_status: computed.dataStatus,
    used_by_preflight: computed.usedByPreflight,
    missing_resolved: computed.missingResolved,
    closing_quality: computed.closing_quality,
    notes: computed.notes,
    legal_note: source.legal_note,
    auto_scrape_allowed: false,
    data,
    ingested_at: new Date().toISOString()
  };
  const patch = {
    ...computed.patch,
    manual_verified_source_capture_latest: captureRecord,
    manual_verified_source_capture_status: computed.dataStatus,
    manual_verified_source_capture_type: captureType,
    manual_verified_source_name: sourceName,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    real_candidate: 0,
    confirmed_pick: false
  };
  const history = { [fingerprint]: captureRecord };

  const [matchesUpdated, footballTickets, mlbSnapshots] = await Promise.all([
    updateJsonbRawData(db, "matches", "id", matchId, patch, history),
    sport === "soccer" ? updateFootballTickets(db, matchId, patch, history) : Promise.resolve({ rows: [] as Record<string, any>[] }),
    sport === "baseball" ? updateMlbSnapshots(db, matchId, patch, history) : Promise.resolve({ rows: [] as Record<string, any>[] })
  ]);

  await db.query("SELECT * FROM register_forecast_match($1::uuid)", [matchId]);

  const normalizedEvent = data.normalized_event && typeof data.normalized_event === "object"
    ? data.normalized_event as Record<string, any>
    : null;
  if (normalizedEvent && ["match_status", "current_odds", "closing_odds"].includes(captureType)) {
    const canonicalKickoff = parseDate(normalizedEvent.starts_at || data.scheduled_kickoff, "canonical_kickoff");
    await db.query(
      "SELECT * FROM validate_forecast_schedule($1::uuid, false, false, $2::timestamptz, NULL, $3)",
      [matchId, canonicalKickoff, verifiedBy]
    );
    const externalMatchId = String(data.provider_event_id || normalizedEvent.source_event_id || "").trim();
    const providerName = String(data.provider || normalizedEvent.source || sourceName).trim().toLowerCase();
    if (externalMatchId) {
      await db.query(
        "SELECT * FROM register_forecast_provider_mapping($1::uuid, $2, $3, NULL, $4)",
        [matchId, providerName, externalMatchId, verifiedBy]
      );
    }
  }

  const rawPayloadHash = String(data.upstream_evidence_sha256 || data.provider_raw_sha256 || "").trim().toLowerCase();
  const forecastEvidence: Record<string, any>[] = [];
  if (ODDS_CAPTURE_TYPES.has(captureType)) {
    const screenshotSha256 = String(data.screenshot_sha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(rawPayloadHash)) throw new Error("forecast_market_raw_payload_hash_required");
    if (!/^[a-f0-9]{64}$/.test(screenshotSha256)) throw new Error("forecast_market_screenshot_sha256_required");
    const rows = normalizedMarketRows(data, sport);
    const requiredSelections = sport === "soccer" ? ["home", "draw", "away"] : ["home", "away"];
    if (!requiredSelections.every((selection) => rows.some((row) => row.selection === selection))) {
      throw new Error("forecast_market_all_sides_required");
    }
    for (const row of rows) {
      forecastEvidence.push(await recordForecastEvidence({
        matchId,
        sourceType: "manual_verified",
        providerName: String(data.provider || sourceName),
        bookmaker: String(data.bookmaker || "").trim(),
        marketType: row.marketType,
        selection: row.selection,
        line: row.line,
        oddsValue: row.decimalOdds,
        oddsFormat: "decimal",
        decimalOdds: row.decimalOdds,
        capturedAt,
        timingQuality: captureType === "closing_odds"
          ? (computed.closing_quality === "CAPTURED_ON_TIME" ? "CAPTURED_ON_TIME" : "LATE")
          : "UNKNOWN",
        sourceUrl,
        screenshotSha256,
        verifiedBy,
        verificationNotes: `Imported from ${sourceName}; ${captureType}`,
        rawPayloadHash,
        evidenceRole: captureType === "closing_odds" ? "closing" : (data.snapshot_type === "entry" ? "entry" : "current")
      }));
    }
  } else if (/^[a-f0-9]{64}$/.test(rawPayloadHash)) {
    const mergedRawData: Record<string, any> = matchesUpdated.rows[0]?.raw_data && typeof matchesUpdated.rows[0].raw_data === "object"
      ? matchesUpdated.rows[0].raw_data as Record<string, any>
      : patch as Record<string, any>;
    const missingFields: string[] = [];
    const lineupConfirmed = Boolean(mergedRawData.lineup_ready);
    const goalkeeperConfirmed = sport === "soccer" ? Boolean(mergedRawData.goalkeeper_ready) : true;
    const battingOrderComplete = sport === "baseball" ? Boolean(mergedRawData.batting_order_complete) : true;
    const pitchersConfirmed = sport === "baseball"
      ? Boolean(mergedRawData.probable_pitcher_home && mergedRawData.probable_pitcher_away)
      : true;
    const bullpenContextComplete = sport === "baseball" ? Boolean(mergedRawData.bullpen_context_complete) : true;
    const availabilityComplete = sport === "soccer" ? Boolean(mergedRawData.player_availability_manual_verified) : true;
    if (!lineupConfirmed) missingFields.push("official_lineups");
    if (!goalkeeperConfirmed) missingFields.push("goalkeepers");
    if (!battingOrderComplete) missingFields.push("batting_order");
    if (!pitchersConfirmed) missingFields.push("pitchers");
    if (!bullpenContextComplete) missingFields.push("bullpen");
    if (!availabilityComplete) missingFields.push("availability");
    await recordForecastContext({
      matchId,
      capturedAt,
      lineupConfirmed,
      battingOrderComplete,
      pitchersConfirmed,
      bullpenContextComplete,
      goalkeeperConfirmed,
      injuries: { unavailable_players: mergedRawData.unavailable_players || [] },
      missingFields,
      notes: `Aggregated verified context after ${captureType}`,
      completeness: missingFields.length === 0 ? "complete" : "partial",
      sourceUrl,
      sourcePayloadHash: rawPayloadHash,
      captureMode: "LIVE_FORWARD",
      sourcePublishedAt: capturedAt,
      sourceAsOfAt: capturedAt,
      replayVerifiedBy: verifiedBy,
      noPostEventDataAttested: true
    });
  }

  return {
    system_status: "MANUAL_VERIFIED_SOURCE_CAPTURE_SAFE_V1",
    applied: true,
    rejected: false,
    data_status: computed.dataStatus,
    capture_quality: computed.closing_quality || computed.dataStatus,
    match_id: matchId,
    sport,
    source_name: sourceName,
    capture_type: captureType,
    idempotency_key: fingerprint,
    used_by_preflight: computed.usedByPreflight,
    missing_resolved: computed.missingResolved,
    updated_matches: matchesUpdated.rows.length,
    updated_football_shadow_tickets: footballTickets.rows.length,
    updated_mlb_snapshots: mlbSnapshots.rows.length,
    forecast_evidence_ids: forecastEvidence.map((row) => row.id),
    notes: computed.notes,
    rows: [...footballTickets.rows, ...mlbSnapshots.rows],
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true,
      confirmed_pick: false
    }
  };
}

export async function getManualVerifiedSourceCaptureStatus(db: Queryable, input: { date?: string; sport?: string; limit?: number } = {}) {
  const window = localDateWindow(input.date);
  const requestedSport = String(input.sport || "all").trim().toLowerCase();
  const sport = requestedSport === "all" ? "all" : normalizedSport(requestedSport);
  const limit = Math.max(1, Math.min(300, Number(input.limit || 120)));
  const result = await db.query(
    `
      WITH football AS (
        SELECT
          pt.match_id,
          'soccer' AS sport,
          COALESCE(NULLIF(pt.home_team, ''), 'Home') || ' vs ' || COALESCE(NULLIF(pt.away_team, ''), 'Away') AS match,
          pt.league_slug AS league,
          m.match_date AS kickoff,
          pt.raw_data->'manual_verified_source_capture_latest' AS capture,
          pt.raw_data
        FROM paper_trades pt
        LEFT JOIN v_valid_matches m ON m.id = pt.match_id
        WHERE pt.league_type = 'football_shadow'
          AND pt.raw_data ? 'manual_verified_source_capture_latest'
      ),
      mlb AS (
        SELECT
          rps.match_id,
          'baseball' AS sport,
          COALESCE(away_team.name, 'Away') || ' @ ' || COALESCE(home_team.name, 'Home') AS match,
          rps.league_slug AS league,
          m.match_date AS kickoff,
          rps.raw_data->'manual_verified_source_capture_latest' AS capture,
          rps.raw_data
        FROM real_paper_snapshots rps
        LEFT JOIN v_valid_matches m ON m.id = rps.match_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
        WHERE rps.sport_slug = 'baseball'
          AND rps.league_slug = 'mlb'
          AND rps.raw_data ? 'manual_verified_source_capture_latest'
      )
      SELECT *
      FROM (
        SELECT * FROM football
        UNION ALL
        SELECT * FROM mlb
      ) captures
      WHERE ($3::text = 'all' OR sport = $3::text)
        AND (
          kickoff IS NULL
          OR (kickoff >= $1::timestamptz AND kickoff < $2::timestamptz)
          OR ((capture->>'captured_at')::timestamptz >= $1::timestamptz AND (capture->>'captured_at')::timestamptz < $2::timestamptz)
        )
      ORDER BY (capture->>'captured_at')::timestamptz DESC NULLS LAST
      LIMIT $4
    `,
    [window.start, window.end, sport, limit]
  );

  const rows = result.rows.map((row) => {
    const capture = row.capture && typeof row.capture === "object" ? row.capture as Record<string, any> : {};
    return {
      match_id: row.match_id,
      match: row.match,
      sport: row.sport,
      league: row.league,
      kickoff: row.kickoff,
      source: capture.source_name || "-",
      capture_type: capture.capture_type || "-",
      captured_at: capture.captured_at || null,
      verified_by: capture.verified_by || "-",
      confidence: capture.confidence_score ?? null,
      data_status: capture.data_status || "ACCEPTED",
      used_by_preflight: Boolean(capture.used_by_preflight),
      missing_resolved: Array.isArray(capture.missing_resolved) ? capture.missing_resolved : [],
      closing_quality: capture.closing_quality || null,
      closing_window_start: row.raw_data?.closing_window_start || null,
      closing_window_end: row.raw_data?.closing_window_end || null,
      minutes_before_kickoff: row.raw_data?.minutes_before_kickoff ?? null,
      minutes_from_valid_window: row.raw_data?.minutes_from_valid_window ?? null,
      closing_why_invalid: row.raw_data?.closing_why_invalid || null,
      notes: Array.isArray(capture.notes) ? capture.notes.join(" ") : "",
      source_url: capture.source_url || null,
      idempotency_key: capture.idempotency_key || null
    };
  });

  return {
    system_status: "MANUAL_VERIFIED_SOURCE_CAPTURE_STATUS_SAFE_V1",
    date: window.selectedDate,
    sport,
    scanned: rows.length,
    accepted: rows.filter((row) => row.data_status === "ACCEPTED").length,
    partial_accepted: rows.filter((row) => row.data_status === "PARTIAL_ACCEPTED").length,
    stored_for_audit_only: rows.filter((row) => row.data_status === "STORED_FOR_AUDIT_ONLY").length,
    captured_on_time: rows.filter((row) => row.closing_quality === "CAPTURED_ON_TIME").length,
    captured_too_early: rows.filter((row) => row.closing_quality === "CAPTURED_TOO_EARLY").length,
    captured_late: rows.filter((row) => row.closing_quality === "CAPTURED_LATE").length,
    rows,
    recommendation: rows.length
      ? "Capturas manual_verified visibles para preflight/auditoria. Solo CAPTURED_ON_TIME alimenta CLV formal."
      : "No hay capturas manual_verified para esta fecha/deporte.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
