import { z } from "zod";
import { FOOTBALL_STANDARD_MARKETS, FootballMarketKey } from "./football-leagues.config.js";
import { buildConsensusForMatch, recordSourceObservations } from "./sports-intelligence-core.js";
import { processFootballTodayUniverse } from "./football-today-universe.js";

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
};

const placeholderPattern = /(__FILL_|UUID_REAL|TU_|PLACEHOLDER|REEMPLAZAR|Equipo Local|Equipo Visitante)/i;

const ownedSignalSchema = z.object({
  match_id: z.string().optional(),
  league: z.string().min(1).optional(),
  league_id: z.string().min(1).optional(),
  market: z.enum(FOOTBALL_STANDARD_MARKETS as [FootballMarketKey, ...FootballMarketKey[]]),
  selection: z.string().min(1),
  home_team: z.string().min(1),
  away_team: z.string().min(1),
  kickoff: z.string().min(1),
  odds_timestamp: z.string().min(1),
  provider: z.string().min(1).optional().default("sports_data_hub_owned_api"),
  market_odds: z.number().gt(1),
  model_probability: z.number().min(0).max(1),
  expected_value: z.number().optional(),
  model_version: z.string().min(1).optional().default("sports_data_hub_football_v1"),
  source_confidence_score: z.number().min(0).max(100).optional().default(85),
  raw_data: z.record(z.unknown()).optional().default({})
});

const ownedRequestSchema = z.object({
  dry_run: z.boolean().optional().default(true),
  date: z.string().optional(),
  source: z.string().min(1).optional().default("sports_data_hub_owned_api"),
  build_consensus: z.boolean().optional().default(true),
  signals: z.array(ownedSignalSchema).min(1).max(50)
});

type OwnedSignal = z.infer<typeof ownedSignalSchema>;

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function expectedValue(modelProbability: number, marketOdds: number, explicit?: number) {
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
  return Math.round((modelProbability * marketOdds - 1) * 1000000) / 1000000;
}

function containsPlaceholder(value: unknown) {
  return placeholderPattern.test(JSON.stringify(value ?? {}));
}

function normalizedLeague(signal: OwnedSignal) {
  return signal.league_id ?? signal.league ?? "";
}

function assertSignalTiming(signal: OwnedSignal) {
  const kickoff = parseDate(signal.kickoff);
  const oddsTimestamp = parseDate(signal.odds_timestamp);
  if (!kickoff) return "INVALID_KICKOFF";
  if (!oddsTimestamp) return "INVALID_ODDS_TIMESTAMP";
  if (oddsTimestamp >= kickoff) return "POST_KICKOFF_REJECTED";
  if (kickoff <= new Date()) return "STALE_MATCH_REJECTED";
  return null;
}

async function assertCanonicalMatchTiming(db: Queryable, signal: OwnedSignal) {
  if (!signal.match_id) return null;

  const result = await db.query(
    `
      SELECT
        m.match_date,
        m.status,
        l.slug AS league_slug
      FROM matches m
      JOIN leagues l ON l.id = m.league_id
      WHERE m.id = $1
      LIMIT 1
    `,
    [signal.match_id]
  );
  const row = result.rows[0];
  if (!row) return "MATCH_ID_NOT_FOUND";

  const dbKickoff = row.match_date instanceof Date ? row.match_date : parseDate(String(row.match_date));
  const payloadKickoff = parseDate(signal.kickoff);
  if (!dbKickoff || !payloadKickoff) return "INVALID_CANONICAL_KICKOFF";
  if (dbKickoff <= new Date()) return "STALE_CANONICAL_MATCH_REJECTED";

  const status = String(row.status || "").toLowerCase();
  if (!["scheduled", "pre", "pregame"].includes(status)) return "CANONICAL_MATCH_NOT_PREGAME";

  const leagueId = normalizedLeague(signal);
  if (leagueId && String(row.league_slug || "").toLowerCase() !== leagueId.toLowerCase()) {
    return "LEAGUE_MATCH_ID_MISMATCH";
  }

  const kickoffDiffMinutes = Math.abs(dbKickoff.getTime() - payloadKickoff.getTime()) / 60000;
  if (kickoffDiffMinutes > 15) return "KICKOFF_MISMATCH_REJECTED";

  return null;
}

