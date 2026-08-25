import { db } from "../../db/index.js";
import { redis } from "../../cache/redis.js";
import { liveMatchKey, LiveMatchState } from "../live/live.service.js";
import { AppError } from "../../shared/http-errors.js";
import { ListMatchesQuery } from "./match.schemas.js";

export class MatchRepository {
  async list(query: ListMatchesQuery) {
    const values: Array<string | number> = [];
    const filters: string[] = [];

    if (query.date) {
      values.push(query.date);
      filters.push(`(
        m.match_date::date = $${values.length}::date
        OR LEFT(m.raw_data->>'match_date', 10) = $${values.length}::text
      )`);
    }

    if (query.league) {
      values.push(query.league);
      filters.push(`l.slug = $${values.length}`);
    }

    if (query.status) {
      values.push(query.status);
      filters.push(`m.status = $${values.length}`);
    }

    if (query.team) {
      values.push(query.team);
      filters.push(`EXISTS (
        SELECT 1
        FROM match_competitors mc
        JOIN teams t ON t.id = mc.team_id
        WHERE mc.match_id = m.id
          AND (t.slug = $${values.length} OR t.abbreviation ILIKE $${values.length})
      )`);
    }

    values.push(query.limit);
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const result = await db.query(
      `
        SELECT
          m.id,
          m.slug,
          m.match_date,
          m.status,
          m.period,
          m.clock,
          m.home_score,
          m.away_score,
          m.home_odds,
          m.away_odds,
          m.odds_source,
          l.slug AS league_slug,
          s.slug AS sport_slug,
          jsonb_agg(
            jsonb_build_object(
              'team_id', t.id,
              'team_slug', t.slug,
              'team_name', t.name,
              'abbreviation', t.abbreviation,
              'home_away', mc.home_away,
              'score', mc.score,
              'winner', mc.winner
            )
            ORDER BY CASE mc.home_away WHEN 'away' THEN 0 ELSE 1 END
          ) AS competitors
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        JOIN sports s ON s.id = l.sport_id
        JOIN match_competitors mc ON mc.match_id = m.id
        JOIN teams t ON t.id = mc.team_id
        ${where}
        GROUP BY m.id, l.slug, s.slug
        ORDER BY m.match_date ASC
        LIMIT $${values.length};
      `,
      values
    );

    return Promise.all(result.rows.map((match) => this.withLiveOverlay(match)));
  }

  async getById(id: string) {
    const result = await db.query(
      `
        SELECT
          m.*,
          l.slug AS league_slug,
          s.slug AS sport_slug,
          v.name AS venue_name,
          COALESCE(ms.home_stats, '{}'::jsonb) AS home_stats,
          COALESCE(ms.away_stats, '{}'::jsonb) AS away_stats,
          jsonb_agg(
            jsonb_build_object(
              'team_id', t.id,
              'team_slug', t.slug,
              'team_name', t.name,
              'abbreviation', t.abbreviation,
              'home_away', mc.home_away,
              'score', mc.score,
              'winner', mc.winner,
              'stats', mc.stats
            )
            ORDER BY CASE mc.home_away WHEN 'away' THEN 0 ELSE 1 END
          ) AS competitors
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        JOIN sports s ON s.id = l.sport_id
        LEFT JOIN venues v ON v.id = m.venue_id
        LEFT JOIN match_statistics ms ON ms.match_id = m.id
        JOIN match_competitors mc ON mc.match_id = m.id
        JOIN teams t ON t.id = mc.team_id
        WHERE m.id = $1
        GROUP BY m.id, l.slug, s.slug, v.name, ms.home_stats, ms.away_stats;
      `,
      [id]
    );

    const match = result.rows[0];
    if (!match) {
      throw new AppError(404, "Partido no encontrado");
    }

    return this.withLiveOverlay(match);
  }

  async getTeamStats(teamId: string) {
    const result = await db.query(
      `
        SELECT
          t.id,
          t.slug,
          t.name,
          COUNT(mc.id)::int AS matches_played,
          COUNT(*) FILTER (WHERE mc.winner = TRUE)::int AS wins,
          COUNT(*) FILTER (WHERE mc.winner = FALSE AND m.status = 'finished')::int AS losses,
          COALESCE(SUM(mc.score), 0)::int AS points_for,
          COALESCE(SUM(
            CASE mc.home_away
              WHEN 'home' THEN m.away_score
              ELSE m.home_score
            END
          ), 0)::int AS points_against
        FROM teams t
        LEFT JOIN match_competitors mc ON mc.team_id = t.id
        LEFT JOIN v_valid_matches m ON m.id = mc.match_id AND m.status = 'finished'
        WHERE t.id = $1
        GROUP BY t.id;
      `,
      [teamId]
    );

    const stats = result.rows[0];
    if (!stats) {
      throw new AppError(404, "Equipo no encontrado");
    }

    return stats;
  }

