from __future__ import annotations

import argparse
import json
import os
from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from fixture_repair_state import classify_group


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)

LEGACY_SOURCE_MATCH_ID_PATTERN = "espn-%-event-%"


def _qualified_identifier(value: str) -> sql.Composed:
    return sql.SQL(".").join(sql.Identifier(part) for part in value.split("."))


def _match_foreign_keys(conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
    return conn.execute(
        """
        SELECT DISTINCT
          c.conrelid::regclass::text AS table_name,
          child_attribute.attname AS column_name,
          CASE c.confdeltype
            WHEN 'a' THEN 'NO ACTION'
            WHEN 'r' THEN 'RESTRICT'
            WHEN 'c' THEN 'CASCADE'
            WHEN 'n' THEN 'SET NULL'
            WHEN 'd' THEN 'SET DEFAULT'
            ELSE c.confdeltype::text
          END AS on_delete
        FROM pg_constraint c
        JOIN LATERAL unnest(c.conkey) WITH ORDINALITY child_key(attnum, ordinality)
          ON TRUE
        JOIN LATERAL unnest(c.confkey) WITH ORDINALITY parent_key(attnum, ordinality)
          ON parent_key.ordinality = child_key.ordinality
        JOIN pg_attribute child_attribute
          ON child_attribute.attrelid = c.conrelid
         AND child_attribute.attnum = child_key.attnum
        JOIN pg_attribute parent_attribute
          ON parent_attribute.attrelid = c.confrelid
         AND parent_attribute.attnum = parent_key.attnum
        WHERE c.contype = 'f'
          AND c.confrelid = 'matches'::regclass
          AND parent_attribute.attname = 'id'
        ORDER BY table_name, column_name;
        """
    ).fetchall()


def _reference_counts(
    conn: psycopg.Connection[Any],
    match_ids: list[str],
    foreign_keys: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    counts: dict[str, dict[str, Any]] = {}
    if not match_ids:
        return counts

    for foreign_key in foreign_keys:
        table_name = str(foreign_key["table_name"])
        column_name = str(foreign_key["column_name"])
        row = conn.execute(
            sql.SQL("SELECT COUNT(*)::int AS count FROM {} WHERE {} = ANY(%s::uuid[])").format(
                _qualified_identifier(table_name),
                sql.Identifier(column_name),
            ),
            (match_ids,),
        ).fetchone()
        counts[f"{table_name}.{column_name}"] = {
            "count": int(row["count"]),
            "on_delete": foreign_key["on_delete"],
        }
    return counts


def audit(source_match_id: str | None, limit: int) -> dict[str, Any]:
    source_filter = "AND legacy.source_match_id = %(source_match_id)s" if source_match_id else ""
    params: dict[str, Any] = {
        "legacy_pattern": LEGACY_SOURCE_MATCH_ID_PATTERN,
        "limit": limit,
    }
    if source_match_id:
        params["source_match_id"] = source_match_id

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        foreign_keys = _match_foreign_keys(conn)
        groups = conn.execute(
            f"""
            WITH legacy AS (
              SELECT
                m.id,
                m.slug,
                m.status::text AS status,
                m.match_date,
                m.created_at,
                m.updated_at,
                l.slug AS league_slug,
                m.raw_data->>'source_match_id' AS source_match_id,
                home_team.name AS home_team,
                away_team.name AS away_team,
                EXISTS (
                  SELECT 1
                  FROM source_match_refs smr
                  WHERE smr.match_id = m.id
                    AND smr.source_match_id = m.raw_data->>'source_match_id'
                ) AS owns_source_ref,
                COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'provider_name', pem.provider_name,
                      'provider_event_id', pem.provider_event_id,
                      'kickoff', pem.kickoff,
                      'is_active', pem.is_active
                    ) ORDER BY pem.last_verified DESC
                  )
                  FROM provider_event_mappings pem
                  WHERE pem.hub_match_id = m.id
                ), '[]'::jsonb) AS provider_mappings
              FROM matches m
              JOIN leagues l ON l.id = m.league_id
              JOIN sports s ON s.id = l.sport_id
              LEFT JOIN match_competitors home_mc
                ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
              LEFT JOIN match_competitors away_mc
                ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
              LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
              LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
              WHERE s.slug = 'soccer'
                AND m.raw_data->>'source_match_id' LIKE %(legacy_pattern)s
            ), duplicate_groups AS (
              SELECT source_match_id
              FROM legacy
              GROUP BY source_match_id
              HAVING COUNT(*) > 1
            )
            SELECT
              legacy.source_match_id,
              MIN(legacy.league_slug) AS league_slug,
              COUNT(*)::int AS match_count,
              MIN(legacy.match_date) AS first_kickoff,
              MAX(legacy.match_date) AS last_kickoff,
              COUNT(*) FILTER (WHERE legacy.owns_source_ref)::int AS source_ref_owner_count,
              COUNT(*) FILTER (
                WHERE jsonb_array_length(legacy.provider_mappings) > 0
              )::int AS provider_mapped_match_count,
              jsonb_agg(
                jsonb_build_object(
                  'id', legacy.id,
                  'slug', legacy.slug,
                  'status', legacy.status,
                  'match_date', legacy.match_date,
                  'created_at', legacy.created_at,
                  'updated_at', legacy.updated_at,
                  'home_team', legacy.home_team,
                  'away_team', legacy.away_team,
                  'owns_source_ref', legacy.owns_source_ref,
                  'provider_mappings', legacy.provider_mappings
                ) ORDER BY legacy.match_date DESC, legacy.updated_at DESC
              ) AS matches
            FROM legacy
            JOIN duplicate_groups USING (source_match_id)
            WHERE TRUE
              {source_filter}
            GROUP BY legacy.source_match_id
            ORDER BY COUNT(*) DESC, legacy.source_match_id
            LIMIT %(limit)s;
            """,
            params,
        ).fetchall()

        duplicate_match_count = 0
        for group in groups:
            matches = list(group["matches"] or [])
            source_ref_owners = [match for match in matches if match["owns_source_ref"]]
            canonical_id = str(source_ref_owners[0]["id"]) if len(source_ref_owners) == 1 else None
            duplicate_ids = [
                str(match["id"])
                for match in matches
                if canonical_id is None or str(match["id"]) != canonical_id
            ]
            duplicate_match_count += max(0, len(matches) - 1)

            group["suggested_canonical_match_id"] = canonical_id
            group["candidate_duplicate_match_ids"] = duplicate_ids
            group["candidate_duplicate_reference_counts"] = _reference_counts(
                conn,
                duplicate_ids,
                foreign_keys,
            )

            group["repair_state"] = classify_group(group).value

    return {
        "mode": "dry_run",
        "source_match_id": source_match_id,
        "legacy_pattern": LEGACY_SOURCE_MATCH_ID_PATTERN,
        "duplicate_group_count": len(groups),
        "duplicate_match_count": duplicate_match_count,
        "foreign_keys_checked": foreign_keys,
        "groups": groups,
        "migration_executed": False,
        "warning": (
            "No se borra ni relinkea nada. Las fechas historicas deben resolverse contra "
            "provider_event_id antes de fusionar registros."
        ),
    }


def summarize(result: dict[str, Any]) -> dict[str, Any]:
    state_counts: dict[str, int] = {}
    reference_counts: dict[str, int] = {}
    groups = list(result["groups"])

    for group in groups:
        state = str(group["repair_state"])
        state_counts[state] = state_counts.get(state, 0) + 1
        for reference, details in group["candidate_duplicate_reference_counts"].items():
            reference_counts[reference] = reference_counts.get(reference, 0) + int(details["count"])

    return {
        "mode": result["mode"],
        "source_match_id": result["source_match_id"],
        "duplicate_group_count": result["duplicate_group_count"],
        "duplicate_match_count": result["duplicate_match_count"],
        "repair_state_counts": state_counts,
        "candidate_duplicate_reference_counts": {
            key: count for key, count in sorted(reference_counts.items()) if count > 0
        },
        "largest_groups": [
            {
                "source_match_id": group["source_match_id"],
                "league_slug": group["league_slug"],
                "match_count": group["match_count"],
                "first_kickoff": group["first_kickoff"],
                "last_kickoff": group["last_kickoff"],
                "source_ref_owner_count": group["source_ref_owner_count"],
                "provider_mapped_match_count": group["provider_mapped_match_count"],
                "repair_state": group["repair_state"],
            }
            for group in groups[:10]
        ],
        "migration_executed": result["migration_executed"],
        "warning": result["warning"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Audita colisiones legacy de IDs ESPN futbol sin modificar la base."
    )
    parser.add_argument("--source-match-id", default=None, help="Audita un ID legacy exacto.")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--summary-only", action="store_true")
    args = parser.parse_args()

    result = audit(args.source_match_id, args.limit)
    if args.summary_only:
        result = summarize(result)
    print(json.dumps(result, default=str, indent=2))


if __name__ == "__main__":
    main()
