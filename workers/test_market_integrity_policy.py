import unittest

from market_integrity_policy import (
    validate_clean_sample_eligibility,
    validate_closing_snapshot,
    validate_entry_snapshot,
    validate_settlement_eligibility,
)


class MarketIntegrityPolicyTest(unittest.TestCase):
    def setUp(self):
        self.base = {
            "kickoff": "2026-08-10T23:00:00Z",
            "source_name": "sportsbook_manual_verified",
            "evidence_id": "evidence-1",
            "screenshot_sha256": "a" * 64,
            "canonical_match": True,
            "duplicate": False,
        }

    def test_complete_chain_is_clean(self):
        entry = validate_entry_snapshot({
            **self.base,
            "captured_at": "2026-08-10T21:00:00Z",
            "snapshot_type": "entry",
            "stale_status": "FRESH",
            "safe_for_entry": True,
        })
        closing = validate_closing_snapshot({
            **self.base,
            "captured_at": "2026-08-10T22:53:00Z",
            "snapshot_type": "closing",
            "safe_for_closing": True,
        })
        settlement = validate_settlement_eligibility(
            entry, closing, result_final=True, result_source_verified=True
        )
        clean = validate_clean_sample_eligibility(
            settlement, settlement_final=True, clv_valid=True
        )
        self.assertTrue(entry["eligible"])
        self.assertTrue(closing["eligible"])
        self.assertTrue(clean["eligible"])

    def test_missing_evidence_blocks_entry(self):
        entry = validate_entry_snapshot({
            **self.base,
            "evidence_id": None,
            "captured_at": "2026-08-10T21:00:00Z",
            "snapshot_type": "entry",
            "stale_status": "FRESH",
            "safe_for_entry": True,
        })
        self.assertFalse(entry["eligible"])
        self.assertIn("EVIDENCE_MISSING", entry["reasons"])

    def test_late_closing_is_audit_only(self):
        closing = validate_closing_snapshot({
            **self.base,
            "captured_at": "2026-08-10T23:01:00Z",
            "snapshot_type": "closing",
            "safe_for_closing": True,
        })
        self.assertFalse(closing["eligible"])
        self.assertTrue(closing["audit_only"])


if __name__ == "__main__":
    unittest.main()
