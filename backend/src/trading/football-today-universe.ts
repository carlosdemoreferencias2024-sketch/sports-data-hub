import { createHash } from "node:crypto";
import { z } from "zod";
import { FOOTBALL_LEAGUES, FOOTBALL_STANDARD_MARKETS, FootballLeagueConfig, FootballMarketKey } from "./football-leagues.config.js";
import { resolveFootballLeagueId } from "./football-league-aliases.js";
import {
  FALLBACK_FOOTBALL_COMPETITION_REGISTRY,
  getCompetitionByLeagueIdFromRows,
  getMarketBlockReasonForCompetition,
  normalizeCompetitionName
} from "./football-competition-registry.js";
import { tradingLocalDateWindow } from "./timezone.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
};

const statusSchema = z.enum(["scheduled", "live", "finished", "postponed", "cancelled"]).default("scheduled");
const uuidSchema = z.string().uuid();

const fixtureSchema = z.object({
  match_id: z.string().optional(),
  league: z.string().min(1),
  home_team: z.string().min(1),
  away_team: z.string().min(1),
  kickoff: z.string().min(1),
  status: statusSchema.optional(),
  source: z.string().optional(),
  raw_data: z.record(z.unknown()).optional()
});

const signalSchema = z.object({
  match_id: z.string().optional(),
  league: z.string().min(1),
  market: z.enum(FOOTBALL_STANDARD_MARKETS as [FootballMarketKey, ...FootballMarketKey[]]),
  selection: z.string().min(1),
  home_team: z.string().min(1),
  away_team: z.string().min(1),
  kickoff: z.string().min(1),
  odds_timestamp: z.string().optional(),
  provider: z.string().default("manual_shadow_global_football"),
  market_odds: z.number().gt(1).optional(),
  model_probability: z.number().min(0).max(1).optional(),
  expected_value: z.number().optional(),
  raw_data: z.record(z.unknown()).optional()
});

const requestSchema = z.object({
  dry_run: z.boolean().optional().default(true),
  date: z.string().optional(),
  source: z.string().optional().default("manual_global_football_today"),
  fixtures: z.array(fixtureSchema).optional().default([]),
  signals: z.array(signalSchema).optional().default([])
});

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(date: Date): string {
  return date.toISOString();
}

function calendarProviderIdentity(rawData: Record<string, unknown> | undefined) {
  const raw = rawData ?? {};
  const apiFootballId = String(raw.api_football_fixture_id ?? "").trim();
  if (apiFootballId) return { providerName: "api-football", providerEventId: apiFootballId };
  const espnId = String(raw.espn_event_id ?? "").trim();
  if (espnId) return { providerName: "espn-soccer", providerEventId: espnId };
  return null;
}

async function registerCalendarTrust(
  db: Queryable,
  input: { matchId: string; kickoffUtc: string; providerName: string; providerEventId: string }
) {
  await db.query("SELECT * FROM register_forecast_match($1::uuid)", [input.matchId]);

  const identity = await db.query(
    `
      SELECT 1
      FROM forecast_provider_match_mappings mapping
      JOIN LATERAL (
        SELECT result
        FROM forecast_slate_validations
        WHERE match_id = mapping.match_id AND validation_type = 'identity'
        ORDER BY validated_at DESC, id DESC
        LIMIT 1
      ) validation ON validation.result = 'VALID'
      WHERE mapping.match_id = $1::uuid
        AND mapping.provider_name = $2
        AND mapping.external_match_id = $3
      LIMIT 1
    `,
    [input.matchId, input.providerName, input.providerEventId]
  );
  if (identity.rows.length === 0) {
    await db.query(
      "SELECT * FROM register_forecast_provider_mapping($1::uuid, $2, $3, NULL::uuid, $4)",
      [input.matchId, input.providerName, input.providerEventId, "football_calendar_provider"]
    );
  }

  const schedule = await db.query(
    `
      SELECT result
      FROM forecast_slate_validations
      WHERE match_id = $1::uuid
        AND validation_type = 'schedule'
      ORDER BY validated_at DESC, id DESC
      LIMIT 1
    `,
    [input.matchId]
  );
  if (String(schedule.rows[0]?.result || "") !== "VALID") {
    await db.query(
      "SELECT * FROM validate_forecast_schedule($1::uuid, false, false, $2::timestamptz, NULL::uuid, $3)",
      [input.matchId, input.kickoffUtc, "football_calendar_provider"]
    );
  }
}

