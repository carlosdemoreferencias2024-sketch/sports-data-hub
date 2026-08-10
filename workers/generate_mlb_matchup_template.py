import argparse
import csv
import os

import psycopg


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


OUTPUT_COLUMNS = [
    "hub_match_id",
    "model_name",
    "home_team",
    "away_team",
    "kickoff",
    "bookmaker",
    "pick",
    "entry_odds",
    "model_probability",
    "expected_value",
    "probable_pitcher_home",
    "probable_pitcher_away",
    "home_era",
    "home_whip",
    "home_ops",
    "home_bullpen_era",
    "home_lineup_confirmed",
    "home_rest_days",
    "home_travel_distance",
    "away_era",
    "away_whip",
    "away_ops",
    "away_bullpen_era",
    "away_lineup_confirmed",
    "away_rest_days",
    "away_travel_distance",
    "source",
    "source_url",
    "verified_at",
]


def generate_template(output_path: str) -> int:
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            """
            WITH active_snapshots AS (
              SELECT DISTINCT ON (rps.match_id)
                rps.match_id,
                rps.model_name,
                rps.bookmaker,
                rps.pick,
                rps.entry_odds,
                rps.model_probability,
                rps.expected_value
              FROM real_paper_snapshots rps
              WHERE rps.sport_slug = 'baseball'
                AND rps.league_slug = 'mlb'
                AND rps.market_type = 'moneyline_2way'
                AND rps.status IN ('OPEN', 'PENDING_CLOSING', 'PENDING_RESULT', 'PENDING_RESULTS')
              ORDER BY rps.match_id, rps.expected_value DESC NULLS LAST, rps.entry_timestamp DESC NULLS LAST
            )
            SELECT
              m.id AS hub_match_id,
              COALESCE(active_snapshots.model_name, 'carlos_v1_mlb') AS model_name,
              home_team.name AS home_team,
              away_team.name AS away_team,
              COALESCE(pem.kickoff, m.match_date) AS kickoff,
              active_snapshots.bookmaker,
              active_snapshots.pick,
              active_snapshots.entry_odds,
              active_snapshots.model_probability,
              active_snapshots.expected_value
            FROM matches m
            JOIN leagues l ON l.id = m.league_id
            LEFT JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
            LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
            LEFT JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
            LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
            LEFT JOIN active_snapshots ON active_snapshots.match_id = m.id
            LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = m.id AND pem.is_active = TRUE
            WHERE l.slug = 'mlb'
              AND m.status IN ('scheduled', 'live')
              AND COALESCE(pem.kickoff, m.match_date) >= NOW() - INTERVAL '12 hours'
            ORDER BY COALESCE(pem.kickoff, m.match_date) ASC, home_team.name, away_team.name;
            """
        ).fetchall()

    with open(output_path, "w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        for row in rows:
            record = dict(zip(OUTPUT_COLUMNS[:10], row))
            record.update({column: "" for column in OUTPUT_COLUMNS[10:]})
            writer.writerow(record)
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate an MLB matchup feature template for open Real Paper picks.")
    parser.add_argument("--output", default="mlb_matchup_features_template.csv")
    args = parser.parse_args()
    count = generate_template(args.output)
    print(f"[+] MLB matchup template generated: {args.output} rows={count}")


if __name__ == "__main__":
    main()
