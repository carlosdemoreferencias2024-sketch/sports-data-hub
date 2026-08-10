import { z } from "zod";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount?: number }>;
};

const guardrails = {
  real_candidate_count: 0,
  real_money_enabled: false,
  kelly_enabled: false,
  telegram_auto_enabled: false,
  kill_switch_enabled: true,
  real_paper_only: true,
  shadow_paper_only: true,
  creates_picks: false
};

function normalizeName(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function textValue(value: unknown) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : "";
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolValue(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "si", "sí", "on"].includes(String(value).trim().toLowerCase());
}

function rowAction(type: string, record: Record<string, any>, action: string, reason: string) {
  return {
    type,
    action,
    reason,
    sport: record.sport ?? null,
    league_id: record.league_id ?? null,
    match_id: record.match_id ?? record.canonical_match_id ?? null,
    team_id: record.team_id ?? null,
    player_id: record.player_id ?? record.canonical_player_id ?? null,
    source: record.source ?? record.provider ?? null
  };
}

const historicalQuerySchema = z.object({
  sport: z.string().min(1).max(40).optional(),
  league_id: z.string().min(1).max(100).optional(),
  season: z.string().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const teamHistoryQuerySchema = historicalQuerySchema.extend({
  team_id: z.string().min(1).max(160).optional(),
  team_name: z.string().min(1).max(180).optional(),
  last_n: z.coerce.number().int().min(1).max(100).default(10),
  as_of_date: z.string().optional()
});

const playerHistoryQuerySchema = historicalQuerySchema.extend({
  player_id: z.string().min(1).max(160).optional(),
  player_name: z.string().min(1).max(180).optional(),
  team_id: z.string().min(1).max(160).optional(),
  last_n: z.coerce.number().int().min(1).max(100).default(10),
  as_of_date: z.string().optional()
});

const matchContextQuerySchema = z.object({
  match_id: z.string().min(1).max(220),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const historicalMatchSchema = z.object({
  sport: z.string().min(1).max(40),
  provider_match_id: z.string().max(180).optional(),
  canonical_match_id: z.string().max(220).optional(),
  match_id: z.string().max(220).optional(),
  league_id: z.string().max(100).optional(),
  competition_id: z.string().max(120).optional(),
  season: z.string().max(40).optional(),
  competition_type: z.string().max(80).optional(),
  stage: z.string().max(80).optional(),
  round: z.string().max(80).optional(),
  is_official: z.boolean().optional(),
  is_friendly: z.boolean().optional(),
  is_preseason: z.boolean().optional(),
  is_spring_training: z.boolean().optional(),
  home_team_id: z.string().max(160).optional(),
  away_team_id: z.string().max(160).optional(),
  home_team_name: z.string().max(180).optional(),
  away_team_name: z.string().max(180).optional(),
  home_team: z.string().max(180).optional(),
  away_team: z.string().max(180).optional(),
  kickoff: z.string().optional(),
  match_date: z.string().optional(),
  status: z.string().max(60).optional(),
  home_score: z.number().nullable().optional(),
  away_score: z.number().nullable().optional(),
  result: z.string().max(40).optional(),
  venue: z.string().max(220).optional(),
  neutral_venue: z.boolean().optional(),
  attendance: z.number().int().nullable().optional(),
  match_importance: z.string().max(80).optional(),
  rotation_risk: z.string().max(80).optional(),
  source: z.string().min(1).max(120),
  source_confidence_score: z.number().min(0).max(100).default(0),
  source_observed_at: z.string().optional(),
  raw_data: z.record(z.any()).default({})
}).passthrough();

const ingestHistoricalMatchesSchema = z.object({
  dry_run: z.boolean().default(true),
  matches: z.array(historicalMatchSchema).default([]),
  team_match_stats: z.array(z.record(z.any())).default([]),
  team_season_profiles: z.array(z.record(z.any())).default([])
});

const ingestPlayerHistorySchema = z.object({
  dry_run: z.boolean().default(true),
  player_profiles: z.array(z.record(z.any())).default([]),
  player_season_stats: z.array(z.record(z.any())).default([]),
  player_match_stats: z.array(z.record(z.any())).default([]),
  lineups: z.array(z.record(z.any())).default([]),
  availability: z.array(z.record(z.any())).default([])
});

const rebuildHistoricalContextSchema = z.object({
  dry_run: z.boolean().default(true),
  sport: z.string().min(1).max(40).optional(),
  league_id: z.string().min(1).max(100).optional(),
  match_id: z.string().min(1).max(220).optional(),
  limit: z.number().int().min(1).max(500).default(100)
});

function addFilter(values: unknown[], filters: string[], column: string, value?: string) {
  if (value) {
    values.push(value);
    filters.push(`${column} = $${values.length}`);
  }
}

async function safeCount(db: Queryable, sql: string, values: unknown[] = []) {
  const result = await db.query(sql, values);
  return Number(result.rows[0]?.count ?? 0);
}

export async function getHistoricalIntelligenceStatus(db: Queryable, query: unknown = {}) {
  const parsed = historicalQuerySchema.parse(query);
  const matchFilters: string[] = [];
  const matchValues: unknown[] = [];
  addFilter(matchValues, matchFilters, "sport", parsed.sport);
  addFilter(matchValues, matchFilters, "league_id", parsed.league_id);
  addFilter(matchValues, matchFilters, "season", parsed.season);
  const matchWhere = matchFilters.length ? `WHERE ${matchFilters.join(" AND ")}` : "";

  const profileFilters: string[] = [];
  const profileValues: unknown[] = [];
  addFilter(profileValues, profileFilters, "sport", parsed.sport);
  addFilter(profileValues, profileFilters, "league_id", parsed.league_id);
  addFilter(profileValues, profileFilters, "season", parsed.season);
  const profileWhere = profileFilters.length ? `WHERE ${profileFilters.join(" AND ")}` : "";

  const currentFilters: string[] = [];
  const currentValues: unknown[] = [];
  addFilter(currentValues, currentFilters, "sport", parsed.sport);
  addFilter(currentValues, currentFilters, "league_id", parsed.league_id);
  const currentWhere = currentFilters.length ? `WHERE ${currentFilters.join(" AND ")}` : "";

  const [
    matches,
    officialMatches,
    friendlies,
    springTraining,
    teamProfiles,
    playerProfiles,
    lineupsConfirmed,
    lineupsProjected,
    lineupsUnknown,
    incompleteRecords
  ] = await Promise.all([
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_match_history ${matchWhere}`, matchValues),
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_match_history ${matchWhere} ${matchWhere ? "AND" : "WHERE"} is_official = true`, matchValues),
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_match_history ${matchWhere} ${matchWhere ? "AND" : "WHERE"} is_friendly = true`, matchValues),
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_match_history ${matchWhere} ${matchWhere ? "AND" : "WHERE"} is_spring_training = true`, matchValues),
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_team_season_profiles ${profileWhere}`, profileValues),
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_player_profiles ${currentWhere}`, currentValues),
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_match_lineups ${currentWhere} ${currentWhere ? "AND" : "WHERE"} lineup_status = 'CONFIRMED'`, currentValues),
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_match_lineups ${currentWhere} ${currentWhere ? "AND" : "WHERE"} lineup_status = 'PROJECTED'`, currentValues),
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_match_lineups ${currentWhere} ${currentWhere ? "AND" : "WHERE"} lineup_status IN ('UNKNOWN', 'PENDING')`, currentValues),
    safeCount(db, `SELECT COUNT(*) AS count FROM sports_match_history ${matchWhere} ${matchWhere ? "AND" : "WHERE"} (kickoff IS NULL OR home_team_name IS NULL OR away_team_name IS NULL)`, matchValues)
  ]);

  const providerValues = [...matchValues];
  const providerCoverage = await db.query(
    `
      SELECT source, sport, league_id, COUNT(*)::int AS rows, ROUND(AVG(source_confidence_score)::numeric, 3) AS avg_confidence
      FROM sports_match_history
      ${matchWhere}
      GROUP BY source, sport, league_id
      ORDER BY rows DESC, avg_confidence DESC NULLS LAST
      LIMIT $${providerValues.push(parsed.limit)}
    `,
    providerValues
  );

  return {
    system_status: "SPORTS_HISTORICAL_INTELLIGENCE_V1",
    recommendation: "Usar historia como contexto y explicacion. No crea picks ni elimina filtros de modelo.",
    summary: {
      matches_loaded: matches,
      official_matches: officialMatches,
      friendlies,
      spring_training: springTraining,
      team_profiles: teamProfiles,
      player_profiles: playerProfiles,
      lineups_confirmed: lineupsConfirmed,
      lineups_projected: lineupsProjected,
      lineups_unknown: lineupsUnknown,
      incomplete_records: incompleteRecords
    },
    provider_coverage: providerCoverage.rows,
    guardrails
  };
}

export async function getTeamHistory(db: Queryable, query: unknown = {}) {
  const parsed = teamHistoryQuerySchema.parse(query);
  const values: unknown[] = [];
  const filters: string[] = [];
  addFilter(values, filters, "stp.sport", parsed.sport);
  addFilter(values, filters, "stp.league_id", parsed.league_id);
  addFilter(values, filters, "stp.season", parsed.season);
  addFilter(values, filters, "stp.team_id", parsed.team_id);
  if (parsed.team_name) {
    values.push(`%${parsed.team_name}%`);
    filters.push(`stp.canonical_team_name ILIKE $${values.length}`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const profiles = await db.query(
    `
      SELECT *
      FROM sports_team_season_profiles stp
      ${where}
      ORDER BY season DESC, source_updated_at DESC NULLS LAST
      LIMIT $${values.push(parsed.limit)}
    `,
    values
  );

  const statsValues: unknown[] = [];
  const statsFilters: string[] = [];
  addFilter(statsValues, statsFilters, "sport", parsed.sport);
  addFilter(statsValues, statsFilters, "league_id", parsed.league_id);
  addFilter(statsValues, statsFilters, "team_id", parsed.team_id);
  if (parsed.team_name) {
    statsValues.push(normalizeName(parsed.team_name));
    statsFilters.push(`normalized_team_name = $${statsValues.length}`);
  }
  if (parsed.as_of_date) {
    statsValues.push(parsed.as_of_date);
    statsFilters.push(`created_at <= $${statsValues.length}::timestamptz`);
  }
  const statsWhere = statsFilters.length ? `WHERE ${statsFilters.join(" AND ")}` : "";
  const recentStats = await db.query(
    `
      SELECT *
      FROM sports_team_match_stats
      ${statsWhere}
      ORDER BY updated_at DESC
      LIMIT $${statsValues.push(parsed.last_n)}
    `,
    statsValues
  );

  return {
    system_status: "TEAM_HISTORY_READ_ONLY",
    profiles: profiles.rows,
    recent_match_stats: recentStats.rows,
    explanation: "Solo usa datos historicos observados antes del corte solicitado; no crea picks.",
    guardrails
  };
}

export async function getPlayerHistory(db: Queryable, query: unknown = {}) {
  const parsed = playerHistoryQuerySchema.parse(query);
  const values: unknown[] = [];
  const filters: string[] = [];
  addFilter(values, filters, "sps.sport", parsed.sport);
  addFilter(values, filters, "sps.league_id", parsed.league_id);
  addFilter(values, filters, "sps.season", parsed.season);
  addFilter(values, filters, "sps.player_id", parsed.player_id);
  addFilter(values, filters, "sps.team_id", parsed.team_id);
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const seasonStats = await db.query(
    `
      SELECT sps.*
      FROM sports_player_season_stats sps
      ${where}
      ORDER BY season DESC, updated_at DESC
      LIMIT $${values.push(parsed.limit)}
    `,
    values
  );

  const profileValues: unknown[] = [];
  const profileFilters: string[] = [];
  addFilter(profileValues, profileFilters, "sport", parsed.sport);
  addFilter(profileValues, profileFilters, "league_id", parsed.league_id);
  addFilter(profileValues, profileFilters, "canonical_player_id", parsed.player_id);
  addFilter(profileValues, profileFilters, "current_team_id", parsed.team_id);
  if (parsed.player_name) {
    profileValues.push(`%${parsed.player_name}%`);
    profileFilters.push(`canonical_player_name ILIKE $${profileValues.length}`);
  }
  const profileWhere = profileFilters.length ? `WHERE ${profileFilters.join(" AND ")}` : "";
  const profiles = await db.query(
    `
      SELECT *
      FROM sports_player_profiles
      ${profileWhere}
      ORDER BY updated_at DESC
      LIMIT $${profileValues.push(parsed.limit)}
    `,
    profileValues
  );

  return {
    system_status: "PLAYER_HISTORY_READ_ONLY",
    profiles: profiles.rows,
    season_stats: seasonStats.rows,
    explanation: "Player history apoya contexto; no puede convertir una baja probabilidad en pick.",
    guardrails
  };
}

export async function getMatchHistoricalContext(db: Queryable, query: unknown = {}) {
  const parsed = matchContextQuerySchema.parse(query);
  const values = [parsed.match_id];
  const [history, teamStats, lineups, availability, contextScore] = await Promise.all([
    db.query(`SELECT * FROM sports_match_history WHERE match_id = $1 OR canonical_match_id = $1 LIMIT 1`, values),
    db.query(`SELECT * FROM sports_team_match_stats WHERE match_id = $1 ORDER BY is_home DESC NULLS LAST`, values),
    db.query(`SELECT * FROM sports_match_lineups WHERE match_id = $1 ORDER BY observed_at DESC LIMIT $2`, [parsed.match_id, parsed.limit]),
    db.query(`SELECT * FROM sports_player_availability WHERE match_id = $1 ORDER BY key_player_flag DESC, observed_at DESC LIMIT $2`, [parsed.match_id, parsed.limit]),
    db.query(`SELECT * FROM match_context_scores WHERE match_id = $1 LIMIT 1`, values)
  ]);

  const row = contextScore.rows[0] ?? {};
  const missing = Array.isArray(row.missing_context_fields) ? row.missing_context_fields : [];
  const blocks = Array.isArray(row.block_reasons) ? row.block_reasons : [];

  return {
    system_status: "MATCH_HISTORICAL_CONTEXT_READ_ONLY",
    match_id: parsed.match_id,
    history: history.rows[0] ?? null,
    team_stats: teamStats.rows,
    lineups: lineups.rows,
    availability: availability.rows,
    scores: row,
    missing_fields: missing,
    block_reasons: blocks,
    recommendation: row.recommendation ?? "Seguir acumulando contexto historico antes de confirmar.",
    explanation: "La historia puede apoyar o contradecir el contexto, pero no elimina bloqueos de lineup/modelo/guardrails.",
    guardrails
  };
}

export async function ingestHistoricalMatches(db: Queryable, body: unknown) {
  const parsed = ingestHistoricalMatchesSchema.parse(body);
  const rows: Array<Record<string, any>> = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const record of parsed.matches) {
    const canonicalMatchId = textValue(record.canonical_match_id ?? record.match_id ?? record.provider_match_id);
    const matchId = textValue(record.match_id ?? canonicalMatchId);
    const homeTeam = textValue(record.home_team_name ?? record.home_team);
    const awayTeam = textValue(record.away_team_name ?? record.away_team);
    if (!matchId || !homeTeam || !awayTeam) {
      skipped += 1;
      rows.push(rowAction("match_history", record, "SKIPPED", "Missing match_id/canonical_match_id or teams."));
      continue;
    }
    rows.push(rowAction("match_history", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", "Historical match warehouse row."));
    if (!parsed.dry_run) {
      const result = await db.query(
        `
          INSERT INTO sports_match_history (
            match_id, sport, provider_match_id, canonical_match_id, league_id, competition_id, season,
            match_date, kickoff, home_team, away_team, normalized_home_team, normalized_away_team,
            home_team_id, away_team_id, home_team_name, away_team_name, status, home_score, away_score,
            result, competition_type, importance_tag, match_importance, is_official, is_friendly,
            is_preseason, is_spring_training, venue, neutral_venue, attendance, rotation_risk,
            source, source_confidence_score, source_observed_at, raw_data, updated_at
          )
          VALUES (
            $1, $2, $3, $4, COALESCE($5, ''), $6, $7, $8::timestamptz, $9::timestamptz,
            $10, $11, $12, $13, $14, $15, $16, $17, COALESCE($18, 'SCHEDULED'), $19, $20,
            $21, COALESCE($22, 'official'), COALESCE($23, 'normal'), $24, COALESCE($25, true),
            COALESCE($26, false), COALESCE($27, false), COALESCE($28, false), $29, COALESCE($30, false),
            $31, $32, $33, $34, COALESCE($35::timestamptz, now()), $36::jsonb, now()
          )
          ON CONFLICT (match_id)
          DO UPDATE SET
            provider_match_id = COALESCE(EXCLUDED.provider_match_id, sports_match_history.provider_match_id),
            canonical_match_id = COALESCE(EXCLUDED.canonical_match_id, sports_match_history.canonical_match_id),
            league_id = EXCLUDED.league_id,
            competition_id = COALESCE(EXCLUDED.competition_id, sports_match_history.competition_id),
            season = COALESCE(EXCLUDED.season, sports_match_history.season),
            match_date = COALESCE(EXCLUDED.match_date, sports_match_history.match_date),
            kickoff = COALESCE(EXCLUDED.kickoff, sports_match_history.kickoff),
            status = EXCLUDED.status,
            home_score = COALESCE(EXCLUDED.home_score, sports_match_history.home_score),
            away_score = COALESCE(EXCLUDED.away_score, sports_match_history.away_score),
            result = COALESCE(EXCLUDED.result, sports_match_history.result),
            competition_type = EXCLUDED.competition_type,
            importance_tag = EXCLUDED.importance_tag,
            match_importance = COALESCE(EXCLUDED.match_importance, sports_match_history.match_importance),
            is_official = EXCLUDED.is_official,
            is_friendly = EXCLUDED.is_friendly,
            is_preseason = EXCLUDED.is_preseason,
            is_spring_training = EXCLUDED.is_spring_training,
            venue = COALESCE(EXCLUDED.venue, sports_match_history.venue),
            neutral_venue = EXCLUDED.neutral_venue,
            attendance = COALESCE(EXCLUDED.attendance, sports_match_history.attendance),
            rotation_risk = COALESCE(EXCLUDED.rotation_risk, sports_match_history.rotation_risk),
            source = EXCLUDED.source,
            source_confidence_score = GREATEST(sports_match_history.source_confidence_score, EXCLUDED.source_confidence_score),
            source_observed_at = EXCLUDED.source_observed_at,
            raw_data = sports_match_history.raw_data || EXCLUDED.raw_data,
            updated_at = now()
          RETURNING (xmax = 0) AS inserted
        `,
        [
          matchId,
          record.sport,
          record.provider_match_id ?? null,
          canonicalMatchId,
          record.league_id ?? null,
          record.competition_id ?? null,
          record.season ?? null,
          record.match_date ?? record.kickoff ?? null,
          record.kickoff ?? record.match_date ?? null,
          homeTeam,
          awayTeam,
          normalizeName(homeTeam),
          normalizeName(awayTeam),
          record.home_team_id ?? null,
          record.away_team_id ?? null,
          homeTeam,
          awayTeam,
          record.status ?? "SCHEDULED",
          numberOrNull(record.home_score),
          numberOrNull(record.away_score),
          record.result ?? null,
          record.competition_type ?? (record.is_spring_training ? "spring_training" : record.is_friendly ? "friendly" : "official"),
          record.match_importance ?? "normal",
          record.match_importance ?? "normal",
          record.is_official ?? (!record.is_friendly && !record.is_preseason && !record.is_spring_training),
          record.is_friendly ?? false,
          record.is_preseason ?? false,
          record.is_spring_training ?? false,
          record.venue ?? null,
          record.neutral_venue ?? false,
          record.attendance ?? null,
          record.rotation_risk ?? null,
          record.source,
          record.source_confidence_score,
          record.source_observed_at ?? null,
          JSON.stringify(record.raw_data ?? record)
        ]
      );
      if (result.rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }
  }

  return {
    system_status: "HISTORICAL_MATCH_INGEST",
    dry_run: parsed.dry_run,
    inserted,
    updated,
    skipped,
    would_upsert: parsed.dry_run ? rows.filter((row) => row.action === "WOULD_UPSERT").length : 0,
    rows,
    guardrails
  };
}

export async function ingestPlayerHistory(db: Queryable, body: unknown) {
  const parsed = ingestPlayerHistorySchema.parse(body);
  const rows: Array<Record<string, any>> = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const record of parsed.player_profiles) {
    const playerName = textValue(record.canonical_player_name ?? record.player_name);
    const playerId = textValue(record.canonical_player_id ?? record.player_id ?? normalizeName(playerName));
    if (!playerId || !playerName) {
      skipped += 1;
      rows.push(rowAction("player_profile", record, "SKIPPED", "Missing player id/name."));
      continue;
    }
    rows.push(rowAction("player_profile", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", "Player profile row."));
    if (!parsed.dry_run) {
      const result = await db.query(
        `
          INSERT INTO sports_player_profiles (
            sport, league_id, team_id, team_name, normalized_team_name, player_id, player_name,
            normalized_player_name, position, active, source, source_confidence_score, observed_at, raw_data,
            canonical_player_id, canonical_player_name, provider_player_ids, current_team_id, birth_date,
            age, nationality, bats, throws, metadata, updated_at
          )
          VALUES (
            $1, COALESCE($2, ''), $3, $4, $5, $6, $7, $8, $9, COALESCE($10, true), $11, $12,
            COALESCE($13::timestamptz, now()), $14::jsonb, $15, $16, COALESCE($17::jsonb, '{}'::jsonb),
            $18, $19::date, $20, $21, $22, $23, COALESCE($24::jsonb, '{}'::jsonb), now()
          )
          ON CONFLICT (sport, league_id, COALESCE(normalized_team_name, ''), normalized_player_name)
          DO UPDATE SET
            team_id = COALESCE(EXCLUDED.team_id, sports_player_profiles.team_id),
            team_name = COALESCE(EXCLUDED.team_name, sports_player_profiles.team_name),
            position = COALESCE(EXCLUDED.position, sports_player_profiles.position),
            active = EXCLUDED.active,
            source = EXCLUDED.source,
            source_confidence_score = GREATEST(sports_player_profiles.source_confidence_score, EXCLUDED.source_confidence_score),
            observed_at = EXCLUDED.observed_at,
            raw_data = sports_player_profiles.raw_data || EXCLUDED.raw_data,
            canonical_player_id = COALESCE(EXCLUDED.canonical_player_id, sports_player_profiles.canonical_player_id),
            canonical_player_name = COALESCE(EXCLUDED.canonical_player_name, sports_player_profiles.canonical_player_name),
            provider_player_ids = sports_player_profiles.provider_player_ids || EXCLUDED.provider_player_ids,
            current_team_id = COALESCE(EXCLUDED.current_team_id, sports_player_profiles.current_team_id),
            metadata = sports_player_profiles.metadata || EXCLUDED.metadata,
            updated_at = now()
          RETURNING (xmax = 0) AS inserted
        `,
        [
          record.sport ?? "football",
          record.league_id ?? null,
          record.current_team_id ?? record.team_id ?? null,
          record.team_name ?? null,
          record.team_name ? normalizeName(record.team_name) : null,
          record.player_id ?? playerId,
          playerName,
          normalizeName(playerName),
          record.position ?? null,
          record.active ?? true,
          record.source ?? record.provider ?? "manual_verified_json",
          numberOrNull(record.source_confidence_score) ?? 0,
          record.observed_at ?? null,
          JSON.stringify(record.raw_data ?? record),
          playerId,
          playerName,
          JSON.stringify(record.provider_player_ids ?? {}),
          record.current_team_id ?? record.team_id ?? null,
          record.birth_date ?? null,
          record.age ?? null,
          record.nationality ?? null,
          record.bats ?? null,
          record.throws ?? null,
          JSON.stringify(record.metadata ?? {})
        ]
      );
      if (result.rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }
  }

  for (const record of parsed.player_season_stats) {
    const playerId = textValue(record.player_id);
    const season = textValue(record.season);
    if (!playerId || !season) {
      skipped += 1;
      rows.push(rowAction("player_season_stats", record, "SKIPPED", "Missing player_id/season."));
      continue;
    }
    rows.push(rowAction("player_season_stats", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", "Player season stats row."));
    if (!parsed.dry_run) {
      const result = await db.query(
        `
          INSERT INTO sports_player_season_stats (
            sport, player_id, team_id, league_id, season, competition_type, appearances, starts,
            minutes_or_innings, source, source_confidence_score, data_completeness_score, raw_stats,
            calculation_version, inputs_used, calculated_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::jsonb, COALESCE($16::timestamptz, now()), now())
          ON CONFLICT (sport, player_id, COALESCE(team_id, ''), COALESCE(league_id, ''), season, COALESCE(competition_type, ''))
          DO UPDATE SET
            appearances = COALESCE(EXCLUDED.appearances, sports_player_season_stats.appearances),
            starts = COALESCE(EXCLUDED.starts, sports_player_season_stats.starts),
            minutes_or_innings = COALESCE(EXCLUDED.minutes_or_innings, sports_player_season_stats.minutes_or_innings),
            source = EXCLUDED.source,
            source_confidence_score = GREATEST(COALESCE(sports_player_season_stats.source_confidence_score, 0), COALESCE(EXCLUDED.source_confidence_score, 0)),
            data_completeness_score = GREATEST(COALESCE(sports_player_season_stats.data_completeness_score, 0), COALESCE(EXCLUDED.data_completeness_score, 0)),
            raw_stats = sports_player_season_stats.raw_stats || EXCLUDED.raw_stats,
            calculation_version = COALESCE(EXCLUDED.calculation_version, sports_player_season_stats.calculation_version),
            inputs_used = sports_player_season_stats.inputs_used || EXCLUDED.inputs_used,
            calculated_at = EXCLUDED.calculated_at,
            updated_at = now()
          RETURNING (xmax = 0) AS inserted
        `,
        [
          record.sport ?? "football",
          playerId,
          record.team_id ?? null,
          record.league_id ?? null,
          season,
          record.competition_type ?? null,
          record.appearances ?? null,
          record.starts ?? null,
          numberOrNull(record.minutes_or_innings),
          record.source ?? record.provider ?? "manual_verified_json",
          numberOrNull(record.source_confidence_score),
          numberOrNull(record.data_completeness_score),
          JSON.stringify(record.raw_stats ?? record),
          record.calculation_version ?? null,
          JSON.stringify(record.inputs_used ?? {}),
          record.calculated_at ?? null
        ]
      );
      if (result.rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }
  }

  for (const record of parsed.player_match_stats) {
    const playerId = textValue(record.player_id);
    const matchId = textValue(record.match_id);
    if (!playerId || !matchId) {
      skipped += 1;
      rows.push(rowAction("player_match_stats", record, "SKIPPED", "Missing player_id/match_id."));
      continue;
    }
    rows.push(rowAction("player_match_stats", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", "Player match stats row."));
    if (!parsed.dry_run) {
      const result = await db.query(
        `
          INSERT INTO sports_player_match_stats (
            sport, match_id, player_id, team_id, opponent_team_id, started, substitute,
            source, source_confidence_score, raw_stats
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          ON CONFLICT (sport, match_id, player_id, COALESCE(team_id, ''))
          DO UPDATE SET
            started = COALESCE(EXCLUDED.started, sports_player_match_stats.started),
            substitute = COALESCE(EXCLUDED.substitute, sports_player_match_stats.substitute),
            source = EXCLUDED.source,
            source_confidence_score = GREATEST(COALESCE(sports_player_match_stats.source_confidence_score, 0), COALESCE(EXCLUDED.source_confidence_score, 0)),
            raw_stats = sports_player_match_stats.raw_stats || EXCLUDED.raw_stats
          RETURNING (xmax = 0) AS inserted
        `,
        [
          record.sport ?? "football",
          matchId,
          playerId,
          record.team_id ?? null,
          record.opponent_team_id ?? null,
          record.started ?? null,
          record.substitute ?? null,
          record.source ?? record.provider ?? "manual_verified_json",
          numberOrNull(record.source_confidence_score),
          JSON.stringify(record.raw_stats ?? record)
        ]
      );
      if (result.rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }
  }

  return {
    system_status: "PLAYER_HISTORY_INGEST",
    dry_run: parsed.dry_run,
    inserted,
    updated,
    skipped,
    would_upsert: parsed.dry_run ? rows.filter((row) => row.action === "WOULD_UPSERT").length : 0,
    rows,
    guardrails
  };
}

export async function rebuildHistoricalContext(db: Queryable, body: unknown) {
  const parsed = rebuildHistoricalContextSchema.parse(body);
  const values: unknown[] = [];
  const filters: string[] = [];
  addFilter(values, filters, "mch.sport", parsed.sport);
  addFilter(values, filters, "mch.league_id", parsed.league_id);
  addFilter(values, filters, "mch.match_id", parsed.match_id);
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const candidates = await db.query(
    `
      SELECT
        mch.match_id,
        mch.sport,
        mch.league_id,
        mch.is_friendly,
        mch.is_preseason,
        mch.is_spring_training,
        COUNT(DISTINCT tms.id)::int AS team_stats_count,
        COUNT(DISTINCT sml.id)::int AS lineup_count,
        COUNT(DISTINCT sml.id) FILTER (WHERE sml.lineup_status = 'CONFIRMED')::int AS confirmed_lineups,
        COUNT(DISTINCT spa.id)::int AS availability_count
      FROM sports_match_history mch
      LEFT JOIN sports_team_match_stats tms ON tms.match_id = mch.match_id
      LEFT JOIN sports_match_lineups sml ON sml.match_id = mch.match_id
      LEFT JOIN sports_player_availability spa ON spa.match_id = mch.match_id
      ${where}
      GROUP BY mch.match_id, mch.sport, mch.league_id, mch.is_friendly, mch.is_preseason, mch.is_spring_training
      ORDER BY mch.match_id DESC
      LIMIT $${values.push(parsed.limit)}
    `,
    values
  );

  const rows = [];
  for (const row of candidates.rows) {
    const friendlyPenalty = row.is_friendly || row.is_preseason || row.is_spring_training ? 35 : 0;
    const historicalDataScore = Math.min(100, Number(row.team_stats_count ?? 0) * 20 + Number(row.availability_count ?? 0) * 5);
    const lineupQualityScore = Number(row.confirmed_lineups ?? 0) >= 2 ? 90 : Number(row.lineup_count ?? 0) > 0 ? 60 : 0;
    const dataFreshnessScore = 70;
    const uncertainty = Math.max(0, 100 - historicalDataScore);
    const historicalContextScore = Math.max(0, Math.min(100, historicalDataScore * 0.45 + lineupQualityScore * 0.25 + dataFreshnessScore * 0.15 - friendlyPenalty));
    const missingFields = [];
    if (Number(row.team_stats_count ?? 0) < 2) missingFields.push("team_match_stats");
    if (Number(row.lineup_count ?? 0) < 2) missingFields.push("lineups");
    if (friendlyPenalty > 0) missingFields.push("official_sample_excluded");
    const blockReasons = friendlyPenalty > 0 ? ["FRIENDLY_OR_PRESEASON_OBSERVATION_ONLY"] : [];
    const recommendation = friendlyPenalty > 0
      ? "Guardar para contexto limitado; no promover amistosos/pretemporada."
      : historicalContextScore >= 70
        ? "Contexto historico apoya revision, pero no confirma sin modelo/lineup/guardrails."
        : "Seguir acumulando historia y contexto antes de confirmar.";

    const output = {
      match_id: row.match_id,
      sport: row.sport,
      league_id: row.league_id,
      historical_data_score: Number(historicalDataScore.toFixed(3)),
      lineup_quality_score: Number(lineupQualityScore.toFixed(3)),
      friendly_or_preseason_penalty: Number(friendlyPenalty.toFixed(3)),
      historical_uncertainty_score: Number(uncertainty.toFixed(3)),
      historical_context_score: Number(historicalContextScore.toFixed(3)),
      data_freshness_score: dataFreshnessScore,
      missing_fields: missingFields,
      block_reasons: blockReasons,
      recommendation,
      action: parsed.dry_run ? "WOULD_SCORE" : "SCORED"
    };
    rows.push(output);

    if (!parsed.dry_run) {
      await db.query(
        `
          INSERT INTO match_context_scores (
            sport, league_id, match_id, historical_data_score, lineup_quality_score,
            friendly_or_preseason_penalty, historical_uncertainty_score, historical_context_score,
            data_freshness_score, scoring_version, score_components, penalties_applied,
            sample_sizes, missing_context_fields, block_reasons, recommendation,
            context_status, calculated_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, 'historical_intelligence_v1',
            $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15,
            CASE WHEN $8::numeric >= 70 AND $6::numeric = 0 THEN 'PARTIAL_CONTEXT_REVIEW' ELSE 'CONTEXT_GAPS' END,
            now(), now()
          )
          ON CONFLICT (match_id)
          DO UPDATE SET
            historical_data_score = EXCLUDED.historical_data_score,
            lineup_quality_score = EXCLUDED.lineup_quality_score,
            friendly_or_preseason_penalty = EXCLUDED.friendly_or_preseason_penalty,
            historical_uncertainty_score = EXCLUDED.historical_uncertainty_score,
            historical_context_score = EXCLUDED.historical_context_score,
            data_freshness_score = EXCLUDED.data_freshness_score,
            scoring_version = EXCLUDED.scoring_version,
            score_components = match_context_scores.score_components || EXCLUDED.score_components,
            penalties_applied = EXCLUDED.penalties_applied,
            sample_sizes = EXCLUDED.sample_sizes,
            missing_context_fields = (
              SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
              FROM jsonb_array_elements(match_context_scores.missing_context_fields || EXCLUDED.missing_context_fields) AS merged(value)
            ),
            block_reasons = (
              SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
              FROM jsonb_array_elements(match_context_scores.block_reasons || EXCLUDED.block_reasons) AS merged(value)
            ),
            recommendation = EXCLUDED.recommendation,
            context_status = CASE
              WHEN match_context_scores.context_status IN ('CONFIRMED_PAPER', 'BLOCKED') THEN match_context_scores.context_status
              WHEN EXCLUDED.friendly_or_preseason_penalty > 0 THEN 'CONTEXT_GAPS'
              WHEN EXCLUDED.historical_context_score >= 70 THEN 'PARTIAL_CONTEXT_REVIEW'
              ELSE match_context_scores.context_status
            END,
            calculated_at = now(),
            updated_at = now()
        `,
        [
          row.sport,
          row.league_id ?? null,
          row.match_id,
          output.historical_data_score,
          output.lineup_quality_score,
          output.friendly_or_preseason_penalty,
          output.historical_uncertainty_score,
          output.historical_context_score,
          output.data_freshness_score,
          JSON.stringify({
            historical_data_score: output.historical_data_score,
            lineup_quality_score: output.lineup_quality_score,
            data_freshness_score: output.data_freshness_score
          }),
          JSON.stringify(output.block_reasons),
          JSON.stringify({
            team_stats_count: row.team_stats_count,
            lineup_count: row.lineup_count,
            availability_count: row.availability_count
          }),
          JSON.stringify(output.missing_fields),
          JSON.stringify(output.block_reasons),
          output.recommendation
        ]
      );
    }
  }

  return {
    system_status: "REBUILD_HISTORICAL_CONTEXT",
    dry_run: parsed.dry_run,
    rows,
    scored: parsed.dry_run ? 0 : rows.length,
    would_score: parsed.dry_run ? rows.length : 0,
    guardrails
  };
}
