import argparse
import csv
import os

import psycopg


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


def generate_template(output_path: str) -> int:
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            """
            SELECT
              pem.hub_match_id,
              pem.home_team_name,
              pem.away_team_name,
              pem.kickoff,
              pem.provider_name,
              pem.provider_event_id
            FROM provider_event_mappings pem
            JOIN matches m ON m.id = pem.hub_match_id
            WHERE pem.is_active = TRUE
              AND m.status IN ('scheduled', 'live')
            ORDER BY pem.kickoff ASC;
            """
        ).fetchall()

    with open(output_path, "w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(
            [
                "hub_match_id",
                "home_team",
                "away_team",
                "kickoff",
                "provider_name",
                "provider_event_id",
                "home_era",
                "home_whip",
                "home_ops",
                "home_bullpen_era",
                "away_era",
                "away_whip",
                "away_ops",
                "away_bullpen_era",
            ]
        )
        for row in rows:
            writer.writerow([*row, "", "", "", "", "", "", "", ""])
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="stats_input_template.csv")
    args = parser.parse_args()
    count = generate_template(args.output)
    print(f"[+] Plantilla generada: {args.output} filas={count}")


if __name__ == "__main__":
    main()
