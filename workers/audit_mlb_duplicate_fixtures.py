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
    ("real_paper_snapshots", "match_id"),
    ("model_features", "match_id"),
    ("match_competitors", "match_id"),
    ("provider_event_mappings", "hub_match_id"),
    ("source_match_refs", "match_id"),
)


def _target_date(value: str | None) -> str | None:
    if value == "today":
        return datetime.now(timezone.utc).date().isoformat()
    return value


def audit(target_date: str | None, limit: int) -> dict[str, Any]:
    date_filter = "AND m.match_date::date = %(target_date)s::date" if target_date else ""
    params: dict[str, Any] = {"limit": limit}
    if target_date:
        params["target_date"] = target_date

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        groups = conn.execute(
            f"""
            WITH fixture_names AS (
              SELECT
                m.id,
                m.slug,
                m.status::text AS status,
                m.match_date::date AS match_day,
                m.match_date,
                m.created_at,
                m.updated_at,
                home_team.name AS home_team,
                away_team.name AS away_team,
                home_team.id AS home_team_id,
                away_team.id AS away_team_id
              FROM matches m
              JOIN leagues l ON l.id = m.league_id
              JOIN match_competitors home_mc ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
              JOIN match_competitors away_mc ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
              JOIN teams home_team ON home_team.id = home_mc.team_id
              JOIN teams away_team ON away_team.id = away_mc.team_id
              WHERE l.slug = 'mlb'
                {date_filter}
            ),
            duplicate_groups AS (
              SELECT
                match_day,
                home_team_id,
                away_team_id,
                MIN(home_team) AS home_team,
                MIN(away_team) AS away_team,
                COUNT(*)::int AS match_count,
                ARRAY_AGG(id ORDER BY
                  CASE status WHEN 'finished' THEN 0 WHEN 'live' THEN 1 ELSE 2 END,
                  updated_at DESC,
                  created_at ASC
                ) AS ordered_ids
              FROM fixture_names
              GROUP BY match_day, home_team_id, away_team_id
              HAVING COUNT(*) > 1
            )
            SELECT
              dg.match_day,
              dg.home_team,
              dg.away_team,
              dg.match_count,
              dg.ordered_ids[1] AS suggested_canonical_match_id,
              (dg.ordered_ids[2:]) AS duplicate_match_ids,
              (
                SELECT json_agg(row_to_json(f) ORDER BY f.status, f.updated_at DESC)
                FROM fixture_names f
                WHERE f.id = ANY(dg.ordered_ids)
              ) AS matches
            FROM duplicate_groups dg
            ORDER BY dg.match_day DESC, dg.home_team, dg.away_team
            LIMIT %(limit)s;
            """,
            params,
        ).fetchall()

        duplicate_ids = [
            str(match_id)
            for group in groups
            for match_id in (group["duplicate_match_ids"] or [])
        ]

        related_counts: dict[str, int] = {}
        if duplicate_ids:
            for table, column in RELATED_TABLES:
                row = conn.execute(
                    f"""
                    SELECT COUNT(*)::int AS count
                    FROM {table} related
                    WHERE related.{column} = ANY(%s::uuid[]);
                    """,
                    (duplicate_ids,),
                ).fetchone()
                related_counts[table] = int(row["count"])
        else:
            related_counts = {table: 0 for table, _ in RELATED_TABLES}

    return {
        "mode": "dry_run",
        "target_date": target_date,
        "duplicate_group_count": len(groups),
        "duplicate_match_count": len(duplicate_ids),
        "related_counts_if_duplicate_rows_relinked_or_purged": related_counts,
        "groups": groups,
        "delete_executed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Audita duplicados MLB por fecha/equipos sin borrar nada.")
    parser.add_argument("--target-date", default=None, help="YYYY-MM-DD, 'today', o vacio para todas las fechas.")
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()

    result = audit(_target_date(args.target_date), args.limit)
    print(json.dumps(result, default=str, indent=2))


if __name__ == "__main__":
    main()
