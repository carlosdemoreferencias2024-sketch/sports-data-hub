import unittest

from espn_soccer_scraper import ESPN_LEAGUES
from espn_source_aliases import resolve_source_slug


class EspnSourceAliasesTests(unittest.TestCase):
    def test_liga_mx_uses_persisted_mexico_source(self):
        self.assertEqual(resolve_source_slug("espn-liga-mx"), "espn-mexico")

    def test_unknown_source_is_unchanged(self):
        self.assertEqual(resolve_source_slug("espn-mls"), "espn-mls")

    def test_world_cup_uses_confirmed_espn_slug(self):
        self.assertEqual(ESPN_LEAGUES["fifa-world-cup-2026"], "fifa.world")


if __name__ == "__main__":
    unittest.main()
