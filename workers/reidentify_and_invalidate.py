"""Replay legacy ESPN identity collisions without moving match IDs or child FKs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from audit_espn_soccer_duplicate_fixtures import audit
from audit_matches_quality_queries import assert_quality_query_gate
from ensure_fresh_backup import BackupArtifact, ensure_fresh_backup
from espn_source_aliases import resolve_source_slug
from fixture_repair_state import RepairState, filter_by_state
from replay_duplicate_fixtures import resolve_row


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)
LOCK_ID = 918273645


def _plan_bytes(plan: dict[str, Any]) -> bytes:
    return json.dumps(plan, default=str, indent=2, sort_keys=True).encode("utf-8")


def write_identity_plan(path: Path, plan: dict[str, Any]) -> str:
    payload = _plan_bytes(plan)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return hashlib.sha256(payload).hexdigest()


def load_identity_plan(path: Path, expected_sha256: str) -> dict[str, Any]:
    payload = path.read_bytes()
    actual_sha256 = hashlib.sha256(payload).hexdigest()
    if actual_sha256 != expected_sha256.lower():
        raise RuntimeError(
            f"PLAN_SHA256_MISMATCH:expected={expected_sha256.lower()}:actual={actual_sha256}"
        )
    plan = json.loads(payload)
    required = {
        "repair_scope", "replayable_group_count", "ambiguous_group_count",
        "resolutions", "ambiguous_match_ids", "database_writes_executed",
    }
    missing = sorted(required - set(plan))
    if missing:
        raise RuntimeError(f"INVALID_PLAN_MISSING_FIELDS:{missing}")
    if plan["repair_scope"] != "LEGACY_SOURCE_COLLISION":
        raise RuntimeError("INVALID_PLAN_SCOPE")
    if plan["database_writes_executed"] is not False:
        raise RuntimeError("INVALID_PLAN_NOT_DRY_RUN")
    return plan


def load_approved_invalid_ids(
    path: Path, expected_sha256: str, expected_plan_sha256: str
) -> set[str]:
    payload = path.read_bytes()
    actual_sha256 = hashlib.sha256(payload).hexdigest()
    if actual_sha256 != expected_sha256.lower():
        raise RuntimeError(
            f"APPROVAL_SHA256_MISMATCH:expected={expected_sha256.lower()}:actual={actual_sha256}"
        )
    report = json.loads(payload)
    if report.get("plan_sha256") != expected_plan_sha256.lower():
        raise RuntimeError("APPROVAL_PLAN_SHA256_MISMATCH")
    approved = report.get("approved_invalid_match_ids")
    if not isinstance(approved, list) or not all(isinstance(value, str) for value in approved):
        raise RuntimeError("INVALID_APPROVAL_REPORT")
    return set(approved)


def _resolve_with_retries(group: dict[str, Any], row: dict[str, Any], timeout: int, retries: int) -> dict[str, Any]:
    result: dict[str, Any] | None = None
    for attempt in range(1, retries + 1):
        result = resolve_row(group, row, timeout=timeout)
        if result["resolution_state"] == "RESOLVED":
            result["attempts"] = attempt
            return result
        if attempt < retries:
            time.sleep(min(attempt, 2))
    assert result is not None
    result["attempts"] = retries
    return result


def build_identity_plan(
    source_match_id: str | None,
    limit: int,
    timeout: int,
    retries: int,
    max_rows_per_group: int | None,
) -> dict[str, Any]:
    audit_result = audit(source_match_id=source_match_id, limit=limit)
    groups = list(audit_result["groups"])
    replayable = filter_by_state(groups, RepairState.NEEDS_PROVIDER_EVENT_REPLAY)
    ambiguous = filter_by_state(groups, RepairState.BLOCKED_SOURCE_REF_AMBIGUOUS)
    resolutions: list[dict[str, Any]] = []
    for group in replayable:
        rows = list(group.get("matches") or [])
        if max_rows_per_group is not None:
            rows = rows[:max_rows_per_group]
        for row in rows:
            result = _resolve_with_retries(group, row, timeout, retries)
            result["league_slug"] = str(group["league_slug"])
            resolutions.append(result)

    ambiguous_match_ids = [
        str(row["id"])
        for group in ambiguous
        for row in list(group.get("matches") or [])
    ]
    resolved = sum(row["resolution_state"] == "RESOLVED" for row in resolutions)
    return {
        "mode": "dry_run",
        "generated_at": datetime.now(UTC).isoformat(),
        "repair_scope": "LEGACY_SOURCE_COLLISION",
        "replayable_group_count": len(replayable),
        "ambiguous_group_count": len(ambiguous),
        "rows_planned": len(resolutions),
        "resolved_count": resolved,
        "unresolved_pending_review_count": len(resolutions) - resolved,
        "ambiguous_pending_review_count": len(ambiguous_match_ids),
        "resolutions": resolutions,
        "ambiguous_match_ids": ambiguous_match_ids,
        "foreign_key_remap_allowed": False,
        "database_writes_executed": False,
    }


def _log_operation(
    conn: psycopg.Connection[Any],
    batch_id: str,
    match_id: str,
    operation: str,
    object_name: str,
    old_value: Any,
    new_value: Any,
) -> None:
    conn.execute(
        """
        INSERT INTO fixture_identity_log
          (batch_id, match_id, operation, object_name, old_value, new_value)
        VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb)
        """,
        (
            batch_id,
            match_id,
            operation,
            object_name,
            json.dumps(old_value, default=str) if old_value is not None else None,
            json.dumps(new_value, default=str) if new_value is not None else None,
        ),
    )


def _current_match(conn: psycopg.Connection[Any], match_id: str) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT id, match_date, raw_data, data_quality_flag, invalidated_at, invalidated_reason
        FROM matches
        WHERE id = %s
        FOR UPDATE
        """,
        (match_id,),
    ).fetchone()
    if not row:
        raise RuntimeError(f"MATCH_NOT_FOUND:{match_id}")
    return row


