import { db } from "../../db/index.js";

export class SnapshotService {
  async captureForMatch(matchId: string) {
    const target = await db.query(
      `
        SELECT m.id, m.match_date, mc.team_id, mc.home_away
        FROM v_valid_matches m
        JOIN match_competitors mc ON mc.match_id = m.id
        WHERE m.id = $1;
      `,
      [matchId]
    );

    if (!target.rows.length) {
      return [];
    }

    for (const competitor of target.rows) {
      const stats = await db.query(
        `
          SELECT
            COUNT(*)::int AS played,
            COUNT(*) FILTER (WHERE mc.score > opp.score)::int AS wins,
            COUNT(*) FILTER (WHERE mc.score = opp.score)::int AS draws,
            COUNT(*) FILTER (WHERE mc.score < opp.score)::int AS losses,
            COALESCE(SUM(mc.score), 0)::int AS points_for,
            COALESCE(SUM(opp.score), 0)::int AS points_against
          FROM match_competitors mc
          JOIN v_valid_matches prior ON prior.id = mc.match_id
          JOIN match_competitors opp ON opp.match_id = prior.id AND opp.team_id <> mc.team_id
          WHERE mc.team_id = $1
            AND prior.status = 'finished'
            AND prior.match_date < $2
            AND mc.score IS NOT NULL
            AND opp.score IS NOT NULL;
        `,
        [competitor.team_id, competitor.match_date]
      );

      const form = await db.query(
        `
          SELECT result
          FROM (
            SELECT
              CASE
                WHEN mc.score > opp.score THEN 'W'
                WHEN mc.score = opp.score THEN 'D'
                ELSE 'L'
              END AS result,
              prior.match_date
            FROM match_competitors mc
            JOIN v_valid_matches prior ON prior.id = mc.match_id
            JOIN match_competitors opp ON opp.match_id = prior.id AND opp.team_id <> mc.team_id
            WHERE mc.team_id = $1
              AND prior.status = 'finished'
              AND prior.match_date < $2
              AND mc.score IS NOT NULL
              AND opp.score IS NOT NULL
            ORDER BY prior.match_date DESC
            LIMIT 5
          ) recent;
        `,
        [competitor.team_id, competitor.match_date]
      );

      const row = stats.rows[0];
      await db.query(
        `
          INSERT INTO team_stat_snapshots (
            match_id, team_id, home_away, snapshot_at, played, wins, draws, losses,
            points_for, points_against, form
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
          ON CONFLICT (match_id, team_id) DO UPDATE SET
            home_away = EXCLUDED.home_away,
            snapshot_at = EXCLUDED.snapshot_at,
            played = EXCLUDED.played,
            wins = EXCLUDED.wins,
            draws = EXCLUDED.draws,
            losses = EXCLUDED.losses,
            points_for = EXCLUDED.points_for,
            points_against = EXCLUDED.points_against,
            form = EXCLUDED.form;
        `,
        [
          matchId,
          competitor.team_id,
          competitor.home_away,
          competitor.match_date,
          row.played,
          row.wins,
          row.draws,
          row.losses,
          row.points_for,
          row.points_against,
          JSON.stringify(form.rows.map((item) => item.result))
        ]
      );
    }

    return this.getForMatch(matchId);
  }

  async getForMatch(matchId: string) {
    const result = await db.query(
      `
        SELECT
          snapshot.*,
          t.slug AS team_slug,
          t.name AS team_name
        FROM team_stat_snapshots snapshot
        JOIN teams t ON t.id = snapshot.team_id
        WHERE snapshot.match_id = $1
        ORDER BY CASE snapshot.home_away WHEN 'home' THEN 0 ELSE 1 END;
      `,
      [matchId]
    );
    return result.rows;
  }

  async backfill(limit = 500) {
    const matches = await db.query(
      `
        SELECT id
        FROM v_valid_matches
        ORDER BY match_date ASC
        LIMIT $1;
      `,
      [limit]
    );

    for (const match of matches.rows) {
      await this.captureForMatch(match.id);
    }

    return { processed: matches.rowCount ?? matches.rows.length };
  }
}
