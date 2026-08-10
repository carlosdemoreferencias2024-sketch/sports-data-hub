import os
import unittest

from alpha_detector import _is_real_paper_candidate


class AlphaDetectorEntryEvidenceTest(unittest.TestCase):
    def setUp(self):
        os.environ["ENABLE_REAL_PAPER"] = "true"
        os.environ["ENABLE_REAL_MONEYLINE"] = "true"
        self.row = {
            "quote_processed": True,
            "status": "scheduled",
            "bookmaker": "Example Book",
            "sport_slug": "baseball",
            "league_slug": "mlb",
            "market_type": "moneyline_2way",
            "provider_name": "sportsbook_manual_verified",
            "source_name": "sportsbook_manual_verified",
            "captured_at": "2026-08-10T20:00:00Z",
            "official_kickoff": "2026-08-10T23:00:00Z",
            "snapshot_type": "entry",
            "stale_status": "FRESH",
            "safe_for_entry": True,
            "canonical_match": True,
            "duplicate": False,
            "evidence_id": "evidence-1",
            "screenshot_sha256": "a" * 64,
        }
        self.selection = {"market_odds": 2.0, "probability": 0.55, "expected_value": 0.10}

    def test_complete_entry_can_create_real_paper(self):
        self.assertTrue(_is_real_paper_candidate(self.row, self.selection))

    def test_missing_evidence_blocks_real_paper(self):
        self.row["evidence_id"] = None
        self.assertFalse(_is_real_paper_candidate(self.row, self.selection))

    def test_post_kickoff_entry_blocks_real_paper(self):
        self.row["captured_at"] = self.row["official_kickoff"]
        self.assertFalse(_is_real_paper_candidate(self.row, self.selection))


if __name__ == "__main__":
    unittest.main()