function localDateWindow(date?: string) {
  return tradingLocalDateWindow(date);
}

type UniverseLeague = Pick<FootballLeagueConfig, "league_id" | "display_name" | "country_or_region" | "confederation" | "enabled"> & {
  observation_only: boolean;
};

function observedLeagueId(value: string): string {
  return `football-observed-${normalizeText(value) || "unknown"}`.slice(0, 100);
}

function resolveLeagueOrNull(value: string): UniverseLeague | null {
  const leagueId = normalizeCompetitionName(value) ?? resolveFootballLeagueId(value);
  if (leagueId) {
    const configured = FOOTBALL_LEAGUES.find((league) => league.league_id === leagueId && league.enabled);
    if (configured) return { ...configured, observation_only: false };
    const competition = getCompetitionByLeagueIdFromRows(leagueId, FALLBACK_FOOTBALL_COMPETITION_REGISTRY);
    if (competition?.enabled) {
      return {
        league_id: competition.league_id,
        display_name: competition.display_name,
        country_or_region: competition.country ?? competition.region ?? "Global",
        confederation: competition.confederation,
        enabled: true,
        observation_only: false
      };
    }
  }
  return {
    league_id: observedLeagueId(value),
    display_name: value.trim(),
    country_or_region: "Global",
    confederation: "GLOBAL",
    enabled: true,
    observation_only: true
  };
}

function fixtureSeed(input: { date?: string; leagueId: string; homeTeam: string; awayTeam: string; kickoffUtc: string }) {
  const day = input.date || input.kickoffUtc.slice(0, 10);
  return [day, input.leagueId, normalizeText(input.homeTeam), normalizeText(input.awayTeam), input.kickoffUtc].join("|");
}

function getMatchId(input: { provided?: string; date?: string; leagueId: string; homeTeam: string; awayTeam: string; kickoffUtc: string }) {
  if (input.provided && uuidSchema.safeParse(input.provided).success) {
    return { matchId: input.provided, generated: false, source: "provided" as const };
  }
  return {
    matchId: deterministicUuid(fixtureSeed(input)),
    generated: true,
    source: "generated" as const
  };
}

function normalizeSelection(selection: string): "home" | "away" | "draw" | "over" | "under" | "yes" | "no" | "home_draw" | "home_away" | "draw_away" | null {
  const normalized = normalizeText(selection).replace(/-/g, "_");
  if (["home", "local", "home_dnb"].includes(normalized)) return "home";
  if (["away", "visitor", "visitante", "away_dnb"].includes(normalized)) return "away";
  if (["draw", "tie", "empate"].includes(normalized)) return "draw";
  if (["home_draw", "home_or_draw", "1x"].includes(normalized)) return "home_draw";
  if (["home_away", "home_or_away", "12"].includes(normalized)) return "home_away";
  if (["draw_away", "draw_or_away", "x2"].includes(normalized)) return "draw_away";
  if (normalized.startsWith("over")) return "over";
  if (normalized.startsWith("under")) return "under";
  if (["yes", "si", "btts_yes"].includes(normalized)) return "yes";
  if (["no", "btts_no"].includes(normalized)) return "no";
  return null;
}

function quoteColumns(selection: "home" | "away" | "draw" | "over" | "under" | "yes" | "no" | "home_draw" | "home_away" | "draw_away", odds: number) {
  return {
    home: selection === "home" || selection === "over" || selection === "yes" || selection === "home_draw" ? odds : null,
    away: selection === "away" || selection === "under" || selection === "no" || selection === "draw_away" ? odds : null,
    draw: selection === "draw" || selection === "home_away" ? odds : null
  };
}

function signalState(signal: z.infer<typeof signalSchema>, league: UniverseLeague) {
  if (!signal.market_odds) return "OBSERVATION_ONLY";
  if (league.observation_only) return "MARKET_SNAPSHOT";
  if (signal.market === "btts") return "MARKET_SNAPSHOT";
  const competition = getCompetitionByLeagueIdFromRows(league.league_id, FALLBACK_FOOTBALL_COMPETITION_REGISTRY);
  if (!competition || competition.trust_status === "BLOCKED" || competition.manual_only || competition.is_friendly) return "MARKET_SNAPSHOT";
  if (signal.model_probability === undefined || signal.expected_value === undefined) return "MARKET_SNAPSHOT";
  return "SHADOW_CANDIDATE";
}