def _set_quality(
    conn: psycopg.Connection[Any],
    batch_id: str,
    match_id: str,
    quality: str,
    reason: str | None,
) -> None:
    current = _current_match(conn, match_id)
    old_value = {
        "data_quality_flag": current["data_quality_flag"],
        "invalidated_at": current["invalidated_at"],
        "invalidated_reason": current["invalidated_reason"],
    }
    invalidated = quality == "SYNTHETIC_INVALIDATED"
    new_value = {
        "data_quality_flag": quality,
        "invalidated_at": "NOW" if invalidated else None,
        "invalidated_reason": reason,
    }
    _log_operation(conn, batch_id, match_id, "UPDATE", "matches.quality", old_value, new_value)
    conn.execute(
        """
        UPDATE matches
        SET data_quality_flag = %s,
            invalidated_at = CASE WHEN %s THEN now() ELSE NULL END,
            invalidated_reason = %s
        WHERE id = %s
        """,
        (quality, invalidated, reason, match_id),
    )


def _assert_no_identity_collision(
    conn: psycopg.Connection[Any], match_id: str, source_match_id: str, provider_event_id: str
) -> None:
    source_collision = conn.execute(
        """
        SELECT id
        FROM matches
        WHERE id <> %s
          AND raw_data->>'source_match_id' = %s
          AND data_quality_flag <> 'SYNTHETIC_INVALIDATED'
        LIMIT 1
        """,
        (match_id, source_match_id),
    ).fetchone()
    if source_collision:
        raise RuntimeError(f"SOURCE_MATCH_ID_ALREADY_OWNED:{source_collision['id']}")
    provider_collision = conn.execute(
        """
        SELECT hub_match_id
        FROM provider_event_mappings
        WHERE provider_name = 'espn_site_api'
          AND provider_event_id = %s
          AND hub_match_id <> %s
        LIMIT 1
        """,
        (provider_event_id, match_id),
    ).fetchone()
    if provider_collision:
        raise RuntimeError(f"PROVIDER_EVENT_ALREADY_OWNED:{provider_collision['hub_match_id']}")


