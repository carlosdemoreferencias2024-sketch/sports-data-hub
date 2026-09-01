import crypto from "node:crypto";
import { appendForecastStage, recordForecastContext, recordForecastEvidence } from "./forecast-chain.js";
import { settleFootballShadow } from "./football-shadow-settlement.js";
import { getCleanSampleQueue } from "./clean-sample-queue.js";
import { tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";
import type { FootballMarketKey } from "./football-leagues.config.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount?: number | null }>;
};

type CaptureInput = Record<string, any>;

const AUTOMATED_MARKET_SOURCES = new Map([
  ["espn_provider_api", ["site.api.espn.com"]],
  ["api_football_provider_api", ["v3.football.api-sports.io"]]
]);

function requiredString(value: unknown, field: string) {
  const parsed = String(value || "").trim();
  if (!parsed) throw new Error(`${field}_required`);
  return parsed;
}

function isoDate(value: unknown, field: string) {
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) throw new Error(`${field}_invalid`);
  return parsed.toISOString();
}

function normalizeTeam(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|club|deportivo|futbol|football|soccer)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export function canonicalPayloadSha256(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function footballCaptureWindow(capturedAt: string, kickoff: string, captureType: string) {
  const minutes = (new Date(kickoff).getTime() - new Date(capturedAt).getTime()) / 60000;
  const inEntryWindow = (minutes <= 90 && minutes >= 60) || (minutes <= 45 && minutes >= 20);
  const inClosingWindow = minutes <= 10 && minutes >= 3;
  return {
    minutes_to_kickoff: Number(minutes.toFixed(2)),
    valid: captureType === "closing_odds" ? inClosingWindow : inEntryWindow,
    role: captureType === "closing_odds" ? "closing" as const : "entry" as const,
    timing_quality: captureType === "closing_odds" ? (inClosingWindow ? "CAPTURED_ON_TIME" as const : "LATE" as const) : "UNKNOWN" as const
  };
}

async function matchIdentity(db: Queryable, matchId: string) {
  const result = await db.query(
    `
      SELECT
        m.id AS match_id,
        m.match_date AS kickoff,
        m.status,
        l.slug AS league_slug,
        home_team.name AS home_team,
        away_team.name AS away_team
      FROM v_valid_matches m
      JOIN leagues l ON l.id = m.league_id
      JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      JOIN teams home_team ON home_team.id = home_mc.team_id
      JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      JOIN teams away_team ON away_team.id = away_mc.team_id
      WHERE m.id = $1::uuid
      LIMIT 1
    `,
    [matchId]
  );
  if (!result.rows[0]) throw new Error("match_id_not_found_or_invalid");
  return result.rows[0];
}

async function assertActiveFocus(db: Queryable, matchId: string) {
  const result = await db.query(
    `
      SELECT *
      FROM forecast_operational_focus_locks
      WHERE match_id = $1::uuid
        AND sport_slug = 'soccer'
        AND status = 'ACTIVE'
        AND locked_until > NOW()
      ORDER BY selected_at DESC
      LIMIT 1
    `,
    [matchId]
  );
  if (!result.rows[0]) throw new Error("operational_focus_not_active");
  return result.rows[0];
}

export async function acquireFootballOperationalFocus(db: Queryable, input: Record<string, unknown> = {}) {
  const date = String(input.date || tradingLocalDate());
  const window = tradingLocalDateWindow(date);
  const requestedMatchId = String(input.match_id || "").trim();
  const existing = await db.query(
    `SELECT * FROM forecast_operational_focus_locks WHERE local_date = $1::date AND sport_slug = 'soccer' LIMIT 1`,
    [date]
  );
  if (existing.rows[0]) {
    const identity = await matchIdentity(db, String(existing.rows[0].match_id));
    return {
      system_status: "FOOTBALL_OPERATIONAL_FOCUS_LOCKED",
      focus: { ...existing.rows[0], ...identity },
      acquired: false,
      immutable_for_date: true
    };
  }

  const queue = await getCleanSampleQueue(db, { date, sport: "soccer", limit: 200 });
  const rows = Array.isArray(queue.rows) ? queue.rows as Record<string, any>[] : [];
  const candidates = rows.filter((row) =>
    row.calendar_trusted === true
    && row.model_quote_id
    && Number(row.minutes_until_start) > 10
    && String(row.action || "") !== "POST_KICKOFF_AUDIT_ONLY"
  );
  const selected = requestedMatchId
    ? candidates.find((row) => String(row.match_id) === requestedMatchId)
    : candidates[0];
  if (!selected) {
    return {
      system_status: "FOOTBALL_OPERATIONAL_FOCUS_NOT_READY",
      focus: null,
      acquired: false,
      reasons: requestedMatchId ? ["REQUESTED_MATCH_NOT_ELIGIBLE"] : ["NO_CALENDAR_TRUSTED_PRICED_MATCH"]
    };
  }

  const kickoff = new Date(String(selected.kickoff));
  const lockedUntil = new Date(kickoff.getTime() + 12 * 60 * 60 * 1000).toISOString();
  const inserted = await db.query(
    `
      INSERT INTO forecast_operational_focus_locks (
        local_date, sport_slug, match_id, status, selection_source, locked_until, details_json
      ) VALUES ($1::date, 'soccer', $2::uuid, 'ACTIVE', $3, $4::timestamptz, $5::jsonb)
      ON CONFLICT (local_date, sport_slug) DO NOTHING
      RETURNING *
    `,
    [
      date,
      selected.match_id,
      requestedMatchId ? "operator_requested_calendar_trust" : "automatic_clean_sample_queue",
      lockedUntil,
      JSON.stringify({
        window_start: window.start,
        window_end: window.end,
        match: selected.match,
        kickoff: selected.kickoff,
        model_quote_id: selected.model_quote_id,
        provider_event_id: selected.provider_event_id,
        selection_action: selected.action
      })
    ]
  );
  const lock = inserted.rows[0] || (await db.query(
    `SELECT * FROM forecast_operational_focus_locks WHERE local_date = $1::date AND sport_slug = 'soccer' LIMIT 1`,
    [date]
  )).rows[0];
  const identity = await matchIdentity(db, String(lock.match_id));
  return {
    system_status: "FOOTBALL_OPERATIONAL_FOCUS_LOCKED",
    focus: { ...lock, ...identity },
    acquired: Boolean(inserted.rows[0]),
    immutable_for_date: true,
    guardrails: { max_focus: 1, real_candidate_count: 0, real_money_enabled: false, kelly_enabled: false, autopost_real: false }
  };
}

function sourceHostAllowed(sourceName: string, sourceUrl: string) {
  const allowedHosts = AUTOMATED_MARKET_SOURCES.get(sourceName);
  if (!allowedHosts) return false;
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

function marketRows(data: Record<string, any>) {
  const rows = Array.isArray(data.odds) ? data.odds : [];
  const bySelection = new Map<string, number>();
  for (const row of rows) {
    const selection = String(row?.selection || "").toLowerCase();
    const odds = Number(row?.decimal_odds ?? row?.odds);
    if (["home", "draw", "away"].includes(selection) && Number.isFinite(odds) && odds > 1) {
      bySelection.set(selection, odds);
    }
  }
  if (!["home", "draw", "away"].every((selection) => bySelection.has(selection))) {
    throw new Error("provider_market_all_three_moneylines_required");
  }
  return bySelection;
}

async function assertCaptureIdentity(match: Record<string, any>, data: Record<string, any>) {
  const normalized = data.normalized_event && typeof data.normalized_event === "object" ? data.normalized_event : {};
  const capturedHome = normalized.home?.name ?? data.home_team;
  const capturedAway = normalized.away?.name ?? data.away_team;
  if (normalizeTeam(capturedHome) !== normalizeTeam(match.home_team)) throw new Error("provider_home_team_mismatch");
  if (normalizeTeam(capturedAway) !== normalizeTeam(match.away_team)) throw new Error("provider_away_team_mismatch");
  const capturedKickoff = new Date(String(normalized.starts_at || data.scheduled_kickoff || ""));
  if (Number.isNaN(capturedKickoff.getTime())) throw new Error("provider_kickoff_missing");
  if (Math.abs(capturedKickoff.getTime() - new Date(match.kickoff).getTime()) > 15 * 60000) {
    throw new Error("provider_kickoff_mismatch");
  }
}

export async function recordAutomatedFootballMarketCapture(db: Queryable, body: CaptureInput = {}) {
  const matchId = requiredString(body.match_id, "match_id");
  const sourceName = requiredString(body.source_name, "source_name").toLowerCase();
  const sourceUrl = requiredString(body.source_url, "source_url");
  if (!sourceHostAllowed(sourceName, sourceUrl)) throw new Error("automated_provider_source_not_allowed");
  const captureType = requiredString(body.capture_type, "capture_type").toLowerCase();
  if (!["current_odds", "closing_odds"].includes(captureType)) throw new Error("capture_type_invalid");
  const capturedAt = isoDate(body.captured_at, "captured_at");
  const screenshotSha256 = requiredString(body.screenshot_sha256, "screenshot_sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(screenshotSha256)) throw new Error("screenshot_sha256_invalid");
  if (!body.raw_payload || typeof body.raw_payload !== "object") throw new Error("raw_payload_required");
  const rawPayloadHash = canonicalPayloadSha256(body.raw_payload);
  const declaredHash = requiredString(body.raw_payload_hash || body.data?.provider_raw_sha256, "raw_payload_hash").toLowerCase();
  if (rawPayloadHash !== declaredHash) throw new Error("raw_payload_hash_mismatch");
  const data = body.data && typeof body.data === "object" ? body.data as Record<string, any> : {};
  const match = await matchIdentity(db, matchId);
  await assertActiveFocus(db, matchId);
  await assertCaptureIdentity(match, data);
  const window = footballCaptureWindow(capturedAt, new Date(match.kickoff).toISOString(), captureType);
  if (!window.valid) throw new Error(`outside_${captureType}_window:${window.minutes_to_kickoff}`);
  const prices = marketRows(data);
  const role = window.role;
  const completedRole = await db.query(
    `
      SELECT
        MIN(market_quote_id::text) AS market_quote_id,
        MIN(captured_at) AS captured_at,
        COUNT(DISTINCT selection)::int AS selections
      FROM odds_snapshots
      WHERE match_id = $1::uuid
        AND snapshot_role = $2
        AND market_type = 'moneyline_3way'
        AND COALESCE((raw_data->>'audit_only')::boolean, false) = false
      HAVING COUNT(DISTINCT selection) >= 3
    `,
    [matchId, role]
  );
  if (completedRole.rows[0]) {
    return {
      system_status: "FOOTBALL_AUTOMATED_PROVIDER_MARKET_ALREADY_CAPTURED",
      match_id: matchId,
      capture_type: captureType,
      snapshot_role: role,
      captured_at: new Date(completedRole.rows[0].captured_at).toISOString(),
      market_quote_id: completedRole.rows[0].market_quote_id,
      idempotent: true,
      guardrails: { shadow_only: true, real_candidate_count: 0, real_money_enabled: false, kelly_enabled: false, autopost_real: false }
    };
  }
  const verifier = `automation:${sourceName}:v1`;
  const evidenceRows: Record<string, any>[] = [];
  for (const selection of ["home", "draw", "away"] as const) {
    evidenceRows.push(await recordForecastEvidence({
      matchId,
      sourceType: "provider_api",
      providerName: sourceName,
      bookmaker: requiredString(data.bookmaker || body.bookmaker, "bookmaker"),
      marketType: "moneyline_3way",
      selection,
      oddsValue: prices.get(selection)!,
      oddsFormat: "decimal",
      decimalOdds: prices.get(selection)!,
      capturedAt,
      timingQuality: window.timing_quality,
      sourceUrl,
      screenshotSha256,
      verifiedBy: verifier,
      verificationNotes: "Automated provider API capture with canonical payload hash and deterministic source render.",
      rawPayloadHash,
      evidenceRole: role
    }));
  }

  const evidenceIds = Object.fromEntries(evidenceRows.map((row) => [row.selection, row.id]));
  const quoteRawData = {
    provider_api_capture: true,
    source_label: sourceName,
    source_url: sourceUrl,
    bookmaker: data.bookmaker,
    verified_by: verifier,
    provider_event_id: data.provider_event_id || body.source_event_id,
    raw_payload_hash: rawPayloadHash,
    screenshot_sha256: screenshotSha256,
    snapshot_type: role,
    evidence_ids: evidenceIds,
    selection_map: { home: "home", draw: "draw", away: "away" },
    no_real_money: true,
    auto_post_real: false
  };
  const existingQuote = await db.query(
    `
      SELECT id FROM market_quotes
      WHERE match_id = $1::uuid
        AND provider_name = $2
        AND market_type = 'moneyline_3way'
        AND captured_at = $3::timestamptz
        AND raw_data->>'raw_payload_hash' = $4
      LIMIT 1
    `,
    [matchId, sourceName, capturedAt, rawPayloadHash]
  );
  const quote = existingQuote.rows[0] || (await db.query(
    `
      INSERT INTO market_quotes (
        match_id, provider_name, market_type, home_odds, away_odds, draw_odds,
        captured_at, raw_data, first_seen_at, last_seen_at, seen_count
      ) VALUES ($1::uuid, $2, 'moneyline_3way', $3, $4, $5, $6::timestamptz, $7::jsonb, $6::timestamptz, $6::timestamptz, 1)
      RETURNING id
    `,
    [matchId, sourceName, prices.get("home"), prices.get("away"), prices.get("draw"), capturedAt, JSON.stringify(quoteRawData)]
  )).rows[0];

  for (const selection of ["home", "draw", "away"] as const) {
    await db.query(
      `
        INSERT INTO odds_snapshots (
          market_quote_id, match_id, sport_slug, league_slug, provider_name, source_name,
          bookmaker, market_type, selection, odds, snapshot_role, captured_at,
          quality_score, quality_flags, raw_data
        ) VALUES (
          $1::uuid, $2::uuid, 'soccer', $3, $4, $4, $5, 'moneyline_3way', $6, $7,
          $8, $9::timestamptz, 95, $10::text[], $11::jsonb
        )
        ON CONFLICT (market_quote_id, selection) WHERE market_quote_id IS NOT NULL DO NOTHING
      `,
      [
        quote.id, matchId, match.league_slug, sourceName, data.bookmaker, selection, prices.get(selection), role,
        capturedAt,
        ["PROVIDER_API", "HASH_VERIFIED", role === "closing" ? "SAFE_FOR_CLOSING" : "SAFE_FOR_ENTRY"],
        JSON.stringify({
          ...quoteRawData,
          evidence_id: evidenceIds[selection],
          snapshot_type: role,
          safe_for_entry: role === "entry",
          safe_for_closing: role === "closing",
          audit_only: false,
          closing_quality: role === "closing" ? "CAPTURED_ON_TIME" : null,
          canonical_match: true,
          duplicate: false,
          integrity_status: role === "closing" ? "CLOSING_VALID" : "ENTRY_VALID"
        })
      ]
    );
  }

  await appendForecastStage({
    matchId,
    stage: role,
    evidenceId: evidenceRows[0].id,
    value: { source_name: sourceName, captured_at: capturedAt, raw_payload_hash: rawPayloadHash, evidence_ids: evidenceIds }
  });
  return {
    system_status: "FOOTBALL_AUTOMATED_PROVIDER_MARKET_CAPTURED",
    match_id: matchId,
    capture_type: captureType,
    snapshot_role: role,
    captured_at: capturedAt,
    minutes_to_kickoff: window.minutes_to_kickoff,
    market_quote_id: quote.id,
    evidence_ids: evidenceIds,
    idempotent: Boolean(existingQuote.rows[0]),
    guardrails: { shadow_only: true, real_candidate_count: 0, real_money_enabled: false, kelly_enabled: false, autopost_real: false }
  };
}

export async function recordAutomatedFootballNearStartContext(db: Queryable, body: CaptureInput = {}) {
  const matchId = requiredString(body.match_id, "match_id");
  const capturedAt = isoDate(body.captured_at, "captured_at");
  const match = await matchIdentity(db, matchId);
  await assertActiveFocus(db, matchId);
  await assertCaptureIdentity(match, body);
  const minutes = (new Date(match.kickoff).getTime() - new Date(capturedAt).getTime()) / 60000;
  if (!((minutes <= 90 && minutes >= 60) || (minutes <= 45 && minutes >= 20))) {
    throw new Error(`outside_near_start_window:${minutes.toFixed(2)}`);
  }
  const rawPayloadHash = requiredString(body.provider_raw_sha256, "provider_raw_sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(rawPayloadHash)) throw new Error("provider_raw_sha256_invalid");
  const homeLineup = Array.isArray(body.home_lineup) ? body.home_lineup : [];
  const awayLineup = Array.isArray(body.away_lineup) ? body.away_lineup : [];
  const goalkeeperHome = String(body.goalkeeper_home || "").trim();
  const goalkeeperAway = String(body.goalkeeper_away || "").trim();
  const lineupConfirmed = String(body.lineup_status || "").toUpperCase() === "CONFIRMED" && homeLineup.length >= 11 && awayLineup.length >= 11;
  const goalkeeperConfirmed = String(body.goalkeeper_status || "").toUpperCase() === "CONFIRMED" && Boolean(goalkeeperHome && goalkeeperAway);
  if (!lineupConfirmed || !goalkeeperConfirmed) throw new Error("official_near_start_context_not_confirmed");
  const missingFields: string[] = [];
  if (!Array.isArray(body.availability_details)) missingFields.push("availability");
  const existingContext = await db.query(
    `
      SELECT *
      FROM forecast_context_snapshots
      WHERE match_id = $1::uuid
        AND source_payload_hash = $2
        AND capture_mode = 'LIVE_FORWARD'
      ORDER BY captured_at DESC
      LIMIT 1
    `,
    [matchId, rawPayloadHash]
  );
  if (existingContext.rows[0]) {
    return {
      system_status: "FOOTBALL_AUTOMATED_OFFICIAL_CONTEXT_ALREADY_CAPTURED",
      match_id: matchId,
      forecast_context_snapshot_id: existingContext.rows[0].id,
      completeness: existingContext.rows[0].completeness_flag,
      captured_at: new Date(existingContext.rows[0].captured_at).toISOString(),
      idempotent: true,
      guardrails: { shadow_only: true, real_candidate_count: 0, real_money_enabled: false, kelly_enabled: false, autopost_real: false }
    };
  }
  const context = await recordForecastContext({
    matchId,
    capturedAt,
    lineupConfirmed,
    battingOrderComplete: true,
    pitchersConfirmed: true,
    bullpenContextComplete: true,
    goalkeeperConfirmed,
    injuries: {
      unavailable_players: Array.isArray(body.unavailable_players) ? body.unavailable_players : [],
      injuries: Array.isArray(body.injuries) ? body.injuries : [],
      suspensions: Array.isArray(body.suspensions) ? body.suspensions : []
    },
    missingFields,
    notes: "Automated official provider near-start context",
    completeness: missingFields.length === 0 ? "complete" : "partial",
    sourceUrl: String(body.source_url || ""),
    sourcePayloadHash: rawPayloadHash,
    captureMode: "LIVE_FORWARD",
    sourcePublishedAt: capturedAt,
    sourceAsOfAt: capturedAt,
    replayVerifiedBy: "automation:api_football_official:v1",
    noPostEventDataAttested: true
  });
  await appendForecastStage({
    matchId,
    stage: "context",
    contextId: context.id,
    value: { captured_at: capturedAt, provider_raw_sha256: rawPayloadHash, completeness: context.completeness_flag }
  });
  return {
    system_status: "FOOTBALL_AUTOMATED_OFFICIAL_CONTEXT_CAPTURED",
    match_id: matchId,
    forecast_context_snapshot_id: context.id,
    completeness: context.completeness_flag,
    captured_at: capturedAt,
    guardrails: { shadow_only: true, real_candidate_count: 0, real_money_enabled: false, kelly_enabled: false, autopost_real: false }
  };
}

export async function reconcileFootballOperationalResults(db: Queryable, input: Record<string, unknown> = {}) {
  const date = String(input.date || tradingLocalDate());
  const locks = await db.query(
    `
      SELECT lock.*
      FROM forecast_operational_focus_locks lock
      JOIN matches m ON m.id = lock.match_id
      WHERE lock.sport_slug = 'soccer'
        AND lock.local_date <= $1::date
        AND lock.status = 'ACTIVE'
        AND m.match_date < NOW()
      ORDER BY lock.local_date, lock.selected_at
      LIMIT 20
    `,
    [date]
  );
  const rows: Record<string, any>[] = [];
  for (const lock of locks.rows) {
    const matchId = String(lock.match_id);
    const candidates = await db.query(
      `
        WITH target AS (
          SELECT
            m.*,
            (SELECT t.name FROM match_competitors mc JOIN teams t ON t.id = mc.team_id WHERE mc.match_id = m.id AND mc.home_away = 'home' LIMIT 1) AS home_team,
            (SELECT t.name FROM match_competitors mc JOIN teams t ON t.id = mc.team_id WHERE mc.match_id = m.id AND mc.home_away = 'away' LIMIT 1) AS away_team
          FROM matches m
          WHERE m.id = $1::uuid
        )
        SELECT
          sibling.id,
          sibling.home_score,
          sibling.away_score,
          sibling.updated_at,
          target.home_team AS target_home_team,
          target.away_team AS target_away_team,
          (SELECT t.name FROM match_competitors mc JOIN teams t ON t.id = mc.team_id WHERE mc.match_id = sibling.id AND mc.home_away = 'home' LIMIT 1) AS sibling_home_team,
          (SELECT t.name FROM match_competitors mc JOIN teams t ON t.id = mc.team_id WHERE mc.match_id = sibling.id AND mc.home_away = 'away' LIMIT 1) AS sibling_away_team
        FROM target
        JOIN matches sibling
          ON sibling.league_id = target.league_id
         AND ABS(EXTRACT(EPOCH FROM (sibling.match_date - target.match_date))) <= 900
        WHERE sibling.status = 'finished'
          AND sibling.home_score IS NOT NULL
          AND sibling.away_score IS NOT NULL
        ORDER BY CASE WHEN sibling.id = target.id THEN 0 ELSE 1 END, sibling.updated_at DESC
      `,
      [matchId]
    );
    const identityMatches = candidates.rows.filter((row) =>
      normalizeTeam(row.target_home_team) === normalizeTeam(row.sibling_home_team)
      && normalizeTeam(row.target_away_team) === normalizeTeam(row.sibling_away_team)
    );
    const distinctResults = new Map(identityMatches.map((row) => [`${row.home_score}:${row.away_score}`, row]));
    if (distinctResults.size !== 1) {
      rows.push({ match_id: matchId, status: "RESULT_RECONCILIATION_BLOCKED", candidate_results: distinctResults.size });
      continue;
    }
    const source = Array.from(distinctResults.values())[0];
    await db.query(
      `
        UPDATE matches
        SET status = 'finished',
            home_score = $2::int,
            away_score = $3::int,
            raw_data = COALESCE(raw_data, '{}'::jsonb) || $4::jsonb,
            updated_at = NOW()
        WHERE id = $1::uuid
      `,
      [matchId, source.home_score, source.away_score, JSON.stringify({
        result_reconciliation: {
          source_match_id: source.id,
          reconciled_at: new Date().toISOString(),
          method: "same_league_kickoff_and_canonical_competitors_v1",
          result_source_verified: true
        },
        result_source_verified: true,
        result_status: "FINAL"
      })]
    );
    let resultStageStatus = "APPENDED";
    try {
      await appendForecastStage({
        matchId,
        stage: "result",
        value: { home_score: Number(source.home_score), away_score: Number(source.away_score), source_match_id: String(source.id), result_source_verified: true }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("requires previous stage closing")) throw error;
      resultStageStatus = "SKIPPED_INCOMPLETE_CHAIN";
    }

    const trades = await db.query(
      `SELECT id, market_type, selection FROM paper_trades WHERE match_id = $1::uuid AND league_type = 'football_shadow' AND status NOT IN ('WIN','LOSS','PUSH','VOID','SETTLED','ARCHIVED')`,
      [matchId]
    );
    const closings: Array<{
      match_id: string;
      market: FootballMarketKey;
      selection: string;
      closing_odds: number;
      closing_odds_timestamp: string;
      closing_odds_provider?: string;
      closing_line_source?: string;
      scheduled_kickoff?: string;
      source_confidence_score?: number;
    }> = [];
    for (const trade of trades.rows) {
      const closing = await db.query(
        `
          SELECT odds, captured_at, provider_name, source_name
          FROM odds_snapshots
          WHERE match_id = $1::uuid
            AND market_type = $2
            AND selection = $3
            AND snapshot_role = 'closing'
            AND COALESCE((raw_data->>'safe_for_closing')::boolean, false)
          ORDER BY captured_at DESC
          LIMIT 1
        `,
        [matchId, trade.market_type, trade.selection]
      );
      if (closing.rows[0]) {
        closings.push({
          match_id: matchId,
          market: String(trade.market_type) as FootballMarketKey,
          selection: trade.selection,
          closing_odds: Number(closing.rows[0].odds),
          closing_odds_timestamp: new Date(closing.rows[0].captured_at).toISOString(),
          closing_odds_provider: closing.rows[0].provider_name,
          closing_line_source: closing.rows[0].source_name,
          scheduled_kickoff: (await matchIdentity(db, matchId)).kickoff,
          source_confidence_score: 95
        });
      }
    }
    const settlement = await settleFootballShadow(db, {
      dry_run: false,
      results: [{
        match_id: matchId,
        home_score: Number(source.home_score),
        away_score: Number(source.away_score),
        finished_at: new Date(source.updated_at).toISOString(),
        result_source: "operational_result_reconciliation_v1"
      }],
      closing_odds: closings
    });
    const completed = Number(settlement.settled || 0) > 0;
    await db.query(
      `
        UPDATE forecast_operational_focus_locks
        SET status = $2, completed_at = NOW(), details_json = details_json || $3::jsonb
        WHERE id = $1::uuid
      `,
      [lock.id, completed ? "COMPLETED" : "MISSED", JSON.stringify({
        result_match_id: source.id,
        home_score: Number(source.home_score),
        away_score: Number(source.away_score),
        shadow_tickets: trades.rows.length,
        closing_snapshots: closings.length,
        settled: Number(settlement.settled || 0),
        result_stage_status: resultStageStatus,
        prospective_clean_possible: completed && closings.length > 0
      })]
    );
    rows.push({
      match_id: matchId,
      source_match_id: source.id,
      home_score: Number(source.home_score),
      away_score: Number(source.away_score),
      focus_status: completed ? "COMPLETED" : "MISSED",
      shadow_tickets: trades.rows.length,
      closing_snapshots: closings.length,
      settled: Number(settlement.settled || 0),
      result_stage_status: resultStageStatus
    });
  }
  return {
    system_status: "FOOTBALL_OPERATIONAL_RESULT_RECONCILIATION",
    scanned: locks.rows.length,
    reconciled: rows.filter((row) => !String(row.status || "").endsWith("BLOCKED")).length,
    rows,
    guardrails: { real_candidate_count: 0, real_money_enabled: false, kelly_enabled: false, autopost_real: false }
  };
}
