import { z } from "zod";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[]; rowCount?: number }>;
};

const DATA_TYPES = [
  "fixture",
  "kickoff",
  "score",
  "lineup",
  "injuries",
  "team_stats",
  "player_stats",
  "odds",
  "closing_odds",
  "standings",
  "settlement_result"
] as const;

const CAPABILITY_STATUSES = [
  "AVAILABLE",
  "PLAN_BLOCKED",
  "RATE_LIMITED",
  "NO_KEY",
  "PROVIDER_ERROR",
  "DISABLED",
  "FALLBACK_ONLY",
  "UNKNOWN"
] as const;

const providerCapabilitySchema = z.object({
  provider: z.string().min(1).max(120),
  sport: z.string().min(1).max(60),
  league_id: z.string().min(1).max(120).optional().nullable(),
  season: z.string().min(1).max(20).optional().nullable(),
  data_type: z.string().min(1).max(80),
  available: z.boolean().optional().default(false),
  status: z.enum(CAPABILITY_STATUSES).optional().default("UNKNOWN"),
  reason: z.string().max(500).optional().nullable(),
  confidence_score: z.number().min(0).max(100).optional().default(0),
  rate_limit_status: z.string().max(80).optional().nullable(),
  quota_remaining: z.number().int().optional().nullable(),
  expires_at: z.string().datetime().optional().nullable(),
  raw_data: z.record(z.any()).optional().default({})
});

const sourceObservationsSchema = z.object({
  dry_run: z.boolean().optional().default(true),
  observations: z.array(z.object({
    provider: z.string().min(1).max(120),
    sport: z.string().min(1).max(60),
    league_id: z.string().min(1).max(120).optional().nullable(),
    match_id: z.string().min(1).max(160).optional().nullable(),
    entity_id: z.string().min(1).max(160).optional().nullable(),
    data_type: z.string().min(1).max(80),
    observed_value: z.record(z.any()),
    source_confidence_score: z.number().min(0).max(100).optional().default(0),
    observed_at: z.string().datetime().optional(),
    raw_data: z.record(z.any()).optional().default({})
  })).min(1).max(100)
});

const buildConsensusSchema = z.object({
  dry_run: z.boolean().optional().default(true),
  sport: z.string().min(1).max(60).optional().default("football"),
  league_id: z.string().min(1).max(120).optional().nullable(),
  match_id: z.string().min(1).max(160),
  data_types: z.array(z.string().min(1).max(80)).optional().default(["fixture", "kickoff", "lineup", "score"])
});

function normalizeName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/football club|club de futbol|club|fc|sc|cf/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizePersonName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function canonicalSlug(value: string) {
  return normalizeName(value).replace(/\s+/g, "-") || "unknown";
}

function jsonStable(value: unknown) {
  return JSON.stringify(value ?? {});
}

function toNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function statusRecommendation(row: Record<string, any>) {
  if (row.status === "PLAN_BLOCKED") return "Use fallback/manual verified sources; do not retry until TTL expires.";
  if (row.status === "RATE_LIMITED") return "Pause provider calls until rate limit window resets.";
  if (row.status === "NO_KEY") return "Configure provider key or keep fallback only.";
  if (row.status === "AVAILABLE") return "Provider can be used for this data type.";
  if (row.status === "FALLBACK_ONLY") return "Use as fallback, not primary confirmation.";
  return row.reason || "Review provider capability before using it.";
}

export async function ensureSportsIntelligenceCoreTables(db: Queryable) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS provider_capabilities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      sport text NOT NULL,
      league_id text,
      season text,
      data_type text NOT NULL,
      available boolean NOT NULL DEFAULT false,
      status text NOT NULL,
      reason text,
      confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      rate_limit_status text,
      quota_remaining integer,
      checked_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_capabilities_unique ON provider_capabilities(provider, sport, COALESCE(league_id, ''), COALESCE(season, ''), data_type);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_provider_capabilities_lookup ON provider_capabilities(provider, sport, league_id, season, data_type, status, expires_at);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_canonical_entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type text NOT NULL,
      sport text NOT NULL,
      canonical_id text NOT NULL UNIQUE,
      canonical_name text NOT NULL,
      display_name text,
      league_id text,
      country text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_canonical_entities_type_sport ON sports_canonical_entities(entity_type, sport, league_id, active);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_entity_aliases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      canonical_id text NOT NULL REFERENCES sports_canonical_entities(canonical_id) ON DELETE CASCADE,
      alias text NOT NULL,
      provider text,
      confidence_score numeric(6,3) NOT NULL DEFAULT 80,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_entity_aliases_unique ON sports_entity_aliases(canonical_id, lower(alias), COALESCE(provider, ''));`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_entity_aliases_alias ON sports_entity_aliases(lower(alias), provider);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_source_observations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      sport text NOT NULL,
      league_id text,
      match_id text,
      entity_id text,
      data_type text NOT NULL,
      observed_value jsonb NOT NULL,
      source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      observed_at timestamptz NOT NULL DEFAULT now(),
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_source_observations_match ON sports_source_observations(sport, league_id, match_id, data_type, observed_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_source_observations_provider ON sports_source_observations(provider, sport, data_type, observed_at DESC);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_consensus_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sport text NOT NULL,
      league_id text,
      match_id text,
      data_type text NOT NULL,
      consensus_verified boolean NOT NULL DEFAULT false,
      consensus_score numeric(6,3) NOT NULL DEFAULT 0,
      selected_value jsonb NOT NULL DEFAULT '{}'::jsonb,
      sources_used jsonb NOT NULL DEFAULT '[]'::jsonb,
      sources_missing jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
      recommendation text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_consensus_events_unique ON sports_consensus_events(sport, COALESCE(league_id, ''), COALESCE(match_id, ''), data_type);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_consensus_events_match ON sports_consensus_events(sport, league_id, match_id, data_type, consensus_verified);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS match_context_scores (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sport text NOT NULL,
      league_id text,
      match_id text NOT NULL UNIQUE,
      fixture_trust_score numeric(6,3) NOT NULL DEFAULT 0,
      source_consensus_score numeric(6,3) NOT NULL DEFAULT 0,
      odds_quality_score numeric(6,3) NOT NULL DEFAULT 0,
      lineup_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      team_context_score numeric(6,3) NOT NULL DEFAULT 0,
      player_context_score numeric(6,3) NOT NULL DEFAULT 0,
      market_maturity_score numeric(6,3) NOT NULL DEFAULT 0,
      settlement_readiness_score numeric(6,3) NOT NULL DEFAULT 0,
      overall_context_score numeric(6,3) NOT NULL DEFAULT 0,
      context_status text NOT NULL,
      missing_context_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
      block_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      recommendation text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_match_context_scores_status ON match_context_scores(sport, league_id, context_status, overall_context_score DESC);`);
  await ensureSportsContextDepthTables(db);
}

async function seedDefaultCapabilities(db: Queryable) {
  const defaults = [
    ["api_football", "football", null, "2026", "fixture", false, "PLAN_BLOCKED", "plan_does_not_allow_requested_season", 0, 24],
    ["api_football", "football", null, "2026", "lineup", false, "PLAN_BLOCKED", "plan_does_not_allow_requested_season", 0, 24],
    ["api_football", "football", null, "2026", "team_stats", false, "PLAN_BLOCKED", "plan_does_not_allow_requested_season", 0, 24],
    ["api_football", "football", null, "2026", "player_stats", false, "PLAN_BLOCKED", "plan_does_not_allow_requested_season", 0, 24],
    ["espn", "football", null, "2026", "fixture", true, "AVAILABLE", "fixture_schedule_available", 80, 12],
    ["espn", "football", null, "2026", "score", true, "AVAILABLE", "scoreboard_available", 80, 12],
    ["onefootball", "football", null, "2026", "fixture", true, "FALLBACK_ONLY", "use_for_fixture_consensus", 75, 12],
    ["onefootball", "football", null, "2026", "score", true, "FALLBACK_ONLY", "use_for_result_consensus", 75, 12],
    ["manual_verified_json", "football", null, "2026", "lineup", true, "AVAILABLE", "confidence_required_80", 85, 24],
    ["manual_verified_json", "football", null, "2026", "team_stats", true, "AVAILABLE", "confidence_required_80", 85, 24],
    ["manual_verified_json", "football", null, "2026", "player_stats", true, "AVAILABLE", "confidence_required_80", 85, 24],
    ["sportsdataio", "baseball", "mlb", "2026", "odds", true, "AVAILABLE", "odds_available", 90, 12],
    ["sportsdataio", "baseball", "mlb", "2026", "closing_odds", true, "AVAILABLE", "closing_odds_available", 90, 12],
    ["sportsdataio", "baseball", "mlb", "2026", "settlement_result", true, "AVAILABLE", "settlement_available", 90, 12]
  ];

  for (const row of defaults) {
    await db.query(
      `
        INSERT INTO provider_capabilities (
          provider, sport, league_id, season, data_type, available, status, reason,
          confidence_score, expires_at, raw_data, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + (($10::int || ' hours')::interval), '{}'::jsonb, now())
        ON CONFLICT (provider, sport, COALESCE(league_id, ''), COALESCE(season, ''), data_type)
        DO NOTHING
      `,
      row
    );
  }
}

export async function updateProviderCapability(db: Queryable, input: unknown) {
  await ensureSportsIntelligenceCoreTables(db);
  const parsed = providerCapabilitySchema.parse(input);
  const result = await db.query(
    `
      INSERT INTO provider_capabilities (
        provider, sport, league_id, season, data_type, available, status, reason,
        confidence_score, rate_limit_status, quota_remaining, expires_at, raw_data, checked_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::jsonb, now(), now())
      ON CONFLICT (provider, sport, COALESCE(league_id, ''), COALESCE(season, ''), data_type)
      DO UPDATE SET
        available = EXCLUDED.available,
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        confidence_score = EXCLUDED.confidence_score,
        rate_limit_status = EXCLUDED.rate_limit_status,
        quota_remaining = EXCLUDED.quota_remaining,
        expires_at = EXCLUDED.expires_at,
        raw_data = EXCLUDED.raw_data,
        checked_at = now(),
        updated_at = now()
      RETURNING *
    `,
    [
      parsed.provider,
      parsed.sport,
      parsed.league_id ?? null,
      parsed.season ?? null,
      parsed.data_type,
      parsed.available,
      parsed.status,
      parsed.reason ?? null,
      parsed.confidence_score,
      parsed.rate_limit_status ?? null,
      parsed.quota_remaining ?? null,
      parsed.expires_at ?? null,
      JSON.stringify(parsed.raw_data ?? {})
    ]
  );
  return result.rows[0];
}