def _repair_resolved(
    conn: psycopg.Connection[Any], batch_id: str, resolution: dict[str, Any]
) -> None:
    match_id = str(resolution["match_id"])
    source_match_id = str(resolution["proposed_source_match_id"])
    provider_event_id = str(resolution["provider_event_id"])
    current = _current_match(conn, match_id)
    current_raw = dict(current["raw_data"] or {})
    if current_raw.get("source_match_id") != resolution["legacy_source_match_id"]:
        raise RuntimeError(f"IDENTITY_CHANGED_SINCE_PLAN:{match_id}")
    _assert_no_identity_collision(conn, match_id, source_match_id, provider_event_id)

    repaired_raw = {
        **current_raw,
        "source_match_id": source_match_id,
        "provider": "espn_site_api",
        "provider_event_id": provider_event_id,
        "provider_event_url": resolution.get("source_url"),
        "identity_repair": {
            "batch_id": batch_id,
            "scope": "LEGACY_SOURCE_COLLISION",
            "legacy_source_match_id": resolution["legacy_source_match_id"],
        },
    }
    old_match = {
        "raw_data": current_raw,
        "data_quality_flag": current["data_quality_flag"],
        "invalidated_at": current["invalidated_at"],
        "invalidated_reason": current["invalidated_reason"],
    }
    new_match = {
        "raw_data": repaired_raw,
        "data_quality_flag": "AUTHENTIC",
        "invalidated_at": None,
        "invalidated_reason": None,
    }
    _log_operation(conn, batch_id, match_id, "UPDATE", "matches.identity", old_match, new_match)
    conn.execute(
        """
        UPDATE matches
        SET raw_data = %s::jsonb,
            data_quality_flag = 'AUTHENTIC',
            invalidated_at = NULL,
            invalidated_reason = NULL
        WHERE id = %s
        """,
        (json.dumps(repaired_raw), match_id),
    )

    existing_mapping = conn.execute(
        """
        SELECT id
        FROM provider_event_mappings
        WHERE provider_name = 'espn_site_api' AND provider_event_id = %s
        """,
        (provider_event_id,),
    ).fetchone()
    if not existing_mapping:
        mapping = conn.execute(
            """
            INSERT INTO provider_event_mappings (
              hub_match_id, provider_name, provider_event_id, home_team_name,
              away_team_name, kickoff, is_active, last_verified, raw_data
            )
            VALUES (%s, 'espn_site_api', %s, %s, %s, %s, true, now(), %s::jsonb)
            RETURNING id
            """,
            (
                match_id,
                provider_event_id,
                resolution["home_team"],
                resolution["away_team"],
                resolution["match_date"],
                json.dumps({"source_url": resolution.get("source_url"), "repair_batch_id": batch_id}),
            ),
        ).fetchone()
        _log_operation(
            conn, batch_id, match_id, "INSERT", "provider_event_mappings",
            None, {"id": str(mapping["id"])},
        )

    expected_source_slug = f"espn-{resolution['league_slug']}"
    source_slug = resolve_source_slug(expected_source_slug)
    source = conn.execute("SELECT id FROM data_sources WHERE slug = %s", (source_slug,)).fetchone()
    if not source:
        raise RuntimeError(
            f"DATA_SOURCE_NOT_FOUND:{expected_source_slug}:resolved={source_slug}"
        )
    existing_ref = conn.execute(
        "SELECT id, match_id FROM source_match_refs WHERE source_id = %s AND source_match_id = %s",
        (source["id"], source_match_id),
    ).fetchone()
    if existing_ref and str(existing_ref["match_id"]) != match_id:
        raise RuntimeError(f"SOURCE_REF_ALREADY_OWNED:{existing_ref['match_id']}")
    if not existing_ref:
        source_ref = conn.execute(
            """
            INSERT INTO source_match_refs (source_id, match_id, source_match_id, source_url, raw_data)
            VALUES (%s, %s, %s, %s, %s::jsonb)
            RETURNING id
            """,
            (
                source["id"], match_id, source_match_id, resolution.get("source_url"),
                json.dumps({"provider_event_id": provider_event_id, "repair_batch_id": batch_id}),
            ),
        ).fetchone()
        _log_operation(
            conn, batch_id, match_id, "INSERT", "source_match_refs",
            None, {"id": str(source_ref["id"])},
        )


def _assert_repair_schema(conn: psycopg.Connection[Any]) -> None:
    row = conn.execute(
        """
        SELECT
          to_regclass('fixture_identity_batches') IS NOT NULL AS has_batches,
          to_regclass('fixture_identity_log') IS NOT NULL AS has_log,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'matches'
              AND column_name = 'data_quality_flag'
          ) AS has_quality
        """
    ).fetchone()
    if not row or not all(row.values()):
        raise RuntimeError("MIGRATION_059_REQUIRED")


def apply_identity_plan(
    plan: dict[str, Any],
    approved_invalid_ids: set[str],
    backup: BackupArtifact,
) -> dict[str, Any]:
    batch_id = str(uuid.uuid4())
    counts = {
        "AUTHENTIC": 0,
        "UNRESOLVED_PENDING_REVIEW": 0,
        "SYNTHETIC_INVALIDATED": 0,
        "AMBIGUOUS_PENDING_REVIEW": 0,
        "COLLISION_PENDING_REVIEW": 0,
    }
    validate_invalidation_approvals(plan, approved_invalid_ids)

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        _assert_repair_schema(conn)
        got_lock = conn.execute("SELECT pg_try_advisory_xact_lock(%s) AS locked", (LOCK_ID,)).fetchone()
        if not got_lock or not got_lock["locked"]:
            raise RuntimeError("FIXTURE_IDENTITY_REPAIR_ALREADY_RUNNING")
        conn.execute(
            """
            INSERT INTO fixture_identity_batches
              (batch_id, repair_scope, status, backup_path, backup_sha256)
            VALUES (%s, 'LEGACY_SOURCE_COLLISION', 'RUNNING', %s, %s)
            """,
            (batch_id, str(backup.path), backup.sha256),
        )

        for resolution in plan["resolutions"]:
            match_id = str(resolution["match_id"])
            if resolution["resolution_state"] == "RESOLVED":
                try:
                    with conn.transaction():
                        _repair_resolved(conn, batch_id, resolution)
                    counts["AUTHENTIC"] += 1
                except RuntimeError as exc:
                    with conn.transaction():
                        _set_quality(conn, batch_id, match_id, "AMBIGUOUS_PENDING_REVIEW", str(exc))
                    counts["COLLISION_PENDING_REVIEW"] += 1
            elif match_id in approved_invalid_ids:
                _set_quality(
                    conn, batch_id, match_id, "SYNTHETIC_INVALIDATED", str(resolution.get("reason")),
                )
                counts["SYNTHETIC_INVALIDATED"] += 1
            else:
                _set_quality(conn, batch_id, match_id, "UNRESOLVED_PENDING_REVIEW", None)
                counts["UNRESOLVED_PENDING_REVIEW"] += 1

        planned_ids = {str(row["match_id"]) for row in plan["resolutions"]}
        for match_id in plan["ambiguous_match_ids"]:
            if match_id in planned_ids:
                continue
            _set_quality(conn, batch_id, match_id, "AMBIGUOUS_PENDING_REVIEW", None)
            counts["AMBIGUOUS_PENDING_REVIEW"] += 1

        conn.execute(
            """
            UPDATE fixture_identity_batches
            SET status = 'COMPLETED', completed_at = now(), summary = %s::jsonb
            WHERE batch_id = %s
            """,
            (json.dumps(counts), batch_id),
        )
    return {"batch_id": batch_id, "counts": counts, "backup": str(backup.path)}


