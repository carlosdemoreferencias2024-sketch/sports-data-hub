import unittest

from market_integrity_policy import validate_closing_snapshot


class PostKickoffClosingBlockedTest(unittest.TestCase):
    def test_post_kickoff_is_late_and_audit_only(self):
        decision = validate_closing_snapshot({
            "kickoff": "2026-08-10T23:00:00Z",
            "captured_at": "2026-08-10T23:00:00.001Z",
            "source_name": "sportsbook_manual_verified",
            "evidence_id": "evidence-1",
            "screenshot_sha256": "a" * 64,
            "snapshot_type": "closing",
            "safe_for_closing": True,
            "canonical_match": True,
            "duplicate": False,
        })
        self.assertFalse(decision["eligible"])
        self.assertEqual(decision["closing_quality"], "CAPTURED_LATE")
        self.assertTrue(decision["audit_only"])


if __name__ == "__main__":
    unittest.main()
