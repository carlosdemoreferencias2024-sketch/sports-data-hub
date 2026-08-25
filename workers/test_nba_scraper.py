from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

import nba_scraper


kickoff = datetime.now(timezone.utc) + timedelta(minutes=75)
previous = kickoff - timedelta(hours=25)
event = {
    "id": "401999001",
    "date": kickoff.isoformat().replace("+00:00", "Z"),
    "season": {"year": 2027, "type": 2, "slug": "regular-season"},
    "competitions": [{
        "date": kickoff.isoformat().replace("+00:00", "Z"),
        "venue": {"fullName": "Test Arena", "indoor": True},
        "status": {"type": {"state": "pre", "completed": False, "detail": "Scheduled"}},
        "competitors": [
            {"id": "2", "homeAway": "home", "score": "0", "team": {"id": "2", "displayName": "Boston Celtics"}},
            {"id": "13", "homeAway": "away", "score": "0", "team": {"id": "13", "displayName": "Los Angeles Lakers"}},
        ],
        "odds": [{"provider": {"name": "Book"}, "details": "BOS -3.5"}],
    }],
}
previous_event = {
    "id": "401999000",
    "date": previous.isoformat().replace("+00:00", "Z"),
    "competitions": [{
        "competitors": [
            {"id": "2", "homeAway": "away", "team": {"id": "2", "displayName": "Boston Celtics"}},
            {"id": "8", "homeAway": "home", "team": {"id": "8", "displayName": "Detroit Pistons"}},
        ]
    }],
}


def player(team_id: str, index: int) -> dict:
    return {
        "starter": True,
        "athlete": {
            "id": f"{team_id}{index}",
            "displayName": f"Player {team_id}-{index}",
            "position": {"abbreviation": "G" if index < 3 else "F"},
        },
    }


summary = {
    "injuries": [
        {"team": {"id": "2", "displayName": "Boston Celtics"}, "injuries": []},
        {"team": {"id": "13", "displayName": "Los Angeles Lakers"}, "injuries": [{
            "status": "Out",
            "date": (kickoff - timedelta(hours=2)).isoformat().replace("+00:00", "Z"),
            "athlete": {"id": "1310", "displayName": "Test Player", "position": {"abbreviation": "F"}},
            "details": {"type": "Rest"},
        }]},
    ],
    "boxscore": {"players": [
        {"team": {"id": "2"}, "statistics": [{"athletes": [player("2", index) for index in range(5)]}]},
        {"team": {"id": "13"}, "statistics": [{"athletes": [player("13", index) for index in range(5)]}]},
    ]},
}

with TemporaryDirectory() as tmp:
    evidence = nba_scraper.write_evidence({"event": event, "summary": summary}, Path(tmp), "event-test")
    row = nba_scraper.build_match(event, summary, evidence, [previous_event, event], True)
    assert row is not None
    assert row["source_match_id"] == "espn-nba-401999001"
    assert row["league_slug"] == "nba"
    assert row["status"] == "scheduled"
    assert row["home_alias"] == "Boston Celtics"
    assert row["raw_data"]["injury_report_present"] is True
    assert row["raw_data"]["starting_lineups_confirmed"] is True
    assert len(row["raw_data"]["home_lineup"]) == 5
    assert row["raw_data"]["load_management_context"]["home"]["back_to_back"] is True
    assert len(row["raw_data"]["load_management_context"]["official_rest_designations"]) == 1
    assert row["raw_data"]["nba_context_complete"] is True
    assert len(row["raw_data"]["provider_raw_sha256"]) == 64
    assert row.get("home_odds") is None
    assert row["raw_data"]["market_observation_audit_only"][0]["model_input"] is False

    incomplete = nba_scraper.build_match(event, {"injuries": summary["injuries"]}, evidence, [event], True)
    assert incomplete is not None
    assert incomplete["raw_data"]["nba_context_complete"] is False
    assert "official_starting_lineups" in incomplete["raw_data"]["nba_context_missing"]

print("NBA_SCRAPER_CONTRACT_OK")
