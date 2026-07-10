from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
import os
from typing import Any

import requests

from normalizer import normalize_alias
from sportsdataio_validator import validate_mlb_match_against_sportsdataio


@dataclass(frozen=True)
class SourceCheck:
    source: str
    ok: bool
    reason: str = "OK"
    matched_id: str | None = None


@dataclass(frozen=True)
class UnifiedValidation:
    ok: bool
    reason: str
    consensus: int
    required: int
    checks: tuple[SourceCheck, ...]


def _enabled(name: str) -> bool:
    return (os.getenv(name) or "").lower() in {"1", "true", "yes", "on"}


def _date_key(value: Any) -> str:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).date().isoformat()


def _extract_strings(payload: Any) -> list[str]:
    values: list[str] = []
    if isinstance(payload, dict):
        for value in payload.values():
            values.extend(_extract_strings(value))
    elif isinstance(payload, list):
        for value in payload:
            values.extend(_extract_strings(value))
    elif isinstance(payload, str):
        stripped = payload.strip()
        if stripped:
            values.append(stripped)
    return values


def _sportmonks_key() -> str | None:
    return os.getenv("SPORTMONKS_API_KEY")


def _sportmonks_schedule_url(date_key: str) -> str | None:
    template = os.getenv("SPORTMONKS_MLB_SCHEDULE_URL_TEMPLATE")
    if not template:
        return None
    return template.format(date=date_key)


def _validate_sportmonks_mlb(match_date: Any, home_team: str, away_team: str) -> SourceCheck:
    if not _enabled("SPORTMONKS_MLB_ENABLED"):
        return SourceCheck("sportmonks", True, "SKIPPED_DISABLED")

    token = _sportmonks_key()
    if not token:
        return SourceCheck("sportmonks", False, "SPORTMONKS_KEY_MISSING")

    date_key = _date_key(match_date)
    url = _sportmonks_schedule_url(date_key)
    if not url:
        return SourceCheck("sportmonks", False, "SPORTMONKS_URL_TEMPLATE_MISSING")

    try:
        response = requests.get(
            url,
            params={"api_token": token},
            timeout=float(os.getenv("SPORTMONKS_TIMEOUT_SECONDS", "10")),
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        return SourceCheck("sportmonks", False, f"SPORTMONKS_FETCH_FAILED:{type(exc).__name__}")

    strings = {normalize_alias(value) for value in _extract_strings(payload)}
    home = normalize_alias(home_team)
    away = normalize_alias(away_team)
    if home in strings and away in strings:
        return SourceCheck("sportmonks", True, "OK")

    return SourceCheck("sportmonks", False, "SPORTMONKS_MATCH_NOT_FOUND")


def _validate_sportsdataio_mlb(match_date: Any, home_team: str, away_team: str) -> SourceCheck:
    result = validate_mlb_match_against_sportsdataio(match_date, home_team, away_team)
    return SourceCheck("sportsdataio", result.ok, result.reason, result.matched_game_key)


def validate_mlb_cross_sources(match_date: Any, home_team: str, away_team: str) -> UnifiedValidation:
    checks = [SourceCheck("hub", True, "OK")]
    validators = []

    if _enabled("SPORTSDATAIO_MLB_ENABLED"):
        validators.append(_validate_sportsdataio_mlb)
    if _enabled("SPORTMONKS_MLB_ENABLED"):
        validators.append(_validate_sportmonks_mlb)

    if validators:
        with ThreadPoolExecutor(max_workers=len(validators)) as executor:
            futures = [executor.submit(validator, match_date, home_team, away_team) for validator in validators]
            for future in as_completed(futures):
                checks.append(future.result())

    active_sources = [check for check in checks if not check.reason.endswith("DISABLED")]
    consensus = sum(1 for check in active_sources if check.ok)
    default_required = 2 if len(active_sources) >= 2 else 1
    required_value = os.getenv("SOURCE_MANAGER_MIN_CONSENSUS")
    required = int(required_value) if required_value else default_required

    if consensus >= required:
        return UnifiedValidation(True, "OK", consensus, required, tuple(checks))

    failed = [f"{check.source}:{check.reason}" for check in active_sources if not check.ok]
    return UnifiedValidation(False, "ERROR_DATA_DISCREPANCY:" + ",".join(failed), consensus, required, tuple(checks))
