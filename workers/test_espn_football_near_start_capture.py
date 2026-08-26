from espn_football_near_start_capture import build_official_draft, parse_near_start_context


def player(name: str, position: str, starter: bool = True) -> dict:
    return {
        "starter": starter,
        "athlete": {"displayName": name},
        "position": {"abbreviation": position},
    }


def test_summary_without_roster_stays_unknown() -> None:
    payload = {
        "header": {"competitions": [{"status": {"type": {"state": "pre"}}}]},
        "rosters": [
            {"homeAway": "home", "team": {"displayName": "Home"}},
            {"homeAway": "away", "team": {"displayName": "Away"}},
        ],
    }
    parsed = parse_near_start_context(payload)
    assert parsed["lineup_status"] == "UNKNOWN"
    assert parsed["goalkeeper_status"] == "UNKNOWN"
    assert parsed["availability_status"] == "SOURCE_NOT_PROVIDED"


def test_exact_starters_and_goalkeepers_are_confirmed() -> None:
    home = [player("Home GK", "G")] + [player(f"Home {index}", "D") for index in range(1, 11)]
    away = [player("Away GK", "G")] + [player(f"Away {index}", "D") for index in range(1, 11)]
    payload = {
        "header": {"competitions": [{"status": {"type": {"state": "pre"}}}]},
        "rosters": [
            {"homeAway": "home", "formation": "4-3-3", "roster": home},
            {"homeAway": "away", "formation": "4-4-2", "roster": away},
        ],
    }
    parsed = parse_near_start_context(payload)
    assert parsed["lineup_status"] == "CONFIRMED"
    assert parsed["goalkeeper_status"] == "CONFIRMED"
    assert parsed["goalkeeper_home"] == "Home GK"
    assert parsed["goalkeeper_away"] == "Away GK"
    assert len(parsed["home_lineup"]) == 11
    assert parsed["player_availability_manual_verified"] is False


def test_postgame_roster_is_not_near_start_confirmation() -> None:
    starters = [player("GK", "G")] + [player(f"Player {index}", "D") for index in range(1, 11)]
    payload = {
        "header": {"competitions": [{"status": {"type": {"state": "post"}}}]},
        "rosters": [
            {"homeAway": "home", "roster": starters},
            {"homeAway": "away", "roster": starters},
        ],
    }
    parsed = parse_near_start_context(payload)
    assert parsed["lineup_status"] == "PENDING"
    assert parsed["goalkeeper_status"] == "PENDING"


def test_official_context_remains_human_verified_draft() -> None:
    target = {
        "match_id": "11111111-1111-1111-1111-111111111111",
        "league_slug": "la-liga",
        "home_team": "Valencia",
        "away_team": "Real Betis",
        "kickoff": "2026-08-26T20:00:00.000Z",
        "provider_event_id": "12345",
        "provider_name": "api-football",
    }
    capture = {
        "capture_ready": True,
        "match_id": target["match_id"],
        "home_team": "Valencia",
        "away_team": "Real Betis",
        "league_slug": "la-liga",
        "kickoff": target["kickoff"],
        "captured_at": "2026-08-26T19:10:00.000Z",
        "provider_event_id": "12345",
        "provider_raw_sha256": "a" * 64,
        "availability_provider_raw_sha256": "a" * 64,
        "source_url": "https://v3.football.api-sports.io/injuries?fixture=12345",
        "lineup_status": "CONFIRMED",
        "goalkeeper_status": "CONFIRMED",
        "availability_status": "CONFIRMED",
        "home_lineup": [f"Home {index}" for index in range(11)],
        "away_lineup": [f"Away {index}" for index in range(11)],
        "goalkeeper_home": "Home 0",
        "goalkeeper_away": "Away 0",
        "unavailable_players": ["Player Out", "Player Suspended"],
        "injuries": ["Player Out"],
        "suspensions": ["Player Suspended"],
        "availability_details": [],
    }
    draft = build_official_draft(target, capture)
    assert draft["workflow_state"] == "PENDING_HUMAN_VERIFICATION"
    assert draft["auto_post"] is False
    assert draft["source_name"] == "official_league_manual_verified"
    assert draft["data"]["availability_provider"] == "api_football"
    assert draft["data"]["player_availability_manual_verified"] is False
    assert draft["guardrails"]["real_candidate"] == 0
