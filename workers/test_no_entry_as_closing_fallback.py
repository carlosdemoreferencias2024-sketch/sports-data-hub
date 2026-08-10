import unittest

from market_integrity_policy import validate_closing_snapshot


class NoEntryAsClosingFallbackTest(unittest.TestCase):
    def test_entry_role_never_qualifies_as_closing(self):
        decision = validate_closing_snapshot({
            "kickoff": "2026-08-10T23:00:00Z",
            "captured_at": "2026-08-10T22:53:00Z",
            "source_name": "sportsbook_manual_verified",
            "evidence_id": "evidence-1",
            "screenshot_sha256": "a" * 64,
            "snapshot_type": "entry",
            "safe_for_closing": True,
            "canonical_match": True,
            "duplicate": False,
        })
        self.assertFalse(decision["eligible"])
        self.assertIn("CLOSING_ROLE_INVALID", decision["reasons"])


if __name__ == "__main__":
    unittest.main()