export async function getProviderCapabilities(db: Queryable): Promise<Array<Record<string, any>>> {
  await ensureSportsIntelligenceCoreTables(db);
  await seedDefaultCapabilities(db);
  const result = await db.query(`
    SELECT *,
      CASE WHEN expires_at IS NOT NULL AND expires_at < now() THEN true ELSE false END AS expired
    FROM provider_capabilities
    ORDER BY
      CASE status
        WHEN 'AVAILABLE' THEN 0
        WHEN 'FALLBACK_ONLY' THEN 1
        WHEN 'PLAN_BLOCKED' THEN 2
        ELSE 3
      END,
      provider,
      sport,
      league_id NULLS FIRST,
      data_type
  `);
  return result.rows.map((row: Record<string, any>) => ({
    ...row,
    recommendation: statusRecommendation(row)
  }));
}

export async function upsertCanonicalEntity(db: Queryable, input: {
  entity_type: string;
  sport: string;
  canonical_id?: string;
  canonical_name: string;
  display_name?: string | null;
  league_id?: string | null;
  country?: string | null;
  metadata?: Record<string, any>;
}) {
  await ensureSportsIntelligenceCoreTables(db);
  const canonicalId = input.canonical_id || `${input.sport}:${input.entity_type}:${canonicalSlug(input.canonical_name)}`;
  const result = await db.query(
    `
      INSERT INTO sports_canonical_entities (
        entity_type, sport, canonical_id, canonical_name, display_name, league_id, country, metadata, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
      ON CONFLICT (canonical_id)
      DO UPDATE SET
        canonical_name = EXCLUDED.canonical_name,
        display_name = COALESCE(EXCLUDED.display_name, sports_canonical_entities.display_name),
        league_id = COALESCE(EXCLUDED.league_id, sports_canonical_entities.league_id),
        country = COALESCE(EXCLUDED.country, sports_canonical_entities.country),
        metadata = sports_canonical_entities.metadata || EXCLUDED.metadata,
        updated_at = now()
      RETURNING *
    `,
    [
      input.entity_type,
      input.sport,
      canonicalId,
      input.canonical_name,
      input.display_name ?? input.canonical_name,
      input.league_id ?? null,
      input.country ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0];
}

export async function upsertEntityAlias(db: Queryable, canonicalId: string, alias: string, provider?: string | null, confidenceScore = 80) {
  await ensureSportsIntelligenceCoreTables(db);
  await db.query(
    `
      INSERT INTO sports_entity_aliases (canonical_id, alias, provider, confidence_score)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (canonical_id, lower(alias), COALESCE(provider, ''))
      DO UPDATE SET confidence_score = GREATEST(sports_entity_aliases.confidence_score, EXCLUDED.confidence_score)
    `,
    [canonicalId, alias, provider ?? null, confidenceScore]
  );
}

export async function resolveCanonicalEntity(db: Queryable, rawName: string, entityType: string, provider?: string | null, sport = "football") {
  await ensureSportsIntelligenceCoreTables(db);
  const normalized = normalizeName(rawName);
  if (!normalized) return { status: "UNKNOWN_ENTITY", raw_name: rawName, canonical_id: null };
  const aliasResult = await db.query(
    `
      SELECT e.*, a.alias, a.provider, a.confidence_score
      FROM sports_entity_aliases a
      JOIN sports_canonical_entities e ON e.canonical_id = a.canonical_id
      WHERE e.entity_type = $1
        AND e.sport = $2
        AND lower(a.alias) = lower($3)
      ORDER BY
        CASE WHEN a.provider = $4 THEN 0 ELSE 1 END,
        a.confidence_score DESC
      LIMIT 1
    `,
    [entityType, sport, rawName, provider ?? null]
  );
  if (aliasResult.rows[0]) {
    return { status: "RESOLVED_ALIAS", raw_name: rawName, ...aliasResult.rows[0] };
  }
  const entityResult = await db.query(
    `
      SELECT *
      FROM sports_canonical_entities
      WHERE entity_type = $1
        AND sport = $2
        AND lower(canonical_name) = lower($3)
      LIMIT 1
    `,
    [entityType, sport, rawName]
  );
  if (entityResult.rows[0]) {
    return { status: "RESOLVED_CANONICAL", raw_name: rawName, ...entityResult.rows[0] };
  }
  return { status: "UNKNOWN_ENTITY", raw_name: rawName, canonical_id: null, normalized };
}

export async function recordSourceObservations(db: Queryable, body: unknown) {
  await ensureSportsIntelligenceCoreTables(db);
  const parsed = sourceObservationsSchema.parse(body);
  const rows = parsed.observations.map((observation) => ({
    ...observation,
    status: parsed.dry_run ? "WOULD_RECORD" : "RECORDED",
    can_confirm: observation.source_confidence_score >= 70,
    recommendation: observation.source_confidence_score >= 80
      ? "Can feed context if competition and consensus rules pass."
      : observation.source_confidence_score >= 70
        ? "Review; confidence is usable but not strong."
        : "Low confidence; cannot confirm."
  }));

  if (!parsed.dry_run) {
    for (const observation of parsed.observations) {
      await db.query(
        `
          INSERT INTO sports_source_observations (
            provider, sport, league_id, match_id, entity_id, data_type,
            observed_value, source_confidence_score, observed_at, raw_data
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, COALESCE($9::timestamptz, now()), $10::jsonb)
        `,
        [
          observation.provider,
          observation.sport,
          observation.league_id ?? null,
          observation.match_id ?? null,
          observation.entity_id ?? null,
          observation.data_type,
          JSON.stringify(observation.observed_value),
          observation.source_confidence_score,
          observation.observed_at ?? null,
          JSON.stringify(observation.raw_data ?? {})
        ]
      );
    }
  }

  return {
    status: parsed.dry_run ? "SOURCE_OBSERVATIONS_DRY_RUN" : "SOURCE_OBSERVATIONS_RECORDED",
    dry_run: parsed.dry_run,
    inserted: parsed.dry_run ? 0 : parsed.observations.length,
    would_insert: parsed.dry_run ? parsed.observations.length : 0,
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    rows
  };
}

async function consensusForDataType(db: Queryable, sport: string, leagueId: string | null | undefined, matchId: string, dataType: string) {
  const observations = await db.query(
    `
      SELECT *
      FROM sports_source_observations
      WHERE sport = $1
        AND COALESCE(league_id, '') = COALESCE($2, '')
        AND match_id = $3
        AND data_type = $4
      ORDER BY source_confidence_score DESC, observed_at DESC
    `,
    [sport, leagueId ?? null, matchId, dataType]
  );
  const rows = observations.rows;
  const providers = [...new Set(rows.map((row) => String(row.provider)))];
  const values = [...new Set(rows.map((row) => jsonStable(row.observed_value)))];
  const best = rows[0] ?? null;
  const avgConfidence = rows.length
    ? rows.reduce((sum, row) => sum + toNumber(row.source_confidence_score), 0) / rows.length
    : 0;
  const manualStrong = rows.some((row) => String(row.provider).includes("manual_verified") && toNumber(row.source_confidence_score) >= 80);
  const consensusVerified = (providers.length >= 2 && avgConfidence >= 70 && values.length <= 1) || manualStrong;
  const consensusScore = rows.length ? Math.min(100, Math.round((avgConfidence + Math.min(providers.length, 3) * 8 - Math.max(values.length - 1, 0) * 20) * 1000) / 1000) : 0;
  const sourceConflicts = values.length > 1
    ? rows.map((row) => ({ provider: row.provider, value: row.observed_value, confidence: row.source_confidence_score }))
    : [];
  const recommendation = consensusVerified
    ? "Consensus verified; can feed context rules."
    : rows.length === 0
      ? "No source observations yet."
      : sourceConflicts.length
        ? "Source conflict; keep in review."
        : "More sources or higher confidence required.";

  return {
    sport,
    league_id: leagueId ?? null,
    match_id: matchId,
    data_type: dataType,
    consensus_verified: consensusVerified,
    consensus_score: consensusScore,
    selected_value: best?.observed_value ?? {},
    sources_used: providers,
    sources_missing: rows.length ? [] : ["source_observation"],
    source_conflicts: sourceConflicts,
    recommendation,
    observation_count: rows.length
  };
}

export async function buildConsensusForMatch(db: Queryable, body: unknown) {
  await ensureSportsIntelligenceCoreTables(db);
  const parsed = buildConsensusSchema.parse(body);
  const rows = [];
  for (const dataType of parsed.data_types) {
    const row = await consensusForDataType(db, parsed.sport, parsed.league_id ?? null, parsed.match_id, dataType);
    rows.push({ ...row, status: parsed.dry_run ? "WOULD_BUILD" : "BUILT" });
    if (!parsed.dry_run) {
      await db.query(
        `
          INSERT INTO sports_consensus_events (
            sport, league_id, match_id, data_type, consensus_verified, consensus_score,
            selected_value, sources_used, sources_missing, source_conflicts, recommendation, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, now())
          ON CONFLICT (sport, COALESCE(league_id, ''), COALESCE(match_id, ''), data_type)
          DO UPDATE SET
            consensus_verified = EXCLUDED.consensus_verified,
            consensus_score = EXCLUDED.consensus_score,
            selected_value = EXCLUDED.selected_value,
            sources_used = EXCLUDED.sources_used,
            sources_missing = EXCLUDED.sources_missing,
            source_conflicts = EXCLUDED.source_conflicts,
            recommendation = EXCLUDED.recommendation,
            updated_at = now()
        `,
        [
          row.sport,
          row.league_id,
          row.match_id,
          row.data_type,
          row.consensus_verified,
          row.consensus_score,
          JSON.stringify(row.selected_value),
          JSON.stringify(row.sources_used),
          JSON.stringify(row.sources_missing),
          JSON.stringify(row.source_conflicts),
          row.recommendation
        ]
      );
    }
  }
  const score = calculateContextScoreFromConsensus(rows);
  if (!parsed.dry_run) {
    await upsertMatchContextScore(db, parsed.sport, parsed.league_id ?? null, parsed.match_id, score);
  }
  return {
    status: parsed.dry_run ? "CONSENSUS_DRY_RUN" : "CONSENSUS_BUILT",
    dry_run: parsed.dry_run,
    match_id: parsed.match_id,
    rows,
    context_score: score,
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false
  };
}

function calculateContextScoreFromConsensus(rows: Array<Record<string, any>>) {
  const byType = new Map(rows.map((row) => [row.data_type, row]));
  const fixture = Math.max(toNumber(byType.get("fixture")?.consensus_score), toNumber(byType.get("kickoff")?.consensus_score));
  const sourceConsensus = rows.length ? rows.reduce((sum, row) => sum + toNumber(row.consensus_score), 0) / rows.length : 0;
  const lineup = toNumber(byType.get("lineup")?.consensus_score);
  const score = Math.min(100, Math.round(((fixture * 0.25) + (sourceConsensus * 0.25) + (lineup * 0.25) + 15) * 1000) / 1000);
  const missing = [];
  if (fixture < 70) missing.push("fixture_or_kickoff_consensus");
  if (lineup < 70) missing.push("lineup_consensus");
  if (sourceConsensus < 70) missing.push("source_consensus");
  const contextStatus = missing.length === 0 && score >= 80
    ? "MATCHUP_CONTEXT_SUPPORTS"
    : score >= 60
      ? "PARTIAL_CONTEXT_REVIEW"
      : score > 0
        ? "CONTEXT_GAPS"
        : "NO_CONTEXT";
  return {
    fixture_trust_score: fixture,
    source_consensus_score: sourceConsensus,
    odds_quality_score: 0,
    lineup_confidence_score: lineup,
    team_context_score: toNumber(byType.get("team_stats")?.consensus_score),
    player_context_score: toNumber(byType.get("player_stats")?.consensus_score),
    market_maturity_score: 0,
    settlement_readiness_score: toNumber(byType.get("score")?.consensus_score),
    overall_context_score: score,
    context_status: contextStatus,
    missing_context_fields: missing,
    block_reasons: contextStatus === "CONTEXT_GAPS" || contextStatus === "NO_CONTEXT" ? ["context_not_confirmed"] : [],
    recommendation: missing.length
      ? `Missing: ${missing.join(", ")}. Keep in review.`
      : "Context supports paper confirmation rules only."
  };
}

async function upsertMatchContextScore(db: Queryable, sport: string, leagueId: string | null, matchId: string, score: Record<string, any>) {
  await db.query(
    `
      INSERT INTO match_context_scores (
        sport, league_id, match_id, fixture_trust_score, source_consensus_score, odds_quality_score,
        lineup_confidence_score, team_context_score, player_context_score, market_maturity_score,
        settlement_readiness_score, overall_context_score, context_status, missing_context_fields,
        block_reasons, recommendation, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16, now())
      ON CONFLICT (match_id)
      DO UPDATE SET
        sport = EXCLUDED.sport,
        league_id = EXCLUDED.league_id,
        fixture_trust_score = EXCLUDED.fixture_trust_score,
        source_consensus_score = EXCLUDED.source_consensus_score,
        odds_quality_score = EXCLUDED.odds_quality_score,
        lineup_confidence_score = EXCLUDED.lineup_confidence_score,
        team_context_score = EXCLUDED.team_context_score,
        player_context_score = EXCLUDED.player_context_score,
        market_maturity_score = EXCLUDED.market_maturity_score,
        settlement_readiness_score = EXCLUDED.settlement_readiness_score,
        overall_context_score = EXCLUDED.overall_context_score,
        context_status = EXCLUDED.context_status,
        missing_context_fields = EXCLUDED.missing_context_fields,
        block_reasons = EXCLUDED.block_reasons,
        recommendation = EXCLUDED.recommendation,
        updated_at = now()
    `,
    [
      sport,
      leagueId,
      matchId,
      score.fixture_trust_score,
      score.source_consensus_score,
      score.odds_quality_score,
      score.lineup_confidence_score,
      score.team_context_score,
      score.player_context_score,
      score.market_maturity_score,
      score.settlement_readiness_score,
      score.overall_context_score,
      score.context_status,
      JSON.stringify(score.missing_context_fields),
      JSON.stringify(score.block_reasons),
      score.recommendation
    ]
  );
}

export async function calculateMatchContextScore(db: Queryable, matchId: string) {
  await ensureSportsIntelligenceCoreTables(db);
  const consensus = await db.query(
    `SELECT * FROM sports_consensus_events WHERE match_id = $1 ORDER BY data_type`,
    [matchId]
  );
  const score = calculateContextScoreFromConsensus(consensus.rows);
  const first = consensus.rows[0];
  if (first) {
    await upsertMatchContextScore(db, first.sport, first.league_id, matchId, score);
  }
  return score;
}

export async function getMatchTrustExplanation(db: Queryable, matchId: string) {
  await ensureSportsIntelligenceCoreTables(db);
  const scores = await db.query(`SELECT * FROM match_context_scores WHERE match_id = $1 LIMIT 1`, [matchId]);
  const consensus = await db.query(`SELECT * FROM sports_consensus_events WHERE match_id = $1 ORDER BY data_type`, [matchId]);
  return {
    match_id: matchId,
    score: scores.rows[0] ?? null,
    consensus: consensus.rows,
    recommendation: scores.rows[0]?.recommendation ?? "Build consensus first."
  };
}

export async function getSportsIntelligenceCoreStatus(db: Queryable) {
  await ensureSportsIntelligenceCoreTables(db);
  await seedDefaultCapabilities(db);
  const capabilities = await getProviderCapabilities(db);
  const consensusSummary = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE consensus_verified)::int AS verified,
      COUNT(*) FILTER (WHERE NOT consensus_verified)::int AS gaps
    FROM sports_consensus_events
  `);
  const contextSummary = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE context_status = 'CONFIRMED_PAPER')::int AS confirmed,
      COUNT(*) FILTER (WHERE context_status IN ('CONTEXT_GAPS', 'NO_CONTEXT', 'BLOCKED'))::int AS gaps,
      COUNT(*) FILTER (WHERE context_status = 'PARTIAL_CONTEXT_REVIEW')::int AS review
    FROM match_context_scores
  `);
  const unknownEntities = await db.query(`
    SELECT COUNT(*)::int AS total
    FROM sports_source_observations
    WHERE entity_id IS NULL
      AND data_type IN ('team_stats', 'player_stats', 'lineup')
  `);
  const manualVerified = await db.query(`
    SELECT COUNT(*)::int AS total
    FROM sports_source_observations
    WHERE provider IN ('manual_verified_json', 'manual_verified', 'manual_verified_football_context')
      AND source_confidence_score >= 80
  `);
  const rows = capabilities.map((row) => ({
    provider: row.provider,
    sport: row.sport,
    league_id: row.league_id ?? "global",
    season: row.season ?? "-",
    data_type: row.data_type,
    status: row.status,
    available: row.available,
    confidence_score: row.confidence_score,
    reason: row.reason,
    expires_at: row.expires_at,
    recommendation: row.recommendation
  }));
  return {
    status: "SPORTS_INTELLIGENCE_CORE_V1",
    recommendation: "sports-data-hub is the decision brain; providers are sources. Keep all real-money guardrails off.",
    provider_capabilities_summary: {
      total: capabilities.length,
      available: capabilities.filter((row) => row.status === "AVAILABLE").length,
      blocked: capabilities.filter((row) => ["PLAN_BLOCKED", "RATE_LIMITED", "NO_KEY", "PROVIDER_ERROR", "DISABLED"].includes(row.status)).length,
      fallback_only: capabilities.filter((row) => row.status === "FALLBACK_ONLY").length
    },
    unavailable_sources: capabilities.filter((row) => !row.available || ["PLAN_BLOCKED", "RATE_LIMITED", "NO_KEY", "PROVIDER_ERROR", "DISABLED"].includes(row.status)),
    plan_blocked_sources: capabilities.filter((row) => row.status === "PLAN_BLOCKED"),
    consensus_verified_count: consensusSummary.rows[0]?.verified ?? 0,
    context_gaps_count: contextSummary.rows[0]?.gaps ?? 0,
    confirmed_context_count: contextSummary.rows[0]?.confirmed ?? 0,
    unknown_entities_count: unknownEntities.rows[0]?.total ?? 0,
    manual_verified_contexts: manualVerified.rows[0]?.total ?? 0,
    consensus_summary: consensusSummary.rows[0],
    context_summary: contextSummary.rows[0],
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    kill_switch_enabled: true,
    rows
  };
}

