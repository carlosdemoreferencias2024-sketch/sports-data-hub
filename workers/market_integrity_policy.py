"""Strict market-data integrity gates shared by alpha and settlement workers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


ALLOWED_MARKET_SOURCES = {
    "sportsbook_manual_verified",
    "bookmaker_manual_verified",
    "sportsdataio_manual_verified",
    "the_odds_api_manual_verified",
}


def _parse_timestamp(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes"}


def _common_reasons(snapshot: dict[str, Any]) -> list[str]:
    reasons: list[str] = []
    if not _bool(snapshot.get("canonical_match")):
        reasons.append("MATCH_NOT_CANONICAL")
    if _bool(snapshot.get("duplicate")):
        reasons.append("DUPLICATE_EXPOSURE")
    if str(snapshot.get("source_name") or "").strip().lower() not in ALLOWED_MARKET_SOURCES:
        reasons.append("SOURCE_NOT_ALLOWED")
    if not snapshot.get("evidence_id") or not snapshot.get("screenshot_sha256"):
        reasons.append("EVIDENCE_MISSING")
    return reasons


def _decision(status_ok: str, status_bad: str, reasons: list[str]) -> dict[str, Any]:
    unique = list(dict.fromkeys(reasons))
    return {
        "eligible": not unique,
        "status": status_ok if not unique else status_bad,
        "reasons": unique,
        "audit_only": bool(unique),
    }


def validate_entry_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    reasons = _common_reasons(snapshot)
    role = str(snapshot.get("snapshot_type") or "").strip().lower()
    if role not in {"entry", "current"}:
        reasons.append("ENTRY_ROLE_INVALID")
    if not _bool(snapshot.get("safe_for_entry")):
        reasons.append("SAFE_FOR_ENTRY_FALSE")
    captured = _parse_timestamp(snapshot.get("captured_at"))
    kickoff = _parse_timestamp(snapshot.get("kickoff"))
    if captured is None:
        reasons.append("INVALID_CAPTURE_TIMESTAMP")
    if kickoff is None:
        reasons.append("INVALID_KICKOFF_TIMESTAMP" if snapshot.get("kickoff") else "MISSING_KICKOFF")
    if captured is not None and kickoff is not None and captured >= kickoff:
        reasons.append("ENTRY_NOT_PREGAME")
    if str(snapshot.get("stale_status") or "").strip().lower() != "fresh":
        reasons.append("ENTRY_STALE")
    return _decision("ENTRY_VALID", "ENTRY_AUDIT_ONLY", reasons)


def closing_window_quality(captured_at: Any, kickoff_at: Any) -> str:
    captured = _parse_timestamp(captured_at)
    kickoff = _parse_timestamp(kickoff_at)
    if captured is None:
        return "INVALID_CAPTURE_TIMESTAMP"
    if kickoff is None:
        return "INVALID_KICKOFF_TIMESTAMP" if kickoff_at else "MISSING_KICKOFF"
    minutes_before = (kickoff - captured).total_seconds() / 60.0
    if 3.0 <= minutes_before <= 10.0:
        return "CAPTURED_ON_TIME"
    return "CAPTURED_TOO_EARLY" if minutes_before > 10.0 else "CAPTURED_LATE"


def validate_closing_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    reasons = _common_reasons(snapshot)
    if str(snapshot.get("snapshot_type") or "").strip().lower() != "closing":
        reasons.append("CLOSING_ROLE_INVALID")
    if not _bool(snapshot.get("safe_for_closing")):
        reasons.append("SAFE_FOR_CLOSING_FALSE")
    quality = closing_window_quality(snapshot.get("captured_at"), snapshot.get("kickoff"))
    if quality != "CAPTURED_ON_TIME":
        reasons.append(quality)
    decision = _decision("CLOSING_VALID", "CLOSING_AUDIT_ONLY", reasons)
    decision["closing_quality"] = quality
    return decision


def validate_settlement_eligibility(
    entry: dict[str, Any],
    closing: dict[str, Any],
    *,
    result_final: bool,
    result_source_verified: bool,
) -> dict[str, Any]:
    reasons = [f"ENTRY:{reason}" for reason in entry.get("reasons", [])]
    reasons.extend(f"CLOSING:{reason}" for reason in closing.get("reasons", []))
    if not entry.get("eligible"):
        reasons.append("ENTRY_CHAIN_INVALID")
    if not closing.get("eligible"):
        reasons.append("CLOSING_CHAIN_INVALID")
    if not result_final:
        reasons.append("RESULT_NOT_FINAL")
    if not result_source_verified:
        reasons.append("RESULT_SOURCE_NOT_VERIFIED")
    return _decision("READY_FOR_SETTLEMENT", "SETTLEMENT_BLOCKED", reasons)


def validate_clean_sample_eligibility(
    settlement: dict[str, Any], *, settlement_final: bool, clv_valid: bool
) -> dict[str, Any]:
    reasons = list(settlement.get("reasons", []))
    if not settlement.get("eligible"):
        reasons.append("SETTLEMENT_CHAIN_INVALID")
    if not settlement_final:
        reasons.append("SETTLEMENT_NOT_FINAL")
    if not clv_valid:
        reasons.append("CLV_NOT_VALID")
    return _decision("CLEAN_V2_ELIGIBLE", "LEGACY_OR_AUDIT_ONLY", reasons)
