import argparse
import json
import os

import psycopg


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


def _team_net_rating(conn, team_id: str, lookback_games: int) -> dict[str, float]:
    rows = conn.execute(
        """
        SELECT
          mc.score::float AS points_for,
          CASE mc.home_away
            WHEN 'home' THEN m.away_score::float
            ELSE m.home_score::float
          END AS points_against
        FROM match_competitors mc
        JOIN matches m ON m.id = mc.match_id
        WHERE mc.team_id = %s
          AND m.status = 'finished'
          AND mc.score IS NOT NULL
          AND m.home_score IS NOT NULL
          AND m.away_score IS NOT NULL
        ORDER BY m.match_date DESC
        LIMIT %s;
        """,
        (team_id, lookback_games),
    ).fetchall()

    if not rows:
        return {"net_rating": 0.0, "pace": 100.0, "games": 0}

    games = len(rows)
    points_for = sum(float(row[0]) for row in rows) / games
    points_against = sum(float(row[1]) for row in rows) / games
    # Until possessions exist, use score environment as a conservative pace proxy.
    pace = max(92.0, min(106.0, ((points_for + points_against) / 2.0) * 0.98))
    return {
        "net_rating": round(points_for - points_against, 4),
        "pace": round(pace, 4),
        "games": games,
    }


def fetch_nba_features(model_name: str, lookback_games: int, include_live: bool, dry_run: bool) -> int:
    statuses = ["scheduled", "live"] if include_live else ["scheduled"]
    processed = 0
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            """
            SELECT
              m.id,
              m.slug,
              home_mc.team_id,
              away_mc.team_id,
              home_team.name AS home_team_name,
              away_team.name AS away_team_name
            FROM matches m
            JOIN leagues l ON l.id = m.league_id
            JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
            JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
            JOIN teams home_team ON home_team.id = home_mc.team_id
            JOIN teams away_team ON away_team.id = away_mc.team_id
            WHERE l.slug = 'nba'
              AND m.status::text = ANY(%s)
            ORDER BY m.match_date ASC;
            """,
            (statuses,),
        ).fetchall()

        for row in rows:
            home = _team_net_rating(conn, str(row[2]), lookback_games)
            away = _team_net_rating(conn, str(row[3]), lookback_games)
            feature_set = {
                "home_team": row[4],
                "away_team": row[5],
                "home_net_rating": home["net_rating"],
                "away_net_rating": away["net_rating"],
                "home_games": home["games"],
                "away_games": away["games"],
                "pace": round((home["pace"] + away["pace"]) / 2.0, 4),
                "home_advantage": 2.5,
                "home_rest_days": 1,
                "away_rest_days": 1,
                "source": "hub_recent_results_proxy",
            }
            processed += 1
            print(
                "[NBA_FEATURE]",
                row[4],
                "vs",
                row[5],
                f"home_net={feature_set['home_net_rating']}",
                f"away_net={feature_set['away_net_rating']}",
            )
            if dry_run:
                continue
            conn.execute(
                """
                INSERT INTO model_features (match_id, sport_slug, model_name, feature_set)
                VALUES (%s, 'nba', %s, %s::jsonb);
                """,
                (row[0], model_name, json.dumps(feature_set)),
            )
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    return processed


def main() -> None:
    parser = argparse.ArgumentParser(description="Genera features NBA en model_features.")
    parser.add_argument("--model-name", default="carlos_v1_nba")
    parser.add_argument("--lookback-games", type=int, default=10)
    parser.add_argument("--include-live", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    count = fetch_nba_features(args.model_name, args.lookback_games, args.include_live, args.dry_run)
    print(f"[+] NBA features generadas={count} dry_run={args.dry_run}")


if __name__ == "__main__":
    main()
