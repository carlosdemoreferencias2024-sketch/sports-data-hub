import argparse
import json
import os
from datetime import datetime, timezone

import requests

from constants import FUTBOL_LEAGUE_MAP


API_URL = os.getenv("API_URL", "http://engine-node:3000/api/v1").rstrip("/")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "replace_with_local_internal_api_key")
SOURCE_SLUG = os.getenv("GLOBAL_SOCCER_SOURCE_SLUG", "sportsapi")
TIMEOUT_SECONDS = int(os.getenv("GLOBAL_SOCCER_TIMEOUT_SECONDS", "12"))


def iso_match_date(event: dict) -> str:
    value = event.get("date")
    if value:
        return value
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_status(event: dict) -> str:
    status_type = event.get("status", {}).get("type", {})
    if status_type.get("completed"):
        return "finished"
    name = (status_type.get("name") or status_type.get("state") or "").lower()
    if name in {"in", "live", "in_progress"}:
        return "live"
    if name in {"postponed"}:
        return "postponed"
    if name in {"canceled", "cancelled"}:
        return "cancelled"
    return "scheduled"


def home_away(competition: dict) -> tuple[dict | None, dict | None]:
    home = None
    away = None
    for competitor in competition.get("competitors", []):
        if competitor.get("homeAway") == "home":
            home = competitor
        elif competitor.get("homeAway") == "away":
            away = competitor
    return home, away


def score(competitor: dict | None) -> int | None:
    if not competitor:
        return None
    value = competitor.get("score")
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_odds(competition: dict) -> tuple[float | None, float | None]:
    odds = competition.get("odds") or []
    if not odds:
        return None, None

    first = odds[0] or {}
    home = first.get("homeTeamOdds", {}).get("decimal") or first.get("homeTeamOdds", {}).get("decimalOdds")
    away = first.get("awayTeamOdds", {}).get("decimal") or first.get("awayTeamOdds", {}).get("decimalOdds")
    try:
        home_odds = float(home) if home else None
        away_odds = float(away) if away else None
    except (TypeError, ValueError):
        return None, None
    return home_odds, away_odds


def event_to_match(event: dict, league_meta: dict) -> dict | None:
    competitions = event.get("competitions") or []
    if not competitions:
        return None

    competition = competitions[0]
    home, away = home_away(competition)
    if not home or not away:
        return None

    home_team = home.get("team", {})
    away_team = away.get("team", {})
    home_name = home_team.get("displayName") or home_team.get("name")
    away_name = away_team.get("displayName") or away_team.get("name")
    if not home_name or not away_name:
        return None

    home_odds, away_odds = parse_odds(competition)
    status_type = event.get("status", {}).get("type", {})

    return {
        "source_slug": SOURCE_SLUG,
        "source_match_id": f"{SOURCE_SLUG}-{event.get('id')}",
        "league_slug": league_meta["slug"],
        "match_date": iso_match_date(event),
        "status": normalize_status(event),
        "home_alias": home_name,
        "away_alias": away_name,
        "home_score": score(home),
        "away_score": score(away),
        "home_odds": home_odds,
        "away_odds": away_odds,
        "odds_source": "market_odds" if home_odds and away_odds else None,
        "period": status_type.get("detail") or status_type.get("description") or status_type.get("shortDetail"),
        "raw_data": {
            "league_type": league_meta["type"],
            "league_name": league_meta["name"],
            "espn_event_id": event.get("id"),
            "source": SOURCE_SLUG,
        },
    }


def fetch_league(espn_code: str, league_meta: dict) -> list[dict]:
    url = f"https://site.api.espn.com/apis/site/v2/sports/soccer/{espn_code}/scoreboard"
    print(json.dumps({"event": "global_soccer_fetch_start", "league": league_meta["slug"], "url": url}), flush=True)
    response = requests.get(url, timeout=TIMEOUT_SECONDS)
    if response.status_code != 200:
        print(json.dumps({"level": "warn", "event": "global_soccer_fetch_failed", "league": league_meta["slug"], "status": response.status_code}), flush=True)
        return []

    data = response.json()
    matches = []
    for event in data.get("events", []):
        try:
            match = event_to_match(event, league_meta)
            if match:
                matches.append(match)
        except Exception as exc:
            print(json.dumps({"level": "warn", "event": "global_soccer_event_parse_failed", "league": league_meta["slug"], "message": str(exc)}), flush=True)
    return matches


def post_batch(matches: list[dict]) -> dict:
    if not matches:
        return {"processed": 0, "created": 0, "updated": 0, "errors": 0, "warnings": ["no_matches_detected"]}

    response = requests.post(
        f"{API_URL}/internal/matches/batch",
        json={"matches": matches},
        headers={"X-Internal-API-Key": INTERNAL_API_KEY},
        timeout=TIMEOUT_SECONDS,
    )
    try:
        return response.json()
    except ValueError:
        return {"status_code": response.status_code, "text": response.text}


def run(league_codes: list[str], dry_run: bool) -> list[dict]:
    results = []
    for code in league_codes:
        meta = FUTBOL_LEAGUE_MAP[code]
        matches = fetch_league(code, meta)
        if dry_run:
            result = {"league": meta["slug"], "detected": len(matches), "matches": matches}
        else:
            result = {"league": meta["slug"], **post_batch(matches)}
        print(json.dumps(result, indent=2, ensure_ascii=False), flush=True)
        results.append(result)
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Scraper global de futbol via ESPN Site API.")
    parser.add_argument("--league", action="append", choices=sorted(FUTBOL_LEAGUE_MAP.keys()))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    selected = args.league or list(FUTBOL_LEAGUE_MAP.keys())
    print(json.dumps({"event": "global_soccer_scraper_started", "leagues": selected, "dry_run": args.dry_run}), flush=True)
    run(selected, args.dry_run)


if __name__ == "__main__":
    main()
