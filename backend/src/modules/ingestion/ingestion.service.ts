import { db } from "../../db/index.js";
import { redis } from "../../cache/redis.js";
import { liveMatchChannel, liveMatchKey, liveMatchUpdatesChannel, LiveMatchState } from "../live/live.service.js";
import { normalizeAlias } from "../../normalization/aliases.js";
import { BatchMatchInput } from "./ingestion.schemas.js";
import { PaperTradeService } from "../paper-trades/paper-trade.service.js";
import { SnapshotService } from "../matches/snapshot.service.js";

type IngestionResult = {
  processed: number;
  created: number;
  updated: number;
  errors: number;
  warnings: Array<{
    source_match_id: string;
    message: string;
  }>;
};

type LiveLifecycleAction = {
  matchId: string;
  match: BatchMatchInput;
};

type KnownTeamAliasFix = {
  sourceSlug: string;
  normalizedAliases: string[];
  leagueSlug: string;
  teamSlug: string;
  name: string;
  shortName: string;
  abbreviation: string;
};

const KNOWN_TEAM_ALIAS_FIXES: KnownTeamAliasFix[] = [
  {
    sourceSlug: "espn-la-liga",
    normalizedAliases: ["alaves", "deportivo alaves"],
    leagueSlug: "la-liga",
    teamSlug: "deportivo-alaves",
    name: "Deportivo Alaves",
    shortName: "Alaves",
    abbreviation: "ALA"
  },
  {
    sourceSlug: "espn-la-liga",
    normalizedAliases: ["rayo vallecano", "rayo", "rayo v", "vallecano"],
    leagueSlug: "la-liga",
    teamSlug: "rayo-vallecano",
    name: "Rayo Vallecano",
    shortName: "Rayo",
    abbreviation: "RAY"
  }
];

export class IngestionService {
  private readonly paperTrades = new PaperTradeService();
  private readonly snapshots = new SnapshotService();

