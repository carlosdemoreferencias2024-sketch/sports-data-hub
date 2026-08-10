import { tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

type ManualLineupInput = {
  match_id?: string;
  home_lineup?: unknown[];
  away_lineup?: unknown[];
  goalkeeper_home?: string;
  goalkeeper_away?: string;
  formation_home?: string;
  formation_away?: string;
  source_label?: string;
  source_url?: string;
  fetched_at?: string;
  verified_by?: string;
  confidence_score?: number;
};

function localDate(date?: string) {
  return date || tradingLocalDate();
}

function localDateWindow(date?: string) {
  return tradingLocalDateWindow(date);
}

function requiredString(body: ManualLineupInput, key: keyof ManualLineupInput) {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${String(key)}_required`);
  }
  return value.trim();
}

function parseDate(value: string, key: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${key}_invalid`);
  return parsed.toISOString();
}

function lineupReady(lineup: unknown) {
  return Array.isArray(lineup) && lineup.length >= 11;
}

function confidence(value: unknown) {
  const parsed = Number(value ?? 85);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) throw new Error("confidence_score_invalid");
  return parsed;
}

function normalizeLineup(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export async function recordFootballManualVerifiedLineup(db: Queryable, body: ManualLineupInput = {}) {
  const matchId = requiredString(body, "match_id");
  const sourceLabel = requiredString(body, "source_label");
  const sourceUrl = requiredString(body, "source_url");
  const fetchedAt = parseDate(requiredString(body, "fetched_at"), "fetched_at");
  const verifiedBy = requiredString(body, "verified_by");
  const homeLineup = normalizeLineup(body.home_lineup);
  const awayLineup = normalizeLineup(body.away_lineup);
  const homeReady = lineupReady(homeLineup);
  const awayReady = lineupReady(awayLineup);
  const goalkeeperHome = typeof body.goalkeeper_home === "string" ? body.goalkeeper_home.trim() : "";
  const goalkeeperAway = typeof body.goalkeeper_away === "string" ? body.goalkeeper_away.trim() : "";
  const goalkeeperReady = goalkeeperHome.length > 0 && goalkeeperAway.length > 0;
  const complete = homeReady && awayReady && goalkeeperReady;
  const patch = {
    home_lineup: homeLineup,
    away_lineup: awayLineup,
    goalkeeper_home: goalkeeperHome || null,
    goalkeeper_away: goalkeeperAway || null,
    formation_home: body.formation_home || null,
    formation_away: body.formation_away || null,
    lineup_ready: homeReady && awayReady,
    goalkeeper_ready: goalkeeperReady,
    lineup_status: complete ? "MANUAL_VERIFIED_COMPLETE" : "MANUAL_VERIFIED_PARTIAL",
    player_intelligence_lineup_status: complete ? "READY" : "PARTIAL",
    manual_verified_lineup: {
      source_label: sourceLabel,
      source_url: sourceUrl,
      fetched_at: fetchedAt,
      verified_by: verifiedBy,
      confidence_score: confidence(body.confidence_score),
      home_count: homeLineup.length,
      away_count: awayLineup.length,
      home_ready: homeReady,
      away_ready: awayReady,
      goalkeeper_ready: goalkeeperReady,
      applied_at: new Date().toISOString()
    },
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    real_candidate: 0
  };

  const result = await db.query(
    `
      UPDATE paper_trades
      SET raw_data = COALESCE(raw_data, '{}'::jsonb) || $2::jsonb,
          updated_at = NOW()
      WHERE match_id = $1::uuid
        AND league_type = 'football_shadow'
        AND status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
      RETURNING id, match_id, home_team, away_team, market_type, selection, status, raw_data
    `,
    [matchId, JSON.stringify(patch)]
  );

  return {
    system_status: "FOOTBALL_MANUAL_VERIFIED_LINEUP_SAFE_V1",
    applied: true,
    updated_tickets: result.rows.length,
    match_id: matchId,
    lineup_ready: homeReady && awayReady,
    goalkeeper_ready: goalkeeperReady,
    context_ready_candidate: complete,
    rows: result.rows,
    rejected: false,
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}

export async function getFootballManualLineupStatus(db: Queryable, input: { date?: string; limit?: number } = {}) {
  const window = localDateWindow(input.date);
  const limit = Math.max(1, Math.min(300, Number(input.limit || 120)));
  const result = await db.query(
    `
      SELECT
        pt.id AS ticket_id,
        pt.match_id,
        COALESCE(NULLIF(pt.home_team, ''), 'Home') || ' vs ' || COALESCE(NULLIF(pt.away_team, ''), 'Away') AS match,
        pt.league_slug,
        m.match_date AS kickoff,
        pt.status,
        jsonb_array_length(CASE WHEN jsonb_typeof(pt.raw_data->'home_lineup') = 'array' THEN pt.raw_data->'home_lineup' ELSE '[]'::jsonb END) AS home_count,
        jsonb_array_length(CASE WHEN jsonb_typeof(pt.raw_data->'away_lineup') = 'array' THEN pt.raw_data->'away_lineup' ELSE '[]'::jsonb END) AS away_count,
        pt.raw_data->>'goalkeeper_home' AS goalkeeper_home,
        pt.raw_data->>'goalkeeper_away' AS goalkeeper_away,
        pt.raw_data->>'lineup_status' AS lineup_status,
        pt.raw_data->'manual_verified_lineup' AS manual_verified_lineup
      FROM paper_trades pt
      LEFT JOIN matches m ON m.id = pt.match_id
      WHERE pt.league_type = 'football_shadow'
        AND (
          (m.match_date >= $1::timestamptz AND m.match_date < $2::timestamptz)
          OR pt.status NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID', 'SETTLED', 'ARCHIVED')
        )
      ORDER BY m.match_date NULLS LAST, pt.created_at DESC
      LIMIT $3
    `,
    [window.start, window.end, limit]
  );

  const rows = result.rows.map((row) => ({
    ...row,
    lineup_ready: Number(row.home_count || 0) >= 11 && Number(row.away_count || 0) >= 11,
    goalkeeper_ready: Boolean(row.goalkeeper_home && row.goalkeeper_away),
    can_improve_bottleneck: !(Number(row.home_count || 0) >= 11 && Number(row.away_count || 0) >= 11 && row.goalkeeper_home && row.goalkeeper_away)
  }));

  return {
    system_status: "FOOTBALL_LINEUPS_STATUS_SAFE_V1",
    date: window.selectedDate,
    scanned: rows.length,
    lineup_ready: rows.filter((row) => row.lineup_ready).length,
    goalkeeper_ready: rows.filter((row) => row.goalkeeper_ready).length,
    needs_manual_verified: rows.filter((row) => row.can_improve_bottleneck).length,
    rows,
    recommendation: rows.some((row) => row.can_improve_bottleneck)
      ? "Cargar alineacion/portero manual_verified solo con fuente oficial o verificada."
      : "Lineups football_shadow visibles para preflight.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