async function ensureLeagueRow(db: Queryable, league: UniverseLeague, dryRun: boolean) {
  if (dryRun) {
    return deterministicUuid(`league|${league.league_id}`);
  }
  const sport = await db.query(
    `
      INSERT INTO sports (slug, name)
      VALUES ('soccer', 'Soccer')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
      RETURNING id
    `
  );
  const sportId = String(sport.rows[0].id);
  const result = await db.query(
    `
      INSERT INTO leagues (id, sport_id, slug, name, abbreviation, country, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        country = EXCLUDED.country,
        is_active = TRUE,
        updated_at = NOW()
      RETURNING id
    `,
    [
      deterministicUuid(`league|${league.league_id}`),
      sportId,
      league.league_id,
      league.display_name,
      league.league_id.slice(0, 30),
      league.country_or_region
    ]
  );
  return String(result.rows[0].id);
}

async function ensureTeam(db: Queryable, leagueDbId: string, leagueId: string, teamName: string, dryRun: boolean) {
  const slug = `${leagueId}-${normalizeText(teamName)}`;
  if (dryRun) {
    return deterministicUuid(`team|${leagueId}|${teamName}`);
  }
  const result = await db.query(
    `
      INSERT INTO teams (id, league_id, slug, name, short_name, raw_data)
      VALUES ($1, $2, $3, $4, $4, $5::jsonb)
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        short_name = EXCLUDED.short_name,
        raw_data = teams.raw_data || EXCLUDED.raw_data,
        updated_at = NOW()
      RETURNING id
    `,
    [
      deterministicUuid(`team|${leagueId}|${teamName}`),
      leagueDbId,
      slug,
      teamName,
      JSON.stringify({ football_today_universe: true, league_id: leagueId })
    ]
  );
  return String(result.rows[0].id);
}

async function ensureObservedMatch(
  db: Queryable,
  input: {
    date?: string;
    source: string;
    matchId?: string;
    leagueInput: string;
    homeTeam: string;
    awayTeam: string;
    kickoff: string;
    status?: string;
    dryRun: boolean;
    rawData?: Record<string, unknown>;
  }
) {
  const league = resolveLeagueOrNull(input.leagueInput);
  if (!league) {
    return { ok: false as const, reason: "league_not_supported", leagueId: null, matchId: null, generated: false };
  }

  const kickoff = parseDate(input.kickoff);
  if (!kickoff) {
    return { ok: false as const, reason: "invalid_kickoff", leagueId: league.league_id, matchId: null, generated: false };
  }

  const status = statusSchema.catch("scheduled").parse(input.status ?? "scheduled");
  const kickoffUtc = toIso(kickoff);
  const id = getMatchId({
    provided: input.matchId,
    date: input.date,
    leagueId: league.league_id,
    homeTeam: input.homeTeam,
    awayTeam: input.awayTeam,
    kickoffUtc
  });
  const slug = `football-today-${kickoffUtc.slice(0, 10)}-${league.league_id}-${normalizeText(input.homeTeam)}-vs-${normalizeText(input.awayTeam)}-${id.matchId.slice(0, 8)}`;

  if (input.dryRun) {
    return { ok: true as const, reason: null, leagueId: league.league_id, matchId: id.matchId, generated: id.generated, inserted: false, status, kickoffUtc };
  }

  const leagueDbId = await ensureLeagueRow(db, league, false);
  const homeTeamId = await ensureTeam(db, leagueDbId, league.league_id, input.homeTeam, false);
  const awayTeamId = await ensureTeam(db, leagueDbId, league.league_id, input.awayTeam, false);
  const rawData = JSON.stringify({
    ...(input.rawData ?? {}),
    football_today_universe: true,
    source: input.source,
    original_league: input.leagueInput,
    normalized_league_id: league.league_id,
    observation_only_league: league.observation_only,
    kickoff_original: input.kickoff,
    kickoff_utc: kickoffUtc,
    generated_match_id: id.generated,
    match_id_source: id.source,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false
  });

  const match = await db.query(
    `
      INSERT INTO matches (id, league_id, slug, match_date, status, raw_data)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (slug) DO UPDATE SET
        match_date = EXCLUDED.match_date,
        status = EXCLUDED.status,
        raw_data = matches.raw_data || EXCLUDED.raw_data,
        updated_at = NOW()
      RETURNING id, (xmax = 0) AS inserted
    `,
    [id.matchId, leagueDbId, slug, kickoffUtc, status, rawData]
  );
  const matchId = String(match.rows[0].id);

  await db.query(
    `
      INSERT INTO match_competitors (match_id, team_id, home_away)
      VALUES ($1, $2, 'home'), ($1, $3, 'away')
      ON CONFLICT (match_id, team_id) DO UPDATE SET home_away = EXCLUDED.home_away
    `,
    [matchId, homeTeamId, awayTeamId]
  );

  return { ok: true as const, reason: null, leagueId: league.league_id, matchId, generated: id.generated, inserted: Boolean(match.rows[0].inserted), status, kickoffUtc };
}

