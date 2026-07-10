import argparse
import csv
import json
import os

import psycopg

from fair_odds_engine import calculate_from_row


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


def _has_required_stats(row: dict[str, str]) -> bool:
    required = ("hub_match_id", "home_era", "home_whip", "away_era", "away_whip")
    return all(str(row.get(key) or "").strip() for key in required)


def _moneyline_raw_data(row: dict[str, str]) -> str:
    return json.dumps({"input": row, "engine": "fair_odds_engine_v1"})


def _total_runs_raw_data(row: dict[str, str], total_runs: dict[str, float]) -> str:
    return json.dumps(
        {
            "input": row,
            "engine": "fair_odds_engine_v1",
            "selection_map": {"home": "over", "away": "under"},
            "projected_home_runs": total_runs.get("projected_home_runs"),
            "projected_away_runs": total_runs.get("projected_away_runs"),
            "projected_total_runs": total_runs.get("projected_total_runs"),
        }
    )


def _run_line_raw_data(row: dict[str, str], run_line: dict[str, float], disabled_selection: str) -> str:
    return json.dumps(
        {
            "input": row,
            "engine": "fair_odds_engine_v1",
            "selection_map": {"home": "home", "away": "away"},
            "disabled_selections": [disabled_selection],
            "projected_margin": run_line.get("projected_margin"),
        }
    )


def ingest_csv(input_path: str, model_name: str, dry_run: bool) -> tuple[int, int]:
    processed = 0
    skipped = 0
    with psycopg.connect(DATABASE_URL) as conn:
        with open(input_path, newline="", encoding="utf-8") as file:
            for row in csv.DictReader(file):
                if not _has_required_stats(row):
                    skipped += 1
                    continue
                odds = calculate_from_row(row)
                processed += 1
                print(
                    "[MODEL_QUOTE]",
                    row.get("home_team"),
                    "vs",
                    row.get("away_team"),
                    f"home={odds['home_fair_odds']}",
                    f"away={odds['away_fair_odds']}",
                    f"confidence={odds['confidence']}",
                )
                if dry_run:
                    continue
                conn.execute(
                    """
                    INSERT INTO model_quotes (
                      match_id, model_name, market_type,
                      home_probability, away_probability,
                      home_fair_odds, away_fair_odds,
                      confidence, raw_data
                    )
                    VALUES (%s, %s, 'moneyline_2way', %s, %s, %s, %s, %s, %s::jsonb);
                    """,
                    (
                        row["hub_match_id"],
                        model_name,
                        odds["home_probability"],
                        odds["away_probability"],
                        odds["home_fair_odds"],
                        odds["away_fair_odds"],
                        odds["confidence"],
                        _moneyline_raw_data(row),
                    ),
                )
                total_runs = odds.get("markets", {}).get("total_runs")
                if total_runs:
                    print(
                        "[MODEL_QUOTE]",
                        row.get("home_team"),
                        "vs",
                        row.get("away_team"),
                        "market=total_runs",
                        f"line={total_runs['line']}",
                        f"over={total_runs['over_fair_odds']}",
                        f"under={total_runs['under_fair_odds']}",
                        f"confidence={total_runs['confidence']}",
                    )
                    conn.execute(
                        """
                        INSERT INTO model_quotes (
                          match_id, model_name, market_type, line,
                          home_probability, away_probability,
                          home_fair_odds, away_fair_odds,
                          confidence, raw_data
                        )
                        VALUES (%s, %s, 'total_runs', %s, %s, %s, %s, %s, %s, %s::jsonb);
                        """,
                        (
                            row["hub_match_id"],
                            model_name,
                            total_runs["line"],
                            total_runs["over_probability"],
                            total_runs["under_probability"],
                            total_runs["over_fair_odds"],
                            total_runs["under_fair_odds"],
                            total_runs["confidence"],
                            _total_runs_raw_data(row, total_runs),
                        ),
                    )
                for market_key in ("run_line_home", "run_line_away"):
                    run_line = odds.get("markets", {}).get(market_key)
                    if not run_line:
                        continue
                    selection = run_line["selection"]
                    disabled_selection = "away" if selection == "home" else "home"
                    home_probability = run_line["probability"] if selection == "home" else 0.01
                    away_probability = run_line["probability"] if selection == "away" else 0.01
                    home_fair_odds = run_line["fair_odds"] if selection == "home" else 100.0
                    away_fair_odds = run_line["fair_odds"] if selection == "away" else 100.0
                    print(
                        "[MODEL_QUOTE]",
                        row.get("home_team"),
                        "vs",
                        row.get("away_team"),
                        "market=run_line",
                        f"line={run_line['line']}",
                        f"selection={selection}",
                        f"fair={run_line['fair_odds']}",
                        f"confidence={run_line['confidence']}",
                    )
                    conn.execute(
                        """
                        INSERT INTO model_quotes (
                          match_id, model_name, market_type, line,
                          home_probability, away_probability,
                          home_fair_odds, away_fair_odds,
                          confidence, raw_data
                        )
                        VALUES (%s, %s, 'run_line', %s, %s, %s, %s, %s, %s, %s::jsonb);
                        """,
                        (
                            row["hub_match_id"],
                            model_name,
                            run_line["line"],
                            home_probability,
                            away_probability,
                            home_fair_odds,
                            away_fair_odds,
                            run_line["confidence"],
                            _run_line_raw_data(row, run_line, disabled_selection),
                        ),
                    )
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    return processed, skipped


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="stats_input.csv")
    parser.add_argument("--model-name", default="carlos_v1_mlb")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    processed, skipped = ingest_csv(args.input, args.model_name, args.dry_run)
    print(f"[+] Ingesta finalizada procesadas={processed} omitidas={skipped} dry_run={args.dry_run}")


if __name__ == "__main__":
    main()
