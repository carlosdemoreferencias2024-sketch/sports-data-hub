from __future__ import annotations

from enum import Enum
from typing import Any


class RepairState(str, Enum):
    NEEDS_PROVIDER_EVENT_REPLAY = "NEEDS_PROVIDER_EVENT_REPLAY"
    BLOCKED_SOURCE_REF_AMBIGUOUS = "BLOCKED_SOURCE_REF_AMBIGUOUS"
    READY_FOR_MANUAL_MERGE_REVIEW = "READY_FOR_MANUAL_MERGE_REVIEW"


def classify_group(group: dict[str, Any]) -> RepairState:
    matches = list(group.get("matches") or [])
    source_ref_owner_count = int(
        group.get(
            "source_ref_owner_count",
            sum(1 for match in matches if match.get("owns_source_ref")),
        )
    )
    provider_mapped_match_count = int(
        group.get(
            "provider_mapped_match_count",
            sum(1 for match in matches if match.get("provider_mappings")),
        )
    )

    if source_ref_owner_count != 1:
        return RepairState.BLOCKED_SOURCE_REF_AMBIGUOUS
    if provider_mapped_match_count < len(matches):
        return RepairState.NEEDS_PROVIDER_EVENT_REPLAY
    return RepairState.READY_FOR_MANUAL_MERGE_REVIEW


def filter_by_state(groups: list[dict[str, Any]], state: RepairState) -> list[dict[str, Any]]:
    return [group for group in groups if classify_group(group) is state]


clasificar_grupo = classify_group
filtrar_por_estado = filter_by_state
