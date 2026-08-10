import unittest

from market_integrity_policy import (
    validate_closing_snapshot,
    validate_entry_snapshot,
    validate_settlement_eligibility,
)


class SettlementRequiresValidClosingTest(unittest.TestCase):
    def setUp(self):
        self.base = {
            "kickoff": "2026-08-10T23:00:00Z",
            "source_name": "sportsbook_manual_verified",
            "evidence_id": "evidence-1",
            "screenshot_sha256": "a" * 64,
            "canonical_match": True,
            "duplicate": False,
        }
        self.entry = validate_entry_snapshot({
            **self.base,
            "captured_at": "2026-08-10T21:00:00Z",
            "snapshot_type": "entry",
            "stale_status": "FRESH",
            "safe_for_entry": True,
        })

    def test_missing_closing_blocks_settlement(self):
        closing = validate_closing_snapshot({**self.base, "captured_at": None})
        decision = validate_settlement_eligibility(
            self.entry, closing, result_final=True, result_source_verified=True
        )
        self.assertFalse(decision["eligible"])
        self.assertIn("CLOSING_CHAIN_INVALID", decision["reasons"])

    def test_post_kickoff_closing_blocks_settlement(self):
        closing = validate_closing_snapshot({
            **self.base,
            "captured_at": "2026-08-10T23:01:00Z",
            "snapshot_type": "closing",
            "safe_for_closing": True,
        })
        decision = validate_settlement_eligibility(
            self.entry, closing, result_final=True, result_source_verified=True
        )
        self.assertFalse(decision["eligible"])

    def test_unverified_result_blocks_settlement(self):
        closing = validate_closing_snapshot({
            **self.base,
            "captured_at": "2026-08-10T22:53:00Z",
            "snapshot_type": "closing",
            "safe_for_closing": True,
        })
        decision = validate_settlement_eligibility(
            self.entry, closing, result_final=True, result_source_verified=False
        )
        self.assertFalse(decision["eligible"])
        self.assertIn("RESULT_SOURCE_NOT_VERIFIED", decision["reasons"])


if __name__ == "__main__":
    unittest.main()
