import unittest

from bs4 import BeautifulSoup

from soccer_scraper import make_source_match_id, provider_event_id


class SoccerScraperIdentityTest(unittest.TestCase):
    def test_provider_event_id_is_primary_identity(self):
        source_match_id = make_source_match_id(
            "serie-a",
            "AS Roma",
            "Fiorentina",
            "2026-08-24T18:45:00Z",
            provider_event_id="401999001",
        )
        self.assertEqual(source_match_id, "espn-serie-a-401999001")

    def test_fallback_identity_always_includes_date(self):
        source_match_id = make_source_match_id(
            "serie-a",
            "AS Roma",
            "Fiorentina",
            "2026-08-24T18:45:00Z",
            status="scheduled",
        )
        self.assertEqual(source_match_id, "espn-serie-a-2026-08-24-as-roma-fiorentina")

    def test_provider_event_id_is_extracted_from_scoreboard_node(self):
        soup = BeautifulSoup(
            '<section class="Scoreboard" id="401999001"><div class="ScoreboardScoreCell"></div></section>',
            "html.parser",
        )
        node = soup.select_one(".ScoreboardScoreCell")
        self.assertEqual(provider_event_id(node), "401999001")


if __name__ == "__main__":
    unittest.main()
