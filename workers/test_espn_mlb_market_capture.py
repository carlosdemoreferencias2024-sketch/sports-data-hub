import unittest

from espn_mlb_market_capture import (
    american_to_decimal,
    event_context,
    market_context,
)


class EspnMlbMarketCaptureTests(unittest.TestCase):
    def test_american_to_decimal(self):
        self.assertEqual(american_to_decimal(128), 2.28)
        self.assertEqual(american_to_decimal(-138), 1.724638)

    def test_extracts_home_away_and_current_market(self):
        summary = {
            "header": {
                "id": "401816509",
                "competitions": [{
                    "date": "2026-08-13T19:07Z",
                    "status": {"type": {"state": "pre", "completed": False}},
                    "competitors": [
                        {"homeAway": "home", "team": {"id": "14", "displayName": "Toronto Blue Jays", "abbreviation": "TOR"}},
                        {"homeAway": "away", "team": {"id": "2", "displayName": "Boston Red Sox", "abbreviation": "BOS"}},
                    ],
                }],
            }
        }
        odds = {
            "items": [{
                "provider": {"id": "100", "name": "DraftKings"},
                "homeTeamOdds": {"current": {"moneyLine": {"american": "+128"}}},
                "awayTeamOdds": {"current": {"moneyLine": {"american": "-138"}}},
            }]
        }
        event = event_context(summary, "401816509")
        market = market_context(odds, "DraftKings")
        self.assertEqual(event["home"]["name"], "Toronto Blue Jays")
        self.assertEqual(event["away"]["name"], "Boston Red Sox")
        self.assertEqual(market["home_american"], 128)
        self.assertEqual(market["away_american"], -138)

    def test_rejects_missing_market_side(self):
        odds = {
            "items": [{
                "provider": {"id": "100", "name": "DraftKings"},
                "homeTeamOdds": {"current": {"moneyLine": {"american": "+128"}}},
                "awayTeamOdds": {},
            }]
        }
        with self.assertRaisesRegex(RuntimeError, "MARKET_PRICE_INVALID"):
            market_context(odds, "DraftKings")


if __name__ == "__main__":
    unittest.main()
