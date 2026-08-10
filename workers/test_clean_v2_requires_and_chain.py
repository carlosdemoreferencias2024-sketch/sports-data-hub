import unittest

from market_integrity_policy import validate_clean_sample_eligibility


class CleanV2RequiresAndChainTest(unittest.TestCase):
    def test_numeric_clv_cannot_rescue_invalid_closing(self):
        settlement = {
            "eligible": False,
            "status": "SETTLEMENT_BLOCKED",
            "reasons": ["CLOSING_CHAIN_INVALID"],
            "audit_only": True,
        }
        clean = validate_clean_sample_eligibility(
            settlement, settlement_final=True, clv_valid=True
        )
        self.assertFalse(clean["eligible"])


if __name__ == "__main__":
    unittest.main()
