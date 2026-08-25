import argparse
import json
import os

import psycopg


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


def _league_averages(conn, league_slug: str) -> dict[str, float]:
    row = conn.execute(
        """
        SELECT
          AVG(home_score)::float AS avg_home_goals,
          AVG(away_score)::float AS avg_away_goals,
          AVG(CASE WHEN home_score = away_score THEN 1.0 ELSE 0.0 END)::float AS draw_rate
        FROM v_valid_matches m
        JOIN leagues l ON l.id = m.league_id
        WHERE l.slug = %s
          AND m.status = 'finished'
          AND m.home_score IS NOT NULL
          AND m.away_score IS NOT NULL;
        """,
        (league_slug,),
    ).fetchone()
    return {
        "avg_home_goals": float(row[0] or 1.35),
        "avg_away_goals": float(row[1] or 1.10),
        "draw_rate": float(row[2] or 0.27),
    }


def _team_profile(conn, team_id: str, league_slug: str, lookback_games: int, league: dict[str, float]) -> dict[str, float]:
    rows = conn.execute(
        """
        SELECT
          mc.score::float AS goals_for,
          CASE mc.home_away
            WHEN 'home' THEN m.away_score::float
            ELSE m.home_score::float
          END AS goals_against
        FROM match_competitors mc
        JOIN v_valid_matches m ON m.id = mc.match_id
        JOIN leagues l ON l.id = m.league_id
        WHERE l.slug = %s
          AND mc.team_id = %s
          AND m.status = 'finished'
          AND mc.score IS NOT NULL
          AND m.home_score IS NOT NULL
          AND m.away_score IS NOT NULL
        ORDER BY m.match_date DESC
        LIMIT %s;
        """,
        (league_slug, team_id, lookback_games),
    ).fetchall()

    if not rows:
        return {
            "games": 0,
            "goals_for": (league["avg_home_goals"] + league["avg_away_goals"]) / 2.0,
            "goals_against": (league["avg_home_goals"] + league["avg_away_goals"]) / 2.0,
        }

    games = len(rows)
    return {
        "games": games,
        "goals_for": sum(float(row[0]) for row in rows) / games,
        "goals_against": sum(float(row[1]) for row in rows) / games,
    }


def fetch_football_features(model_name: str, league_slug: str, lookback_games: int, include_live: bool, dry_run: bool) -> int:
    statuses = ["scheduled", "live"] if include_live else ["scheduled"]
    processed = 0
    with psycopg.connect(DATABASE_URL) as conn:
        league = _league_averages(conn, league_slug)
        draw_coefficient = 1.0 + max(0.0, min(0.18, league["draw_rate"] - 0.24))
        rows = conn.execute(
            """
            WITH candidate_matches AS (
            SELECT
              m.id,
              m.slug,
              home_mc.team_id AS home_team_id,
              away_mc.team_id AS away_team_id,
              home_team.name AS home_team_name,
              away_team.name AS away_team_name,
              ROW_NUMBER() OVER (
                PARTITION BY l.slug, home_mc.team_id, away_mc.team_id
                ORDER BY
                  CASE WHEN m.status = 'live' THEN 0 ELSE 1 END,
                  m.match_date DESC,
                  m.updated_at DESC
              ) AS logical_rank
            FROM v_valid_matches m
            JOIN leagues l ON l.id = m.league_id
            JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
            JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
            JOIN teams home_team ON home_team.id = home_mc.team_id
            JOIN teams away_team ON away_team.id = away_mc.team_id
            WHERE l.slug = %s
              AND m.status::text = ANY(%s)
            )
            SELECT id, slug, home_team_id, away_team_id, home_team_name, away_team_name
            FROM candidate_matches
            WHERE logical_rank = 1
            ORDER BY home_team_name, away_team_name;
            """,
            (league_slug, statuses),
        ).fetchall()

        league_goal_base = max(0.35, (league["avg_home_goals"] + league["avg_away_goals"]) / 2.0)
        for row in rows:
            home = _team_profile(conn, str(row[2]), league_slug, lookback_games, league)
            away = _team_profile(conn, str(row[3]), league_slug, lookback_games, league)
            feature_set = {
                "home_team": row[4],
                "away_team": row[5],
                "league_slug": league_slug,
                "league_avg_home_goals": round(league["avg_home_goals"], 4),
                "league_avg_away_goals": round(league["avg_away_goals"], 4),
                "league_draw_rate": round(league["draw_rate"], 4),
                "home_attack_strength": round(home["goals_for"] / league_goal_base, 4),
                "home_defense_weakness": round(home["goals_against"] / league_goal_base, 4),
                "away_attack_strength": round(away["goals_for"] / league_goal_base, 4),
                "away_defense_weakness": round(away["goals_against"] / league_goal_base, 4),
                "home_games": home["games"],
                "away_games": away["games"],
                "home_advantage": 1.07,
                "draw_coefficient": round(draw_coefficient, 4),
                "max_goals": 7,
                "source": "hub_recent_results_poisson",
            }
            processed += 1
            print(
                "[FOOTBALL_FEATURE]",
                row[4],
                "vs",
                row[5],
                f"home_attack={feature_set['home_attack_strength']}",
                f"away_attack={feature_set['away_attack_strength']}",
            )
            if dry_run:
                continue
            conn.execute(
                """
                INSERT INTO model_features (match_id, sport_slug, model_name, feature_set)
                VALUES (%s, 'football', %s, %s::jsonb);
                """,
                (row[0], model_name, json.dumps(feature_set)),
            )
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    return processed


def main() -> None:
    parser = argparse.ArgumentParser(description="Genera features futbol en model_features.")
    parser.add_argument("--model-name", default="carlos_v1_football")
    parser.add_argument("--league-slug", default="liga-mx")
    parser.add_argument("--lookback-games", type=int, default=10)
    parser.add_argument("--include-live", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    count = fetch_football_features(args.model_name, args.league_slug, args.lookback_games, args.include_live, args.dry_run)
    print(f"[+] Football features generadas={count} dry_run={args.dry_run}")


if __name__ == "__main__":
    main()
