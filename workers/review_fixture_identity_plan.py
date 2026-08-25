"""Build an auditable, conservative invalidation approval report from a signed plan."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from audit_espn_soccer_duplicate_fixtures import _match_foreign_keys, audit
from reidentify_and_invalidate import load_identity_plan


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)
CREATED_NEAR_KICKOFF_SECONDS = 120
EXPECTED_COMPETITOR_COUNT = 2
DERIVED_REFERENCE_ALLOWLIST = {"team_stat_snapshots.match_id": {2}}


def classify_unresolved_row(row: dict[str, Any]) -> tuple[str, list[str]]:
    reasons: list[str] = []
    delta = row.get("created_kickoff_delta_seconds")
    if delta is None or float(delta) > CREATED_NEAR_KICKOFF_SECONDS:
        reasons.append("created_not_near_kickoff")
    if row.get("status") != "scheduled":
        reasons.append("status_not_scheduled")
    if int(row.get("source_ref_count", 0)) != 0:
        reasons.append("has_source_ref")
    if int(row.get("provider_mapping_count", 0)) != 0:
        reasons.append("has_provider_mapping")
    if int(row.get("competitor_count", 0)) != EXPECTED_COMPETITOR_COUNT:
        reasons.append("unexpected_competitor_count")
    non_competitor_references = dict(row.get("non_competitor_references") or {})
    unsupported_references = {
        key: count
        for key, count in non_competitor_references.items()
        if key not in DERIVED_REFERENCE_ALLOWLIST
        or int(count) not in DERIVED_REFERENCE_ALLOWLIST[key]
    }
    if unsupported_references:
        reasons.append("has_non_competitor_references")
    raw_data = dict(row.get("raw_data") or {})
    if not str(raw_data.get("source_match_id") or "").startswith("espn-"):
        reasons.append("legacy_source_id_missing")
    if raw_data.get("home_odds") is not None or raw_data.get("away_odds") is not None:
        reasons.append("has_odds")
    return ("APPROVED_SYNTHETIC" if not reasons else "KEEP_PENDING_REVIEW", reasons)


def _reference_counts_by_match(
    conn: psycopg.Connection[Any], match_ids: list[str]
) -> dict[str, dict[str, int]]:
    counts = {match_id: {} for match_id in match_ids}
    for foreign_key in _match_foreign_keys(conn):
        table_name = str(foreign_key["table_name"])
        column_name = str(foreign_key["column_name"])
        qualified_table = sql.SQL(".").join(sql.Identifier(part) for part in table_name.split("."))
        rows = conn.execute(
            sql.SQL(
                "SELECT {column}::text AS match_id, COUNT(*)::int AS count "
                "FROM {table} WHERE {column} = ANY(%s::uuid[]) GROUP BY {column}"
            ).format(column=sql.Identifier(column_name), table=qualified_table),
            (match_ids,),
        ).fetchall()
        key = f"{table_name}.{column_name}"
        for row in rows:
            counts[str(row["match_id"])][key] = int(row["count"])
    return counts


def review_plan(plan: dict[str, Any], plan_sha256: str | None = None) -> dict[str, Any]:
    unresolved = {
        str(row["match_id"]): row
        for row in plan["resolutions"]
        if row["resolution_state"] != "RESOLVED"
    }
    match_ids = sorted(unresolved)
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        reference_counts = _reference_counts_by_match(conn, match_ids)
        matches = conn.execute(
            """
            SELECT id, match_date, created_at, updated_at, status::text AS status, raw_data,
                   ABS(EXTRACT(EPOCH FROM (match_date - created_at))) AS created_kickoff_delta_seconds,
                   (SELECT COUNT(*)::int FROM source_match_refs WHERE match_id = matches.id)
                     AS source_ref_count,
                   (SELECT COUNT(*)::int FROM provider_event_mappings WHERE hub_match_id = matches.id)
                     AS provider_mapping_count,
                   (SELECT COUNT(*)::int FROM match_competitors WHERE match_id = matches.id)
                     AS competitor_count
            FROM matches
            WHERE id = ANY(%s::uuid[])
            ORDER BY match_date, id
            """,
            (match_ids,),
        ).fetchall()

    reviewed_rows: list[dict[str, Any]] = []
    for match in matches:
        match_id = str(match["id"])
        refs = reference_counts[match_id]
        non_competitor_refs = {
            key: count
            for key, count in refs.items()
            if key != "match_competitors.match_id" and count > 0
        }
        review_input = {
            **match,
            "id": match_id,
            "non_competitor_references": non_competitor_refs,
        }
        decision, reasons = classify_unresolved_row(review_input)
        reviewed_rows.append({
            "match_id": match_id,
            "legacy_source_match_id": unresolved[match_id].get("legacy_source_match_id"),
            "match_date": match["match_date"],
            "created_at": match["created_at"],
            "created_kickoff_delta_seconds": match["created_kickoff_delta_seconds"],
            "status": match["status"],
            "source_ref_count": match["source_ref_count"],
            "provider_mapping_count": match["provider_mapping_count"],
            "competitor_count": match["competitor_count"],
            "non_competitor_references": non_competitor_refs,
            "decision": decision,
            "reasons": reasons,
        })

    current_audit = audit(source_match_id=None, limit=100)
    ambiguous_groups = [
        {
            "source_match_id": group["source_match_id"],
            "match_count": group["match_count"],
            "source_ref_owner_count": group["source_ref_owner_count"],
            "provider_mapped_match_count": group["provider_mapped_match_count"],
        }
        for group in current_audit["groups"]
        if group["repair_state"] == "BLOCKED_SOURCE_REF_AMBIGUOUS"
    ]
    approved_ids = [
        row["match_id"] for row in reviewed_rows if row["decision"] == "APPROVED_SYNTHETIC"
    ]
    return {
        "reviewed_at": datetime.now().astimezone().isoformat(),
        "plan_generated_at": plan.get("generated_at"),
        "plan_sha256": plan_sha256,
        "criteria": {
            "created_near_kickoff_seconds": CREATED_NEAR_KICKOFF_SECONDS,
            "required_status": "scheduled",
            "source_ref_count": 0,
            "provider_mapping_count": 0,
            "allowed_direct_references": {
                "match_competitors.match_id": 2,
                "team_stat_snapshots.match_id": 2,
            },
            "odds_required_absent": True,
        },
        "plan_counts": {
            "replayable_group_count": plan["replayable_group_count"],
            "ambiguous_group_count": plan["ambiguous_group_count"],
            "resolved_count": plan["resolved_count"],
            "unresolved_count": plan["unresolved_pending_review_count"],
        },
        "current_ambiguous_groups": ambiguous_groups,
        "approved_invalid_match_ids": approved_ids,
        "approved_invalid_count": len(approved_ids),
        "kept_pending_count": len(reviewed_rows) - len(approved_ids),
        "rows": reviewed_rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan-input", type=Path, required=True)
    parser.add_argument("--plan-sha256", required=True)
    parser.add_argument("--report-output", type=Path, required=True)
    args = parser.parse_args()
    plan = load_identity_plan(args.plan_input, args.plan_sha256)
    report = review_plan(plan, args.plan_sha256.lower())
    args.report_output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(report, default=str, indent=2, sort_keys=True).encode("utf-8")
    args.report_output.write_bytes(payload)
    report_sha256 = hashlib.sha256(payload).hexdigest()
    print(json.dumps({
        "report_path": str(args.report_output),
        "report_sha256": report_sha256,
        "approved_invalid_count": report["approved_invalid_count"],
        "kept_pending_count": report["kept_pending_count"],
        "current_ambiguous_group_count": len(report["current_ambiguous_groups"]),
    }, indent=2))


if __name__ == "__main__":
    main()
