"""Generate a signed, grouped review of unresolved rows from one repair batch."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fixture_review_report_common import (
    batch_quality_match_ids,
    connect,
    load_signed_plan,
    match_contexts,
    write_report,
)


def age_bucket(match_date: datetime | None, now: datetime) -> str:
    if not match_date:
        return "missing_date"
    days = (now - match_date).days
    if days < 30:
        return "under_30_days"
    if days < 180:
        return "30_to_179_days"
    return "180_days_or_more"


def classify_unresolved(row: dict[str, Any], plan_reason: str) -> str:
    if plan_reason.startswith("ESPN_LEAGUE_UNSUPPORTED:"):
        return "SCRAPER_LEAGUE_MAPPING_MISSING"
    references = dict(row.get("direct_reference_counts") or {})
    meaningful_refs = {
        key: count for key, count in references.items()
        if key not in {"match_competitors.match_id", "team_stat_snapshots.match_id"}
        and int(count) > 0
    }
    raw_data = dict(row.get("raw_data") or {})
    has_odds = raw_data.get("home_odds") is not None or raw_data.get("away_odds") is not None
    if meaningful_refs or has_odds or int(row.get("source_ref_count", 0)) > 0:
        return "HAS_INDEPENDENT_EVIDENCE_KEEP_PENDING"
    return "HISTORICAL_PROVIDER_LOOKUP_GAP"


def build_report(
    batch_id: str, plan: dict[str, Any], plan_sha256: str
) -> dict[str, Any]:
    resolutions = {str(row["match_id"]): row for row in plan["resolutions"]}
    with connect() as conn:
        batch_ids = batch_quality_match_ids(conn, batch_id, "UNRESOLVED_PENDING_REVIEW")
        contexts = match_contexts(conn, batch_ids)

    now = datetime.now(UTC)
    rows: list[dict[str, Any]] = []
    for match_id in batch_ids:
        context = contexts.get(match_id)
        resolution = resolutions.get(match_id)
        if not context or not resolution:
            raise RuntimeError(f"UNRESOLVED_NOT_IN_SIGNED_PLAN:{match_id}")
        reason = str(resolution.get("reason") or "UNKNOWN")
        classification = classify_unresolved(context, reason)
        rows.append({
            "match_id": match_id,
            "classification": classification,
            "plan_reason": reason,
            "age_bucket": age_bucket(context["match_date"], now),
            "match": context,
        })

    by_league = Counter(row["match"]["league_slug"] for row in rows)
    by_reason = Counter(row["plan_reason"] for row in rows)
    by_age = Counter(row["age_bucket"] for row in rows)
    by_classification = Counter(row["classification"] for row in rows)
    return {
        "generated_at": now.isoformat(),
        "mode": "READ_ONLY_REVIEW",
        "batch_id": batch_id,
        "plan_sha256": plan_sha256.lower(),
        "unresolved_count": len(rows),
        "grouping": {
            "by_league": dict(by_league.most_common()),
            "by_plan_reason": dict(by_reason.most_common()),
            "by_age": dict(by_age.most_common()),
            "by_classification": dict(by_classification.most_common()),
        },
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
        "unresolved_count": report["unresolved_count"],
        "grouping": report["grouping"],
        "database_writes_executed": False,
    }, indent=2))


if __name__ == "__main__":
    main()
