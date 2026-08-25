import unittest

from review_fixture_identity_plan import classify_unresolved_row


class ReviewFixtureIdentityPlanTest(unittest.TestCase):
    def test_approves_only_dependency_free_placeholder(self):
        decision, reasons = classify_unresolved_row({
            "created_kickoff_delta_seconds": 5,
            "status": "scheduled",
            "source_ref_count": 0,
            "provider_mapping_count": 0,
            "competitor_count": 2,
            "non_competitor_references": {"team_stat_snapshots.match_id": 2},
            "raw_data": {"source_match_id": "espn-ligue-1-event-home-away"},
        })
        self.assertEqual(decision, "APPROVED_SYNTHETIC")
        self.assertEqual(reasons, [])

    def test_keeps_rows_with_any_positive_evidence_pending(self):
        decision, reasons = classify_unresolved_row({
            "created_kickoff_delta_seconds": 5,
            "status": "scheduled",
            "source_ref_count": 1,
            "provider_mapping_count": 0,
            "competitor_count": 2,
            "non_competitor_references": {"model_quotes.match_id": 1},
            "raw_data": {"source_match_id": "espn-ligue-1-event-home-away"},
        })
        self.assertEqual(decision, "KEEP_PENDING_REVIEW")
        self.assertIn("has_source_ref", reasons)
        self.assertIn("has_non_competitor_references", reasons)


if __name__ == "__main__":
    unittest.main()
