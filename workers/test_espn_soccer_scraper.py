from pathlib import Path
import copy
import tempfile
import unittest
from unittest.mock import patch

from espn_soccer_scraper import (
    american_to_decimal,
    discover_event,
    event_context,
    league_provider_slugs,
    moneyline_market,
    team_match_score,
    team_name_matches,
    write_market_render,
)


class EspnSoccerScraperContractTest(unittest.TestCase):
    def setUp(self):
        self.event = {
            "id": "401874142",
            "date": "2026-08-20T22:00:00Z",
            "status": {"type": {"state": "pre", "completed": False}},
            "competitions": [{
                "date": "2026-08-20T22:00:00Z",
                "status": {"type": {"state": "pre", "completed": False}},
                "competitors": [
                    {"homeAway": "home", "team": {"id": "2686", "displayName": "Liga de Quito", "abbreviation": "LDU"}},
                    {"homeAway": "away", "team": {"id": "10175", "displayName": "Mirassol", "abbreviation": "MIR"}},
                ],
                "odds": [{
                    "provider": {"id": "1000", "name": "DraftKings"},
                    "moneyline": {
                        "home": {"close": {"odds": "-175"}},
                        "draw": {"close": {"odds": "+280"}},
                        "away": {"close": {"odds": "+500"}},
                    },
                }],
            }],
        }

    def test_identity_accepts_provider_abbreviation(self):
        context = event_context(self.event, "conmebol.libertadores")
        self.assertTrue(team_name_matches("LDU de Quito", context["home"]))
        self.assertEqual(team_match_score("LDU de Quito", context["home"]), 25)
        self.assertTrue(team_name_matches("Mirassol", context["away"]))
        self.assertEqual(team_match_score("Mirassol", context["away"]), 100)

    def test_identity_accepts_known_provider_alias(self):
        team = {
            "name": "Athletico-PR",
            "abbreviation": "CAP",
            "aliases": ["Athletico Paranaense"],
        }
        self.assertEqual(team_match_score("Atletico Paranaense", team), 100)

    def test_ligue_one_maps_to_espn_provider_slug(self):
        self.assertEqual(league_provider_slugs("ligue-1"), ["fra.1"])

    @patch("espn_soccer_scraper.fetch_json")
    def test_discovery_restricts_provider_league_and_accepts_clear_partial(self, fetch_json):
        event = copy.deepcopy(self.event)
        event["id"] = "401999001"
        event["competitions"][0]["competitors"] = [
            {"homeAway": "home", "team": {"id": "1", "displayName": "Roma", "abbreviation": "ROM"}},
            {"homeAway": "away", "team": {"id": "2", "displayName": "Fiorentina", "abbreviation": "FIO"}},
        ]
        fetch_json.return_value = {"events": [event]}

        selected, _, url = discover_event(
            "20260824",
            "AS Roma",
            "Fiorentina",
            10,
            league_slug="serie-a",
        )

        self.assertEqual(selected["id"], "401999001")
        self.assertIn("/ita.1/scoreboard", url)
        fetch_json.assert_called_once()

    @patch("espn_soccer_scraper.fetch_json")
    def test_discovery_fails_closed_on_tied_candidates(self, fetch_json):
        events = []
        for event_id in ("401999001", "401999002"):
            event = copy.deepcopy(self.event)
            event["id"] = event_id
            event["competitions"][0]["competitors"] = [
                {"homeAway": "home", "team": {"id": "1", "displayName": "Roma", "abbreviation": "ROM"}},
                {"homeAway": "away", "team": {"id": "2", "displayName": "Fiorentina", "abbreviation": "FIO"}},
            ]
            events.append(event)
        fetch_json.return_value = {"events": events}

        with self.assertRaisesRegex(RuntimeError, "ESPN_EVENT_NOT_FOUND_OR_AMBIGUOUS"):
            discover_event("20260824", "AS Roma", "Fiorentina", 10, league_slug="serie-a")

    def test_market_requires_complete_three_way_prices(self):
        market = moneyline_market(self.event, "DraftKings")
        self.assertEqual(market["home_american"], -175)
        self.assertEqual(market["draw_american"], 280)
        self.assertEqual(market["away_american"], 500)
        self.assertEqual(market["home_decimal"], american_to_decimal(-175))

    def test_started_event_is_rejected(self):
        self.event["status"]["type"]["state"] = "in"
        self.event["competitions"][0]["status"]["type"]["state"] = "in"
        with self.assertRaisesRegex(RuntimeError, "POST_KICKOFF_AUDIT_ONLY"):
            event_context(self.event, "conmebol.libertadores")

    def test_local_render_contains_auditable_three_way_market(self):
        context = event_context(self.event, "conmebol.libertadores")
        market = moneyline_market(self.event, "DraftKings")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "capture.html"
            write_market_render(path, "https://example.test/source", context, market, "a" * 64, "2026-08-20T19:00:00Z")
            rendered = path.read_text(encoding="utf-8")
        self.assertIn("DraftKings", rendered)
        self.assertIn("+500", rendered)
        self.assertIn("Raw JSON SHA-256", rendered)
        self.assertIn("Human verification is required", rendered)


if __name__ == "__main__":
    unittest.main()
