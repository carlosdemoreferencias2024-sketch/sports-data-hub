import { createHash } from "node:crypto";
import { z } from "zod";
import { tradingLocalDateWindow } from "./timezone.js";

const PROVIDER = "api_football";
const DEFAULT_BASE_URL = "https://v3.football.api-sports.io";
const DEFAULT_DAILY_LIMIT = 100;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_CACHE_HOURS = 6;
const DEFAULT_NEAR_START_RESERVE = 20;

const API_FOOTBALL_LEAGUE_IDS: Record<string, number> = {
  "liga-mx": 262,
  mls: 253,
  "brasileirao-serie-a": 71,
  "argentina-primera-division": 128,
  "fifa-world-cup-2026": 1,
  "uefa-champions-league": 2,
  "premier-league": 39,
  "la-liga": 140,
  "serie-a": 135,
  bundesliga: 78
};

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount?: number }>;
};

type GatewayTarget = {
  match_id: string;
  league_id: string;
  league_name: string | null;
  home_team: string;
  away_team: string;
  kickoff: string | null;
  match_status: string | null;
  match_raw_data: Record<string, any>;
  candidate_market: string | null;
  candidate_selection: string | null;
  candidate_odds: number | null;
  candidate_provider: string | null;
  candidate_raw_data: Record<string, any>;
  api_football_fixture_id: string | null;
  api_football_league_id: string | null;
  api_football_season: string | null;
};

type FetchPlanItem = {
  endpoint: string;
  params: Record<string, string | number>;
  cache_key: string;
  needs_fixture_id: boolean;
  status: "WOULD_FETCH" | "CACHE_HIT" | "FETCHED" | "SKIPPED" | "ERROR";
  reason?: string;
};

const hydrateSchema = z.object({
  dry_run: z.boolean().optional().default(true),
  date: z.string().optional(),
  league_ids: z.array(z.string().min(1)).optional().default(["mls", "liga-mx", "fifa-world-cup-2026"]),
  match_ids: z.array(z.string().uuid()).optional().default([]),
  priority_only: z.boolean().optional().default(true),
  include_lineups: z.boolean().optional().default(true),
  include_injuries: z.boolean().optional().default(true),
  include_team_stats: z.boolean().optional().default(true),
  include_player_stats: z.boolean().optional().default(false),
  max_api_requests: z.number().int().min(0).max(50).optional().default(10)
});

type HydrateInput = z.infer<typeof hydrateSchema>;

const manualContextSchema = z.object({
  dry_run: z.boolean().optional().default(true),
  source: z.string().min(1).max(120).optional().default("manual_verified_football_context"),
  matches: z.array(z.object({
    match_id: z.string().uuid(),
    league_id: z.string().min(1).max(100).optional(),
    home_team: z.string().max(160).optional(),
    away_team: z.string().max(160).optional(),
    team_intelligence_status: z.enum(["NO_CONTEXT", "CONTEXT_GAPS", "PARTIAL_CONTEXT_REVIEW", "TEAM_CONTEXT_SUPPORTS", "TEAM_CONTEXT_CONFLICTS", "BLOCK_CONFIRMATION", "REQUIRES_MANUAL_REVIEW"]).optional().default("PARTIAL_CONTEXT_REVIEW"),
    source_confidence_score: z.number().min(0).max(1).optional().default(0.75),
    team_context: z.record(z.any()).optional().default({}),
    lineups: z.array(z.object({
      team: z.string().min(1).max(160),
      player_name: z.string().min(1).max(160).optional(),
      position: z.string().max(80).optional().default("lineup"),
      expected_starting: z.boolean().optional(),
      confirmed_starting: z.boolean().optional(),
      lineup_status: z.enum(["UNKNOWN", "PROBABLE", "CONFIRMED", "NOT_STARTING", "BENCH", "OUT"]).optional().default("UNKNOWN"),
      injury_status: z.enum(["UNKNOWN", "HEALTHY", "QUESTIONABLE", "OUT"]).optional().default("UNKNOWN"),
      suspension_status: z.enum(["NONE", "SUSPENDED", "RISK", "UNKNOWN"]).optional().default("UNKNOWN"),
      key_player_flag: z.boolean().optional().default(true),
      player_intelligence_status: z.enum(["NO_CONTEXT", "LINEUP_PENDING", "PLAYER_CONTEXT_SUPPORTS", "PLAYER_CONTEXT_CONFLICTS", "BLOCK_CONFIRMATION", "REQUIRES_MANUAL_REVIEW"]).optional(),
      raw_data: z.record(z.any()).optional().default({})
    })).optional().default([])
  })).min(1).max(20)
});

const officialNearStartSchema = z.object({
  match_id: z.string().uuid(),
  dry_run: z.boolean().optional().default(false),
  max_cache_age_minutes: z.number().int().min(1).max(30).optional().default(5)
});

type ManualContextInput = z.infer<typeof manualContextSchema>;

function toInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashPayload(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cacheKey(endpoint: string, params: Record<string, unknown>) {
  return `${endpoint}:${hashPayload(params)}`;
}

function rawObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function localDateWindow(date?: string | null) {
  if (!date) return { start: null as string | null, end: null as string | null };
  return tradingLocalDateWindow(date);
}

function apiFootballPayloadHasErrors(payload: unknown) {
  const errors = rawObject(payload).errors;
  if (!errors) return false;
  if (Array.isArray(errors)) return errors.length > 0;
  if (typeof errors === "object") return Object.keys(errors as Record<string, unknown>).length > 0;
  return String(errors).trim().length > 0;
}

function apiFootballErrorSummary(payload: unknown) {
  const errors = rawObject(payload).errors;
  if (!errors) return null;
  if (typeof errors === "string") return errors;
  if (Array.isArray(errors)) return errors.map(String).join("; ");
  if (typeof errors === "object") {
    return Object.entries(errors as Record<string, unknown>)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join("; ");
  }
  return String(errors);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return null;
}

function rawFixtureId(target: GatewayTarget) {
  return firstString(
    target.api_football_fixture_id,
    target.match_raw_data.api_football_fixture_id,
    target.candidate_raw_data.api_football_fixture_id,
    target.match_raw_data.fixture_id,
    target.candidate_raw_data.fixture_id
  );
}

function rawLeagueId(target: GatewayTarget) {
  return firstString(
    target.api_football_league_id,
    target.match_raw_data.api_football_league_id,
    target.candidate_raw_data.api_football_league_id,
    API_FOOTBALL_LEAGUE_IDS[target.league_id]
  );
}

function rawSeason(target: GatewayTarget) {
  return firstString(
    target.api_football_season,
    target.match_raw_data.api_football_season,
    target.candidate_raw_data.api_football_season,
    target.kickoff ? new Date(target.kickoff).getUTCFullYear() : new Date().getUTCFullYear()
  );
}
function normalizeName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/football club|fc|sc|cf|club de futbol|club/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesLikelyMatch(left: unknown, right: unknown) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function findApiFixtureMatch(payload: unknown, target: GatewayTarget) {
  const response = rawObject(payload).response;
  const rows = Array.isArray(response) ? response : response ? [response] : [];
  for (const item of rows) {
    const home = item?.teams?.home?.name;
    const away = item?.teams?.away?.name;
    if (namesLikelyMatch(home, target.home_team) && namesLikelyMatch(away, target.away_team)) {
      return {
        fixture_id: firstString(item?.fixture?.id),
        league_id: firstString(item?.league?.id),
        season: firstString(item?.league?.season),
        home_team: home,
        away_team: away,
        kickoff: firstString(item?.fixture?.date),
        status_short: firstString(item?.fixture?.status?.short),
        raw: item
      };
    }
  }
  return null;
}

async function persistApiFixtureMatch(db: Queryable, target: GatewayTarget, fixtureMatch: ReturnType<typeof findApiFixtureMatch>) {
  if (!fixtureMatch?.fixture_id) return;
  await db.query(
    `
      UPDATE matches
      SET raw_data = COALESCE(raw_data, '{}'::jsonb) || $2::jsonb,
          updated_at = now()
      WHERE id = $1
    `,
    [
      target.match_id,
      JSON.stringify({
        api_football_fixture_id: fixtureMatch.fixture_id,
        api_football_league_id: fixtureMatch.league_id,
        api_football_season: fixtureMatch.season,
        api_football_fixture_matched_at: new Date().toISOString(),
        api_football_fixture_match_source: "football_data_gateway",
        source_consensus: "local+api_football",
        kickoff_trusted: true
      })
    ]
  );
}

async function ensureGatewayTables(db: Queryable) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS api_provider_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider varchar(80) NOT NULL,
      date_utc date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
      endpoint varchar(160) NOT NULL,
      minute_bucket timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
      requests_used integer NOT NULL DEFAULT 0,
      requests_limit integer NOT NULL DEFAULT 100,
      rate_limit_per_minute integer NOT NULL DEFAULT 10,
      last_request_at timestamptz,
      status varchar(40) NOT NULL DEFAULT 'OK',
      raw_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, date_utc, endpoint, minute_bucket)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_api_provider_usage_provider_date ON api_provider_usage(provider, date_utc, endpoint)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS api_response_cache (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider varchar(80) NOT NULL,
      endpoint varchar(160) NOT NULL,
      params_hash varchar(80) NOT NULL,
      cache_key varchar(260) NOT NULL,
      response_json jsonb NOT NULL,
      source_confidence_score numeric(6,3) NOT NULL DEFAULT 0.750,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, cache_key),
      CHECK (source_confidence_score >= 0 AND source_confidence_score <= 1)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_api_response_cache_valid ON api_response_cache(provider, endpoint, expires_at DESC)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS football_source_consensus (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id uuid REFERENCES matches(id) ON DELETE CASCADE,
      league_id varchar(100) NOT NULL,
      home_team varchar(160) NOT NULL,
      away_team varchar(160) NOT NULL,
      kickoff timestamptz,
      sources jsonb NOT NULL DEFAULT '{}'::jsonb,
      consensus_verified boolean NOT NULL DEFAULT false,
      consensus_score numeric(6,3) NOT NULL DEFAULT 0,
      missing_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
      conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
      recommendation varchar(160) NOT NULL DEFAULT 'SOURCE_CONSENSUS_REQUIRED',
      observed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (match_id),
      CHECK (consensus_score >= 0 AND consensus_score <= 1)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_football_source_consensus_league ON football_source_consensus(league_id, consensus_verified, observed_at DESC)`);
}

async function usageStatus(db: Queryable) {
  const dailyLimit = toInt(process.env.API_FOOTBALL_DAILY_LIMIT, DEFAULT_DAILY_LIMIT);
  const rateLimitPerMinute = toInt(process.env.API_FOOTBALL_RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE);
  const nearStartReserve = Math.min(
    dailyLimit,
    toInt(process.env.API_FOOTBALL_NEAR_START_RESERVE, DEFAULT_NEAR_START_RESERVE)
  );
  const used = await db.query(
    `SELECT COALESCE(SUM(requests_used), 0)::int AS requests_used_today FROM api_provider_usage WHERE provider = $1 AND date_utc = (now() AT TIME ZONE 'UTC')::date`,
    [PROVIDER]
  );
  const requestsUsedToday = Number(used.rows[0]?.requests_used_today ?? 0);
  return {
    provider: PROVIDER,
    api_key_configured: Boolean(process.env.API_FOOTBALL_KEY || process.env.FOOTBALL_API_KEY),
    base_url: process.env.API_FOOTBALL_BASE_URL || DEFAULT_BASE_URL,
    requests_used_today: requestsUsedToday,
    requests_limit: dailyLimit,
    quota_remaining_estimate: Math.max(0, dailyLimit - requestsUsedToday),
    near_start_reserve: nearStartReserve,
    general_context_quota_remaining: Math.max(0, dailyLimit - requestsUsedToday - nearStartReserve),
    rate_limit_per_minute: rateLimitPerMinute
  };
}

async function cacheLookup(
  db: Queryable,
  endpoint: string,
  params: Record<string, unknown>,
  maxAgeMinutes?: number
): Promise<{ response_json: unknown; source_confidence_score: unknown; expires_at: unknown; cache_key: string } | null> {
  const key = cacheKey(endpoint, params);
  const result = await db.query(
    `
      SELECT response_json, source_confidence_score, expires_at
      FROM api_response_cache
      WHERE provider = $1
        AND cache_key = $2
        AND expires_at > now()
        AND ($3::integer IS NULL OR updated_at >= now() - ($3::text || ' minutes')::interval)
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [PROVIDER, key, maxAgeMinutes ?? null]
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row || apiFootballPayloadHasErrors(row.response_json)) return null;
  return { response_json: row.response_json, source_confidence_score: row.source_confidence_score, expires_at: row.expires_at, cache_key: key };
}

