from __future__ import annotations

import argparse
import json
from typing import Any, Callable

from audit_espn_soccer_duplicate_fixtures import audit
from espn_soccer_scraper import discover_event
from fk_migration_policy import RepairScope
from fixture_repair_state import RepairState, filter_by_state
from soccer_scraper import make_source_match_id


EventResolver = Callable[..., tuple[dict, dict, str]]


def load_groups(state: RepairState, limit: int = 100) -> list[dict[str, Any]]:
    result = audit(source_match_id=None, limit=limit)
    return filter_by_state(list(result["groups"]), state)


def cargar_grupos_replayables(limit: int = 100) -> list[dict[str, Any]]:
    return load_groups(RepairState.NEEDS_PROVIDER_EVENT_REPLAY, limit)


def cargar_grupos_ambiguos(limit: int = 100) -> list[dict[str, Any]]:
    return load_groups(RepairState.BLOCKED_SOURCE_REF_AMBIGUOUS, limit)


def resolve_row(
    group: dict[str, Any],
    row: dict[str, Any],
    timeout: int = 15,
    resolver: EventResolver = discover_event,
) -> dict[str, Any]:
    match_date = str(row["match_date"])
    home_team = str(row.get("home_team") or "").strip()
    away_team = str(row.get("away_team") or "").strip()
    base = {
        "match_id": str(row["id"]),
        "legacy_source_match_id": str(group["source_match_id"]),
        "match_date": match_date,
        "home_team": home_team,
        "away_team": away_team,
    }
    if not home_team or not away_team:
        return {**base, "resolution_state": "UNRESOLVED", "reason": "TEAM_IDENTITY_INCOMPLETE"}

    try:
        event, _, source_url = resolver(
            date_key=match_date[:10].replace("-", ""),
            expected_home=home_team,
            expected_away=away_team,
            timeout=timeout,
            league_slug=str(group["league_slug"]),
            allow_post_kickoff=True,
        )
    except RuntimeError as exc:
        return {**base, "resolution_state": "UNRESOLVED", "reason": str(exc)}

    provider_event_id = str(event.get("id") or "").strip()
    if not provider_event_id:
        return {**base, "resolution_state": "UNRESOLVED", "reason": "PROVIDER_EVENT_ID_MISSING"}

    proposed_source_match_id = make_source_match_id(
        league_slug=str(group["league_slug"]),
        home_alias=home_team,
        away_alias=away_team,
        match_date=match_date,
        provider_event_id=provider_event_id,
    )
    return {
        **base,
        "resolution_state": "RESOLVED",
        "provider_event_id": provider_event_id,
        "proposed_source_match_id": proposed_source_match_id,
        "source_url": source_url,
    }


def plan_group(
    group: dict[str, Any],
    timeout: int = 15,
    max_rows: int | None = None,
    resolver: EventResolver = discover_event,
) -> dict[str, Any]:
    rows = list(group.get("matches") or [])
    if max_rows is not None:
        rows = rows[:max_rows]
    resolutions = [resolve_row(group, row, timeout, resolver) for row in rows]
    resolved = [row for row in resolutions if row["resolution_state"] == "RESOLVED"]
    provider_event_counts: dict[str, int] = {}
    for row in resolved:
        event_id = str(row["provider_event_id"])
        provider_event_counts[event_id] = provider_event_counts.get(event_id, 0) + 1

    return {
        "source_match_id": group["source_match_id"],
        "league_slug": group["league_slug"],
        "repair_state": group["repair_state"],
        "suggested_canonical_match_id": group.get("suggested_canonical_match_id"),
        "rows_in_group": len(group.get("matches") or []),
        "rows_planned": len(resolutions),
        "resolved_count": len(resolved),
        "unresolved_count": len(resolutions) - len(resolved),
        "provider_event_reuse": {
            event_id: count for event_id, count in provider_event_counts.items() if count > 1
        },
        "resolutions": resolutions,
    }


def build_replay_plan(limit: int, timeout: int, max_rows_per_group: int | None) -> dict[str, Any]:
    audit_result = audit(source_match_id=None, limit=limit)
    groups = list(audit_result["groups"])
    replayable = filter_by_state(groups, RepairState.NEEDS_PROVIDER_EVENT_REPLAY)
    ambiguous = filter_by_state(groups, RepairState.BLOCKED_SOURCE_REF_AMBIGUOUS)
    plans = [plan_group(group, timeout, max_rows_per_group) for group in replayable]
    return {
        "mode": "dry_run",
        "repair_scope": RepairScope.LEGACY_SOURCE_COLLISION.value,
        "replayable_group_count": len(replayable),
        "ambiguous_group_count": len(ambiguous),
        "resolved_row_count": sum(plan["resolved_count"] for plan in plans),
        "unresolved_row_count": sum(plan["unresolved_count"] for plan in plans),
        "plans": plans,
        "ambiguous_groups": [
            {
                "source_match_id": group["source_match_id"],
                "league_slug": group["league_slug"],
                "match_count": group["match_count"],
                "source_ref_owner_count": group["source_ref_owner_count"],
            }
            for group in ambiguous
        ],
        "database_writes_executed": False,
        "foreign_key_remap_allowed": False,
        "warning": (
            "Este comando solo genera un plan. LEGACY_SOURCE_COLLISION no autoriza remapear "
            "claves foraneas: las filas sinteticas pueden contener features, quotes o snapshots "
            "que no pertenecen al fixture canonico."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Genera un plan de replay ESPN para colisiones legacy sin modificar la base."
    )
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--timeout", type=int, default=15)
    parser.add_argument("--max-rows-per-group", type=int, default=None)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.apply:
        parser.error(
            "--apply no esta habilitado: faltan reglas transaccionales para las referencias reales."
        )
    result = build_replay_plan(args.limit, args.timeout, args.max_rows_per_group)
    print(json.dumps(result, default=str, indent=2))


if __name__ == "__main__":
    main()
