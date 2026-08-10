import { tradingLocalDate, tradingLocalDateWindow } from "./timezone.js";

type QueryResult = {
  rows: Record<string, any>[];
  rowCount?: number | null;
};

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<QueryResult>;
};

type RepairInput = {
  date?: string;
  apply?: boolean;
  limit?: number;
};

type StatsApiGame = {
  game_pk: string;
  source_match_id: string;
  official_kickoff: string;
  status: string;
  home_team: string;
  away_team: string;
  raw_data: Record<string, any>;
};

type ExistingFixture = {
  match_id: string;
  slug: string;
  status: string;
  current_kickoff: string;
  home_team: string;
  away_team: string;
  source_match_id: string | null;
  raw_data: Record<string, any> | null;
};

const MLB_STATS_API_BASE = "https://statsapi.mlb.com/api/v1";
const REPAIR_SOURCE = "mlb-fixture-time-repair";

function targetDate(date?: string) {
  return date || tradingLocalDate();
}

function normalizeName(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function namesMatch(left: unknown, right: unknown) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 5 && b.includes(a)) return true;
  if (b.length >= 5 && a.includes(b)) return true;
  return false;
}

function parseOfficialKickoff(value: unknown) {
  const parsed = new Date(String(value || ""));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function isPlaceholderMlbKickoff(row: ExistingFixture) {
  const kickoff = new Date(String(row.current_kickoff || ""));
  const sourceMatchId = String(row.source_match_id || "").toLowerCase();
  if (Number.isNaN(kickoff.getTime())) return true;
  return row.status === "scheduled"
    && kickoff.getUTCHours() === 12
    && kickoff.getUTCMinutes() === 0
    && sourceMatchId.startsWith("espn-mlb-");
}

function inferEspnPlaceholderKickoff(row: ExistingFixture) {
  const sourceMatchId = String(row.source_match_id || "");
  const match = sourceMatchId.match(/^espn-mlb-(\d{4}-\d{2}-\d{2})-/i);
  return match ? `${match[1]}T12:00:00.000Z` : null;
}

function gameStatus(game: Record<string, any>) {
  const abstractState = String(game.status?.abstractGameState || "").toLowerCase();
  const detailed = String(game.status?.detailedState || "").toLowerCase();
  if (abstractState === "final" || detailed === "final") return "finished";
  if (abstractState === "live") return "live";
  if (detailed.includes("postponed")) return "postponed";
  if (detailed.includes("cancelled") || detailed.includes("canceled")) return "cancelled";
  return "scheduled";
}

async function fetchStatsApiGames(date: string): Promise<StatsApiGame[]> {
  const url = new URL(`${MLB_STATS_API_BASE}/schedule`);
  url.searchParams.set("sportId", "1");
  url.searchParams.set("date", date);
  url.searchParams.set("hydrate", "probablePitcher,team");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`MLB_STATS_API_HTTP_${response.status}`);
  }
  const payload = await response.json() as Record<string, any>;
  const games = (payload.dates || []).flatMap((day: Record<string, any>) => day.games || []);
  return games
    .filter((game: Record<string, any>) => String(game.gameType || "") === "R")
    .map((game: Record<string, any>) => {
      const gamePk = String(game.gamePk || "");
      const officialKickoff = parseOfficialKickoff(game.gameDate);
      const home = game.teams?.home?.team?.name;
      const away = game.teams?.away?.team?.name;
      if (!gamePk || !officialKickoff || !home || !away) return null;
      return {
        game_pk: gamePk,
        source_match_id: `mlb-statsapi-${gamePk}`,
        official_kickoff: officialKickoff,
        status: gameStatus(game),
        home_team: String(home),
        away_team: String(away),
        raw_data: game
      };
    })
    .filter((game: StatsApiGame | null): game is StatsApiGame => game !== null);
}

async function loadExistingPlaceholderFixtures(db: Queryable, date: string, limit: number): Promise<ExistingFixture[]> {
  const window = tradingLocalDateWindow(date);
  const result = await db.query(
    `
      SELECT
        m.id AS match_id,
        m.slug,
        m.status::text AS status,
        m.match_date AS current_kickoff,
        home_team.name AS home_team,
        away_team.name AS away_team,
        COALESCE(m.raw_data->>'source_match_id', smr.source_match_id) AS source_match_id,
        m.raw_data
      FROM matches m
      JOIN leagues l ON l.id = m.league_id
      JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
      JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
      JOIN teams home_team ON home_team.id = home_mc.team_id
      JOIN teams away_team ON away_team.id = away_mc.team_id
      LEFT JOIN LATERAL (
        SELECT source_match_id
        FROM source_match_refs
        WHERE match_id = m.id
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1
      ) smr ON TRUE
      WHERE l.slug = 'mlb'
        AND m.status IN ('scheduled', 'live')
        AND m.match_date >= $1::timestamptz
        AND m.match_date < $2::timestamptz
      ORDER BY m.match_date ASC, away_team.name, home_team.name
      LIMIT $3;
    `,
    [window.start, window.end, limit]
  );
  return result.rows as ExistingFixture[];
}