async function cacheStore(
  db: Queryable,
  endpoint: string,
  params: Record<string, unknown>,
  response: unknown,
  confidence = 0.8,
  ttlMinutes?: number
) {
  const key = cacheKey(endpoint, params);
  const paramsHash = hashPayload(params);
  const cacheHours = toInt(process.env.API_FOOTBALL_CACHE_HOURS, DEFAULT_CACHE_HOURS);
  const expiresAt = new Date(Date.now() + (ttlMinutes ? ttlMinutes * 60_000 : cacheHours * 3_600_000)).toISOString();
  await db.query(
    `
      INSERT INTO api_response_cache (provider, endpoint, params_hash, cache_key, response_json, source_confidence_score, expires_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz)
      ON CONFLICT (provider, cache_key) DO UPDATE SET
        response_json = EXCLUDED.response_json,
        source_confidence_score = EXCLUDED.source_confidence_score,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `,
    [PROVIDER, endpoint, paramsHash, key, JSON.stringify(response), confidence, expiresAt]
  );
}

async function recordUsage(db: Queryable, endpoint: string, headers: Record<string, string> = {}, status = "OK") {
  const dailyLimit = toInt(process.env.API_FOOTBALL_DAILY_LIMIT, DEFAULT_DAILY_LIMIT);
  const rateLimitPerMinute = toInt(process.env.API_FOOTBALL_RATE_LIMIT_PER_MINUTE, DEFAULT_RATE_LIMIT_PER_MINUTE);
  await db.query(
    `
      INSERT INTO api_provider_usage (provider, date_utc, endpoint, minute_bucket, requests_used, requests_limit, rate_limit_per_minute, last_request_at, status, raw_headers)
      VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2, date_trunc('minute', now()), 1, $3, $4, now(), $5, $6::jsonb)
      ON CONFLICT (provider, date_utc, endpoint, minute_bucket) DO UPDATE SET
        requests_used = api_provider_usage.requests_used + 1,
        requests_limit = EXCLUDED.requests_limit,
        rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
        last_request_at = now(),
        status = EXCLUDED.status,
        raw_headers = EXCLUDED.raw_headers,
        updated_at = now()
    `,
    [PROVIDER, endpoint, dailyLimit, rateLimitPerMinute, status, JSON.stringify(headers)]
  );
}

