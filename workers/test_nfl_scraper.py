from pathlib import Path
from tempfile import TemporaryDirectory

import nfl_scraper


event = {
    "id": "401000001",
    "date": "2026-09-11T00:20Z",
    "season": {"year": 2026, "type": 2, "slug": "regular-season"},
    "week": {"number": 1},
    "competitions": [{
        "date": "2026-09-11T00:20Z",
        "venue": {"fullName": "Test Stadium", "indoor": False},
        "status": {"type": {"state": "pre", "completed": False, "detail": "Scheduled"}},
        "competitors": [
            {"homeAway": "home", "score": "0", "team": {"displayName": "Houston Texans"}},
            {"homeAway": "away", "score": "0", "team": {"displayName": "Las Vegas Raiders"}},
        ],
        "odds": [{"provider": {"displayName": "Book"}, "details": "HOU -1.5"}],
    }],
}
summary = {"injuries": [{"team": {"id": "34", "displayName": "Houston Texans"}, "injuries": []}]}

with TemporaryDirectory() as tmp:
    evidence = nfl_scraper.write_evidence({"event": event, "summary": summary}, Path(tmp), "event-test")
    row = nfl_scraper.build_match(event, summary, evidence)
    assert row is not None
    assert row["source_match_id"] == "espn-nfl-401000001"
    assert row["match_date"] == "2026-09-11T00:20Z"
    assert row["status"] == "scheduled"
    assert row["home_alias"] == "Houston Texans"
    assert row["raw_data"]["nfl_context_complete"] is False
    assert "official_inactives" in row["raw_data"]["nfl_context_missing"]
    assert len(row["raw_data"]["provider_raw_sha256"]) == 64
    assert row.get("home_odds") is None

print("NFL_SCRAPER_CONTRACT_OK")