def validate_invalidation_approvals(plan: dict[str, Any], approved_invalid_ids: set[str]) -> None:
    unresolved_ids = {
        str(row["match_id"])
        for row in plan["resolutions"]
        if row["resolution_state"] != "RESOLVED"
    }
    unknown_approvals = approved_invalid_ids - unresolved_ids
    if unknown_approvals:
        raise RuntimeError(f"INVALIDATION_NOT_IN_UNRESOLVED_PLAN:{sorted(unknown_approvals)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-match-id", default=None)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--timeout", type=int, default=15)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--max-rows-per-group", type=int, default=None)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-writers-paused", action="store_true")
    parser.add_argument("--approve-invalid-match-id", action="append", default=[])
    parser.add_argument("--plan-output", type=Path)
    parser.add_argument("--plan-input", type=Path)
    parser.add_argument("--plan-sha256")
    parser.add_argument("--approval-report", type=Path)
    parser.add_argument("--approval-report-sha256")
    parser.add_argument(
        "--backup-dir", type=Path, default=Path(os.getenv("BACKUP_DIR", "backups"))
    )
    args = parser.parse_args()

    if args.plan_input and args.plan_output:
        parser.error("Usa --plan-input o --plan-output, no ambos.")
    if args.plan_input:
        if not args.plan_sha256:
            parser.error("--plan-input exige --plan-sha256.")
        plan = load_identity_plan(args.plan_input, args.plan_sha256)
    else:
        plan = build_identity_plan(
            args.source_match_id, args.limit, args.timeout, args.retries, args.max_rows_per_group,
        )
    if args.plan_output:
        plan_sha256 = write_identity_plan(args.plan_output, plan)
        print(json.dumps({
            "plan_path": str(args.plan_output),
            "plan_sha256": plan_sha256,
            "replayable_group_count": plan["replayable_group_count"],
            "ambiguous_group_count": plan["ambiguous_group_count"],
            "rows_planned": plan["rows_planned"],
            "resolved_count": plan["resolved_count"],
            "unresolved_pending_review_count": plan["unresolved_pending_review_count"],
            "ambiguous_pending_review_count": plan["ambiguous_pending_review_count"],
            "database_writes_executed": plan["database_writes_executed"],
        }, indent=2))
        if not args.apply:
            return
    if not args.apply:
        print(json.dumps(plan, default=str, indent=2))
        return
    if not args.confirm_writers_paused:
        parser.error("--apply exige --confirm-writers-paused y una ventana sin escritores.")

    approved_invalid_ids = set(args.approve_invalid_match_id)
    if args.approval_report:
        if not args.approval_report_sha256:
            parser.error("--approval-report exige --approval-report-sha256.")
        if not args.plan_sha256:
            parser.error("--approval-report exige un --plan-sha256.")
        approved_invalid_ids |= load_approved_invalid_ids(
            args.approval_report, args.approval_report_sha256, args.plan_sha256,
        )

    assert_quality_query_gate(Path(__file__).resolve().parent.parent)
    backup = ensure_fresh_backup(
        DATABASE_URL,
        backup_dir=args.backup_dir,
        compose_file=Path("docker-compose.yml"),
    )
    result = apply_identity_plan(plan, approved_invalid_ids, backup)
    print(json.dumps(result, default=str, indent=2))


if __name__ == "__main__":
    main()