async function fetchApiFootball(endpoint: string, params: Record<string, string | number>) {
  const key = process.env.API_FOOTBALL_KEY || process.env.FOOTBALL_API_KEY;
  if (!key) return { ok: false, status: 0, reason: "API_FOOTBALL_KEY_MISSING", json: null, headers: {} as Record<string, string> };
  const base = process.env.API_FOOTBALL_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(endpoint.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  const response = await fetch(url, { headers: { "x-apisports-key": key } });
  const headers = Object.fromEntries(response.headers.entries());
  const json = await response.json().catch(() => null);
  if (response.ok && apiFootballPayloadHasErrors(json)) {
    return { ok: false, status: response.status, reason: "API_FOOTBALL_RESPONSE_ERROR", json, headers };
  }
  return { ok: response.ok, status: response.status, reason: response.ok ? null : "API_FOOTBALL_HTTP_ERROR", json, headers };
}

async function findTargets(db: Queryable, input: HydrateInput): Promise<GatewayTarget[]> {
  const dateWindow = localDateWindow(input.date || null);
  const leagueIds = input.league_ids ?? [];
  const matchIds = input.match_ids ?? [];
  const result = await db.query(
    `
      WITH latest_candidate AS (
        SELECT DISTINCT ON (os.match_id)
          os.match_id,
          os.market_type,
          os.selection,
          os.odds,
          os.provider_name,
          os.raw_data,
          os.captured_at
        FROM odds_snapshots os
        WHERE os.sport_slug = 'soccer'
          AND os.raw_data->>'feed_status' = 'SHADOW_CANDIDATE'
        ORDER BY os.match_id, os.captured_at DESC
      )
      SELECT
        m.id::text AS match_id,
        l.slug AS league_id,
        l.name AS league_name,
        home_team.name AS home_team,
        away_team.name AS away_team,
        m.match_date::text AS kickoff,
        m.status::text AS match_status,
        COALESCE(m.raw_data, '{}'::jsonb) AS match_raw_data,
        lc.market_type AS candidate_market,
        lc.selection AS candidate_selection,
        lc.odds::numeric AS candidate_odds,
        lc.provider_name AS candidate_provider,
        COALESCE(lc.raw_data, '{}'::jsonb) AS candidate_raw_data,
        COALESCE(m.raw_data->>'api_football_fixture_id', lc.raw_data->>'api_football_fixture_id') AS api_football_fixture_id,
        COALESCE(m.raw_data->>'api_football_league_id', lc.raw_data->>'api_football_league_id') AS api_football_league_id,
        COALESCE(m.raw_data->>'api_football_season', lc.raw_data->>'api_football_season') AS api_football_season
      FROM v_valid_matches m
      JOIN leagues l ON l.id = m.league_id
      LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
      LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      LEFT JOIN latest_candidate lc ON lc.match_id = m.id
      WHERE l.slug = ANY($1::text[])
        AND ($2::timestamptz IS NULL OR (m.match_date >= $2::timestamptz AND m.match_date < $3::timestamptz))
        AND (COALESCE(array_length($4::uuid[], 1), 0) = 0 OR m.id = ANY($4::uuid[]))
        AND (m.raw_data->>'football_today_universe' = 'true' OR lc.match_id IS NOT NULL)
        AND ($5::boolean = false OR lc.match_id IS NOT NULL)
      ORDER BY COALESCE(lc.captured_at, m.match_date) DESC
      LIMIT 80
    `,
    [leagueIds, dateWindow.start, dateWindow.end, matchIds, input.priority_only]
  );
  return result.rows.map((row) => ({
    match_id: String(row.match_id),
    league_id: String(row.league_id),
    league_name: row.league_name ? String(row.league_name) : null,
    home_team: String(row.home_team || "Home"),
    away_team: String(row.away_team || "Away"),
    kickoff: row.kickoff ? String(row.kickoff) : null,
    match_status: row.match_status ? String(row.match_status) : null,
    match_raw_data: rawObject(row.match_raw_data),
    candidate_market: row.candidate_market ? String(row.candidate_market) : null,
    candidate_selection: row.candidate_selection ? String(row.candidate_selection) : null,
    candidate_odds: row.candidate_odds === null || row.candidate_odds === undefined ? null : Number(row.candidate_odds),
    candidate_provider: row.candidate_provider ? String(row.candidate_provider) : null,
    candidate_raw_data: rawObject(row.candidate_raw_data),
    api_football_fixture_id: row.api_football_fixture_id ? String(row.api_football_fixture_id) : null,
    api_football_league_id: row.api_football_league_id ? String(row.api_football_league_id) : null,
    api_football_season: row.api_football_season ? String(row.api_football_season) : null
  }));
}

function buildFetchPlan(target: GatewayTarget, input: HydrateInput): FetchPlanItem[] {
  const fixtureId = rawFixtureId(target);
  const leagueId = rawLeagueId(target);
  const season = rawSeason(target);
  const date = input.date || (target.kickoff ? target.kickoff.slice(0, 10) : undefined);
  const plan: Array<{ endpoint: string; params: Record<string, string | number>; needs_fixture_id: boolean }> = [];
  if (fixtureId) plan.push({ endpoint: "/fixtures", params: { id: fixtureId }, needs_fixture_id: true });
  else if (date && leagueId && season) plan.push({ endpoint: "/fixtures", params: { date, league: leagueId, season }, needs_fixture_id: false });
  if (fixtureId && input.include_lineups) plan.push({ endpoint: "/fixtures/lineups", params: { fixture: fixtureId }, needs_fixture_id: true });
  if (fixtureId && input.include_injuries) plan.push({ endpoint: "/injuries", params: { fixture: fixtureId }, needs_fixture_id: true });
  if (fixtureId && input.include_team_stats) plan.push({ endpoint: "/fixtures/statistics", params: { fixture: fixtureId }, needs_fixture_id: true });
  if (fixtureId && input.include_player_stats) plan.push({ endpoint: "/fixtures/players", params: { fixture: fixtureId }, needs_fixture_id: true });
  if (!fixtureId && (input.include_lineups || input.include_injuries || input.include_team_stats || input.include_player_stats)) {
    plan.push({ endpoint: "/fixtures/context", params: { date: date || "unknown", league: leagueId || target.league_id }, needs_fixture_id: true });
  }
  return plan.map((item) => ({ ...item, cache_key: cacheKey(item.endpoint, item.params), status: item.needs_fixture_id && !fixtureId ? "SKIPPED" : "WOULD_FETCH", reason: item.needs_fixture_id && !fixtureId ? "API_FOOTBALL_FIXTURE_ID_REQUIRED" : undefined }));
}

function payloadHasResponse(payload: unknown) {
  const value = rawObject(payload);
  return Array.isArray(value.response) ? value.response.length > 0 : Boolean(value.response);
}

function responseCount(payload: unknown) {
  const value = rawObject(payload);
  return Array.isArray(value.response) ? value.response.length : value.response ? 1 : 0;
}

async function upsertConsensus(db: Queryable, target: GatewayTarget, sources: Record<string, unknown>, verified: boolean, score: number, missing: string[], conflicts: string[]) {
  await db.query(
    `
      INSERT INTO football_source_consensus (match_id, league_id, home_team, away_team, kickoff, sources, consensus_verified, consensus_score, missing_sources, conflicts, recommendation, observed_at)
      VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11, now())
      ON CONFLICT (match_id) DO UPDATE SET
        league_id = EXCLUDED.league_id,
        home_team = EXCLUDED.home_team,
        away_team = EXCLUDED.away_team,
        kickoff = EXCLUDED.kickoff,
        sources = EXCLUDED.sources,
        consensus_verified = EXCLUDED.consensus_verified,
        consensus_score = EXCLUDED.consensus_score,
        missing_sources = EXCLUDED.missing_sources,
        conflicts = EXCLUDED.conflicts,
        recommendation = EXCLUDED.recommendation,
        observed_at = now(),
        updated_at = now()
    `,
    [target.match_id, target.league_id, target.home_team, target.away_team, target.kickoff, JSON.stringify(sources), verified, score, JSON.stringify(missing), JSON.stringify(conflicts), verified ? "SOURCE_CONSENSUS_VERIFIED" : "SOURCE_CONSENSUS_REQUIRED"]
  );
}

async function upsertTeamIntelligence(db: Queryable, target: GatewayTarget, status: string, confidence: number, rawData: Record<string, unknown>) {
  await db.query(
    `
      INSERT INTO football_team_intelligence (match_id, league_id, home_team, away_team, team_intelligence_status, source, source_confidence_score, observed_at, raw_data)
      VALUES ($1, $2, $3, $4, $5, 'football_data_gateway', $6, now(), $7::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [target.match_id, target.league_id, target.home_team, target.away_team, status, confidence, JSON.stringify(rawData)]
  );
}

async function insertPlayerLineupContext(db: Queryable, target: GatewayTarget, team: string, supports: boolean, confidence: number, rawData: Record<string, unknown>) {
  await db.query(
    `
      INSERT INTO football_player_intelligence (match_id, league_id, team, player_name, normalized_player_name, position, lineup_status, injury_status, suspension_status, key_player_flag, impact_area, player_intelligence_status, source, source_confidence_score, observed_at, raw_data)
      VALUES ($1, $2, $3, $4, $5, 'lineup', $6, 'UNKNOWN', 'UNKNOWN', true, 'lineup_context', $7, 'football_data_gateway', $8, now(), $9::jsonb)
    `,
    [
      target.match_id,
      target.league_id,
      team,
      `${team} lineup`,
      `${normalizeName(team)}-lineup`,
      supports ? "CONFIRMED" : "UNKNOWN",
      supports ? "PLAYER_CONTEXT_SUPPORTS" : "LINEUP_PENDING",
      confidence,
      JSON.stringify(rawData)
    ]
  );
}

async function applyHydration(db: Queryable, target: GatewayTarget, responses: Record<string, unknown>) {
  const fixturePayload = responses["/fixtures"];
  const fixtureMatch = findApiFixtureMatch(fixturePayload, target);
  await persistApiFixtureMatch(db, target, fixtureMatch);
  const lineupsPayload = responses["/fixtures/lineups"];
  const injuriesPayload = responses["/injuries"];
  const statsPayload = responses["/fixtures/statistics"];
  const hasFixture = payloadHasResponse(fixturePayload);
  const hasLineups = payloadHasResponse(lineupsPayload);
  const hasStats = payloadHasResponse(statsPayload);
  const hasInjuries = payloadHasResponse(injuriesPayload);
  const verified = Boolean(fixtureMatch?.fixture_id || rawFixtureId(target));
  const consensusScore = verified ? (hasLineups || hasStats ? 0.85 : 0.72) : 0.45;
  const missing = [!verified ? "api_football_fixture_match" : null, !hasLineups ? "lineups" : null, !hasStats ? "team_stats" : null].filter(Boolean) as string[];
  await upsertConsensus(db, target, {
    local: { source: target.match_raw_data.source || "football_today_universe", kickoff: target.kickoff },
    api_football: {
      fixture_id: fixtureMatch?.fixture_id || rawFixtureId(target),
      fixture_response: responseCount(fixturePayload),
      lineups_response: responseCount(lineupsPayload),
      injuries_response: responseCount(injuriesPayload),
      statistics_response: responseCount(statsPayload)
    }
  }, verified, consensusScore, missing, []);
  const teamStatus = hasStats ? "TEAM_CONTEXT_SUPPORTS" : verified ? "PARTIAL_CONTEXT_REVIEW" : "CONTEXT_GAPS";
  await upsertTeamIntelligence(db, target, teamStatus, consensusScore, { fixture: fixturePayload ?? null, statistics: statsPayload ?? null, injuries: injuriesPayload ?? null });
  await insertPlayerLineupContext(db, target, target.home_team, hasLineups, hasLineups ? 0.82 : 0.5, { lineups: lineupsPayload ?? null, side: "home", has_injuries: hasInjuries });
  await insertPlayerLineupContext(db, target, target.away_team, hasLineups, hasLineups ? 0.82 : 0.5, { lineups: lineupsPayload ?? null, side: "away", has_injuries: hasInjuries });
  return { consensus_verified: verified, consensus_score: consensusScore, team_status: teamStatus, player_status: hasLineups ? "PLAYER_CONTEXT_SUPPORTS" : "LINEUP_PENDING" };
}

function responseRows(payload: unknown) {
  const response = rawObject(payload).response;
  return Array.isArray(response) ? response : [];
}

function usableOfficialPayload(payload: unknown) {
  return Boolean(payload && typeof payload === "object" && Array.isArray(rawObject(payload).response) && !apiFootballPayloadHasErrors(payload));
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function lineupSide(rows: any[], teamName: string) {
  const side = rows.find((row) => namesLikelyMatch(row?.team?.name, teamName));
  const starters = Array.isArray(side?.startXI) ? side.startXI : [];
  const normalizedStarters = starters
    .map((row: any) => ({
      id: firstString(row?.player?.id),
      name: firstString(row?.player?.name),
      number: row?.player?.number ?? null,
      position: firstString(row?.player?.pos),
      grid: firstString(row?.player?.grid)
    }))
    .filter((row: Record<string, unknown>) => Boolean(row.name));
  const goalkeeper = normalizedStarters.find((row: Record<string, unknown>) => {
    const position = String(row.position || "").trim().toLowerCase();
    return position === "g" || position === "gk" || position === "goalkeeper";
  });
  return {
    team_id: firstString(side?.team?.id),
    team_name: firstString(side?.team?.name),
    formation: firstString(side?.formation),
    starters: normalizedStarters,
    goalkeeper: goalkeeper?.name ? String(goalkeeper.name) : null,
    confirmed: normalizedStarters.length === 11
  };
}

export function normalizeApiFootballNearStartPayloads(input: {
  homeTeam: string;
  awayTeam: string;
  lineupsPayload: unknown;
  injuriesPayload: unknown;
}) {
  const lineupsUsable = usableOfficialPayload(input.lineupsPayload);
  const availabilityUsable = usableOfficialPayload(input.injuriesPayload);
  const lineupRows = responseRows(input.lineupsPayload);
  const home = lineupSide(lineupRows, input.homeTeam);
  const away = lineupSide(lineupRows, input.awayTeam);
  const identityMatches = Boolean(
    home.team_name && away.team_name &&
    namesLikelyMatch(home.team_name, input.homeTeam) &&
    namesLikelyMatch(away.team_name, input.awayTeam)
  );
  const lineupConfirmed = lineupsUsable && identityMatches && home.confirmed && away.confirmed;
  const goalkeeperConfirmed = lineupConfirmed && Boolean(home.goalkeeper && away.goalkeeper);

  const availabilityDetails = responseRows(input.injuriesPayload)
    .map((row: any) => {
      const playerName = firstString(row?.player?.name);
      const type = firstString(row?.player?.type);
      const reason = firstString(row?.player?.reason);
      const teamName = firstString(row?.team?.name);
      if (!playerName) return null;
      const joined = `${type || ""} ${reason || ""}`.toLowerCase();
      const category = /suspend|red card|yellow card ban|disciplin/.test(joined) ? "suspension" : "injury";
      const side = namesLikelyMatch(teamName, input.homeTeam)
        ? "home"
        : namesLikelyMatch(teamName, input.awayTeam) ? "away" : "unknown";
      return {
        player_id: firstString(row?.player?.id),
        player_name: playerName,
        team_id: firstString(row?.team?.id),
        team_name: teamName,
        side,
        category,
        type,
        reason
      };
    })
    .filter(Boolean) as Array<Record<string, unknown>>;
  const injuries = uniqueStrings(availabilityDetails.filter((row) => row.category === "injury").map((row) => row.player_name));
  const suspensions = uniqueStrings(availabilityDetails.filter((row) => row.category === "suspension").map((row) => row.player_name));

  return {
    lineup_status: lineupConfirmed ? "CONFIRMED" : (lineupsUsable && lineupRows.length > 0 ? "PENDING" : "UNKNOWN"),
    goalkeeper_status: goalkeeperConfirmed ? "CONFIRMED" : (lineupsUsable && lineupRows.length > 0 ? "PENDING" : "UNKNOWN"),
    availability_status: availabilityUsable ? "CONFIRMED" : "SOURCE_UNAVAILABLE",
    home_lineup: home.starters.map((row: Record<string, unknown>) => String(row.name)),
    away_lineup: away.starters.map((row: Record<string, unknown>) => String(row.name)),
    formation_home: home.formation,
    formation_away: away.formation,
    goalkeeper_home: home.goalkeeper,
    goalkeeper_away: away.goalkeeper,
    unavailable_players: uniqueStrings([...injuries, ...suspensions]),
    injuries,
    suspensions,
    availability_details: availabilityDetails,
    source_integrity: {
      lineups_payload_valid: lineupsUsable,
      availability_payload_valid: availabilityUsable,
      lineup_team_identity_match: identityMatches,
      empty_availability_report_is_valid: availabilityUsable && availabilityDetails.length === 0
    }
  };
}

async function officialNearStartTarget(db: Queryable, matchId: string) {
  const result = await db.query(
    `
      SELECT
        m.id::text AS match_id,
        m.match_date::text AS kickoff,
        l.slug AS league_slug,
        home_team.name AS home_team,
        away_team.name AS away_team,
        mapping.provider_name,
        mapping.external_match_id AS fixture_id,
        schedule_validation.result AS schedule_validation,
        identity_validation.result AS identity_validation,
        EXTRACT(EPOCH FROM (m.match_date - now())) / 60.0 AS minutes_until_start
      FROM v_valid_matches m
      JOIN leagues l ON l.id = m.league_id
      JOIN sports s ON s.id = l.sport_id
      LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
      LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
      LEFT JOIN LATERAL (
        SELECT provider_name, external_match_id
        FROM forecast_provider_match_mappings
        WHERE match_id = m.id
          AND LOWER(REPLACE(provider_name, '_', '-')) LIKE '%api-football%'
        ORDER BY verified_at DESC, id DESC
        LIMIT 1
      ) mapping ON TRUE
      LEFT JOIN LATERAL (
        SELECT result
        FROM forecast_slate_validations
        WHERE match_id = m.id AND validation_type = 'schedule'
        ORDER BY validated_at DESC, id DESC
        LIMIT 1
      ) schedule_validation ON TRUE
      LEFT JOIN LATERAL (
        SELECT result
        FROM forecast_slate_validations
        WHERE match_id = m.id AND validation_type = 'identity'
        ORDER BY validated_at DESC, id DESC
        LIMIT 1
      ) identity_validation ON TRUE
      WHERE m.id = $1::uuid AND s.slug = 'soccer'
      LIMIT 1
    `,
    [matchId]
  );
  return result.rows[0] || null;
}

export async function captureFootballOfficialNearStartContext(db: Queryable, body: unknown) {
  await ensureGatewayTables(db);
  const input = officialNearStartSchema.parse(body ?? {});
  const target = await officialNearStartTarget(db, input.match_id);
  if (!target) throw new Error("football_near_start_match_not_found");
  if (!target.fixture_id) throw new Error("api_football_fixture_mapping_required");
  if (String(target.schedule_validation) !== "VALID") throw new Error("football_schedule_validation_required");
  if (String(target.identity_validation) !== "VALID") throw new Error("football_identity_validation_required");
  const minutesUntilStart = Number(target.minutes_until_start);
  if (!Number.isFinite(minutesUntilStart) || minutesUntilStart <= 0) throw new Error("post_kickoff_capture_rejected");
  if (minutesUntilStart < 5 || minutesUntilStart > 90) throw new Error("football_near_start_window_inactive");

  const usage = await usageStatus(db);
  const endpoints = ["/fixtures/lineups", "/injuries"] as const;
  const payloads: Record<string, unknown> = {};
  const fetchStatus: Record<string, unknown>[] = [];
  let remaining = usage.quota_remaining_estimate;
  for (const endpoint of endpoints) {
    const params = { fixture: String(target.fixture_id) };
    const cached = await cacheLookup(db, endpoint, params, input.max_cache_age_minutes);
    if (cached) {
      payloads[endpoint] = cached.response_json;
      fetchStatus.push({ endpoint, status: "CACHE_HIT", cache_key: cached.cache_key });
      continue;
    }
    if (input.dry_run) {
      fetchStatus.push({ endpoint, status: "WOULD_FETCH" });
      continue;
    }
    if (remaining <= 0) {
      fetchStatus.push({ endpoint, status: "SKIPPED", reason: "API_FOOTBALL_QUOTA_GUARD" });
      continue;
    }
    const response = await fetchApiFootball(endpoint, params);
    await recordUsage(db, endpoint, response.headers, response.ok ? "OK" : String(response.reason || "ERROR"));
    remaining -= 1;
    if (!response.ok) {
      fetchStatus.push({
        endpoint,
        status: "ERROR",
        reason: [response.reason, apiFootballErrorSummary(response.json)].filter(Boolean).join(" | ")
      });
      continue;
    }
    payloads[endpoint] = response.json;
    await cacheStore(db, endpoint, params, response.json, 0.9, 10);
    fetchStatus.push({ endpoint, status: "FETCHED" });
  }

  if (input.dry_run && endpoints.some((endpoint) => !payloads[endpoint])) {
    return {
      system_status: "FOOTBALL_OFFICIAL_NEAR_START_DRY_RUN",
      capture_ready: false,
      match_id: String(target.match_id),
      fixture_id: String(target.fixture_id),
      fetch_status: fetchStatus,
      quota_remaining_estimate: remaining
    };
  }

  const normalized = normalizeApiFootballNearStartPayloads({
    homeTeam: String(target.home_team),
    awayTeam: String(target.away_team),
    lineupsPayload: payloads["/fixtures/lineups"],
    injuriesPayload: payloads["/injuries"]
  });
  const captureReady = Boolean(
    normalized.source_integrity.lineups_payload_valid &&
    normalized.source_integrity.availability_payload_valid
  );
  const capturedAt = new Date().toISOString();
  const rawPayload = {
    provider: PROVIDER,
    fixture_id: String(target.fixture_id),
    captured_at: capturedAt,
    lineups: payloads["/fixtures/lineups"] ?? null,
    injuries: payloads["/injuries"] ?? null
  };
  const providerRawSha256 = captureReady ? canonicalHash(rawPayload) : null;
  const availabilityProviderRawSha256 = captureReady ? canonicalHash(payloads["/injuries"]) : null;
  const sourceUrl = `${process.env.API_FOOTBALL_BASE_URL || DEFAULT_BASE_URL}/injuries?fixture=${encodeURIComponent(String(target.fixture_id))}`;
  return {
    system_status: captureReady
      ? "FOOTBALL_OFFICIAL_NEAR_START_CAPTURE_READY"
      : "FOOTBALL_OFFICIAL_NEAR_START_SOURCE_UNAVAILABLE",
    capture_ready: captureReady,
    match_id: String(target.match_id),
    match: `${target.home_team} vs ${target.away_team}`,
    home_team: String(target.home_team),
    away_team: String(target.away_team),
    league_slug: String(target.league_slug),
    kickoff: new Date(target.kickoff).toISOString(),
    minutes_until_start: Number(minutesUntilStart.toFixed(1)),
    provider: PROVIDER,
    provider_event_id: String(target.fixture_id),
    source_url: sourceUrl,
    captured_at: capturedAt,
    provider_raw_sha256: providerRawSha256,
    availability_provider_raw_sha256: availabilityProviderRawSha256,
    ...normalized,
    raw_payload: rawPayload,
    fetch_status: fetchStatus,
    quota_remaining_estimate: remaining,
    auto_import: false,
    guardrails: {
      human_verification_required: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      autopost_enabled: false,
      kill_switch_enabled: true
    }
  };
}

export async function getFootballDataGatewayStatus(db: Queryable) {
  await ensureGatewayTables(db);
  const usage = await usageStatus(db);
  const cache = await db.query(
    `
      SELECT
        COUNT(*)::int AS total_cache_entries,
        COUNT(*) FILTER (WHERE expires_at > now())::int AS valid_cache_entries,
        COUNT(*) FILTER (WHERE expires_at <= now())::int AS expired_cache_entries
      FROM api_response_cache
      WHERE provider = $1
    `,
    [PROVIDER]
  );
  const consensus = await db.query(
    `
      SELECT
        COUNT(*)::int AS total_consensus,
        COUNT(*) FILTER (WHERE consensus_verified = true)::int AS verified_consensus,
        COUNT(*) FILTER (WHERE recommendation = 'SOURCE_CONSENSUS_REQUIRED')::int AS consensus_required
      FROM football_source_consensus
    `
  );
  const recent = await db.query(
    `
      SELECT league_id, home_team, away_team, consensus_verified, consensus_score, recommendation, observed_at
      FROM football_source_consensus
      ORDER BY observed_at DESC
      LIMIT 20
    `
  );
  return {
    system_status: "FOOTBALL_DATA_GATEWAY_SAFE",
    provider_status: usage,
    football_data_url: {
      configured: Boolean(process.env.FOOTBALL_DATA_URL && process.env.FOOTBALL_DATA_URL.trim()),
      source_status: process.env.FOOTBALL_DATA_URL && process.env.FOOTBALL_DATA_URL.trim()
        ? "CONFIGURED_HEALTH_CHECK_REQUIRED"
        : "SOURCE_MISSING",
      provider_name: process.env.FOOTBALL_DATA_URL && process.env.FOOTBALL_DATA_URL.trim()
        ? "football_data_worker"
        : null,
      fetched_at: null,
      recommendation: process.env.FOOTBALL_DATA_URL && process.env.FOOTBALL_DATA_URL.trim()
        ? "FOOTBALL_DATA_URL configurado; validar health del worker antes de aplicar datos."
        : "FOOTBALL_DATA_URL no configurado; no inventar contexto de futbol y usar manual_verified/cache."
    },
    cache: cache.rows[0] ?? { total_cache_entries: 0, valid_cache_entries: 0, expired_cache_entries: 0 },
    consensus: consensus.rows[0] ?? { total_consensus: 0, verified_consensus: 0, consensus_required: 0 },
    recent_consensus: recent.rows,
    recommendation: usage.api_key_configured
      ? "Gateway listo: usar dry-run primero; aplicar solo para candidatos o ligas confiables."
      : "API_FOOTBALL_KEY no esta configurada en engine-node; el gateway puede planear/cachear pero no hacer fetch externo.",
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}

export async function hydrateFootballIntelligence(db: Queryable, body: unknown) {
  await ensureGatewayTables(db);
  const input = hydrateSchema.parse(body ?? {});
  const usage = await usageStatus(db);
  const targets = await findTargets(db, input);
  const generalContextQuota = Math.max(0, usage.quota_remaining_estimate - usage.near_start_reserve);
  let apiRequestsAllowed = Math.min(input.max_api_requests, generalContextQuota);
  let fetched = 0;
  let cachedHits = 0;
  let skipped = 0;
  let errors = 0;
  let quotaGuardSkips = 0;
  const rows = [] as Array<Record<string, unknown>>;

  for (const target of targets) {
    const plan = buildFetchPlan(target, input);
    const responses: Record<string, unknown> = {};
    const planRows: FetchPlanItem[] = [];
    for (const item of plan) {
      if (item.status === "SKIPPED") {
        skipped += 1;
        planRows.push(item);
        continue;
      }
      const cached = await cacheLookup(db, item.endpoint, item.params);
      if (cached) {
        cachedHits += 1;
        responses[item.endpoint] = cached.response_json;
        planRows.push({ ...item, status: "CACHE_HIT" });
        continue;
      }
      if (input.dry_run) {
        planRows.push({ ...item, status: "WOULD_FETCH" });
        continue;
      }
      if (apiRequestsAllowed <= 0) {
        skipped += 1;
        quotaGuardSkips += 1;
        planRows.push({ ...item, status: "SKIPPED", reason: "API_FOOTBALL_QUOTA_GUARD" });
        continue;
      }
      const response = await fetchApiFootball(item.endpoint, item.params);
      await recordUsage(db, item.endpoint, response.headers, response.ok ? "OK" : String(response.reason || "ERROR"));
      apiRequestsAllowed -= 1;
      if (!response.ok) {
        errors += 1;
        const errorSummary = apiFootballErrorSummary(response.json);
        planRows.push({
          ...item,
          status: "ERROR",
          reason: [response.reason || `HTTP_${response.status}`, errorSummary].filter(Boolean).join(" | ")
        });
        continue;
      }
      fetched += 1;
      responses[item.endpoint] = response.json;
      await cacheStore(db, item.endpoint, item.params, response.json, 0.82);
      planRows.push({ ...item, status: "FETCHED" });
    }
    let hydrationResult: Record<string, unknown> | null = null;
    if (!input.dry_run) {
      hydrationResult = await applyHydration(db, target, responses);
    }
    rows.push({
      match_id: target.match_id,
      league_id: target.league_id,
      match: `${target.home_team} vs ${target.away_team}`,
      kickoff: target.kickoff,
      candidate_market: target.candidate_market,
      candidate_selection: target.candidate_selection,
      api_football_fixture_id: rawFixtureId(target),
      fetch_plan: planRows,
      hydration: hydrationResult,
      recommendation: rawFixtureId(target)
        ? "Puede hidratar contexto via API-Football/cache."
        : "Falta api_football_fixture_id; primero validar fixture oficial antes de contexto fino."
    });
  }

  const wouldFetch = rows.reduce((sum, row) => sum + ((row.fetch_plan as FetchPlanItem[]) || []).filter((item) => item.status === "WOULD_FETCH").length, 0);
  return {
    system_status: input.dry_run ? "FOOTBALL_DATA_GATEWAY_DRY_RUN" : "FOOTBALL_DATA_GATEWAY_APPLY_COMPLETE",
    dry_run: input.dry_run,
    target_count: targets.length,
    would_fetch: wouldFetch,
    cached_hits: cachedHits,
    fetched,
    skipped,
    errors,
    quota_remaining_estimate: Math.max(0, usage.quota_remaining_estimate - fetched),
    near_start_reserve: usage.near_start_reserve,
    general_context_quota_remaining: Math.max(0, generalContextQuota - fetched),
    blocked_by_quota: input.dry_run ? wouldFetch > generalContextQuota : quotaGuardSkips > 0,
    rows,
    recommendation: input.dry_run
      ? "Revisar would_fetch/cache_hits; aplicar solo si targets y fixture_id son correctos."
      : "Hydration aplicada en modo seguro; revisar Football Confirmed Pick Chain.",
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}

export async function hydrateFootballManualContext(db: Queryable, body: unknown) {
  const input: ManualContextInput = manualContextSchema.parse(body ?? {});
  const rows: Record<string, unknown>[] = [];
  let teamContexts = 0;
  let playerContexts = 0;
  let skipped = 0;

  for (const matchInput of input.matches) {
    const match = await db.query(
      `
        SELECT
          m.id::text AS match_id,
          l.slug AS league_id,
          home_team.name AS home_team,
          away_team.name AS away_team
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
        WHERE m.id = $1
        LIMIT 1
      `,
      [matchInput.match_id]
    );
    const dbMatch = match.rows[0];
    if (!dbMatch) {
      skipped += 1;
      rows.push({ match_id: matchInput.match_id, status: "SKIPPED", reason: "MATCH_NOT_FOUND" });
      continue;
    }

    const leagueId = matchInput.league_id || String(dbMatch.league_id);
    const homeTeam = matchInput.home_team || String(dbMatch.home_team || "Home");
    const awayTeam = matchInput.away_team || String(dbMatch.away_team || "Away");
    const playerRows = matchInput.lineups.length ? matchInput.lineups : [
      { team: homeTeam, player_name: `${homeTeam} lineup`, position: "lineup", lineup_status: "UNKNOWN" as const, injury_status: "UNKNOWN" as const, suspension_status: "UNKNOWN" as const, key_player_flag: true, raw_data: {} },
      { team: awayTeam, player_name: `${awayTeam} lineup`, position: "lineup", lineup_status: "UNKNOWN" as const, injury_status: "UNKNOWN" as const, suspension_status: "UNKNOWN" as const, key_player_flag: true, raw_data: {} }
    ];

    if (!input.dry_run) {
      await db.query(
        `
          INSERT INTO football_team_intelligence (
            match_id, league_id, home_team, away_team, team_intelligence_status,
            source, source_confidence_score, observed_at, raw_data
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8::jsonb)
        `,
        [
          matchInput.match_id,
          leagueId,
          homeTeam,
          awayTeam,
          matchInput.team_intelligence_status,
          input.source,
          matchInput.source_confidence_score,
          JSON.stringify(matchInput.team_context || {})
        ]
      );
      teamContexts += 1;

      for (const player of playerRows) {
        const playerStatus = player.player_intelligence_status
          || (player.lineup_status === "CONFIRMED" ? "PLAYER_CONTEXT_SUPPORTS" : "LINEUP_PENDING");
        await db.query(
          `
            INSERT INTO football_player_intelligence (
              match_id, league_id, team, player_name, normalized_player_name,
              position, expected_starting, confirmed_starting, lineup_status,
              injury_status, suspension_status, key_player_flag, impact_area,
              player_intelligence_status, source, source_confidence_score,
              observed_at, raw_data
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'lineup_context', $13, $14, $15, now(), $16::jsonb)
          `,
          [
            matchInput.match_id,
            leagueId,
            player.team,
            player.player_name || `${player.team} lineup`,
            normalizeName(player.player_name || `${player.team} lineup`),
            player.position || "lineup",
            player.expected_starting ?? null,
            player.confirmed_starting ?? null,
            player.lineup_status,
            player.injury_status,
            player.suspension_status,
            player.key_player_flag ?? true,
            playerStatus,
            input.source,
            matchInput.source_confidence_score,
            JSON.stringify(player.raw_data || {})
          ]
        );
        playerContexts += 1;
      }
    }

    rows.push({
      match_id: matchInput.match_id,
      match: `${homeTeam} vs ${awayTeam}`,
      league_id: leagueId,
      status: input.dry_run ? "WOULD_APPLY" : "APPLIED",
      team_intelligence_status: matchInput.team_intelligence_status,
      player_rows: playerRows.length,
      recommendation: matchInput.team_intelligence_status === "TEAM_CONTEXT_SUPPORTS"
        ? "Contexto de equipo apoya revision; revisar player context antes de confirmar."
        : "Contexto cargado para review; no confirma solo."
    });
  }

  return {
    system_status: input.dry_run ? "FOOTBALL_MANUAL_CONTEXT_DRY_RUN" : "FOOTBALL_MANUAL_CONTEXT_APPLIED",
    dry_run: input.dry_run,
    rows,
    inserted_team_contexts: teamContexts,
    inserted_player_contexts: playerContexts,
    skipped,
    recommendation: input.dry_run
      ? "Revisar matches y lineups; aplicar solo con datos reales/verificados."
      : "Contexto manual/verificado cargado; revisar Football Confirmed Pick Chain.",
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
