import argparse
import json
import os

import psycopg

from fair_odds_engine_nba import calculate_nba_odds
from fair_odds_engine_football import calculate_football_odds


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


ENGINES = {
    "football": calculate_football_odds,
    "nba": calculate_nba_odds,
}


def _quote_rows_from_odds(sport: str, odds: dict) -> list[dict]:
    if sport != "football" or "markets" not in odds:
        return [
            {
                "market_type": "moneyline_3way" if "draw_probability" in odds else "moneyline_2way",
                "line": None,
                "home_probability": odds["home_probability"],
                "away_probability": odds["away_probability"],
                "draw_probability": odds.get("draw_probability"),
                "home_fair_odds": odds["home_fair_odds"],
                "away_fair_odds": odds["away_fair_odds"],
                "draw_fair_odds": odds.get("draw_fair_odds"),
                "confidence": odds["confidence"],
                "selection_map": {
                    "home": "home",
                    "away": "away",
                    "draw": "draw",
                },
            }
        ]

    markets = odds["markets"]
    return [
        {
            "market_type": "moneyline_3way",
            "line": None,
            "home_probability": markets["moneyline_3way"]["home_probability"],
            "away_probability": markets["moneyline_3way"]["away_probability"],
            "draw_probability": markets["moneyline_3way"]["draw_probability"],
            "home_fair_odds": markets["moneyline_3way"]["home_fair_odds"],
            "away_fair_odds": markets["moneyline_3way"]["away_fair_odds"],
            "draw_fair_odds": markets["moneyline_3way"]["draw_fair_odds"],
            "confidence": markets["moneyline_3way"]["confidence"],
            "selection_map": {"home": "home", "away": "away", "draw": "draw"},
        },
        {
            "market_type": "total_goals_2_5",
            "line": markets["total_goals_2_5"]["line"],
            "home_probability": markets["total_goals_2_5"]["over_probability"],
            "away_probability": markets["total_goals_2_5"]["under_probability"],
            "draw_probability": None,
            "home_fair_odds": markets["total_goals_2_5"]["over_fair_odds"],
            "away_fair_odds": markets["total_goals_2_5"]["under_fair_odds"],
            "draw_fair_odds": None,
            "confidence": markets["total_goals_2_5"]["confidence"],
            "selection_map": {"home": "over", "away": "under"},
        },
        {
            "market_type": "btts",
            "line": None,
            "home_probability": markets["btts"]["yes_probability"],
            "away_probability": markets["btts"]["no_probability"],
            "draw_probability": None,
            "home_fair_odds": markets["btts"]["yes_fair_odds"],
            "away_fair_odds": markets["btts"]["no_fair_odds"],
            "draw_fair_odds": None,
            "confidence": markets["btts"]["confidence"],
            "selection_map": {"home": "yes", "away": "no"},
        },
        {
            "market_type": "draw_no_bet",
            "line": None,
            "home_probability": markets["draw_no_bet"]["home_probability"],
            "away_probability": markets["draw_no_bet"]["away_probability"],
            "draw_probability": None,
            "home_fair_odds": markets["draw_no_bet"]["home_fair_odds"],
            "away_fair_odds": markets["draw_no_bet"]["away_fair_odds"],
            "draw_fair_odds": None,
            "confidence": markets["draw_no_bet"]["confidence"],
            "selection_map": {"home": "home", "away": "away"},
        },
    ]


def ingest_features(sport: str, model_name: str, dry_run: bool, league_slug: str | None = None) -> tuple[int, int]:
    if sport not in ENGINES:
        raise ValueError(f"Sport no soportado para model_features: {sport}")

    processed = 0
    skipped = 0
    with psycopg.connect(DATABASE_URL) as conn:
        rows = conn.execute(
            """
            WITH latest_features AS (
              SELECT DISTINCT ON (match_id, model_name)
                match_id,
                feature_set,
                generated_at
              FROM model_features
              WHERE sport_slug = %s
                AND model_name = %s
              ORDER BY match_id, model_name, generated_at DESC
            )
            SELECT lf.match_id, lf.feature_set
            FROM latest_features lf
            JOIN v_valid_matches m ON m.id = lf.match_id
            JOIN leagues l ON l.id = m.league_id
            WHERE m.status::text IN ('scheduled', 'live')
              AND (%s::text IS NULL OR l.slug = %s::text OR lf.feature_set->>'league_slug' = %s::text);
            """,
            (sport, model_name, league_slug, league_slug, league_slug),
        ).fetchall()

        for match_id, feature_set in rows:
            features = dict(feature_set)
            odds = ENGINES[sport](features)
            quote_rows = _quote_rows_from_odds(sport, odds)
            for quote in quote_rows:
                processed += 1
                print(
                    "[MODEL_FEATURE_QUOTE]",
                    features.get("home_team", "home"),
                    "vs",
                    features.get("away_team", "away"),
                    f"market={quote['market_type']}",
                    f"line={quote['line'] or '-'}",
                    f"home={quote['home_fair_odds']}",
                    f"draw={quote.get('draw_fair_odds') or '-'}",
                    f"away={quote['away_fair_odds']}",
                    f"confidence={quote['confidence']}",
                )
                if dry_run:
                    continue
                conn.execute(
                    """
                    INSERT INTO model_quotes (
                      match_id, model_name, market_type, line,
                      home_probability, away_probability,
                      draw_probability,
                      home_fair_odds, away_fair_odds,
                      draw_fair_odds,
                      confidence, raw_data
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb);
                    """,
                    (
                        match_id,
                        model_name,
                        quote["market_type"],
                        quote["line"],
                        quote["home_probability"],
                        quote["away_probability"],
                        quote["draw_probability"],
                        quote["home_fair_odds"],
                        quote["away_fair_odds"],
                        quote["draw_fair_odds"],
                        quote["confidence"],
                        json.dumps(
                            {
                                "feature_set": features,
                                "engine": f"fair_odds_engine_{sport}_v1",
                                "selection_map": quote["selection_map"],
                                "lambda_home": odds.get("lambda_home"),
                                "lambda_away": odds.get("lambda_away"),
                            }
                        ),
                    ),
                )

        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    return processed, skipped


def main() -> None:
    parser = argparse.ArgumentParser(description="Convierte model_features en model_quotes.")
    parser.add_argument("--sport", required=True, choices=sorted(ENGINES))
    parser.add_argument("--model-name", required=True)
    parser.add_argument("--league-slug")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    processed, skipped = ingest_features(args.sport, args.model_name, args.dry_run, args.league_slug)
    print(f"[+] Feature ingest finalizada procesadas={processed} omitidas={skipped} dry_run={args.dry_run}")


if __name__ == "__main__":
    main()