function matchStatsApiGame(row: ExistingFixture, games: StatsApiGame[]) {
  return games.filter((game) => (
    namesMatch(row.home_team, game.home_team)
    && namesMatch(row.away_team, game.away_team)
  ));
}

function buildPatch(row: ExistingFixture, game: StatsApiGame, date: string) {
  const inferredPlaceholder = inferEspnPlaceholderKickoff(row);
  const existingPrevious = typeof row.raw_data?.previous_placeholder_match_date === "string"
    ? row.raw_data.previous_placeholder_match_date
    : null;
  const previousPlaceholder = existingPrevious && existingPrevious !== game.official_kickoff
    ? existingPrevious
    : inferredPlaceholder ?? new Date(row.current_kickoff).toISOString();
  return {
    match_date: game.official_kickoff,
    fixture_time_source: "mlb_stats_api",
    fixture_time_verified: true,
    fixture_time_verified_at: new Date().toISOString(),
    fixture_time_repair_source: REPAIR_SOURCE,
    fixture_time_repair_date: date,
    previous_placeholder_match_date: previousPlaceholder,
    official_kickoff: game.official_kickoff,
    mlb_game_pk: game.game_pk,
    mlb_statsapi_source_match_id: game.source_match_id,
    mlb_statsapi_status: game.status,
    mlb_statsapi_home_team: game.home_team,
    mlb_statsapi_away_team: game.away_team,
    no_real_money: true,
    real_candidate_count: 0,
    kelly_enabled: false,
    telegram_auto_enabled: false
  };
}

function hasFixtureMetadataMismatch(row: ExistingFixture, game: StatsApiGame) {
  const inferredPlaceholder = inferEspnPlaceholderKickoff(row);
  return Boolean(
    row.raw_data?.fixture_time_source !== "mlb_stats_api"
    || row.raw_data?.fixture_time_verified !== true
    || row.raw_data?.match_date !== game.official_kickoff
    || row.raw_data?.official_kickoff !== game.official_kickoff
    || (inferredPlaceholder !== null && row.raw_data?.previous_placeholder_match_date !== inferredPlaceholder)
  );
}

async function applyRepair(db: Queryable, row: ExistingFixture, game: StatsApiGame, date: string) {
  const patch = buildPatch(row, game, date);
  const updated = await db.query(
    `
      UPDATE matches
      SET match_date = $2::timestamptz,
          raw_data = COALESCE(raw_data, '{}'::jsonb) || $3::jsonb,
          updated_at = NOW()
      WHERE id = $1::uuid
        AND match_date = $4::timestamptz
        AND status IN ('scheduled', 'live')
      RETURNING id;
    `,
    [row.match_id, game.official_kickoff, JSON.stringify(patch), row.current_kickoff]
  );
  if (!updated.rows[0]) return false;

  await db.query(
    `
      INSERT INTO provider_event_mappings (
        hub_match_id, provider_name, provider_event_id,
        home_team_name, away_team_name, kickoff,
        is_active, last_verified, raw_data
      )
      VALUES ($1, 'mlb_stats_api', $2, $3, $4, $5::timestamptz, TRUE, NOW(), $6::jsonb)
      ON CONFLICT (provider_name, provider_event_id) DO UPDATE SET
        hub_match_id = EXCLUDED.hub_match_id,
        home_team_name = EXCLUDED.home_team_name,
        away_team_name = EXCLUDED.away_team_name,
        kickoff = EXCLUDED.kickoff,
        is_active = TRUE,
        last_verified = NOW(),
        raw_data = EXCLUDED.raw_data;
    `,
    [
      row.match_id,
      game.source_match_id,
      game.home_team,
      game.away_team,
      game.official_kickoff,
      JSON.stringify({ ...patch, statsapi_raw_data: game.raw_data })
    ]
  );
  return true;
}