  async getLeagueTable(leagueSlug: string) {
    const result = await db.query(
      `
        WITH finished_rows AS (
          SELECT
            mc.team_id,
            COUNT(*)::int AS played,
            COUNT(*) FILTER (WHERE mc.score > opp.score)::int AS wins,
            COUNT(*) FILTER (WHERE mc.score = opp.score)::int AS draws,
            COUNT(*) FILTER (WHERE mc.score < opp.score)::int AS losses,
            COALESCE(SUM(mc.score), 0)::int AS goals_for,
            COALESCE(SUM(opp.score), 0)::int AS goals_against,
            COALESCE(SUM(
              CASE
                WHEN mc.score > opp.score THEN 3
                WHEN mc.score = opp.score THEN 1
                ELSE 0
              END
            ), 0)::int AS points
          FROM v_valid_matches m
          JOIN leagues l ON l.id = m.league_id
          JOIN match_competitors mc ON mc.match_id = m.id
          JOIN match_competitors opp ON opp.match_id = m.id AND opp.team_id <> mc.team_id
          WHERE l.slug = $1
            AND m.status = 'finished'
            AND mc.score IS NOT NULL
            AND opp.score IS NOT NULL
          GROUP BY mc.team_id
        )
        SELECT
          t.id,
          t.slug,
          t.name,
          t.abbreviation,
          COALESCE(fr.played, 0)::int AS played,
          COALESCE(fr.wins, 0)::int AS wins,
          COALESCE(fr.draws, 0)::int AS draws,
          COALESCE(fr.losses, 0)::int AS losses,
          COALESCE(fr.goals_for, 0)::int AS goals_for,
          COALESCE(fr.goals_against, 0)::int AS goals_against,
          COALESCE(fr.goals_for, 0)::int - COALESCE(fr.goals_against, 0)::int AS goal_difference,
          COALESCE(fr.points, 0)::int AS points
        FROM teams t
        JOIN leagues l ON l.id = t.league_id
        LEFT JOIN finished_rows fr ON fr.team_id = t.id
        WHERE l.slug = $1
        ORDER BY points DESC, goal_difference DESC, goals_for DESC, t.name ASC;
      `,
      [leagueSlug]
    );

    return result.rows.map((row, index) => ({
      position: index + 1,
      ...row
    }));
  }

  async getTeamForm(teamSlug: string) {
    const result = await db.query(
      `
        SELECT
          m.id AS match_id,
          m.match_date,
          l.slug AS league_slug,
          mc.score AS team_score,
          opp.score AS opponent_score,
          t.slug AS team_slug,
          t.name AS team_name,
          ot.slug AS opponent_slug,
          ot.name AS opponent_name,
          CASE
            WHEN mc.score > opp.score THEN 'W'
            WHEN mc.score = opp.score THEN 'D'
            ELSE 'L'
          END AS result
        FROM teams t
        JOIN match_competitors mc ON mc.team_id = t.id
        JOIN v_valid_matches m ON m.id = mc.match_id
        JOIN leagues l ON l.id = m.league_id
        JOIN match_competitors opp ON opp.match_id = m.id AND opp.team_id <> t.id
        JOIN teams ot ON ot.id = opp.team_id
        WHERE t.slug = $1
          AND m.status = 'finished'
          AND mc.score IS NOT NULL
          AND opp.score IS NOT NULL
        ORDER BY m.match_date DESC
        LIMIT 5;
      `,
      [teamSlug]
    );

    if (!result.rows.length) {
      const team = await db.query("SELECT id, slug, name FROM teams WHERE slug = $1", [teamSlug]);
      if (!team.rows[0]) {
        throw new AppError(404, "Equipo no encontrado");
      }
    }

    return {
      team_slug: teamSlug,
      form: result.rows.map((row) => row.result),
      matches: result.rows
    };
  }

  private async withLiveOverlay(match: Record<string, unknown>) {
    const raw = await redis.get(liveMatchKey(match.id as string));
    if (!raw) {
      return {
        ...match,
        source: "postgres_historical"
      };
    }

    const live = JSON.parse(raw) as LiveMatchState;
    return {
      ...match,
      status: live.status,
      period: live.period ?? match.period,
      clock: live.clock ?? match.clock,
      home_score: live.home_score ?? match.home_score,
      away_score: live.away_score ?? match.away_score,
      home_odds: live.home_odds ?? match.home_odds,
      away_odds: live.away_odds ?? match.away_odds,
      odds_source: live.odds_source ?? match.odds_source,
      source: "redis_live"
    };
  }
}
