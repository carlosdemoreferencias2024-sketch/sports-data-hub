import argparse
import json
import os
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from typing import Any

from batch_scraper import ScrapedMatch, post_batch


MLB_API_BASE = "https://statsapi.mlb.com/api/v1"
DEFAULT_BATCH_URL = os.getenv("BATCH_INGESTION_URL", "http://engine-node:3000/api/v1/internal/matches/batch")
DEFAULT_API_KEY = os.getenv("INTERNAL_API_KEY")


def _get_json(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    query = urllib.parse.urlencode(params or {})
    url = f"{MLB_API_BASE}/{path.lstrip('/')}"
    if query:
        url = f"{url}?{query}"
    with urllib.request.urlopen(url, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _status(game: dict[str, Any]) -> str:
    code = str(game.get("status", {}).get("abstractGameState") or "").lower()
    detailed = str(game.get("status", {}).get("detailedState") or "").lower()
    if code == "final" or detailed == "final":
        return "finished"
    if code == "live":
        return "live"
    if "postponed" in detailed:
        return "postponed"
    if "cancelled" in detailed or "canceled" in detailed:
        return "cancelled"
    return "scheduled"


def _score(game: dict[str, Any], side: str) -> int | None:
    value = game.get("teams", {}).get(side, {}).get("score")
    return int(value) if value is not None else None


def _game_to_match(game: dict[str, Any]) -> ScrapedMatch | None:
    if str(game.get("gameType")) != "R":
        return None
    home = game.get("teams", {}).get("home", {}).get("team", {})
    away = game.get("teams", {}).get("away", {}).get("team", {})
    if not home.get("name") or not away.get("name"):
        return None

    match_date = str(game.get("gameDate") or "")
    if match_date.endswith("Z"):
        match_date = match_date[:-1] + "+00:00"
    parsed = datetime.fromisoformat(match_date)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    match_date = parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")
    period = game.get("status", {}).get("detailedState")
    source_match_id = f"mlb-statsapi-{game.get('gamePk')}"
    return ScrapedMatch(
        source_match_id=source_match_id,
        league_slug="mlb",
        match_date=match_date,
        status=_status(game),
        home_alias=str(home["name"]),
        away_alias=str(away["name"]),
        home_score=_score(game, "home"),
        away_score=_score(game, "away"),
        period=str(period) if period else None,
    )


def load_matches(date: str) -> list[ScrapedMatch]:
    payload = _get_json(
        "schedule",
        {
            "sportId": 1,
            "date": date,
            "hydrate": "probablePitcher,team",
        },
    )
    games: list[dict[str, Any]] = []
    for date_node in payload.get("dates", []):
        games.extend(date_node.get("games", []))
    matches = [_game_to_match(game) for game in games]
    return [match for match in matches if match is not None]


def main() -> None:
    parser = argparse.ArgumentParser(description="Load MLB fixtures from MLB Stats API into the Hub batch endpoint.")
    parser.add_argument("--date", required=True)
    parser.add_argument("--api-url", default=DEFAULT_BATCH_URL)
    parser.add_argument("--api-key", default=DEFAULT_API_KEY)
    parser.add_argument("--source", default="espn-mlb")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    matches = load_matches(args.date)
    if args.dry_run:
        print(json.dumps({"date": args.date, "count": len(matches), "matches": [match.__dict__ for match in matches]}, indent=2))
        return
    if not matches:
        print(json.dumps({"date": args.date, "count": 0, "posted": False, "reason": "NO_MLB_REGULAR_GAMES"}))
        return
    response = post_batch(matches, args.source, args.api_url, args.api_key)
    print(json.dumps({"date": args.date, "count": len(matches), "posted": True, "response": response}, indent=2))


if __name__ == "__main__":
    main()