export async function runMlbFixtureTimeRepair(db: Queryable, input: RepairInput = {}) {
  const date = targetDate(input.date);
  const apply = Boolean(input.apply);
  const limit = Math.max(1, Math.min(200, Number(input.limit || 120)));

  let games: StatsApiGame[] = [];
  try {
    games = await fetchStatsApiGames(date);
  } catch (error) {
    return {
      system_status: "MLB_FIXTURE_TIME_REPAIR_SOURCE_UNAVAILABLE",
      date,
      applied: false,
      source_status: "MLB_STATS_API_UNAVAILABLE",
      reason: error instanceof Error ? error.message : "unknown_mlb_stats_api_error",
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

  const existing = await loadExistingPlaceholderFixtures(db, date, limit);
  const rows = [];
  let repairable = 0;
  let ambiguous = 0;
  let notPlaceholder = 0;
  let unmatched = 0;
  let alreadyVerified = 0;
  let metadataRepairable = 0;
  let updated = 0;

  for (const row of existing) {
    const candidates = matchStatsApiGame(row, games);
    const matchedGame = candidates.length === 1 ? candidates[0] : null;

    if (row.raw_data?.fixture_time_source === "mlb_stats_api" && row.raw_data?.fixture_time_verified === true) {
      alreadyVerified += 1;
      const metadataMismatch = Boolean(matchedGame && hasFixtureMetadataMismatch(row, matchedGame));
      let repaired = false;
      if (matchedGame && metadataMismatch) {
        metadataRepairable += 1;
        if (apply) {
          repaired = await applyRepair(db, row, matchedGame, date);
          if (repaired) updated += 1;
        }
      }
      rows.push({
        ...row,
        action: metadataMismatch
          ? (apply ? (repaired ? "REPAIRED_METADATA_KICKOFF" : "METADATA_REPAIR_SKIPPED_CONCURRENT_CHANGE") : "WOULD_REPAIR_METADATA_KICKOFF")
          : "ALREADY_VERIFIED",
        official_kickoff: matchedGame?.official_kickoff ?? row.raw_data?.official_kickoff ?? row.current_kickoff,
        repair_applied: repaired,
        patch_preview: matchedGame && metadataMismatch ? buildPatch(row, matchedGame, date) : null
      });
      continue;
    }

    if (!isPlaceholderMlbKickoff(row) && matchedGame && hasFixtureMetadataMismatch(row, matchedGame)) {
      metadataRepairable += 1;
      let repaired = false;
      if (apply) {
        repaired = await applyRepair(db, row, matchedGame, date);
        if (repaired) updated += 1;
      }
      rows.push({
        ...row,
        action: apply ? (repaired ? "REPAIRED_METADATA_KICKOFF" : "METADATA_REPAIR_SKIPPED_CONCURRENT_CHANGE") : "WOULD_REPAIR_METADATA_KICKOFF",
        official_kickoff: matchedGame.official_kickoff,
        repair_applied: repaired,
        patch_preview: buildPatch(row, matchedGame, date)
      });
      continue;
    }

    if (!isPlaceholderMlbKickoff(row)) {
      notPlaceholder += 1;
      rows.push({
        ...row,
        action: "NO_REPAIR_NEEDED",
        repair_applied: false
      });
      continue;
    }

    if (candidates.length !== 1) {
      if (candidates.length > 1) ambiguous += 1;
      else unmatched += 1;
      rows.push({
        ...row,
        action: candidates.length > 1 ? "AMBIGUOUS_MATCH" : "NO_STATSAPI_MATCH",
        candidate_count: candidates.length,
        candidates: candidates.map((game) => ({
          source_match_id: game.source_match_id,
          official_kickoff: game.official_kickoff,
          match: `${game.away_team} @ ${game.home_team}`
        })),
        repair_applied: false
      });
      continue;
    }

    const game = candidates[0];
    repairable += 1;
    let repaired = false;
    if (apply) {
      repaired = await applyRepair(db, row, game, date);
      if (repaired) updated += 1;
    }
    rows.push({
      ...row,
      action: apply ? (repaired ? "REPAIRED_OFFICIAL_KICKOFF" : "REPAIR_SKIPPED_CONCURRENT_CHANGE") : "WOULD_REPAIR_OFFICIAL_KICKOFF",
      official_kickoff: game.official_kickoff,
      mlb_game_pk: game.game_pk,
      statsapi_source_match_id: game.source_match_id,
      minutes_shift: Number(((new Date(game.official_kickoff).getTime() - new Date(row.current_kickoff).getTime()) / 60000).toFixed(3)),
      repair_applied: repaired,
      patch_preview: buildPatch(row, game, date)
    });
  }

  return {
    system_status: "MLB_FIXTURE_TIME_REPAIR_SAFE_V1",
    date,
    applied: apply,
    source_status: "MLB_STATS_API_OK",
    statsapi_games: games.length,
    summary: {
      scanned: existing.length,
      repairable,
      updated,
      already_verified: alreadyVerified,
      metadata_repairable: metadataRepairable,
      not_placeholder: notPlaceholder,
      unmatched,
      ambiguous,
      skipped: notPlaceholder + unmatched + ambiguous
    },
    rows,
    recommendation: apply
      ? "Revisar Clean Sample Queue; los juegos reparados ya deben usar ventanas reales para near-start/closing."
      : "Dry-run: si repairable > 0 y ambiguous = 0, correr con apply=true para reparar solo kickoff oficial MLB.",
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

export async function getMlbFixtureTimeRepairStatus(db: Queryable, input: RepairInput = {}) {
  return runMlbFixtureTimeRepair(db, { ...input, apply: false });
}