async function ensureSportsContextDepthTables(db: Queryable) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_team_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sport text NOT NULL,
      league_id text NOT NULL DEFAULT '',
      team_id text,
      team_name text NOT NULL,
      normalized_team_name text NOT NULL,
      country text,
      home_venue text,
      profile_status text NOT NULL DEFAULT 'ACTIVE',
      source text NOT NULL,
      source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      observed_at timestamptz NOT NULL DEFAULT now(),
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_team_profiles_unique ON sports_team_profiles(sport, league_id, normalized_team_name);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_team_profiles_lookup ON sports_team_profiles(sport, league_id, profile_status, source_confidence_score DESC);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_player_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sport text NOT NULL,
      league_id text NOT NULL DEFAULT '',
      team_id text,
      team_name text,
      normalized_team_name text,
      player_id text,
      player_name text NOT NULL,
      normalized_player_name text NOT NULL,
      position text,
      active boolean NOT NULL DEFAULT true,
      source text NOT NULL,
      source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      observed_at timestamptz NOT NULL DEFAULT now(),
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_player_profiles_unique ON sports_player_profiles(sport, league_id, COALESCE(normalized_team_name, ''), normalized_player_name);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_player_profiles_lookup ON sports_player_profiles(sport, league_id, normalized_team_name, active, source_confidence_score DESC);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_match_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id text NOT NULL UNIQUE,
      sport text NOT NULL,
      league_id text NOT NULL DEFAULT '',
      season text,
      match_date timestamptz,
      home_team text NOT NULL,
      away_team text NOT NULL,
      normalized_home_team text NOT NULL,
      normalized_away_team text NOT NULL,
      home_score numeric(8,3),
      away_score numeric(8,3),
      status text NOT NULL DEFAULT 'SCHEDULED',
      competition_type text NOT NULL DEFAULT 'official',
      importance_tag text NOT NULL DEFAULT 'normal',
      source text NOT NULL,
      source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_match_history_team_date ON sports_match_history(sport, league_id, normalized_home_team, normalized_away_team, match_date DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_match_history_importance ON sports_match_history(sport, league_id, competition_type, importance_tag, match_date DESC);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_team_match_stats (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id text NOT NULL,
      sport text NOT NULL,
      league_id text NOT NULL DEFAULT '',
      team_name text NOT NULL,
      normalized_team_name text NOT NULL,
      opponent_team text,
      is_home boolean,
      result text,
      points_for numeric(8,3),
      points_against numeric(8,3),
      xg_for numeric(8,3),
      xg_against numeric(8,3),
      shots_for numeric(8,3),
      shots_against numeric(8,3),
      possession_pct numeric(8,3),
      rest_days numeric(8,3),
      travel_status text,
      source text NOT NULL,
      source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_team_match_stats_unique ON sports_team_match_stats(match_id, normalized_team_name);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_team_match_stats_lookup ON sports_team_match_stats(sport, league_id, normalized_team_name, updated_at DESC);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_match_lineups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id text NOT NULL,
      sport text NOT NULL,
      league_id text NOT NULL DEFAULT '',
      team_name text NOT NULL,
      normalized_team_name text NOT NULL,
      lineup_status text NOT NULL DEFAULT 'UNKNOWN',
      formation text,
      starters jsonb NOT NULL DEFAULT '[]'::jsonb,
      bench jsonb NOT NULL DEFAULT '[]'::jsonb,
      missing_players jsonb NOT NULL DEFAULT '[]'::jsonb,
      key_players_available boolean,
      source text NOT NULL,
      source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      observed_at timestamptz NOT NULL DEFAULT now(),
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_match_lineups_unique ON sports_match_lineups(match_id, normalized_team_name);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_match_lineups_status ON sports_match_lineups(sport, league_id, lineup_status, observed_at DESC);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_expected_lineups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sport text NOT NULL,
      league_id text NOT NULL DEFAULT '',
      team_name text NOT NULL,
      normalized_team_name text NOT NULL,
      player_name text NOT NULL,
      normalized_player_name text NOT NULL,
      position text,
      expected_role text NOT NULL DEFAULT 'STARTER',
      expected_starting boolean NOT NULL DEFAULT true,
      confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      source text NOT NULL,
      source_reason text,
      sample_size integer NOT NULL DEFAULT 0,
      last_seen_match_id text,
      last_seen_at timestamptz,
      observed_at timestamptz NOT NULL DEFAULT now(),
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_expected_lineups_unique ON sports_expected_lineups(sport, league_id, normalized_team_name, normalized_player_name);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_expected_lineups_lookup ON sports_expected_lineups(sport, league_id, normalized_team_name, expected_starting, confidence_score DESC);`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sports_player_availability (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      match_id text NOT NULL,
      sport text NOT NULL,
      league_id text NOT NULL DEFAULT '',
      team_name text NOT NULL,
      normalized_team_name text NOT NULL,
      player_name text NOT NULL,
      normalized_player_name text NOT NULL,
      status text NOT NULL DEFAULT 'UNKNOWN',
      reason text,
      expected_minutes numeric(8,3),
      key_player_flag boolean NOT NULL DEFAULT false,
      impact_score numeric(6,3) NOT NULL DEFAULT 0,
      source text NOT NULL,
      source_confidence_score numeric(6,3) NOT NULL DEFAULT 0,
      observed_at timestamptz NOT NULL DEFAULT now(),
      raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sports_player_availability_unique ON sports_player_availability(match_id, normalized_team_name, normalized_player_name);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sports_player_availability_status ON sports_player_availability(sport, league_id, status, key_player_flag, observed_at DESC);`);
}

