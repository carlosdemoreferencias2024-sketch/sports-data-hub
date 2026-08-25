"""Generate a signed, read-only report for collision rows from one repair batch."""

from __future__ import annotations

import argparse
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from espn_soccer_scraper import league_provider_slugs
from fixture_review_report_common import (
    batch_quality_match_ids,
    connect,
    load_signed_plan,
    match_contexts,
    write_report,
)


OWNER_REASON = re.compile(r"^SOURCE_MATCH_ID_ALREADY_OWNED:([0-9a-f-]{36})$")
SOURCE_REASON = re.compile(r"^DATA_SOURCE_NOT_FOUND:(.+)$")


def classify_collision(
    blocked: dict[str, Any], owner: dict[str, Any] | None, resolution: dict[str, Any]
) -> str:
    if blocked.get("invalidated_reason", "").startswith("DATA_SOURCE_NOT_FOUND:"):
        return "DATA_SOURCE_ALIAS_MISSING"
    if not owner:
        return "OWNER_NOT_FOUND"
    same_event = (
        blocked.get("match_date") == owner.get("match_date")
        and blocked.get("home_team") == owner.get("home_team")
        and blocked.get("away_team") == owner.get("away_team")
        and dict(owner.get("raw_data") or {}).get("source_match_id")
        == resolution.get("proposed_source_match_id")
    )
    if same_event and owner.get("data_quality_flag") == "AUTHENTIC":
        return "EXACT_EVENT_DUPLICATE_OWNER_PRESENT"
    return "IDENTITY_COLLISION_REQUIRES_REVIEW"


def build_report(
    batch_id: str, plan: dict[str, Any], plan_sha256: str
) -> dict[str, Any]:
    resolutions = {str(row["match_id"]): row for row in plan["resolutions"]}
    with connect() as conn:
        batch_ids = batch_quality_match_ids(conn, batch_id, "AMBIGUOUS_PENDING_REVIEW")
        batch_context = match_contexts(conn, batch_ids)
        collision_ids = [
            match_id for match_id in batch_ids
            if batch_context.get(match_id, {}).get("invalidated_reason")
        ]
        owner_ids = []
        for match_id in collision_ids:
            match = OWNER_REASON.match(str(batch_context[match_id]["invalidated_reason"]))
            if match:
                owner_ids.append(match.group(1))
        owner_context = match_contexts(conn, owner_ids)
        sources = conn.execute(
            "SELECT slug, name FROM data_sources WHERE slug LIKE 'espn%' ORDER BY slug"
        ).fetchall()

    rows: list[dict[str, Any]] = []
    for match_id in collision_ids:
        blocked = batch_context[match_id]
        resolution = resolutions.get(match_id)
        if not resolution:
            raise RuntimeError(f"COLLISION_NOT_IN_SIGNED_PLAN:{match_id}")
        reason = str(blocked["invalidated_reason"])
        owner_match = OWNER_REASON.match(reason)
        source_match = SOURCE_REASON.match(reason)
        owner = owner_context.get(owner_match.group(1)) if owner_match else None
        expected_source_slug = source_match.group(1) if source_match else None
        alternatives = [
            dict(source) for source in sources
            if expected_source_slug and (
                blocked["league_slug"] in source["slug"]
                or (blocked["league_slug"] == "liga-mx" and source["slug"] == "espn-mexico")
            )
        ]
        try:
            provider_slugs = league_provider_slugs(blocked["league_slug"])
        except RuntimeError as exc:
            provider_slugs = [str(exc)]
        rows.append({
            "match_id": match_id,
            "classification": classify_collision(blocked, owner, resolution),
            "blocked_match": blocked,
            "signed_resolution": resolution,
            "current_owner": owner,
            "expected_data_source_slug": expected_source_slug,
            "existing_source_alternatives": alternatives,
            "espn_provider_slugs": provider_slugs,
        })

    counts: dict[str, int] = {}
    for row in rows:
        counts[row["classification"]] = counts.get(row["classification"], 0) + 1
    return {
        "generated_at": datetime.now(UTC).isoformat(),
        "mode": "READ_ONLY_REVIEW",
        "batch_id": batch_id,
        "plan_sha256": plan_sha256.lower(),
        "collision_count": len(rows),
        "classification_counts": counts,
        "rows": rows,
        "database_writes_executed": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--plan-input", type=Path, required=True)
    parser.add_argument("--plan-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    plan = load_signed_plan(args.plan_input, args.plan_sha256)
    report = build_report(args.batch_id, plan, args.plan_sha256)
    digest = write_report(args.output, report)
    print(json.dumps({
        "output": str(args.output),
        "sha256": digest,
        "collision_count": report["collision_count"],
        "classification_counts": report["classification_counts"],
        "database_writes_executed": False,
    }, indent=2))


if __name__ == "__main__":
    main()
