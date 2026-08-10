from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import os
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    reason: str = "OK"


def _env_flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def _trading_timezone() -> ZoneInfo:
    return ZoneInfo(os.getenv("TRADING_TIME_ZONE", "America/Matamoros"))


def _target_date() -> str:
    configured = os.getenv("PREBET_TARGET_DATE")
    if configured:
        return configured.strip()[:10]
    return datetime.now(_trading_timezone()).date().isoformat()


def _parse_datetime(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def validate_mlb_fixture(
    *,
    match_date,
    home_team: str | None,
    away_team: str | None,
    status: str | None,
    strict_date: bool | None = None,
) -> ValidationResult:
    strict = _env_flag("PREBET_STRICT_DATE", True) if strict_date is None else strict_date
    parsed_date = _parse_datetime(match_date)
    if parsed_date is None:
        return ValidationResult(False, "INVALID_DATE")

    if strict and parsed_date.astimezone(_trading_timezone()).date().isoformat() != _target_date():
        return ValidationResult(False, "INVALID_DATE")

    if not (home_team or "").strip() or not (away_team or "").strip():
        return ValidationResult(False, "INVALID_MATCH")

    if (home_team or "").strip().lower() == (away_team or "").strip().lower():
        return ValidationResult(False, "INVALID_MATCH")

    if (status or "").strip() not in {"scheduled", "live", "finished"}:
        return ValidationResult(False, "INVALID_STATUS")

    return ValidationResult(True)


def validate_market_quote(
    *,
    market_type: str | None,
    market_odds: float | None,
    captured_at,
    max_age_seconds: int | None = None,
) -> ValidationResult:
    if market_odds is None:
        return ValidationResult(False, "MISSING_ODDS")

    max_age = max_age_seconds or int(os.getenv("PREBET_MAX_MARKET_AGE_SECONDS", "1200"))
    captured = _parse_datetime(captured_at)
    if captured is None:
        return ValidationResult(False, "INVALID_CAPTURED_AT")

    age = datetime.now(timezone.utc) - captured.astimezone(timezone.utc)
    if age > timedelta(seconds=max_age):
        return ValidationResult(False, "STALE_DATA")

    market = (market_type or "").strip()
    if market == "run_line" and (market_odds > 3.0 or market_odds < 1.2):
        return ValidationResult(False, "ODDS_SUSPICIOUS")

    if market_odds <= 1.0:
        return ValidationResult(False, "ODDS_SUSPICIOUS")

    return ValidationResult(True)