function signalToUniverseSignal(signal: OwnedSignal, source: string) {
  const ev = expectedValue(signal.model_probability, signal.market_odds, signal.expected_value);
  return {
    match_id: signal.match_id,
    league: normalizedLeague(signal),
    market: signal.market,
    selection: signal.selection,
    home_team: signal.home_team,
    away_team: signal.away_team,
    kickoff: signal.kickoff,
    odds_timestamp: signal.odds_timestamp,
    provider: signal.provider,
    market_odds: signal.market_odds,
    model_probability: signal.model_probability,
    expected_value: ev,
    raw_data: {
      ...signal.raw_data,
      owned_api: true,
      source,
      model_version: signal.model_version,
      source_confidence_score: signal.source_confidence_score,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };
}

function buildObservationPayload(
  signal: OwnedSignal,
  source: string,
  matchId: string,
  leagueId: string
) {
  const ev = expectedValue(signal.model_probability, signal.market_odds, signal.expected_value);
  const base = {
    provider: signal.provider,
    sport: "football",
    league_id: leagueId,
    match_id: matchId,
    source_confidence_score: signal.source_confidence_score,
    observed_at: signal.odds_timestamp,
    raw_data: {
      ...signal.raw_data,
      owned_api: true,
      source,
      model_version: signal.model_version,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };

  return [
    {
      ...base,
      data_type: "odds",
      observed_value: {
        market: signal.market,
        selection: signal.selection,
        market_odds: signal.market_odds,
        odds_timestamp: signal.odds_timestamp,
        provider: signal.provider
      }
    },
    {
      ...base,
      data_type: "model_signal",
      observed_value: {
        market: signal.market,
        selection: signal.selection,
        model_probability: signal.model_probability,
        expected_value: ev,
        model_version: signal.model_version
      }
    }
  ];
}

export async function processFootballOwnedSignals(db: Queryable, body: unknown) {
  const parsed = ownedRequestSchema.parse(body);
  const rejected = [];
  const accepted = [];

  for (let index = 0; index < parsed.signals.length; index += 1) {
    const signal = parsed.signals[index];
    if (containsPlaceholder(signal)) {
      rejected.push({ index, status: "REJECTED", reason: "PLACEHOLDER_DETECTED", match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }
    const timingBlock = assertSignalTiming(signal);
    if (timingBlock) {
      rejected.push({ index, status: "REJECTED", reason: timingBlock, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }
    const canonicalTimingBlock = await assertCanonicalMatchTiming(db, signal);
    if (canonicalTimingBlock) {
      rejected.push({ index, status: "REJECTED", reason: canonicalTimingBlock, match: `${signal.home_team} vs ${signal.away_team}` });
      continue;
    }
    accepted.push(signal);
  }

  if (accepted.length === 0) {
    return {
      system_status: "FOOTBALL_OWNED_SIGNALS",
      dry_run: parsed.dry_run,
      accepted: 0,
      rejected: rejected.length,
      inserted: 0,
      would_insert: 0,
      market_snapshots: 0,
      shadow_candidates: 0,
      duplicates: 0,
      blocked: rejected.length,
      observations_inserted: 0,
      consensus_built: 0,
      rows: rejected,
      guardrails: {
        shadow_paper_only: true,
        real_candidate_count: 0,
        real_money_enabled: false,
        kelly_enabled: false,
        telegram_auto_enabled: false
      }
    };
  }

  const universeResult = await processFootballTodayUniverse(db, {
    dry_run: parsed.dry_run,
    date: parsed.date,
    source: parsed.source,
    fixtures: [],
    signals: accepted.map((signal) => signalToUniverseSignal(signal, parsed.source))
  });

  let observationsInserted = 0;
  let consensusBuilt = 0;
  const observationRows = [];
  const consensusRows = [];

  if (!parsed.dry_run) {
    const signalRows = (universeResult.rows ?? []).filter((row: Record<string, unknown>) => row.type === "signal" && row.match_id && row.league_id);
    for (const row of signalRows) {
      const matchLabel = String(row.match ?? "");
      const signal = accepted.find((item) => `${item.home_team} vs ${item.away_team}` === matchLabel);
      if (!signal) continue;

      const observations = buildObservationPayload(signal, parsed.source, String(row.match_id), String(row.league_id));
      const recorded = await recordSourceObservations(db, { dry_run: false, observations });
      observationsInserted += Number(recorded.inserted ?? 0);
      observationRows.push(...recorded.rows);

      if (parsed.build_consensus) {
        const oddsConsensus = await buildConsensusForMatch(db, {
          dry_run: false,
          sport: "football",
          league_id: String(row.league_id),
          match_id: String(row.match_id),
          data_types: ["odds", "model_signal"]
        });
        consensusBuilt += oddsConsensus.rows.length;
        consensusRows.push(oddsConsensus);
      }
    }
  }

  return {
    system_status: "FOOTBALL_OWNED_SIGNALS",
    dry_run: parsed.dry_run,
    source: parsed.source,
    accepted: accepted.length,
    rejected: rejected.length,
    inserted: universeResult.signals_inserted ?? 0,
    would_insert: universeResult.signals_would_insert ?? 0,
    market_snapshots: universeResult.market_snapshots ?? 0,
    shadow_candidates: universeResult.shadow_candidates ?? 0,
    duplicates: universeResult.duplicates ?? 0,
    blocked: universeResult.blocked ?? 0,
    observations_inserted: observationsInserted,
    consensus_built: consensusBuilt,
    rows: [...rejected, ...(universeResult.rows ?? [])],
    observation_rows: observationRows.slice(0, 20),
    consensus_rows: consensusRows.slice(0, 20),
    guardrails: {
      shadow_paper_only: true,
      real_candidate_count: 0,
      real_money_enabled: false,
      kelly_enabled: false,
      telegram_auto_enabled: false
    }
  };
}
