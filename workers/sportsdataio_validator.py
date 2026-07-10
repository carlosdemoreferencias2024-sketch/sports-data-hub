from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import os
from typing import Any

import requests

from normalizer import normalize_alias


SPORTSDATAIO_BASE_URL = os.getenv("SPORTSDATAIO_BASE_URL", "https://api.sportsdata.io/v3/mlb")


@dataclass(frozen=True)
class SportsDataIOValidation:
    ok: bool
    reason: str = "OK"
    matched_game_key: str | None = None


def is_enabled() -> bool:
    return (os.getenv("SPORTSDATAIO_MLB_ENABLED") or "").lower() in {"1", "true", "yes", "on"}


def _api_key() -> str | None:
    return os.getenv("SPORTSDATAIO_API_KEY") or os.getenv("SPORTS_DATA_IO_API_KEY")


def _date_key(value: Any) -> str:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).date().isoformat()


def _headers() -> dict[str, str]:
    key = _api_key()
    if not key:
        return {}
    return {"Ocp-Apim-Subscription-Key": key}


def _params() -> dict[str, str]:
    key = _api_key()
    if not key:
        return {}
    return {"key": key}


def _fetch_json(path: str) -> Any:
    response = requests.get(
        f"{SPORTSDATAIO_BASE_URL.rstrip('/')}/{path.lstrip('/')}",
        headers=_headers(),
        params=_params(),
        timeout=float(os.getenv("SPORTSDATAIO_TIMEOUT_SECONDS", "10")),
    )
    response.raise_for_status()
    return response.json()


_teams_cache: dict[str, set[str]] | None = None
_schedule_cache: dict[str, list[dict[str, Any]]] = {}


def _team_aliases() -> dict[str, set[str]]:
    global _teams_cache
    if _teams_cache is not None:
        return _teams_cache

    aliases: dict[str, set[str]] = {}
    teams = _fetch_json("scores/json/Teams")
    for team in teams:
        key = str(team.get("Key") or team.get("Team") or "").strip()
        if not key:
            continue
        values = {
            key,
            str(team.get("Name") or ""),
            str(team.get("City") or ""),
            str(team.get("FullName") or ""),
            f"{team.get('City') or ''} {team.get('Name') or ''}",
        }
        aliases[key] = {normalize_alias(value) for value in values if str(value).strip()}
    _teams_cache = aliases
    return aliases


def _games_by_date(date_key: str) -> list[dict[str, Any]]:
    if date_key not in _schedule_cache:
        parsed = datetime.fromisoformat(date_key)
        candidates = [
            date_key,
            parsed.strftime("%Y-%b-%d").upper(),
        ]
        last_error: Exception | None = None
        for candidate in candidates:
            try:
                _schedule_cache[date_key] = _fetch_json(f"scores/json/GamesByDate/{candidate}")
                break
            except Exception as exc:
                last_error = exc
        else:
            if last_error:
                raise last_error
            _schedule_cache[date_key] = []
    return _schedule_cache[date_key]


def _matches_team(candidate: str, sportsdataio_key: str, aliases: dict[str, set[str]]) -> bool:
    normalized = normalize_alias(candidate)
    allowed = aliases.get(sportsdataio_key, {normalize_alias(sportsdataio_key)})
    return normalized in allowed or any(normalized == item for item in allowed)


def validate_mlb_match_against_sportsdataio(match_date: Any, home_team: str, away_team: str) -> SportsDataIOValidation:
    if not is_enabled():
        return SportsDataIOValidation(True, "SKIPPED_DISABLED")

    if not _api_key():
        return SportsDataIOValidation(False, "SPORTSDATAIO_KEY_MISSING")

    date_key = _date_key(match_date)
    try:
        aliases = _team_aliases()
        games = _games_by_date(date_key)
    except Exception as exc:
        return SportsDataIOValidation(False, f"SPORTSDATAIO_FETCH_FAILED:{type(exc).__name__}")

    for game in games:
        home_key = str(game.get("HomeTeam") or "").strip()
        away_key = str(game.get("AwayTeam") or "").strip()
        if not home_key or not away_key:
            continue
        if _matches_team(home_team, home_key, aliases) and _matches_team(away_team, away_key, aliases):
            return SportsDataIOValidation(True, "OK", str(game.get("GameID") or game.get("GameKey") or ""))

    return SportsDataIOValidation(False, "SPORTSDATAIO_MATCH_NOT_FOUND")
