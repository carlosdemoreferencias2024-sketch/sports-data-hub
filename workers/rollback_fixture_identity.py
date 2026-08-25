"""Rollback one completed fixture-identity batch from its row-level operation log."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from ensure_fresh_backup import ensure_fresh_backup


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)
LOCK_ID = 918273645
INSERT_OBJECTS = {"provider_event_mappings", "source_match_refs"}


def _restore_match(conn: psycopg.Connection[Any], log: dict[str, Any]) -> None:
    old = dict(log["old_value"] or {})
    new = dict(log["new_value"] or {})
    current = conn.execute(
        """
        SELECT raw_data, data_quality_flag, invalidated_at, invalidated_reason,
               duplicate_of_match_id
        FROM matches WHERE id = %s FOR UPDATE
        """,
        (log["match_id"],),
    ).fetchone()
    if not current:
        raise RuntimeError(f"MATCH_NOT_FOUND:{log['match_id']}")
    if current["data_quality_flag"] != new.get("data_quality_flag"):
        raise RuntimeError(f"MATCH_CHANGED_AFTER_BATCH:{log['match_id']}")
    if log["object_name"] == "matches.identity" and current["raw_data"] != new.get("raw_data"):
        raise RuntimeError(f"MATCH_IDENTITY_CHANGED_AFTER_BATCH:{log['match_id']}")
    if (
        log["object_name"] == "matches.duplicate_quality"
        and str(current["duplicate_of_match_id"]) != str(new.get("duplicate_of_match_id"))
    ):
        raise RuntimeError(f"MATCH_DUPLICATE_OWNER_CHANGED_AFTER_BATCH:{log['match_id']}")
    restore_duplicate_owner = "duplicate_of_match_id" in old
    conn.execute(
        """
        UPDATE matches
        SET raw_data = COALESCE(%s::jsonb, raw_data),
            data_quality_flag = %s,
            invalidated_at = %s,
            invalidated_reason = %s,
            duplicate_of_match_id = CASE WHEN %s THEN %s ELSE duplicate_of_match_id END
        WHERE id = %s
        """,
        (
            json.dumps(old.get("raw_data")) if "raw_data" in old else None,
            old["data_quality_flag"],
            old.get("invalidated_at"),
            old.get("invalidated_reason"),
            restore_duplicate_owner,
            old.get("duplicate_of_match_id"),
            log["match_id"],
        ),
    )


def rollback_batch(batch_id: str) -> dict[str, int]:
    counts = {"matches_restored": 0, "inserted_rows_removed": 0}
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        lock = conn.execute("SELECT pg_try_advisory_xact_lock(%s) AS locked", (LOCK_ID,)).fetchone()
        if not lock or not lock["locked"]:
            raise RuntimeError("FIXTURE_IDENTITY_REPAIR_ALREADY_RUNNING")
        batch = conn.execute(
            "SELECT status FROM fixture_identity_batches WHERE batch_id = %s FOR UPDATE",
            (batch_id,),
        ).fetchone()
        if not batch or batch["status"] != "COMPLETED":
            raise RuntimeError("BATCH_NOT_COMPLETED_OR_NOT_FOUND")
        logs = conn.execute(
            "SELECT * FROM fixture_identity_log WHERE batch_id = %s ORDER BY id DESC",
            (batch_id,),
        ).fetchall()
        for log in logs:
            if log["operation"] == "INSERT" and log["object_name"] in INSERT_OBJECTS:
                row_id = str((log["new_value"] or {})["id"])
                table = log["object_name"]
                if table == "provider_event_mappings":
                    result = conn.execute(
                        "DELETE FROM provider_event_mappings WHERE id = %s AND hub_match_id = %s",
                        (row_id, log["match_id"]),
                    )
                else:
                    result = conn.execute(
                        "DELETE FROM source_match_refs WHERE id = %s AND match_id = %s",
                        (row_id, log["match_id"]),
                    )
                if result.rowcount != 1:
                    raise RuntimeError(f"INSERTED_ROW_CHANGED_AFTER_BATCH:{table}:{row_id}")
                counts["inserted_rows_removed"] += 1
            elif log["operation"] == "UPDATE" and log["object_name"] in {
                "matches.identity", "matches.quality", "matches.duplicate_quality"
            }:
                _restore_match(conn, log)
                counts["matches_restored"] += 1
            else:
                raise RuntimeError(f"UNSUPPORTED_LOG_OPERATION:{log['id']}")
        conn.execute(
            """
            UPDATE fixture_identity_batches
            SET status = 'ROLLED_BACK', completed_at = now(),
                summary = summary || %s::jsonb
            WHERE batch_id = %s
            """,
            (json.dumps({"rollback": counts}), batch_id),
        )
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--confirm-writers-paused", action="store_true")
    parser.add_argument(
        "--backup-dir", type=Path, default=Path(os.getenv("BACKUP_DIR", "backups"))
    )
    args = parser.parse_args()
    if not args.apply:
        parser.error("Rollback requiere --apply; no existe modo de escritura implicito.")
    if not args.confirm_writers_paused:
        parser.error("Rollback exige --confirm-writers-paused.")
    backup = ensure_fresh_backup(
        DATABASE_URL, backup_dir=args.backup_dir, compose_file=Path("docker-compose.yml")
    )
    result = rollback_batch(args.batch_id)
    print(json.dumps({"backup": str(backup.path), "rollback": result}, indent=2))


if __name__ == "__main__":
    main()