async function insertSnapshot(
  db: Queryable,
  input: {
    matchId: string;
    leagueId: string;
    source: string;
    provider: string;
    market: FootballMarketKey;
    selection: "home" | "away" | "draw" | "over" | "under" | "yes" | "no" | "home_draw" | "home_away" | "draw_away";
    odds: number;
    capturedAt: string;
    rawData: Record<string, unknown>;
  }
) {
  const columns = quoteColumns(input.selection, input.odds);
  const rawData = JSON.stringify(input.rawData);
  const result = await db.query(
    `
      WITH quote_insert AS (
        INSERT INTO market_quotes (
          match_id, provider_name, market_type, line, home_odds, away_odds,
          draw_odds, captured_at, raw_data
        )
        VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id, captured_at
      )
      INSERT INTO odds_snapshots (
        market_quote_id, match_id, sport_slug, league_slug, provider_name,
        source_name, market_type, line, selection, odds, snapshot_role,
        captured_at, quality_score, quality_flags, raw_data
      )
      SELECT
        qi.id, $1, 'soccer', $9, $2, $10, $3, NULL, $11, $12,
        CASE WHEN LOWER($2) LIKE '%manual%' OR LOWER($2) LIKE '%shadow%' THEN 'manual_shadow' ELSE 'market' END,
        qi.captured_at,
        CASE WHEN LOWER($2) LIKE '%manual%' OR LOWER($2) LIKE '%shadow%' THEN 70 ELSE 85 END,
        ARRAY[$13]::text[]
          || CASE WHEN LOWER($2) LIKE '%manual%' OR LOWER($2) LIKE '%shadow%' THEN ARRAY['MANUAL_OR_SHADOW']::text[] ELSE ARRAY[]::text[] END,
        $8::jsonb
      FROM quote_insert qi
      ON CONFLICT (market_quote_id, selection) WHERE market_quote_id IS NOT NULL DO NOTHING
      RETURNING id
    `,
    [
      input.matchId,
      input.provider,
      input.market,
      columns.home,
      columns.away,
      columns.draw,
      input.capturedAt,
      rawData,
      input.leagueId,
      input.source,
      input.selection,
      input.odds,
      String(input.rawData.feed_status ?? "MARKET_SNAPSHOT")
    ]
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

function addCount(map: Map<string, Record<string, unknown>>, key: string, patch: Record<string, number | string | null>) {
  const row = map.get(key) ?? {};
  for (const [field, value] of Object.entries(patch)) {
    if (typeof value === "number") {
      row[field] = Number(row[field] ?? 0) + value;
    } else {
      row[field] = value;
    }
  }
  map.set(key, row);
}

export async function processFootballTodayUniverse(db: Queryable, payload: unknown) {
  const body = requestSchema.parse(payload);
  const dryRun = body.dry_run !== false;
  const summary = {
    dry_run: dryRun,
    fixtures_received: body.fixtures.length,
    fixtures_would_insert: 0,
    fixtures_inserted: 0,
    signals_received: body.signals.length,
    signals_would_insert: 0,
    signals_inserted: 0,
    observation_only: 0,
    market_snapshots: 0,
    shadow_candidates: 0,
    shadow_paper: 0,
    no_bet: 0,
    rejected: 0,
    duplicates: 0,
    calendar_trusted: 0,
    blocked: 0,
    errors: 0
  };
  const rows: Record<string, unknown>[] = [];
  const byLeague = new Map<string, Record<string, unknown>>();
  const byMarket = new Map<string, Record<string, unknown>>();

  const fixtureByKey = new Map<string, z.infer<typeof fixtureSchema>>();
  for (const fixture of body.fixtures) {
    const league = resolveLeagueOrNull(fixture.league);
    if (!league) {
      summary.rejected += 1;
      rows.push({ type: "fixture", status: "REJECTED", reason: "league_not_supported", league: fixture.league, match: `${fixture.home_team} vs ${fixture.away_team}` });
      continue;
    }
    const kickoff = parseDate(fixture.kickoff);
    const key = league && kickoff
      ? `${league.league_id}|${normalizeText(fixture.home_team)}|${normalizeText(fixture.away_team)}|${toIso(kickoff)}`
      : `${fixture.league}|${fixture.home_team}|${fixture.away_team}|${fixture.kickoff}`;
    fixtureByKey.set(key, fixture);

    const saved = await ensureObservedMatch(db, {
      date: body.date,
      source: fixture.source ?? body.source,
      matchId: fixture.match_id,
      leagueInput: fixture.league,
      homeTeam: fixture.home_team,
      awayTeam: fixture.away_team,
      kickoff: fixture.kickoff,
      status: fixture.status,
      dryRun,
      rawData: fixture.raw_data
    });
    if (!saved.ok) {
      summary.rejected += 1;
      rows.push({ type: "fixture", status: "REJECTED", reason: saved.reason, league: fixture.league, match: `${fixture.home_team} vs ${fixture.away_team}` });
      continue;
    }
    if (dryRun) summary.fixtures_would_insert += 1;
    else if (saved.inserted) summary.fixtures_inserted += 1;
    else summary.duplicates += 1;
    const providerIdentity = calendarProviderIdentity(fixture.raw_data);
    if (providerIdentity) {
      if (!dryRun) {
        await registerCalendarTrust(db, {
          matchId: saved.matchId,
          kickoffUtc: saved.kickoffUtc,
          ...providerIdentity
        });
      }
      summary.calendar_trusted += 1;
    }
    summary.observation_only += 1;
    addCount(byLeague, saved.leagueId, { league_id: saved.leagueId, observation_only: 1 });
    rows.push({
      type: "fixture",
      status: dryRun ? "DRY_RUN_WOULD_OBSERVE" : "OBSERVATION_ONLY",
      league_id: saved.leagueId,
      match_id: saved.matchId,
      generated_match_id: saved.generated,
      match: `${fixture.home_team} vs ${fixture.away_team}`,
      observation_only_league: league.observation_only,
      calendar_trusted: Boolean(providerIdentity),
      calendar_provider: providerIdentity?.providerName ?? null,
      provider_event_id: providerIdentity?.providerEventId ?? null
    });
  }

  for (const signal of body.signals) {
    const league = resolveLeagueOrNull(signal.league);
    const kickoff = parseDate(signal.kickoff);
    if (!league || !kickoff) {
      summary.rejected += 1;
      rows.push({ type: "signal", status: "REJECTED", reason: !league ? "league_not_supported" : "invalid_kickoff", league: signal.league, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }
    const oddsTimestamp = signal.odds_timestamp ? parseDate(signal.odds_timestamp) : null;
    if (signal.market_odds && !oddsTimestamp) {
      summary.rejected += 1;
      rows.push({ type: "signal", status: "REJECTED", reason: "missing_or_invalid_odds_timestamp", league_id: league.league_id, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }
    if (oddsTimestamp && oddsTimestamp >= kickoff) {
      summary.rejected += 1;
      rows.push({ type: "signal", status: "REJECTED", reason: "POST_KICKOFF_REJECTED", league_id: league.league_id, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }
    const selection = normalizeSelection(signal.selection);
    if (!selection) {
      summary.rejected += 1;
      rows.push({ type: "signal", status: "REJECTED", reason: "unsupported_selection", league_id: league.league_id, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }
    const manualReview = signal.raw_data?.manual_review === true || signal.raw_data?.manual_review_required === true;
    const competition = getCompetitionByLeagueIdFromRows(league.league_id, FALLBACK_FOOTBALL_COMPETITION_REGISTRY);
    const marketBlockReason = getMarketBlockReasonForCompetition(competition, signal.market, manualReview);
    if (!league.observation_only && marketBlockReason) {
      summary.blocked += 1;
      rows.push({ type: "signal", status: "BLOCKED", reason: marketBlockReason, league_id: league.league_id, market: signal.market, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }
    if (signal.market === "btts" && !manualReview) {
      summary.blocked += 1;
      rows.push({ type: "signal", status: "BLOCKED", reason: "btts_requires_manual_review", league_id: league.league_id, market: signal.market, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }

    const saved = await ensureObservedMatch(db, {
      date: body.date,
      source: body.source,
      matchId: signal.match_id,
      leagueInput: signal.league,
      homeTeam: signal.home_team,
      awayTeam: signal.away_team,
      kickoff: signal.kickoff,
      status: "scheduled",
      dryRun,
      rawData: signal.raw_data
    });
    if (!saved.ok || !saved.matchId || !saved.leagueId) {
      summary.rejected += 1;
      rows.push({ type: "signal", status: "REJECTED", reason: saved.reason, league: signal.league, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }

    const state = signalState(signal, league);
    const rawData = {
      ...(signal.raw_data ?? {}),
      football_today_universe: true,
      source: body.source,
      feed_status: state,
      original_league: signal.league,
      normalized_league_id: saved.leagueId,
      observation_only_league: league.observation_only,
      kickoff_original: signal.kickoff,
      kickoff_utc: toIso(kickoff),
      odds_timestamp: oddsTimestamp ? toIso(oddsTimestamp) : null,
      generated_match_id: saved.generated,
      match_id_source: saved.generated ? "generated" : "provided",
      model_probability: signal.model_probability ?? null,
      expected_value: signal.expected_value ?? null,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    };

    if (!signal.market_odds) {
      summary.observation_only += 1;
      rows.push({ type: "signal", status: "OBSERVATION_ONLY", league_id: saved.leagueId, match_id: saved.matchId, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }

    if (dryRun) {
      summary.signals_would_insert += 1;
      if (state === "SHADOW_CANDIDATE") summary.shadow_candidates += 1;
      else summary.market_snapshots += 1;
      addCount(byLeague, saved.leagueId, { league_id: saved.leagueId, [state.toLowerCase()]: 1 });
      addCount(byMarket, signal.market, { market: signal.market, [state.toLowerCase()]: 1 });
      rows.push({ type: "signal", status: state, dry_run: true, league_id: saved.leagueId, market: signal.market, match_id: saved.matchId, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }

    const inserted = await insertSnapshot(db, {
      matchId: saved.matchId,
      leagueId: saved.leagueId,
      source: body.source,
      provider: signal.provider,
      market: signal.market,
      selection,
      odds: signal.market_odds,
      capturedAt: toIso(oddsTimestamp!),
      rawData
    });
    if (!inserted) {
      summary.duplicates += 1;
      rows.push({ type: "signal", status: "DUPLICATE", reason: "snapshot_conflict", league_id: saved.leagueId, market: signal.market, match_id: saved.matchId });
      continue;
    }
    summary.signals_inserted += 1;
    if (state === "SHADOW_CANDIDATE") summary.shadow_candidates += 1;
    else summary.market_snapshots += 1;
    addCount(byLeague, saved.leagueId, { league_id: saved.leagueId, [state.toLowerCase()]: 1 });
    addCount(byMarket, signal.market, { market: signal.market, [state.toLowerCase()]: 1 });
    rows.push({ type: "signal", status: state, league_id: saved.leagueId, market: signal.market, match_id: saved.matchId, match: `${signal.home_team} vs ${signal.away_team}` });
  }

  return {
    system_status: "FOOTBALL_TODAY_UNIVERSE",
    ...summary,
    rows,
    by_league: Array.from(byLeague.values()),
    by_market: Array.from(byMarket.values()),
    examples: rows.slice(0, 10),
    conversion: {
      observed_to_candidate: summary.observation_only > 0 ? summary.shadow_candidates / summary.observation_only : 0,
      candidate_to_pick: summary.shadow_candidates > 0 ? summary.shadow_paper / summary.shadow_candidates : 0
    },
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };
}

export async function getFootballTodayUniverse(db: Queryable, date?: string) {
  const { selectedDate: targetDate, start, end } = localDateWindow(date);
  const summary = await db.query(
    `
      WITH observed_matches AS (
        SELECT m.id, l.slug AS league_id
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        WHERE m.raw_data->>'football_today_universe' = 'true'
          AND m.match_date >= $1::timestamptz
          AND m.match_date < $2::timestamptz
      ),
      observed_snapshots AS (
        SELECT os.*
        FROM odds_snapshots os
        JOIN observed_matches om ON om.id = os.match_id
        WHERE os.raw_data->>'football_today_universe' = 'true'
      )
      SELECT
        (SELECT COUNT(*)::int FROM observed_matches) AS observed_fixtures,
        (SELECT COUNT(*)::int FROM observed_snapshots WHERE raw_data->>'feed_status' = 'MARKET_SNAPSHOT') AS market_snapshots,
        (SELECT COUNT(*)::int FROM observed_snapshots WHERE raw_data->>'feed_status' = 'SHADOW_CANDIDATE') AS shadow_candidates,
        0::int AS shadow_paper,
        (SELECT COUNT(DISTINCT league_id)::int FROM observed_matches) AS leagues_observed
    `,
    [start, end]
  );
  const byLeague = await db.query(
    `
      SELECT
        l.slug AS league_id,
        COUNT(DISTINCT m.id)::int AS observed_fixtures,
        COUNT(os.id) FILTER (WHERE os.raw_data->>'feed_status' = 'MARKET_SNAPSHOT')::int AS market_snapshots,
        COUNT(os.id) FILTER (WHERE os.raw_data->>'feed_status' = 'SHADOW_CANDIDATE')::int AS shadow_candidates
      FROM v_valid_matches m
      JOIN leagues l ON l.id = m.league_id
      LEFT JOIN odds_snapshots os ON os.match_id = m.id AND os.raw_data->>'football_today_universe' = 'true'
      WHERE m.raw_data->>'football_today_universe' = 'true'
        AND m.match_date >= $1::timestamptz
        AND m.match_date < $2::timestamptz
      GROUP BY l.slug
      ORDER BY observed_fixtures DESC, shadow_candidates DESC
    `,
    [start, end]
  );
  const byMarket = await db.query(
    `
      SELECT
        market_type AS market,
        COUNT(*) FILTER (WHERE raw_data->>'feed_status' = 'MARKET_SNAPSHOT')::int AS market_snapshots,
        COUNT(*) FILTER (WHERE raw_data->>'feed_status' = 'SHADOW_CANDIDATE')::int AS shadow_candidates
      FROM odds_snapshots
      WHERE raw_data->>'football_today_universe' = 'true'
        AND captured_at >= $1::timestamptz
        AND captured_at < $2::timestamptz
      GROUP BY market_type
      ORDER BY shadow_candidates DESC, market_snapshots DESC
    `,
    [start, end]
  );
  const row = summary.rows[0] ?? {};
  const observed = Number(row.observed_fixtures ?? 0);
  const candidates = Number(row.shadow_candidates ?? 0);
  return {
    system_status: "FOOTBALL_TODAY_UNIVERSE",
    date: targetDate,
    observed_fixtures: observed,
    market_snapshots: Number(row.market_snapshots ?? 0),
    shadow_candidates: candidates,
    shadow_paper: Number(row.shadow_paper ?? 0),
    leagues_observed: Number(row.leagues_observed ?? 0),
    conversion: {
      observed_to_candidate: observed > 0 ? candidates / observed : 0,
      candidate_to_pick: candidates > 0 ? Number(row.shadow_paper ?? 0) / candidates : 0
    },
    by_league: byLeague.rows,
    by_market: byMarket.rows,
    recommendation: observed > 0
      ? "Usar volumen observado para cobertura; promover candidatos solo con validacion y filtros."
      : "Cargar fixtures globales como OBSERVATION_ONLY para empezar cobertura de futbol.",
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };
}
