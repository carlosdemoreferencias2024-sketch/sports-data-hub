"""Invalidate the exact duplicates approved by a signed collision report."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from audit_matches_quality_queries import assert_quality_query_gate
from ensure_fresh_backup import BackupArtifact, ensure_fresh_backup
from fixture_review_report_common import match_contexts


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)
LOCK_ID = 918273645
EXPECTED_ORIGINAL_BATCH_ID = "a957799c-50ec-4b0b-9a0c-a7bae3b5217e"
EXPECTED_PLAN_SHA256 = "e8d706e1976f0dba376a188acbc57097306e88dab774624b7fa35f20ec5e710c"
EXPECTED_DUPLICATE_COUNT = 4
ALLOWED_DUPLICATE_REFERENCES = {
    "fixture_identity_log.match_id": 1,
    "match_competitors.match_id": 2,
    "team_stat_snapshots.match_id": 2,
}


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_signed_collision_report(path: Path, expected_sha256: str) -> dict[str, Any]:
    actual_sha256 = _file_sha256(path)
    if actual_sha256 != expected_sha256.lower():
        raise RuntimeError(
            f"COLLISION_REPORT_SHA256_MISMATCH:expected={expected_sha256.lower()}:"
            f"actual={actual_sha256}"
        )
    report = json.loads(path.read_bytes())
    if report.get("database_writes_executed") is not False:
        raise RuntimeError("COLLISION_REPORT_NOT_READ_ONLY")
    if report.get("mode") != "READ_ONLY_REVIEW":
        raise RuntimeError("COLLISION_REPORT_MODE_INVALID")
    if report.get("batch_id") != EXPECTED_ORIGINAL_BATCH_ID:
        raise RuntimeError("COLLISION_REPORT_BATCH_MISMATCH")
    if report.get("plan_sha256") != EXPECTED_PLAN_SHA256:
        raise RuntimeError("COLLISION_REPORT_PLAN_MISMATCH")
    if report.get("collision_count") != 5:
        raise RuntimeError("COLLISION_REPORT_COUNT_MISMATCH")
    rows = [
        row for row in report.get("rows", [])
        if row.get("classification") == "EXACT_EVENT_DUPLICATE_OWNER_PRESENT"
    ]
    if len(rows) != EXPECTED_DUPLICATE_COUNT:
        raise RuntimeError(f"EXACT_DUPLICATE_COUNT_MISMATCH:{len(rows)}")
    owners = {str(row.get("current_owner", {}).get("match_id")) for row in rows}
    if None in owners or "None" in owners or len(owners) != EXPECTED_DUPLICATE_COUNT:
        raise RuntimeError("EXACT_DUPLICATE_OWNER_SET_INVALID")
    report["approved_exact_duplicate_rows"] = rows
    report["report_sha256"] = actual_sha256
    return report


def _timestamp(value: Any) -> str:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return parsed.astimezone(UTC).isoformat()


def _assert_schema(conn: psycopg.Connection[Any]) -> None:
    row = conn.execute(
        """
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'matches'
              AND column_name = 'duplicate_of_match_id'
          ) AS has_duplicate_owner,
          to_regclass('v_duplicate_matches') IS NOT NULL AS has_duplicate_view
        """
    ).fetchone()
    if not row or not all(row.values()):
        raise RuntimeError("MIGRATION_060_REQUIRED")


def validate_candidates(
    conn: psycopg.Connection[Any], report: dict[str, Any], *, lock_rows: bool = False
) -> list[dict[str, Any]]:
    approved = list(report["approved_exact_duplicate_rows"])
    duplicate_ids = [str(row["match_id"]) for row in approved]
    owner_ids = [str(row["current_owner"]["match_id"]) for row in approved]
    contexts = match_contexts(conn, duplicate_ids + owner_ids)
    if lock_rows:
        conn.execute(
            "SELECT id FROM matches WHERE id = ANY(%s::uuid[]) ORDER BY id FOR UPDATE",
            (sorted(duplicate_ids + owner_ids),),
        ).fetchall()

    validated: list[dict[str, Any]] = []
    for approved_row in approved:
        duplicate_id = str(approved_row["match_id"])
        owner_id = str(approved_row["current_owner"]["match_id"])
        duplicate = contexts.get(duplicate_id)
        owner = contexts.get(owner_id)
        signed_duplicate = approved_row["blocked_match"]
        resolution = approved_row["signed_resolution"]
        if not duplicate or not owner:
            raise RuntimeError(f"DUPLICATE_OR_OWNER_NOT_FOUND:{duplicate_id}:{owner_id}")
        if duplicate["data_quality_flag"] != "AMBIGUOUS_PENDING_REVIEW":
            raise RuntimeError(f"DUPLICATE_QUALITY_DRIFT:{duplicate_id}")
        if duplicate["invalidated_reason"] != f"SOURCE_MATCH_ID_ALREADY_OWNED:{owner_id}":
            raise RuntimeError(f"DUPLICATE_OWNER_REASON_DRIFT:{duplicate_id}")
        if owner["data_quality_flag"] != "AUTHENTIC":
            raise RuntimeError(f"OWNER_NOT_AUTHENTIC:{owner_id}")
        for field in ("home_team", "away_team"):
            if duplicate[field] != owner[field] or duplicate[field] != signed_duplicate[field]:
                raise RuntimeError(f"DUPLICATE_{field.upper()}_DRIFT:{duplicate_id}")
        if (
            _timestamp(duplicate["match_date"]) != _timestamp(owner["match_date"])
            or _timestamp(duplicate["match_date"]) != _timestamp(signed_duplicate["match_date"])
        ):
            raise RuntimeError(f"DUPLICATE_KICKOFF_DRIFT:{duplicate_id}")
        if duplicate["direct_reference_counts"] != ALLOWED_DUPLICATE_REFERENCES:
            raise RuntimeError(
                f"DUPLICATE_REFERENCE_DRIFT:{duplicate_id}:"
                f"{json.dumps(duplicate['direct_reference_counts'], sort_keys=True)}"
            )
        owner_raw = dict(owner.get("raw_data") or {})
        duplicate_raw = dict(duplicate.get("raw_data") or {})
        if owner_raw.get("source_match_id") != resolution.get("proposed_source_match_id"):
            raise RuntimeError(f"OWNER_SOURCE_ID_DRIFT:{owner_id}")
        if owner_raw.get("provider_event_id") != str(resolution.get("provider_event_id")):
            raise RuntimeError(f"OWNER_PROVIDER_EVENT_DRIFT:{owner_id}")
        if duplicate_raw.get("source_match_id") != resolution.get("legacy_source_match_id"):
            raise RuntimeError(f"DUPLICATE_SOURCE_ID_DRIFT:{duplicate_id}")
        mapping = conn.execute(
            """
            SELECT hub_match_id::text AS hub_match_id
            FROM provider_event_mappings
            WHERE provider_name = 'espn_site_api' AND provider_event_id = %s
            """,
            (str(resolution["provider_event_id"]),),
        ).fetchall()
        if [str(row["hub_match_id"]) for row in mapping] != [owner_id]:
            raise RuntimeError(f"PROVIDER_MAPPING_OWNER_DRIFT:{duplicate_id}")
        validated.append({
            "duplicate_match_id": duplicate_id,
            "original_match_id": owner_id,
            "provider_event_id": str(resolution["provider_event_id"]),
            "home_team": duplicate["home_team"],
            "away_team": duplicate["away_team"],
            "match_date": _timestamp(duplicate["match_date"]),
        })
    return validated


def _log_change(
    conn: psycopg.Connection[Any], batch_id: str, duplicate_id: str,
    old_value: dict[str, Any], new_value: dict[str, Any]
) -> None:
    conn.execute(
        """
        INSERT INTO fixture_identity_log
          (batch_id, match_id, operation, object_name, old_value, new_value)
        VALUES (%s, %s, 'UPDATE', 'matches.duplicate_quality', %s::jsonb, %s::jsonb)
        """,
        (
            batch_id,
            duplicate_id,
            json.dumps(old_value, default=str),
            json.dumps(new_value, default=str),
        ),
    )


def apply_duplicates(
    report: dict[str, Any], backup: BackupArtifact
) -> dict[str, Any]:
    batch_id = str(uuid.uuid4())
    applied_at = datetime.now(UTC)
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        _assert_schema(conn)
        got_lock = conn.execute(
            "SELECT pg_try_advisory_xact_lock(%s) AS locked", (LOCK_ID,)
        ).fetchone()
        if not got_lock or not got_lock["locked"]:
            raise RuntimeError("FIXTURE_IDENTITY_REPAIR_ALREADY_RUNNING")
        validated = validate_candidates(conn, report, lock_rows=True)
        conn.execute(
            """
            INSERT INTO fixture_identity_batches
              (batch_id, repair_scope, status, backup_path, backup_sha256, summary)
            VALUES (%s, 'EXACT_DUPLICATE_INVALIDATION', 'RUNNING', %s, %s, %s::jsonb)
            """,
            (
                batch_id,
                str(backup.path),
                backup.sha256,
                json.dumps({"collision_report_sha256": report["report_sha256"]}),
            ),
        )
        for row in validated:
            duplicate_id = row["duplicate_match_id"]
            current = conn.execute(
                """
                SELECT data_quality_flag, invalidated_at, invalidated_reason,
                       duplicate_of_match_id
                FROM matches WHERE id = %s
                """,
                (duplicate_id,),
            ).fetchone()
            reason = (
                f"Exact ESPN provider-event duplicate {row['provider_event_id']}; "
                f"AUTHENTIC owner {row['original_match_id']}"
            )
            old_value = dict(current)
            new_value = {
                "data_quality_flag": "DUPLICATE_INVALIDATED",
                "invalidated_at": applied_at,
                "invalidated_reason": reason,
                "duplicate_of_match_id": row["original_match_id"],
            }
            _log_change(conn, batch_id, duplicate_id, old_value, new_value)
            result = conn.execute(
                """
                UPDATE matches
                SET data_quality_flag = 'DUPLICATE_INVALIDATED',
                    invalidated_at = %s,
                    invalidated_reason = %s,
                    duplicate_of_match_id = %s
                WHERE id = %s AND data_quality_flag = 'AMBIGUOUS_PENDING_REVIEW'
                  AND duplicate_of_match_id IS NULL
                """,
                (applied_at, reason, row["original_match_id"], duplicate_id),
            )
            if result.rowcount != 1:
                raise RuntimeError(f"DUPLICATE_UPDATE_CONFLICT:{duplicate_id}")
        summary = {
            "DUPLICATE_INVALIDATED": len(validated),
            "foreign_keys_moved": 0,
            "collision_report_sha256": report["report_sha256"],
        }
        conn.execute(
            """
            UPDATE fixture_identity_batches
            SET status = 'COMPLETED', completed_at = now(), summary = %s::jsonb
            WHERE batch_id = %s
            """,
            (json.dumps(summary), batch_id),
        )
    return {
        "mode": "APPLY",
        "batch_id": batch_id,
        "backup_path": str(backup.path),
        "backup_sha256": backup.sha256,
        "counts": summary,
        "rows": validated,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--report-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-writers-paused", action="store_true")
    args = parser.parse_args()
    report = load_signed_collision_report(args.report, args.report_sha256)
    assert_quality_query_gate(Path(__file__).resolve().parent.parent)
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        validated = validate_candidates(conn, report)
    if not args.apply:
        print(json.dumps({
            "mode": "DRY_RUN",
            "report_sha256": report["report_sha256"],
            "exact_duplicate_count": len(validated),
            "foreign_keys_moved": 0,
            "rows": validated,
        }, indent=2))
        return
    if not args.confirm_writers_paused:
        raise RuntimeError("APPLY_REQUIRES_CONFIRM_WRITERS_PAUSED")
    backup = ensure_fresh_backup(DATABASE_URL)
    print(json.dumps(apply_duplicates(report, backup), indent=2))


if __name__ == "__main__":
    main()
