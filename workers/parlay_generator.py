import argparse
import json
import os
from itertools import combinations
from typing import Any

import psycopg
from psycopg.rows import dict_row


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


def as_float(value: Any) -> float:
    if value is None:
        return 0.0
    return float(value)


def fetch_opportunities(model_name: str | None, min_ev: float, processed: bool, max_age_minutes: int, limit: int) -> list[dict]:
    params: list[Any] = [min_ev, processed, max_age_minutes]
    model_filter = ""
    if model_name:
        params.append(model_name)
        model_filter = f"AND ao.model_name = %s"
    params.append(limit)

    query = f"""
        WITH enriched AS (
          SELECT
            ao.id,
            ao.match_id,
            ao.sport_slug,
            ao.league_slug,
            ao.model_name,
            ao.provider_name,
            ao.market_type,
            ao.line,
            ao.market_selection,
            COALESCE(pem.home_team_name, home_comp.team_name) AS home_team_name,
            COALESCE(pem.away_team_name, away_comp.team_name) AS away_team_name,
            ao.model_probability,
            ao.market_odds,
            ao.expected_value,
            mq.confidence,
            ao.detected_at
          FROM alpha_opportunities ao
          JOIN matches m ON m.id = ao.match_id
          JOIN model_quotes mq ON mq.id = ao.model_quote_id
          LEFT JOIN provider_event_mappings pem ON pem.hub_match_id = ao.match_id AND pem.is_active = TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = ao.match_id AND mc.home_away = 'home'
            LIMIT 1
          ) home_comp ON TRUE
          LEFT JOIN LATERAL (
            SELECT t.name AS team_name
            FROM match_competitors mc
            JOIN teams t ON t.id = mc.team_id
            WHERE mc.match_id = ao.match_id AND mc.home_away = 'away'
            LIMIT 1
          ) away_comp ON TRUE
          WHERE m.status::text IN ('scheduled', 'live')
            AND ao.expected_value >= %s
            AND ao.processed = %s
            AND ao.detected_at >= NOW() - (%s * INTERVAL '1 minute')
            {model_filter}
        ),
        ranked AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY
                league_slug,
                regexp_replace(lower(COALESCE(home_team_name, match_id::text)), '[^a-z0-9]+', '', 'g'),
                regexp_replace(lower(COALESCE(away_team_name, match_id::text)), '[^a-z0-9]+', '', 'g')
              ORDER BY detected_at DESC, expected_value DESC, confidence DESC
            ) AS row_rank
          FROM enriched
        )
        SELECT *
        FROM ranked
        WHERE row_rank = 1
        ORDER BY expected_value DESC, confidence DESC, detected_at DESC
        LIMIT %s;
    """

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        return list(conn.execute(query, params).fetchall())


def correlation_penalty(legs: list[dict]) -> float:
    same_league_pairs = 0
    same_sport_pairs = 0
    for first, second in combinations(legs, 2):
        if first["league_slug"] == second["league_slug"]:
            same_league_pairs += 1
        elif first["sport_slug"] == second["sport_slug"]:
            same_sport_pairs += 1
    return (0.94 ** same_league_pairs) * (0.98 ** same_sport_pairs)


def build_parlay(kind: str, label: str, target_legs: int, stake_fraction: float, candidates: list[dict]) -> dict:
    legs = candidates[:target_legs]
    if len(legs) < target_legs:
        return {
            "kind": kind,
            "label": label,
            "status": "insufficient_legs",
            "needed_legs": target_legs,
            "available_legs": len(candidates),
            "stake_fraction": stake_fraction,
            "reason": f"Faltan {target_legs - len(candidates)} selecciones para construir este parlay sin forzarlo.",
            "legs": legs,
        }

    estimated_odds = 1.0
    raw_probability = 1.0
    for leg in legs:
        estimated_odds *= as_float(leg["market_odds"])
        raw_probability *= as_float(leg["model_probability"])

    penalty = correlation_penalty(legs)
    adjusted_probability = raw_probability * penalty
    expected_value = (adjusted_probability * estimated_odds) - 1.0
    return {
        "kind": kind,
        "label": label,
        "status": "ready",
        "legs_count": len(legs),
        "stake_fraction": stake_fraction,
        "estimated_odds": round(estimated_odds, 4),
        "raw_model_probability": round(raw_probability, 6),
        "correlation_penalty": round(penalty, 6),
        "adjusted_probability": round(adjusted_probability, 6),
        "expected_value": round(expected_value, 6),
        "legs": legs,
    }


def generate_parlays(opportunities: list[dict]) -> list[dict]:
    steady = sorted(
        [
            op for op in opportunities
            if as_float(op.get("confidence")) >= 0.5 and 0.05 <= as_float(op["expected_value"]) <= 0.07
        ],
        key=lambda op: (as_float(op.get("confidence")), as_float(op["expected_value"])),
        reverse=True,
    )
    dreamer = sorted(
        [op for op in opportunities if as_float(op["expected_value"]) >= 0.05],
        key=lambda op: (as_float(op["expected_value"]), as_float(op.get("confidence"))),
        reverse=True,
    )
    black_swan = sorted(
        [op for op in opportunities if as_float(op["expected_value"]) >= 0.05 and as_float(op["market_odds"]) >= 2.5],
        key=lambda op: (op["sport_slug"], -as_float(op["market_odds"])),
    )

    return [
        build_parlay("steady", "Parlay Seguro", 2, 0.015, steady),
        build_parlay("value_hunter", "Parlay Soñador", 3, 0.005, dreamer),
        build_parlay("black_swan", "Parlay Jubilador", 6, 0.001, black_swan),
    ]


def print_human(parlays: list[dict]) -> None:
    for parlay in parlays:
        print(f"[{parlay['kind']}] {parlay['label']} status={parlay['status']} stake={parlay['stake_fraction']:.2%}")
        if parlay["status"] != "ready":
            print(f"  {parlay['reason']}")
            continue
        print(
            f"  odds={parlay['estimated_odds']} prob_adj={parlay['adjusted_probability']:.2%} "
            f"ev={parlay['expected_value']:.2%} corr={parlay['correlation_penalty']:.2%}"
        )
        for leg in parlay["legs"]:
            print(
                "  - "
                f"{leg.get('home_team_name') or 'Home'} vs {leg.get('away_team_name') or 'Away'} | "
                f"{leg['market_selection']} @ {as_float(leg['market_odds']):.4f} "
                f"EV={as_float(leg['expected_value']):.2%}"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Genera parlays shadow desde alpha_opportunities.")
    parser.add_argument("--model-name", default=None)
    parser.add_argument("--min-ev", type=float, default=0.05)
    parser.add_argument("--processed", action="store_true")
    parser.add_argument("--max-age-minutes", type=int, default=1440)
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    opportunities = fetch_opportunities(args.model_name, args.min_ev, args.processed, args.max_age_minutes, args.limit)
    parlays = generate_parlays(opportunities)
    payload = {
        "count": len(opportunities),
        "source": {
            "min_ev": args.min_ev,
            "processed": args.processed,
            "max_age_minutes": args.max_age_minutes,
        },
        "parlays": parlays,
    }
    if args.json:
        print(json.dumps(payload, default=str, ensure_ascii=False, indent=2))
    else:
        print(f"[+] oportunidades={len(opportunities)}")
        print_human(parlays)


if __name__ == "__main__":
    main()
