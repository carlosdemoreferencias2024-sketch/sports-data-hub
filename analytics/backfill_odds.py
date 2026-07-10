import json
import os

import requests


API_URL = os.getenv("API_URL", "http://engine-node:3000/api/v1").rstrip("/")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "replace_with_local_internal_api_key")
TIMEOUT_SECONDS = int(os.getenv("BACKFILL_ODDS_TIMEOUT_SECONDS", "10"))

ODDS_BY_MATCHUP = {
    "club-america-vs-chivas-guadalajara": {"home_odds": 1.95, "away_odds": 3.40},
    "real-madrid-vs-borussia-dortmund": {"home_odds": 1.65, "away_odds": 4.50},
    "manchester-city-vs-arsenal": {"home_odds": 1.90, "away_odds": 3.60},
    "boston-red-sox-vs-new-york-yankees": {"home_odds": 1.91, "away_odds": 1.98},
}


def competitor(match: dict, side: str) -> dict | None:
    for item in match.get("competitors", []):
        if item.get("home_away") == side:
            return item
    return None


def get_matches() -> list[dict]:
    response = requests.get(f"{API_URL}/matches?limit=200", timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    return response.json()


def send_update(match: dict, home: dict, away: dict, odds: dict) -> dict:
    match_day = match["match_date"][:10]
    source_match_id = match["slug"]
    prefix = f"{match_day}-"
    if source_match_id.startswith(prefix):
        source_match_id = source_match_id[len(prefix):]

    payload = {
        "matches": [
            {
                "source_slug": "sportsapi",
                "source_match_id": source_match_id,
                "league_slug": match["league_slug"],
                "match_date": match["match_date"],
                "status": match["status"],
                "home_alias": home["team_name"],
                "away_alias": away["team_name"],
                "home_score": match.get("home_score"),
                "away_score": match.get("away_score"),
                "period": match.get("period") or "odds-backfill",
                "home_odds": odds["home_odds"],
                "away_odds": odds["away_odds"],
                "odds_source": "manual_backfill_odds",
                "raw_data": {
                    "source": "odds-backfill",
                    "original_match_id": match["id"],
                },
            }
        ]
    }

    response = requests.post(
        f"{API_URL}/internal/matches/batch",
        json=payload,
        headers={"X-Internal-API-Key": INTERNAL_API_KEY},
        timeout=TIMEOUT_SECONDS,
    )
    try:
        return response.json()
    except ValueError:
        return {"status_code": response.status_code, "text": response.text}


def main() -> None:
    print(json.dumps({"event": "odds_backfill_started", "fixtures": len(ODDS_BY_MATCHUP)}), flush=True)
    injected = 0
    results = []

    for match in get_matches():
        home = competitor(match, "home")
        away = competitor(match, "away")
        if not home or not away:
            continue

        key = f"{home['team_slug']}-vs-{away['team_slug']}"
        odds = ODDS_BY_MATCHUP.get(key)
        if not odds:
            continue

        result = send_update(match, home, away, odds)
        injected += 1
        results.append({"match_id": match["id"], "key": key, "result": result})
        print(json.dumps({"event": "odds_backfill_match_updated", "key": key, "result": result}, ensure_ascii=False), flush=True)

    print(json.dumps({"event": "odds_backfill_completed", "injected": injected, "results": results}, indent=2), flush=True)


if __name__ == "__main__":
    main()
