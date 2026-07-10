from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from typing import Any

import psycopg
from psycopg.rows import dict_row


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


RELATED_TABLES = (
    ("model_quotes", "match_id"),
    ("market_quotes", "match_id"),
    ("alpha_opportunities", "match_id"),
    ("paper_trades", "match_id"),
    ("model_features", "match_id"),
    ("match_competitors", "match_id"),
    ("provider_event_mappings", "hub_match_id"),
    ("source_match_refs", "match_id"),
)


def _target_date(value: str | None) -> str:
    if value:
        return value
    return datetime.now(timezone.utc).date().isoformat()


def audit(target_date: str, limit: int) -> dict[str, Any]:
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        stale = conn.execute(
            """
            SELECT
              m.id,
              m.slug,
              m.status::text AS status,
              m.match_date,
              home_team.name AS home_team,
              away_team.name AS away_team,
              m.updated_at
            FROM matches m
            JOIN leagues l ON l.id = m.league_id
            JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
            JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
            JOIN teams home_team ON home_team.id = home_mc.team_id
            JOIN teams away_team ON away_team.id = away_mc.team_id
            WHERE l.slug = 'mlb'
              AND m.status IN ('scheduled', 'live')
              AND m.match_date::date <> %s::date
            ORDER BY m.match_date DESC, m.updated_at DESC
            LIMIT %s;
            """,
            (target_date, limit),
        ).fetchall()

        totals = conn.execute(
            """
            SELECT
              m.status::text AS status,
              COUNT(*)::int AS count
            FROM matches m
            JOIN leagues l ON l.id = m.league_id
            WHERE l.slug = 'mlb'
              AND m.status IN ('scheduled', 'live')
              AND m.match_date::date <> %s::date
            GROUP BY m.status
            ORDER BY m.status;
            """,
            (target_date,),
        ).fetchall()

        related_counts: dict[str, int] = {}
        for table, column in RELATED_TABLES:
            row = conn.execute(
                f"""
                SELECT COUNT(*)::int AS count
                FROM {table} related
                WHERE related.{column} IN (
                  SELECT m.id
                  FROM matches m
                  JOIN leagues l ON l.id = m.league_id
                  WHERE l.slug = 'mlb'
                    AND m.status IN ('scheduled', 'live')
                    AND m.match_date::date <> %s::date
                );
                """,
                (target_date,),
            ).fetchone()
            related_counts[table] = int(row["count"])

    return {
        "mode": "dry_run",
        "target_date": target_date,
        "stale_active_by_status": totals,
        "related_counts_if_purged": related_counts,
        "sample": stale,
        "delete_executed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Audita fixtures MLB activos viejos sin borrar nada.")
    parser.add_argument("--target-date", default=None, help="Fecha valida YYYY-MM-DD. Default: hoy UTC.")
    parser.add_argument("--limit", type=int, default=25)
    args = parser.parse_args()

    result = audit(_target_date(args.target_date), args.limit)
    print(json.dumps(result, default=str, indent=2))


if __name__ == "__main__":
    main()
