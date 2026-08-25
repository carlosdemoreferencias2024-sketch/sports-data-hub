import unittest

from replay_duplicate_fixtures import plan_group, resolve_row


GROUP = {
    "source_match_id": "espn-serie-a-event-genova-napoli",
    "league_slug": "serie-a",
    "repair_state": "NEEDS_PROVIDER_EVENT_REPLAY",
    "suggested_canonical_match_id": "canonical-uuid",
    "match_count": 1,
    "source_ref_owner_count": 1,
    "provider_mapped_match_count": 0,
    "matches": [
        {
            "id": "match-uuid",
            "match_date": "2026-08-22T18:45:00+00:00",
            "home_team": "Genoa",
            "away_team": "Napoli",
        }
    ],
}


class ReplayDuplicateFixturesTest(unittest.TestCase):
    def test_resolve_row_uses_real_group_shape_and_historical_mode(self):
        calls = []

        def resolver(**kwargs):
            calls.append(kwargs)
            return {"id": "401999001"}, {}, "https://example.test/scoreboard"

        result = resolve_row(GROUP, GROUP["matches"][0], resolver=resolver)

        self.assertEqual(result["resolution_state"], "RESOLVED")
        self.assertEqual(result["proposed_source_match_id"], "espn-serie-a-401999001")
        self.assertEqual(calls[0]["date_key"], "20260822")
        self.assertTrue(calls[0]["allow_post_kickoff"])

    def test_unresolved_row_is_preserved_for_manual_review(self):
        def resolver(**_kwargs):
            raise RuntimeError("ESPN_EVENT_NOT_FOUND")

        result = resolve_row(GROUP, GROUP["matches"][0], resolver=resolver)
        self.assertEqual(result["resolution_state"], "UNRESOLVED")
        self.assertEqual(result["reason"], "ESPN_EVENT_NOT_FOUND")

    def test_plan_never_claims_database_writes(self):
        def resolver(**_kwargs):
            return {"id": "401999001"}, {}, "https://example.test/scoreboard"

        result = plan_group(GROUP, resolver=resolver)
        self.assertEqual(result["resolved_count"], 1)
        self.assertEqual(result["unresolved_count"], 0)

    def test_apply_scope_forbids_foreign_key_remap(self):
        from unittest.mock import patch

        with patch(
            "replay_duplicate_fixtures.audit",
            return_value={"groups": [GROUP]},
        ):
            from replay_duplicate_fixtures import build_replay_plan

            result = build_replay_plan(limit=1, timeout=1, max_rows_per_group=0)

        self.assertEqual(result["repair_scope"], "LEGACY_SOURCE_COLLISION")
        self.assertFalse(result["foreign_key_remap_allowed"])


if __name__ == "__main__":
    unittest.main()
