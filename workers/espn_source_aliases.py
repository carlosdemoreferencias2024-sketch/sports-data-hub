"""Compatibility aliases between ESPN league keys and persisted data-source slugs."""

from __future__ import annotations


SOURCE_SLUG_ALIASES = {
    "espn-liga-mx": "espn-mexico",
}


def resolve_source_slug(expected_slug: str) -> str:
    """Return the persisted data-source slug for an ESPN league source."""
    normalized = str(expected_slug).strip().lower()
    return SOURCE_SLUG_ALIASES.get(normalized, normalized)
