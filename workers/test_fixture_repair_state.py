import unittest

from fixture_repair_state import RepairState, classify_group, filter_by_state


class FixtureRepairStateTest(unittest.TestCase):
    def test_ambiguous_source_owner_blocks_replay(self):
        group = {"matches": [{}, {}], "source_ref_owner_count": 0, "provider_mapped_match_count": 0}
        self.assertIs(classify_group(group), RepairState.BLOCKED_SOURCE_REF_AMBIGUOUS)

    def test_missing_provider_coverage_requires_replay(self):
        group = {"matches": [{}, {}], "source_ref_owner_count": 1, "provider_mapped_match_count": 1}
        self.assertIs(classify_group(group), RepairState.NEEDS_PROVIDER_EVENT_REPLAY)

    def test_complete_provider_coverage_is_ready_for_review(self):
        group = {"matches": [{}, {}], "source_ref_owner_count": 1, "provider_mapped_match_count": 2}
        self.assertIs(classify_group(group), RepairState.READY_FOR_MANUAL_MERGE_REVIEW)

    def test_filter_uses_classifier_not_stale_string(self):
        replayable = {
            "matches": [{}, {}],
            "source_ref_owner_count": 1,
            "provider_mapped_match_count": 0,
            "repair_state": RepairState.READY_FOR_MANUAL_MERGE_REVIEW.value,
        }
        self.assertEqual(
            filter_by_state([replayable], RepairState.NEEDS_PROVIDER_EVENT_REPLAY),
            [replayable],
        )


if __name__ == "__main__":
    unittest.main()
