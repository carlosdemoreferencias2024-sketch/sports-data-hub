"""Read-only helpers for signed fixture identity review reports."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from reidentify_and_invalidate import load_identity_plan
from review_fixture_identity_plan import _reference_counts_by_match


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


def load_signed_plan(path: Path, sha256: str) -> dict[str, Any]:
    return load_identity_plan(path, sha256)


def connect() -> psycopg.Connection[Any]:
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def batch_quality_match_ids(
    conn: psycopg.Connection[Any], batch_id: str, quality: str
) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT match_id::text AS match_id
        FROM fixture_identity_log
        WHERE batch_id = %s
          AND object_name = 'matches.quality'
          AND new_value->>'data_quality_flag' = %s
        ORDER BY match_id::text
        """,
        (batch_id, quality),
    ).fetchall()
    return [str(row["match_id"]) for row in rows]


def match_contexts(
    conn: psycopg.Connection[Any], match_ids: list[str]
) -> dict[str, dict[str, Any]]:
    if not match_ids:
        return {}
    rows = conn.execute(
        """
        SELECT
          m.id::text AS match_id,
          m.match_date,
          m.created_at,
          m.updated_at,
          m.status::text AS status,
          m.data_quality_flag,
          m.invalidated_reason,
          m.raw_data,
          l.slug AS league_slug,
          l.name AS league_name,
          home_team.name AS home_team,
          away_team.name AS away_team,
          (SELECT COUNT(*)::int FROM source_match_refs WHERE match_id = m.id) AS source_ref_count,
          (SELECT COUNT(*)::int FROM provider_event_mappings WHERE hub_match_id = m.id)
            AS provider_mapping_count
        FROM matches m
        JOIN leagues l ON l.id = m.league_id
        LEFT JOIN match_competitors home_mc
          ON home_mc.match_id = m.id AND home_mc.home_away = 'home'
        LEFT JOIN teams home_team ON home_team.id = home_mc.team_id
        LEFT JOIN match_competitors away_mc
          ON away_mc.match_id = m.id AND away_mc.home_away = 'away'
        LEFT JOIN teams away_team ON away_team.id = away_mc.team_id
        WHERE m.id = ANY(%s::uuid[])
        ORDER BY m.match_date, m.id
        """,
        (match_ids,),
    ).fetchall()
    references = _reference_counts_by_match(conn, match_ids)
    return {
        str(row["match_id"]): {
            **row,
            "direct_reference_counts": references[str(row["match_id"])],
        }
        for row in rows
    }


def write_report(path: Path, report: dict[str, Any]) -> str:
    payload = json.dumps(report, default=str, indent=2, sort_keys=True).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()