  async ingestBatch(matches: BatchMatchInput[]): Promise<IngestionResult> {
    const result: IngestionResult = {
      processed: 0,
      created: 0,
      updated: 0,
      errors: 0,
      warnings: []
    };

    const client = await db.connect();
    const liveActions: LiveLifecycleAction[] = [];

    try {
      await client.query("BEGIN");

      const sourceSlug = matches[0]?.source_slug ?? "unknown";
      const source = await client.query("SELECT id FROM data_sources WHERE slug = $1", [sourceSlug]);
      if (!source.rows[0]) {
        throw new Error(`Unknown data source: ${sourceSlug}`);
      }

      const sourceId = source.rows[0].id as string;
      const run = await client.query(
        `
          INSERT INTO scrape_runs (source_id, run_type, status, metadata)
          VALUES ($1, 'batch-api', 'running', $2)
          RETURNING id;
        `,
        [sourceId, { started_by: "fastify-ingestion" }]
      );
      const runId = run.rows[0].id as string;

      for (const match of matches) {
        result.processed += 1;

        try {
          const homeTeamId = await this.resolveTeamId(client, match.source_slug, match.home_alias);
          const awayTeamId = await this.resolveTeamId(client, match.source_slug, match.away_alias);

          const league = await client.query(
            `
              SELECT l.id, s.id AS season_id
              FROM leagues l
              LEFT JOIN seasons s ON s.league_id = l.id AND s.is_current = TRUE
              WHERE l.slug = $1;
            `,
            [match.league_slug]
          );

          if (!league.rows[0]) {
            throw new Error(`Unknown league: ${match.league_slug}`);
          }

          const existingMatchId = await this.findExistingLogicalMatch(
            client,
            league.rows[0].id,
            homeTeamId,
            awayTeamId,
            match.match_date
          );
          const existingSlug = existingMatchId
            ? await this.getMatchSlug(client, existingMatchId)
            : null;
          const slug = existingSlug ?? `${match.match_date.slice(0, 10)}-${match.source_match_id}`;
          const savedMatch = await client.query(
            `
              INSERT INTO matches (
                league_id, season_id, slug, match_date, status, period, home_score, away_score,
                home_odds, away_odds, odds_source, raw_data
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
              ON CONFLICT (slug) DO UPDATE SET
                status = EXCLUDED.status,
                period = EXCLUDED.period,
                home_score = EXCLUDED.home_score,
                away_score = EXCLUDED.away_score,
                home_odds = COALESCE(EXCLUDED.home_odds, matches.home_odds),
                away_odds = COALESCE(EXCLUDED.away_odds, matches.away_odds),
                odds_source = COALESCE(EXCLUDED.odds_source, matches.odds_source),
                raw_data = EXCLUDED.raw_data
              RETURNING id, (xmax = 0) AS inserted;
            `,
            [
              league.rows[0].id,
              league.rows[0].season_id,
              slug,
              match.match_date,
              match.status,
              match.period ?? null,
              match.home_score ?? null,
              match.away_score ?? null,
              match.home_odds ?? null,
              match.away_odds ?? null,
              match.odds_source ?? null,
              match.raw_data ?? match
            ]
          );

          const matchId = savedMatch.rows[0].id as string;
          if (savedMatch.rows[0].inserted) {
            result.created += 1;
          } else {
            result.updated += 1;
          }

          await this.upsertCompetitor(client, matchId, homeTeamId, "home", match.home_score ?? null);
          await this.upsertCompetitor(client, matchId, awayTeamId, "away", match.away_score ?? null);
          if (match.status === "finished" && match.home_score !== null && match.home_score !== undefined && match.away_score !== null && match.away_score !== undefined) {
            await client.query(
              `
                UPDATE match_competitors
                SET winner = CASE
                  WHEN home_away = 'home' THEN $2 > $3
                  WHEN home_away = 'away' THEN $3 > $2
                  ELSE FALSE
                END
                WHERE match_id = $1;
              `,
              [matchId, match.home_score, match.away_score]
            );
          }

          await client.query(
            `
              INSERT INTO source_match_refs (source_id, match_id, source_match_id, raw_data)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (source_id, source_match_id) DO UPDATE SET
                match_id = EXCLUDED.match_id,
                raw_data = EXCLUDED.raw_data;
            `,
            [sourceId, matchId, match.source_match_id, match.raw_data ?? match]
          );

          if (match.source_match_id.startsWith("mlb-statsapi-")) {
            await client.query(
              `
                INSERT INTO provider_event_mappings (
                  hub_match_id, provider_name, provider_event_id,
                  home_team_name, away_team_name, kickoff,
                  is_active, last_verified, raw_data
                )
                VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), $7)
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
                matchId,
                "mlb_stats_api",
                match.source_match_id,
                match.home_alias,
                match.away_alias,
                match.match_date,
                match.raw_data ?? match
              ]
            );
          }

          liveActions.push({ matchId, match });
        } catch (error) {
          result.errors += 1;
          const message = error instanceof Error ? error.message : "Unknown ingestion error";
          result.warnings.push({
            source_match_id: match.source_match_id,
            message
          });

          await client.query(
            `
              INSERT INTO scrape_errors (scrape_run_id, source_id, message, context)
              VALUES ($1, $2, $3, $4);
            `,
            [runId, sourceId, message, match]
          );
        }
      }

      await client.query(
        `
          UPDATE scrape_runs
          SET status = $1,
              finished_at = NOW(),
              processed_count = $2,
              created_count = $3,
              updated_count = $4,
              error_count = $5
          WHERE id = $6;
        `,
        [
          result.errors ? "completed_with_errors" : "completed",
          result.processed,
          result.created,
          result.updated,
          result.errors,
          runId
        ]
      );

      await client.query("COMMIT");

      await Promise.all(liveActions.map((action) => this.syncLiveLifecycle(action.matchId, action.match)));
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async syncLiveLifecycle(matchId: string, match: BatchMatchInput) {
    await this.snapshots.captureForMatch(matchId);

    if (match.status === "finished") {
      const state: LiveMatchState = {
        match_id: matchId,
        status: "finished",
        period: match.period ?? null,
        clock: null,
        home_score: match.home_score ?? null,
        away_score: match.away_score ?? null,
        home_odds: match.home_odds ?? null,
        away_odds: match.away_odds ?? null,
        odds_source: match.odds_source ?? null,
        updated_at: new Date().toISOString(),
        payload: {
          source_slug: match.source_slug,
          source_match_id: match.source_match_id,
          event: "match_finished"
        }
      };
      const payload = JSON.stringify(state);

      const deleted = await redis.del(liveMatchKey(matchId));

      if (deleted > 0) {
        await Promise.all([
          redis.publish(liveMatchChannel(matchId), payload),
          redis.publish(liveMatchUpdatesChannel(matchId), payload)
        ]);
        console.log(`[CACHE] Match ${matchId} finished. Removed ${liveMatchKey(matchId)} from Redis.`);
      }
      await this.paperTrades.settlePaperTrades(matchId, {
        home_score: match.home_score,
        away_score: match.away_score
      });
      return;
    }

    if (match.status !== "live") {
      return;
    }

    const state: LiveMatchState = {
      match_id: matchId,
      status: "live",
      period: match.period ?? null,
      clock: null,
      home_score: match.home_score ?? null,
      away_score: match.away_score ?? null,
      home_odds: match.home_odds ?? null,
      away_odds: match.away_odds ?? null,
      odds_source: match.odds_source ?? null,
      updated_at: new Date().toISOString(),
      payload: {
        source_slug: match.source_slug,
        source_match_id: match.source_match_id
      }
    };
    const payload = JSON.stringify(state);

    await Promise.all([
      redis.set(liveMatchKey(matchId), payload, "EX", 60 * 60 * 8),
      redis.publish(liveMatchChannel(matchId), payload),
      redis.publish(liveMatchUpdatesChannel(matchId), payload)
    ]);
  }

  private async resolveTeamId(client: { query: typeof db.query }, sourceSlug: string, alias: string) {
    const normalizedAlias = normalizeAlias(alias);
    const team = await client.query(
      `
        SELECT sta.team_id
        FROM source_team_aliases sta
        JOIN data_sources ds ON ds.id = sta.source_id
        WHERE ds.slug = $1 AND sta.normalized_alias = $2;
      `,
      [sourceSlug, normalizedAlias]
    );

    if (!team.rows[0]) {
      const repairedTeamId = await this.ensureKnownTeamAlias(client, sourceSlug, alias, normalizedAlias);
      if (repairedTeamId) return repairedTeamId;
      throw new Error(`Alias no reconocido: ${alias}`);
    }

    return team.rows[0].team_id as string;
  }

  private async ensureKnownTeamAlias(client: { query: typeof db.query }, sourceSlug: string, alias: string, normalizedAlias: string) {
    const fix = KNOWN_TEAM_ALIAS_FIXES.find((item) => item.sourceSlug === sourceSlug && item.normalizedAliases.includes(normalizedAlias));
    if (!fix) return null;

    const team = await client.query(
      `
        INSERT INTO teams (league_id, slug, name, short_name, abbreviation, raw_data)
        SELECT l.id, $2, $3, $4, $5, $6::jsonb
        FROM leagues l
        WHERE l.slug = $1
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name,
          short_name = EXCLUDED.short_name,
          abbreviation = EXCLUDED.abbreviation,
          raw_data = COALESCE(teams.raw_data, '{}'::jsonb) || EXCLUDED.raw_data,
          updated_at = now()
        RETURNING id;
      `,
      [
        fix.leagueSlug,
        fix.teamSlug,
        fix.name,
        fix.shortName,
        fix.abbreviation,
        {
          source: "known_team_alias_fix",
          source_slug: sourceSlug,
          aliases: fix.normalizedAliases
        }
      ]
    );
    const teamId = team.rows[0]?.id as string | undefined;
    if (!teamId) return null;

    await client.query(
      `
        INSERT INTO source_team_aliases (source_id, team_id, alias, normalized_alias)
        SELECT ds.id, $2, $3, $4
        FROM data_sources ds
        WHERE ds.slug = $1
        ON CONFLICT (source_id, normalized_alias) DO UPDATE SET
          team_id = EXCLUDED.team_id,
          alias = EXCLUDED.alias;
      `,
      [sourceSlug, teamId, alias, normalizedAlias]
    );

    return teamId;
  }

  private async getMatchSlug(client: { query: typeof db.query }, matchId: string) {
    const match = await client.query("SELECT slug FROM matches WHERE id = $1", [matchId]);
    return match.rows[0]?.slug as string | null;
  }

  private async findExistingLogicalMatch(
    client: { query: typeof db.query },
    leagueId: string,
    homeTeamId: string,
    awayTeamId: string,
    matchDate: string
  ) {
    const existing = await client.query(
      `
        SELECT m.id
        FROM matches m
        JOIN match_competitors home_comp
          ON home_comp.match_id = m.id
         AND home_comp.home_away = 'home'
         AND home_comp.team_id = $2
        JOIN match_competitors away_comp
          ON away_comp.match_id = m.id
         AND away_comp.home_away = 'away'
         AND away_comp.team_id = $3
        WHERE m.league_id = $1
          AND m.status IN ('scheduled', 'live')
          AND m.match_date::date = $4::timestamptz::date
        ORDER BY
          CASE WHEN m.status = 'live' THEN 0 ELSE 1 END,
          ABS(EXTRACT(EPOCH FROM (m.match_date - $4::timestamptz))) ASC,
          m.updated_at DESC
        LIMIT 1;
      `,
      [leagueId, homeTeamId, awayTeamId, matchDate]
    );

    return existing.rows[0]?.id as string | null;
  }

  private async upsertCompetitor(
    client: { query: typeof db.query },
    matchId: string,
    teamId: string,
    homeAway: "home" | "away",
    score: number | null
  ) {
    await client.query(
      `
        INSERT INTO match_competitors (match_id, team_id, home_away, score)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (match_id, team_id) DO UPDATE SET
          score = EXCLUDED.score,
          home_away = EXCLUDED.home_away;
      `,
      [matchId, teamId, homeAway, score]
    );
  }
}
