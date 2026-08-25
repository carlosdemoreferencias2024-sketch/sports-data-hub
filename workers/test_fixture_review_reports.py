import unittest
from datetime import UTC, datetime, timedelta

from generate_collision_review import classify_collision
from generate_unresolved_review import age_bucket, classify_unresolved


class FixtureReviewReportTest(unittest.TestCase):
    def test_exact_owner_collision_is_classified_as_duplicate(self):
        match_date = datetime(2026, 8, 22, 23, 30, tzinfo=UTC)
        blocked = {
            "match_date": match_date,
            "home_team": "Charlotte",
            "away_team": "DC United",
            "invalidated_reason": "SOURCE_MATCH_ID_ALREADY_OWNED:owner",
        }
        owner = {
            "match_date": match_date,
            "home_team": "Charlotte",
            "away_team": "DC United",
            "data_quality_flag": "AUTHENTIC",
            "raw_data": {"source_match_id": "espn-mls-761741"},
        }
        resolution = {"proposed_source_match_id": "espn-mls-761741"}
        self.assertEqual(
            classify_collision(blocked, owner, resolution),
            "EXACT_EVENT_DUPLICATE_OWNER_PRESENT",
        )

    def test_data_source_failure_is_not_identity_ambiguity(self):
        blocked = {"invalidated_reason": "DATA_SOURCE_NOT_FOUND:espn-liga-mx"}
        self.assertEqual(
            classify_collision(blocked, None, {}), "DATA_SOURCE_ALIAS_MISSING"
        )

    def test_unresolved_with_quote_stays_pending(self):
        row = {
            "direct_reference_counts": {"model_quotes.match_id": 1},
            "raw_data": {},
            "source_ref_count": 0,
        }
        self.assertEqual(
            classify_unresolved(row, "ESPN_EVENT_NOT_FOUND"),
            "HAS_INDEPENDENT_EVIDENCE_KEEP_PENDING",
        )

    def test_age_buckets(self):
        now = datetime(2026, 8, 25, tzinfo=UTC)
        self.assertEqual(age_bucket(now - timedelta(days=5), now), "under_30_days")
        self.assertEqual(age_bucket(now - timedelta(days=60), now), "30_to_179_days")


if __name__ == "__main__":
    unittest.main()