const contextQuerySchema = z.object({
  sport: z.string().min(1).max(60).optional().default("football"),
  league_id: z.string().min(1).max(120).optional().nullable(),
  match_id: z.string().min(1).max(160).optional().nullable(),
  team: z.string().min(1).max(160).optional().nullable(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const expectedLineupRebuildSchema = z.object({
  dry_run: z.boolean().optional().default(true),
  sport: z.string().min(1).max(60).default("baseball"),
  league_id: z.string().min(1).max(120).default("mlb"),
  days_lookback: z.coerce.number().int().min(1).max(180).default(21),
  last_n: z.coerce.number().int().min(1).max(20).default(10),
  min_frequency: z.coerce.number().min(0.1).max(1).default(0.5),
  min_confidence_score: z.coerce.number().min(1).max(100).default(50),
  limit: z.coerce.number().int().min(1).max(2000).default(500)
});

const sportsContextIngestSchema = z.object({
  dry_run: z.boolean().optional().default(true),
  team_profiles: z.array(z.record(z.any())).optional().default([]),
  player_profiles: z.array(z.record(z.any())).optional().default([]),
  match_history: z.array(z.record(z.any())).optional().default([]),
  team_match_stats: z.array(z.record(z.any())).optional().default([]),
  match_lineups: z.array(z.record(z.any())).optional().default([]),
  expected_lineups: z.array(z.record(z.any())).optional().default([]),
  player_availability: z.array(z.record(z.any())).optional().default([])
}).refine((value) =>
  value.team_profiles.length
  + value.player_profiles.length
  + value.match_history.length
  + value.team_match_stats.length
  + value.match_lineups.length
  + value.expected_lineups.length
  + value.player_availability.length > 0,
  { message: "At least one context array must contain records." }
);

function textValue(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function confidenceValue(record: Record<string, any>, fallback = 80) {
  return Math.max(0, Math.min(100, toNumber(record.source_confidence_score ?? record.confidence_score, fallback)));
}

function jsonArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function boolValue(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "si", "start", "starter", "starting"].includes(text)) return true;
  if (["false", "0", "no", "n", "bench", "substitute"].includes(text)) return false;
  return fallback;
}

function starterNamesFromLineup(value: unknown) {
  return jsonArray(value)
    .map((player) => {
      if (typeof player === "string") return player;
      if (player && typeof player === "object") {
        const record = player as Record<string, any>;
        return record.player_name ?? record.name ?? record.display_name ?? record.full_name ?? "";
      }
      return "";
    })
    .map((name) => normalizePersonName(name))
    .filter(Boolean);
}

function lineupPlayerEntries(lineup: Record<string, any>) {
  const primary = jsonArray(lineup.batting_order).length ? jsonArray(lineup.batting_order) : jsonArray(lineup.starters);
  const seen = new Set<string>();
  return primary
    .map((player, index) => {
      const record = player && typeof player === "object" ? player as Record<string, any> : {};
      const playerName = typeof player === "string"
        ? player
        : record.player_name ?? record.name ?? record.display_name ?? record.full_name ?? "";
      const normalized = normalizePersonName(playerName);
      return {
        player_name: textValue(playerName),
        normalized_player_name: normalized,
        position: textValue(record.position ?? record.pos ?? record.fielding_position ?? ""),
        order: toNumber(record.lineup_position ?? record.batting_order ?? record.order, index + 1)
      };
    })
    .filter((player) => {
      if (!player.normalized_player_name || seen.has(player.normalized_player_name)) return false;
      seen.add(player.normalized_player_name);
      return true;
    });
}

function similarityPercent(expectedNames: string[], officialNames: string[]) {
  const expected = Array.from(new Set(expectedNames.filter(Boolean)));
  const official = new Set(officialNames.filter(Boolean));
  if (!expected.length || !official.size) return null;
  const matches = expected.filter((name) => official.has(name)).length;
  return Math.round((matches / expected.length) * 10000) / 100;
}

function contextRow(kind: string, record: Record<string, any>, status: string, recommendation: string) {
  return {
    kind,
    status,
    sport: record.sport ?? "football",
    league_id: record.league_id ?? "",
    match_id: record.match_id ?? null,
    team: record.team_name ?? record.home_team ?? null,
    player: record.player_name ?? null,
    confidence: confidenceValue(record),
    recommendation
  };
}

async function insertGroupedSourceObservation(
  db: Queryable,
  provider: string,
  sport: string,
  leagueId: string,
  matchId: string,
  dataType: string,
  observedValue: Record<string, any>,
  sourceConfidenceScore: number
) {
  await db.query(
    `
      INSERT INTO sports_source_observations (
        provider, sport, league_id, match_id, entity_id, data_type,
        observed_value, source_confidence_score, observed_at, raw_data
      )
      VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb, $7, now(), $8::jsonb)
    `,
    [
      provider,
      sport,
      leagueId,
      matchId,
      dataType,
      JSON.stringify(observedValue),
      sourceConfidenceScore,
      JSON.stringify({ mirrored_from: "sports_context_depth_v1" })
    ]
  );
}

async function mirrorContextToSourceObservations(db: Queryable, parsed: z.infer<typeof sportsContextIngestSchema>) {
  const lineupsByMatch = new Map<string, Record<string, any>[]>();
  for (const record of parsed.match_lineups) {
    const matchId = textValue(record.match_id);
    if (!matchId) continue;
    const key = `${record.sport ?? "football"}|${record.league_id ?? ""}|${matchId}`;
    lineupsByMatch.set(key, [...(lineupsByMatch.get(key) ?? []), record]);
  }
  for (const [key, records] of lineupsByMatch.entries()) {
    const [sport, leagueId, matchId] = key.split("|");
    const statuses = records.map((record) => textValue(record.lineup_status, "UNKNOWN").toUpperCase());
    await insertGroupedSourceObservation(db, "sports_context_depth_v1", sport, leagueId, matchId, "lineup", {
      teams: records.map((record) => ({
        team_name: record.team_name,
        lineup_status: textValue(record.lineup_status, "UNKNOWN").toUpperCase(),
        formation: record.formation ?? null,
        starters_count: jsonArray(record.starters).length,
        bench_count: jsonArray(record.bench).length,
        missing_players: jsonArray(record.missing_players),
        key_players_available: record.key_players_available ?? null
      })),
      all_lineups_confirmed: statuses.length >= 2 && statuses.every((status) => status === "CONFIRMED")
    }, Math.min(...records.map((record) => confidenceValue(record))));
  }

  const statsByMatch = new Map<string, Record<string, any>[]>();
  for (const record of parsed.team_match_stats) {
    const matchId = textValue(record.match_id);
    if (!matchId) continue;
    const key = `${record.sport ?? "football"}|${record.league_id ?? ""}|${matchId}`;
    statsByMatch.set(key, [...(statsByMatch.get(key) ?? []), record]);
  }
  for (const [key, records] of statsByMatch.entries()) {
    const [sport, leagueId, matchId] = key.split("|");
    await insertGroupedSourceObservation(db, "sports_context_depth_v1", sport, leagueId, matchId, "team_stats", {
      teams: records.map((record) => ({
        team_name: record.team_name,
        result: record.result ?? null,
        points_for: record.points_for ?? null,
        points_against: record.points_against ?? null,
        xg_for: record.xg_for ?? null,
        xg_against: record.xg_against ?? null,
        rest_days: record.rest_days ?? null,
        travel_status: record.travel_status ?? null
      }))
    }, Math.min(...records.map((record) => confidenceValue(record))));
  }

  const availabilityByMatch = new Map<string, Record<string, any>[]>();
  for (const record of parsed.player_availability) {
    const matchId = textValue(record.match_id);
    if (!matchId) continue;
    const key = `${record.sport ?? "football"}|${record.league_id ?? ""}|${matchId}`;
    availabilityByMatch.set(key, [...(availabilityByMatch.get(key) ?? []), record]);
  }
  for (const [key, records] of availabilityByMatch.entries()) {
    const [sport, leagueId, matchId] = key.split("|");
    await insertGroupedSourceObservation(db, "sports_context_depth_v1", sport, leagueId, matchId, "player_stats", {
      availability: records.map((record) => ({
        team_name: record.team_name,
        player_name: record.player_name,
        status: record.status ?? "UNKNOWN",
        key_player_flag: Boolean(record.key_player_flag),
        impact_score: record.impact_score ?? 0,
        reason: record.reason ?? null
      })),
      key_players_unavailable: records.filter((record) => Boolean(record.key_player_flag) && !["AVAILABLE", "STARTING", "CONFIRMED"].includes(textValue(record.status).toUpperCase())).length
    }, Math.min(...records.map((record) => confidenceValue(record))));
  }
}

export async function recordSportsContextData(db: Queryable, body: unknown) {
  await ensureSportsIntelligenceCoreTables(db);
  const parsed = sportsContextIngestSchema.parse(body);
  const rows: Array<Record<string, any>> = [];

  for (const record of parsed.team_profiles) {
    const teamName = textValue(record.team_name);
    rows.push(contextRow("team_profile", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", teamName ? "Team profile can feed team context." : "Missing team_name."));
    if (!parsed.dry_run && teamName) {
      await db.query(
        `
          INSERT INTO sports_team_profiles (
            sport, league_id, team_id, team_name, normalized_team_name, country, home_venue,
            profile_status, source, source_confidence_score, observed_at, raw_data, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'ACTIVE'), $9, $10, COALESCE($11::timestamptz, now()), $12::jsonb, now())
          ON CONFLICT (sport, league_id, normalized_team_name)
          DO UPDATE SET
            team_id = COALESCE(EXCLUDED.team_id, sports_team_profiles.team_id),
            team_name = EXCLUDED.team_name,
            country = COALESCE(EXCLUDED.country, sports_team_profiles.country),
            home_venue = COALESCE(EXCLUDED.home_venue, sports_team_profiles.home_venue),
            profile_status = EXCLUDED.profile_status,
            source = EXCLUDED.source,
            source_confidence_score = GREATEST(sports_team_profiles.source_confidence_score, EXCLUDED.source_confidence_score),
            observed_at = EXCLUDED.observed_at,
            raw_data = sports_team_profiles.raw_data || EXCLUDED.raw_data,
            updated_at = now()
        `,
        [
          record.sport ?? "football",
          record.league_id ?? "",
          record.team_id ?? null,
          teamName,
          normalizeName(teamName),
          record.country ?? null,
          record.home_venue ?? null,
          record.profile_status ?? "ACTIVE",
          record.source ?? record.provider ?? "manual_verified_json",
          confidenceValue(record),
          record.observed_at ?? null,
          JSON.stringify(record.raw_data ?? record)
        ]
      );
    }
  }

  for (const record of parsed.player_profiles) {
    const playerName = textValue(record.player_name);
    const teamName = textValue(record.team_name);
    rows.push(contextRow("player_profile", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", playerName ? "Player profile can feed player context." : "Missing player_name."));
    if (!parsed.dry_run && playerName) {
      await db.query(
        `
          INSERT INTO sports_player_profiles (
            sport, league_id, team_id, team_name, normalized_team_name, player_id, player_name,
            normalized_player_name, position, active, source, source_confidence_score, observed_at, raw_data, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, true), $11, $12, COALESCE($13::timestamptz, now()), $14::jsonb, now())
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
            updated_at = now()
        `,
        [
          record.sport ?? "football",
          record.league_id ?? "",
          record.team_id ?? null,
          teamName || null,
          teamName ? normalizeName(teamName) : null,
          record.player_id ?? null,
          playerName,
          normalizePersonName(playerName),
          record.position ?? null,
          record.active ?? true,
          record.source ?? record.provider ?? "manual_verified_json",
          confidenceValue(record),
          record.observed_at ?? null,
          JSON.stringify(record.raw_data ?? record)
        ]
      );
    }
  }

  for (const record of parsed.match_history) {
    const matchId = textValue(record.match_id);
    const homeTeam = textValue(record.home_team);
    const awayTeam = textValue(record.away_team);
    rows.push(contextRow("match_history", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", matchId && homeTeam && awayTeam ? "Match history can feed form and importance." : "Missing match_id/home_team/away_team."));
    if (!parsed.dry_run && matchId && homeTeam && awayTeam) {
      await db.query(
        `
          INSERT INTO sports_match_history (
            match_id, sport, league_id, season, match_date, home_team, away_team,
            normalized_home_team, normalized_away_team, home_score, away_score, status,
            competition_type, importance_tag, source, source_confidence_score, raw_data, updated_at
          )
          VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, COALESCE($12, 'SCHEDULED'),
                  COALESCE($13, 'official'), COALESCE($14, 'normal'), $15, $16, $17::jsonb, now())
          ON CONFLICT (match_id)
          DO UPDATE SET
            sport = EXCLUDED.sport,
            league_id = EXCLUDED.league_id,
            season = COALESCE(EXCLUDED.season, sports_match_history.season),
            match_date = COALESCE(EXCLUDED.match_date, sports_match_history.match_date),
            home_score = COALESCE(EXCLUDED.home_score, sports_match_history.home_score),
            away_score = COALESCE(EXCLUDED.away_score, sports_match_history.away_score),
            status = EXCLUDED.status,
            competition_type = EXCLUDED.competition_type,
            importance_tag = EXCLUDED.importance_tag,
            source = EXCLUDED.source,
            source_confidence_score = GREATEST(sports_match_history.source_confidence_score, EXCLUDED.source_confidence_score),
            raw_data = sports_match_history.raw_data || EXCLUDED.raw_data,
            updated_at = now()
        `,
        [
          matchId,
          record.sport ?? "football",
          record.league_id ?? "",
          record.season ?? null,
          record.match_date ?? record.kickoff ?? null,
          homeTeam,
          awayTeam,
          normalizeName(homeTeam),
          normalizeName(awayTeam),
          record.home_score ?? null,
          record.away_score ?? null,
          record.status ?? "SCHEDULED",
          record.competition_type ?? "official",
          record.importance_tag ?? "normal",
          record.source ?? record.provider ?? "manual_verified_json",
          confidenceValue(record),
          JSON.stringify(record.raw_data ?? record)
        ]
      );
    }
  }

  for (const record of parsed.team_match_stats) {
    const matchId = textValue(record.match_id);
    const teamName = textValue(record.team_name);
    rows.push(contextRow("team_match_stats", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", matchId && teamName ? "Team match stats can feed form engine." : "Missing match_id/team_name."));
    if (!parsed.dry_run && matchId && teamName) {
      await db.query(
        `
          INSERT INTO sports_team_match_stats (
            match_id, sport, league_id, team_name, normalized_team_name, opponent_team, is_home, result,
            points_for, points_against, xg_for, xg_against, shots_for, shots_against, possession_pct,
            rest_days, travel_status, source, source_confidence_score, raw_data, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, now())
          ON CONFLICT (match_id, normalized_team_name)
          DO UPDATE SET
            opponent_team = COALESCE(EXCLUDED.opponent_team, sports_team_match_stats.opponent_team),
            is_home = COALESCE(EXCLUDED.is_home, sports_team_match_stats.is_home),
            result = COALESCE(EXCLUDED.result, sports_team_match_stats.result),
            points_for = COALESCE(EXCLUDED.points_for, sports_team_match_stats.points_for),
            points_against = COALESCE(EXCLUDED.points_against, sports_team_match_stats.points_against),
            xg_for = COALESCE(EXCLUDED.xg_for, sports_team_match_stats.xg_for),
            xg_against = COALESCE(EXCLUDED.xg_against, sports_team_match_stats.xg_against),
            shots_for = COALESCE(EXCLUDED.shots_for, sports_team_match_stats.shots_for),
            shots_against = COALESCE(EXCLUDED.shots_against, sports_team_match_stats.shots_against),
            possession_pct = COALESCE(EXCLUDED.possession_pct, sports_team_match_stats.possession_pct),
            rest_days = COALESCE(EXCLUDED.rest_days, sports_team_match_stats.rest_days),
            travel_status = COALESCE(EXCLUDED.travel_status, sports_team_match_stats.travel_status),
            source = EXCLUDED.source,
            source_confidence_score = GREATEST(sports_team_match_stats.source_confidence_score, EXCLUDED.source_confidence_score),
            raw_data = sports_team_match_stats.raw_data || EXCLUDED.raw_data,
            updated_at = now()
        `,
        [
          matchId,
          record.sport ?? "football",
          record.league_id ?? "",
          teamName,
          normalizeName(teamName),
          record.opponent_team ?? null,
          record.is_home ?? null,
          record.result ?? null,
          record.points_for ?? record.goals_for ?? record.runs_for ?? null,
          record.points_against ?? record.goals_against ?? record.runs_against ?? null,
          record.xg_for ?? null,
          record.xg_against ?? null,
          record.shots_for ?? null,
          record.shots_against ?? null,
          record.possession_pct ?? null,
          record.rest_days ?? null,
          record.travel_status ?? null,
          record.source ?? record.provider ?? "manual_verified_json",
          confidenceValue(record),
          JSON.stringify(record.raw_data ?? record)
        ]
      );
    }
  }

  for (const record of parsed.expected_lineups) {
    const teamName = textValue(record.team_name);
    const playerName = textValue(record.player_name);
    const confidence = confidenceValue(record, 65);
    const expectedStarting = boolValue(record.expected_starting ?? record.is_starter ?? record.starting, true);
    rows.push(contextRow(
      "expected_lineup",
      record,
      parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED",
      teamName && playerName
        ? "Expected lineup can support preview only; official lineup still required."
        : "Missing team_name/player_name."
    ));
    if (!parsed.dry_run && teamName && playerName) {
      await db.query(
        `
          INSERT INTO sports_expected_lineups (
            sport, league_id, team_name, normalized_team_name, player_name, normalized_player_name,
            position, expected_role, expected_starting, confidence_score, source, source_reason,
            sample_size, last_seen_match_id, last_seen_at, observed_at, raw_data, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'STARTER'), $9, $10, $11, $12, COALESCE($13, 0), $14, $15::timestamptz, COALESCE($16::timestamptz, now()), $17::jsonb, now())
          ON CONFLICT (sport, league_id, normalized_team_name, normalized_player_name)
          DO UPDATE SET
            team_name = EXCLUDED.team_name,
            player_name = EXCLUDED.player_name,
            position = COALESCE(EXCLUDED.position, sports_expected_lineups.position),
            expected_role = EXCLUDED.expected_role,
            expected_starting = EXCLUDED.expected_starting,
            confidence_score = GREATEST(sports_expected_lineups.confidence_score, EXCLUDED.confidence_score),
            source = EXCLUDED.source,
            source_reason = COALESCE(EXCLUDED.source_reason, sports_expected_lineups.source_reason),
            sample_size = GREATEST(sports_expected_lineups.sample_size, EXCLUDED.sample_size),
            last_seen_match_id = COALESCE(EXCLUDED.last_seen_match_id, sports_expected_lineups.last_seen_match_id),
            last_seen_at = COALESCE(EXCLUDED.last_seen_at, sports_expected_lineups.last_seen_at),
            observed_at = EXCLUDED.observed_at,
            raw_data = sports_expected_lineups.raw_data || EXCLUDED.raw_data,
            updated_at = now()
        `,
        [
          record.sport ?? "football",
          record.league_id ?? "",
          teamName,
          normalizeName(teamName),
          playerName,
          normalizePersonName(playerName),
          record.position ?? null,
          record.expected_role ?? (expectedStarting ? "STARTER" : "ROTATION"),
          expectedStarting,
          confidence,
          record.source ?? record.provider ?? "manual_verified_json",
          record.source_reason ?? record.reason ?? null,
          Number.isFinite(Number(record.sample_size)) ? Number(record.sample_size) : 0,
          record.last_seen_match_id ?? record.match_id ?? null,
          record.last_seen_at ?? null,
          record.observed_at ?? null,
          JSON.stringify(record.raw_data ?? record)
        ]
      );
    }
  }

  for (const record of parsed.match_lineups) {
    const matchId = textValue(record.match_id);
    const teamName = textValue(record.team_name);
    const lineupStatus = textValue(record.lineup_status, "UNKNOWN").toUpperCase();
    const canConfirm = lineupStatus === "CONFIRMED" && confidenceValue(record) >= 85;
    rows.push(contextRow("match_lineup", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", canConfirm ? "Confirmed lineup can support context." : "Lineup is not confirmed enough; review only."));
    if (!parsed.dry_run && matchId && teamName) {
      await db.query(
        `
          INSERT INTO sports_match_lineups (
            match_id, sport, league_id, team_name, normalized_team_name, lineup_status, formation,
            starters, bench, missing_players, key_players_available, source, source_confidence_score,
            observed_at, raw_data, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, COALESCE($14::timestamptz, now()), $15::jsonb, now())
          ON CONFLICT (match_id, normalized_team_name)
          DO UPDATE SET
            lineup_status = EXCLUDED.lineup_status,
            formation = COALESCE(EXCLUDED.formation, sports_match_lineups.formation),
            starters = EXCLUDED.starters,
            bench = EXCLUDED.bench,
            missing_players = EXCLUDED.missing_players,
            key_players_available = COALESCE(EXCLUDED.key_players_available, sports_match_lineups.key_players_available),
            source = EXCLUDED.source,
            source_confidence_score = GREATEST(sports_match_lineups.source_confidence_score, EXCLUDED.source_confidence_score),
            observed_at = EXCLUDED.observed_at,
            raw_data = sports_match_lineups.raw_data || EXCLUDED.raw_data,
            updated_at = now()
        `,
        [
          matchId,
          record.sport ?? "football",
          record.league_id ?? "",
          teamName,
          normalizeName(teamName),
          ["UNKNOWN", "PENDING", "PROJECTED", "CONFIRMED"].includes(lineupStatus) ? lineupStatus : "UNKNOWN",
          record.formation ?? null,
          JSON.stringify(jsonArray(record.starters)),
          JSON.stringify(jsonArray(record.bench)),
          JSON.stringify(jsonArray(record.missing_players)),
          record.key_players_available ?? null,
          record.source ?? record.provider ?? "manual_verified_json",
          confidenceValue(record),
          record.observed_at ?? null,
          JSON.stringify(record.raw_data ?? record)
        ]
      );
    }
  }

  for (const record of parsed.player_availability) {
    const matchId = textValue(record.match_id);
    const teamName = textValue(record.team_name);
    const playerName = textValue(record.player_name);
    rows.push(contextRow("player_availability", record, parsed.dry_run ? "WOULD_UPSERT" : "UPSERTED", playerName ? "Availability can feed player context and injury review." : "Missing player_name."));
    if (!parsed.dry_run && matchId && teamName && playerName) {
      await db.query(
        `
          INSERT INTO sports_player_availability (
            match_id, sport, league_id, team_name, normalized_team_name, player_name, normalized_player_name,
            status, reason, expected_minutes, key_player_flag, impact_score, source, source_confidence_score,
            observed_at, raw_data, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'UNKNOWN'), $9, $10, COALESCE($11, false), $12, $13, $14, COALESCE($15::timestamptz, now()), $16::jsonb, now())
          ON CONFLICT (match_id, normalized_team_name, normalized_player_name)
          DO UPDATE SET
            status = EXCLUDED.status,
            reason = COALESCE(EXCLUDED.reason, sports_player_availability.reason),
            expected_minutes = COALESCE(EXCLUDED.expected_minutes, sports_player_availability.expected_minutes),
            key_player_flag = EXCLUDED.key_player_flag,
            impact_score = GREATEST(sports_player_availability.impact_score, EXCLUDED.impact_score),
            source = EXCLUDED.source,
            source_confidence_score = GREATEST(sports_player_availability.source_confidence_score, EXCLUDED.source_confidence_score),
            observed_at = EXCLUDED.observed_at,
            raw_data = sports_player_availability.raw_data || EXCLUDED.raw_data,
            updated_at = now()
        `,
        [
          matchId,
          record.sport ?? "football",
          record.league_id ?? "",
          teamName,
          normalizeName(teamName),
          playerName,
          normalizePersonName(playerName),
          record.status ?? "UNKNOWN",
          record.reason ?? null,
          record.expected_minutes ?? null,
          record.key_player_flag ?? false,
          Math.max(0, Math.min(100, toNumber(record.impact_score, 0))),
          record.source ?? record.provider ?? "manual_verified_json",
          confidenceValue(record),
          record.observed_at ?? null,
          JSON.stringify(record.raw_data ?? record)
        ]
      );
    }
  }

  if (!parsed.dry_run) {
    await mirrorContextToSourceObservations(db, parsed);
  }

  return {
    status: parsed.dry_run ? "SPORTS_CONTEXT_INGEST_DRY_RUN" : "SPORTS_CONTEXT_INGEST_APPLIED",
    dry_run: parsed.dry_run,
    inserted: parsed.dry_run ? 0 : rows.length,
    would_insert: parsed.dry_run ? rows.length : 0,
    mirrored_source_observations: parsed.dry_run ? 0 : new Set([
      ...parsed.match_lineups.map((row) => `${row.sport ?? "football"}|${row.league_id ?? ""}|${row.match_id}|lineup`),
      ...parsed.team_match_stats.map((row) => `${row.sport ?? "football"}|${row.league_id ?? ""}|${row.match_id}|team_stats`),
      ...parsed.player_availability.map((row) => `${row.sport ?? "football"}|${row.league_id ?? ""}|${row.match_id}|player_stats`)
    ].filter((key) => !key.includes("|undefined|") && !key.includes("|null|"))).size,
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    rows
  };
}

export async function getSportsTeamContext(db: Queryable, query: unknown = {}) {
  await ensureSportsIntelligenceCoreTables(db);
  const parsed = contextQuerySchema.parse(query ?? {});
  const params: unknown[] = [parsed.sport, parsed.limit];
  let where = "WHERE sport = $1";
  if (parsed.league_id) {
    params.push(parsed.league_id);
    where += ` AND league_id = $${params.length}`;
  }
  if (parsed.team) {
    params.push(normalizeName(parsed.team));
    where += ` AND normalized_team_name = $${params.length}`;
  }
  const summary = await db.query(`
    SELECT
      COUNT(*)::int AS team_profiles,
      COUNT(*) FILTER (WHERE profile_status = 'ACTIVE')::int AS active_profiles,
      ROUND(AVG(source_confidence_score), 3) AS avg_confidence
    FROM sports_team_profiles
    WHERE sport = $1
  `, [parsed.sport]);
  const rows = await db.query(`
    SELECT *
    FROM sports_team_profiles
    ${where}
    ORDER BY source_confidence_score DESC, updated_at DESC
    LIMIT $2
  `, params);
  const stats = await db.query(`
    SELECT *
    FROM sports_team_match_stats
    ${where}
    ORDER BY updated_at DESC
    LIMIT $2
  `, params);
  return {
    status: "SPORTS_TEAM_CONTEXT_V1",
    summary: summary.rows[0] ?? {},
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    rows: rows.rows,
    match_stats: stats.rows
  };
}

export async function getSportsPlayerContext(db: Queryable, query: unknown = {}) {
  await ensureSportsIntelligenceCoreTables(db);
  const parsed = contextQuerySchema.parse(query ?? {});
  const profileParams: unknown[] = [parsed.sport, parsed.limit];
  const availabilityParams: unknown[] = [parsed.sport, parsed.limit];
  let profileWhere = "WHERE sport = $1";
  let availabilityWhere = "WHERE sport = $1";
  if (parsed.league_id) {
    profileParams.push(parsed.league_id);
    availabilityParams.push(parsed.league_id);
    profileWhere += ` AND league_id = $${profileParams.length}`;
    availabilityWhere += ` AND league_id = $${availabilityParams.length}`;
  }
  if (parsed.team) {
    const normalizedTeam = normalizeName(parsed.team);
    profileParams.push(normalizedTeam);
    availabilityParams.push(normalizedTeam);
    profileWhere += ` AND normalized_team_name = $${profileParams.length}`;
    availabilityWhere += ` AND normalized_team_name = $${availabilityParams.length}`;
  }
  if (parsed.match_id) {
    availabilityParams.push(parsed.match_id);
    availabilityWhere += ` AND match_id = $${availabilityParams.length}`;
  }
  const summary = await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM sports_player_profiles WHERE sport = $1) AS player_profiles,
      (SELECT COUNT(*)::int FROM sports_player_availability WHERE sport = $1) AS availability_rows,
      (SELECT COUNT(*)::int FROM sports_player_availability WHERE sport = $1 AND key_player_flag AND status NOT IN ('AVAILABLE', 'STARTING', 'CONFIRMED')) AS key_player_alerts
  `, [parsed.sport]);
  const profiles = await db.query(`
    SELECT *
    FROM sports_player_profiles
    ${profileWhere}
    ORDER BY source_confidence_score DESC, updated_at DESC
    LIMIT $2
  `, profileParams);
  const availability = await db.query(`
    SELECT *
    FROM sports_player_availability
    ${availabilityWhere}
    ORDER BY key_player_flag DESC, impact_score DESC, observed_at DESC
    LIMIT $2
  `, availabilityParams);
  return {
    status: "SPORTS_PLAYER_CONTEXT_V1",
    summary: summary.rows[0] ?? {},
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    rows: profiles.rows,
    availability: availability.rows
  };
}

export async function getSportsMatchHistoryContext(db: Queryable, query: unknown = {}) {
  await ensureSportsIntelligenceCoreTables(db);
  const parsed = contextQuerySchema.parse(query ?? {});
  const params: unknown[] = [parsed.sport, parsed.limit];
  let where = "WHERE sport = $1";
  if (parsed.league_id) {
    params.push(parsed.league_id);
    where += ` AND league_id = $${params.length}`;
  }
  if (parsed.match_id) {
    params.push(parsed.match_id);
    where += ` AND match_id = $${params.length}`;
  }
  if (parsed.team) {
    params.push(normalizeName(parsed.team));
    where += ` AND (normalized_home_team = $${params.length} OR normalized_away_team = $${params.length})`;
  }
  const summary = await db.query(`
    SELECT
      COUNT(*)::int AS matches,
      COUNT(*) FILTER (WHERE status IN ('FINAL', 'FINISHED', 'SETTLED'))::int AS finished,
      COUNT(*) FILTER (WHERE competition_type ILIKE '%friendly%')::int AS friendlies,
      COUNT(*) FILTER (WHERE importance_tag IN ('high', 'playoff', 'final', 'must_win'))::int AS high_importance
    FROM sports_match_history
    WHERE sport = $1
  `, [parsed.sport]);
  const rows = await db.query(`
    SELECT *
    FROM sports_match_history
    ${where}
    ORDER BY match_date DESC NULLS LAST, updated_at DESC
    LIMIT $2
  `, params);
  return {
    status: "SPORTS_MATCH_HISTORY_CONTEXT_V1",
    summary: summary.rows[0] ?? {},
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    rows: rows.rows
  };
}

export async function getExpectedLineupEngine(db: Queryable, query: unknown = {}) {
  await ensureSportsIntelligenceCoreTables(db);
  const parsed = contextQuerySchema.parse(query ?? {});
  const expectedParams: unknown[] = [parsed.sport, parsed.limit];
  let expectedWhere = "WHERE sport = $1";
  const lineupParams: unknown[] = [parsed.sport, parsed.limit];
  let lineupWhere = "WHERE sport = $1";

  if (parsed.league_id) {
    expectedParams.push(parsed.league_id);
    expectedWhere += ` AND league_id = $${expectedParams.length}`;
    lineupParams.push(parsed.league_id);
    lineupWhere += ` AND league_id = $${lineupParams.length}`;
  }
  if (parsed.team) {
    const normalizedTeam = normalizeName(parsed.team);
    expectedParams.push(normalizedTeam);
    expectedWhere += ` AND normalized_team_name = $${expectedParams.length}`;
    lineupParams.push(normalizedTeam);
    lineupWhere += ` AND normalized_team_name = $${lineupParams.length}`;
  }
  if (parsed.match_id) {
    lineupParams.push(parsed.match_id);
    lineupWhere += ` AND match_id = $${lineupParams.length}`;
  }

  const expectedResult = await db.query(`
    SELECT *
    FROM sports_expected_lineups
    ${expectedWhere}
    ORDER BY expected_starting DESC, confidence_score DESC, observed_at DESC
    LIMIT $2
  `, expectedParams);

  const lineupResult = await db.query(`
    SELECT *
    FROM sports_match_lineups
    ${lineupWhere}
    ORDER BY observed_at DESC
    LIMIT $2
  `, lineupParams);

  const summary = await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM sports_expected_lineups WHERE sport = $1) AS expected_players,
      (SELECT COUNT(DISTINCT league_id || '|' || normalized_team_name)::int FROM sports_expected_lineups WHERE sport = $1) AS expected_teams,
      (SELECT COUNT(*)::int FROM sports_match_lineups WHERE sport = $1 AND lineup_status = 'CONFIRMED') AS official_confirmed,
      (SELECT COUNT(*)::int FROM sports_match_lineups WHERE sport = $1 AND lineup_status IN ('PENDING', 'PROJECTED', 'UNKNOWN')) AS needs_official
  `, [parsed.sport]);

  const expectedByTeam = new Map<string, Record<string, any>[]>();
  for (const row of expectedResult.rows) {
    const key = `${row.sport}|${row.league_id ?? ""}|${row.normalized_team_name}`;
    const bucket = expectedByTeam.get(key) ?? [];
    bucket.push(row);
    expectedByTeam.set(key, bucket);
  }

  const rows: Record<string, any>[] = [];
  const seen = new Set<string>();

  function buildRow(lineup: Record<string, any> | null, expectedRows: Record<string, any>[], key: string) {
    const expectedStarters = expectedRows.filter((row) => Boolean(row.expected_starting));
    const officialNames = lineup ? starterNamesFromLineup(lineup.starters) : [];
    const expectedNames = expectedStarters.map((row) => String(row.normalized_player_name ?? "")).filter(Boolean);
    const similarity = similarityPercent(expectedNames, officialNames);
    const officialStatus = textValue(lineup?.lineup_status, "NO_OFFICIAL_LINEUP").toUpperCase();
    const avgConfidence = expectedRows.length
      ? Math.round((expectedRows.reduce((sum, row) => sum + toNumber(row.confidence_score, 0), 0) / expectedRows.length) * 1000) / 1000
      : 0;
    const expectedStatus = expectedRows.length
      ? (avgConfidence >= 75 ? "LINEUP_EXPECTED_FROM_HISTORY" : "LINEUP_PROJECTED_LOW_CONFIDENCE")
      : "NO_EXPECTED_LINEUP";

    let engineStatus = "NO_EXPECTED_LINEUP";
    let changeRisk = "UNKNOWN";
    let confirmationPower = "NO_CONFIRMATION_POWER";
    let recommendation = "Cargar expected_lineups o lineup oficial antes de usar contexto.";

    if (expectedRows.length && officialStatus === "CONFIRMED") {
      if (similarity !== null && similarity >= 75) {
        engineStatus = "LINEUP_CONFIRMED";
        changeRisk = "LOW";
        confirmationPower = "CAN_SUPPORT_CONTEXT";
        recommendation = "La alineacion oficial coincide con el resguardo; puede apoyar contexto, no dinero real.";
      } else if (similarity !== null) {
        engineStatus = "LINEUP_CHANGED_REVIEW";
        changeRisk = "HIGH";
        confirmationPower = "REQUIRES_MANUAL_REVIEW";
        recommendation = "La alineacion oficial cambio contra lo esperado; revisar antes de confirmar paper.";
      } else {
        engineStatus = "OFFICIAL_LINEUP_NO_STARTERS";
        changeRisk = "MEDIUM";
        confirmationPower = "PARTIAL_CONTEXT_ONLY";
        recommendation = "Hay lineup oficial, pero faltan starters parseables; revisar fuente.";
      }
    } else if (expectedRows.length && ["PROJECTED", "PENDING", "UNKNOWN", "NO_OFFICIAL_LINEUP"].includes(officialStatus)) {
      engineStatus = officialStatus === "NO_OFFICIAL_LINEUP" ? "EXPECTED_ONLY_NEEDS_OFFICIAL" : "EXPECTED_PLUS_PENDING_OFFICIAL";
      changeRisk = avgConfidence >= 80 ? "MEDIUM" : "HIGH";
      confirmationPower = "PARTIAL_CONTEXT_ONLY";
      recommendation = "Usar como preview; esperar once oficial antes de confirmed paper.";
    } else if (!expectedRows.length && officialStatus === "CONFIRMED") {
      engineStatus = "OFFICIAL_ONLY";
      changeRisk = "LOW";
      confirmationPower = "CAN_SUPPORT_CONTEXT";
      recommendation = "Hay lineup oficial sin resguardo historico; puede alimentar contexto y crear baseline.";
    }

    return {
      sport: lineup?.sport ?? expectedRows[0]?.sport ?? parsed.sport,
      league_id: lineup?.league_id ?? expectedRows[0]?.league_id ?? "",
      match_id: lineup?.match_id ?? expectedRows[0]?.last_seen_match_id ?? null,
      team_name: lineup?.team_name ?? expectedRows[0]?.team_name ?? key.split("|").pop(),
      expected_status: expectedStatus,
      official_status: officialStatus,
      engine_status: engineStatus,
      expected_players: expectedRows.length,
      expected_starters: expectedStarters.length,
      official_starters: officialNames.length,
      similarity_score: similarity,
      avg_expected_confidence: avgConfidence,
      change_risk: changeRisk,
      confirmation_power: confirmationPower,
      missing_official: officialStatus !== "CONFIRMED",
      source: expectedRows[0]?.source ?? lineup?.source ?? "-",
      source_reason: expectedRows[0]?.source_reason ?? null,
      observed_at: lineup?.observed_at ?? expectedRows[0]?.observed_at ?? null,
      recommendation
    };
  }

  for (const lineup of lineupResult.rows) {
    const key = `${lineup.sport}|${lineup.league_id ?? ""}|${lineup.normalized_team_name}`;
    rows.push(buildRow(lineup, expectedByTeam.get(key) ?? [], key));
    seen.add(key);
  }
  for (const [key, expectedRows] of expectedByTeam.entries()) {
    if (!seen.has(key)) {
      rows.push(buildRow(null, expectedRows, key));
    }
  }

  const changedOrConflict = rows.filter((row) => ["LINEUP_CHANGED_REVIEW", "OFFICIAL_LINEUP_NO_STARTERS"].includes(row.engine_status)).length;
  const confirmed = rows.filter((row) => row.engine_status === "LINEUP_CONFIRMED" || row.engine_status === "OFFICIAL_ONLY").length;
  const needsOfficial = rows.filter((row) => Boolean(row.missing_official)).length;
  const expectedOrProjected = rows.filter((row) => String(row.expected_status || "").startsWith("LINEUP_")).length;

  return {
    status: "EXPECTED_LINEUP_ENGINE_V1",
    summary: summary.rows[0] ?? {},
    expected_or_projected: expectedOrProjected,
    confirmed,
    changed_or_conflict: changedOrConflict,
    needs_official: needsOfficial,
    real_candidate_count: 0,
    real_money_enabled: false,
    kelly_enabled: false,
    telegram_auto_enabled: false,
    recommendation: needsOfficial
      ? "Alineacion esperada lista para preview; esperar oficial antes de confirmed paper."
      : "Lineups oficiales disponibles; usar solo como contexto paper.",
    rows: rows.slice(0, parsed.limit)
  };
}

export async function rebuildExpectedLineupsFromHistory(db: Queryable, body: unknown = {}) {
  await ensureSportsIntelligenceCoreTables(db);
  const parsed = expectedLineupRebuildSchema.parse(body ?? {});
  const lineups = await db.query(`
    SELECT *
    FROM sports_match_lineups
    WHERE sport = $1
      AND league_id = $2
      AND lineup_status = 'CONFIRMED'
      AND observed_at >= NOW() - ($3::int * INTERVAL '1 day')
    ORDER BY normalized_team_name ASC, observed_at DESC
    LIMIT $4
  `, [parsed.sport, parsed.league_id, parsed.days_lookback, parsed.limit]);

  const byTeam = new Map<string, Record<string, any>[]>();
  for (const lineup of lineups.rows) {
    const key = normalizeName(lineup.normalized_team_name || lineup.team_name);
    const bucket = byTeam.get(key) ?? [];
    if (bucket.length < parsed.last_n) bucket.push(lineup);
    byTeam.set(key, bucket);
  }

  const candidateRows: Record<string, any>[] = [];
  for (const [teamKey, teamLineups] of byTeam.entries()) {
    const playerStats = new Map<string, {
      player_name: string;
      normalized_player_name: string;
      position: string;
      starts: number;
      orders: number[];
      last_seen_match_id: string | null;
      last_seen_at: string | null;
      team_name: string;
      league_id: string;
    }>();

    for (const lineup of teamLineups) {
      for (const player of lineupPlayerEntries(lineup)) {
        const current: {
          player_name: string;
          normalized_player_name: string;
          position: string;
          starts: number;
          orders: number[];
          last_seen_match_id: string | null;
          last_seen_at: string | null;
          team_name: string;
          league_id: string;
        } = playerStats.get(player.normalized_player_name) ?? {
          player_name: player.player_name,
          normalized_player_name: player.normalized_player_name,
          position: player.position,
          starts: 0,
          orders: [],
          last_seen_match_id: lineup.match_id ?? null,
          last_seen_at: lineup.observed_at ?? null,
          team_name: lineup.team_name ?? teamKey,
          league_id: lineup.league_id ?? parsed.league_id
        };
        current.starts += 1;
        current.orders.push(player.order);
        if (!current.position && player.position) current.position = player.position;
        if (lineup.observed_at && (!current.last_seen_at || new Date(lineup.observed_at) > new Date(current.last_seen_at))) {
          current.last_seen_at = lineup.observed_at;
          current.last_seen_match_id = lineup.match_id ?? null;
          current.team_name = lineup.team_name ?? current.team_name;
        }
        playerStats.set(player.normalized_player_name, current);
      }
    }

    const sampleSize = Math.max(1, teamLineups.length);
    const players = [...playerStats.values()]
      .map((player) => {
        const frequency = player.starts / sampleSize;
        const avgOrder = player.orders.length
          ? Math.round((player.orders.reduce((sum, order) => sum + order, 0) / player.orders.length) * 100) / 100
          : null;
        const confidence = Math.round(frequency * 10000) / 100;
        return {
          sport: parsed.sport,
          league_id: player.league_id || parsed.league_id,
          team_name: player.team_name,
          normalized_team_name: teamKey,
          player_name: player.player_name,
          normalized_player_name: player.normalized_player_name,
          position: player.position,
          expected_role: "STARTER",
          expected_starting: frequency >= parsed.min_frequency,
          confidence_score: confidence,
          sample_size: sampleSize,
          starts_in_sample: player.starts,
          start_frequency: Math.round(frequency * 10000) / 10000,
          average_lineup_order: avgOrder,
          last_seen_match_id: player.last_seen_match_id,
          last_seen_at: player.last_seen_at,
          source: "historical_lineup_baseline",
          source_reason: `Derived from last ${sampleSize} confirmed ${parsed.league_id.toUpperCase()} lineups.`,
          raw_data: {
            rebuild_version: "expected_lineup_baseline_v1",
            days_lookback: parsed.days_lookback,
            last_n: parsed.last_n,
            min_frequency: parsed.min_frequency,
            starts_in_sample: player.starts,
            sample_size: sampleSize,
            average_lineup_order: avgOrder
          }
        };
      })
      .filter((player) => player.expected_starting && player.confidence_score >= parsed.min_confidence_score)
      .sort((a, b) => Number(a.average_lineup_order ?? 99) - Number(b.average_lineup_order ?? 99) || b.confidence_score - a.confidence_score)
      .slice(0, parsed.sport === "baseball" ? 9 : 11);

    candidateRows.push(...players);
  }

  let upserted = 0;
  if (!parsed.dry_run) {
    for (const player of candidateRows) {
      await db.query(`
        INSERT INTO sports_expected_lineups (
          sport, league_id, team_name, normalized_team_name, player_name, normalized_player_name,
          position, expected_role, expected_starting, confidence_score, source, source_reason,
          sample_size, last_seen_match_id, last_seen_at, observed_at, raw_data
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), $16::jsonb)
        ON CONFLICT (sport, league_id, normalized_team_name, normalized_player_name)
        DO UPDATE SET
          team_name = EXCLUDED.team_name,
          position = COALESCE(EXCLUDED.position, sports_expected_lineups.position),
          expected_role = EXCLUDED.expected_role,
          expected_starting = EXCLUDED.expected_starting,
          confidence_score = EXCLUDED.confidence_score,
          source = EXCLUDED.source,
          source_reason = EXCLUDED.source_reason,
          sample_size = EXCLUDED.sample_size,
          last_seen_match_id = EXCLUDED.last_seen_match_id,
          last_seen_at = EXCLUDED.last_seen_at,
          observed_at = EXCLUDED.observed_at,
          raw_data = sports_expected_lineups.raw_data || EXCLUDED.raw_data,
          updated_at = now()
      `, [
        player.sport,
        player.league_id,
        player.team_name,
        player.normalized_team_name,
        player.player_name,
        player.normalized_player_name,
        player.position || null,
        player.expected_role,
        player.expected_starting,
        player.confidence_score,
        player.source,
        player.source_reason,
        player.sample_size,
        player.last_seen_match_id,
        player.last_seen_at,
        JSON.stringify(player.raw_data)
      ]);
      upserted += 1;
    }
  }

  return {
    status: "EXPECTED_LINEUP_BASELINE_REBUILD",
    dry_run: parsed.dry_run,
    sport: parsed.sport,
    league_id: parsed.league_id,
    source_lineups: lineups.rows.length,
    teams_seen: byTeam.size,
    would_upsert: parsed.dry_run ? candidateRows.length : 0,
    upserted,
    rows: candidateRows.slice(0, 100),
    recommendation: candidateRows.length
      ? parsed.dry_run
        ? "Dry-run limpio: aplicar con dry_run=false si las filas son reales y sin placeholders."
        : "Baseline historico actualizado; recalcular Confirmed Pick Chain."
      : "No hay lineups confirmados suficientes para construir baseline; hidratar lineups oficiales primero.",
    guardrails: {
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false,
      kill_switch_enabled: true
    }
  };
}
