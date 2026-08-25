import unittest
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from reidentify_and_invalidate import (
    build_identity_plan,
    load_approved_invalid_ids,
    load_identity_plan,
    validate_invalidation_approvals,
    write_identity_plan,
)


REPLAYABLE = {
    "source_match_id": "espn-ligue-1-event-home-away",
    "league_slug": "ligue-1",
    "source_ref_owner_count": 1,
    "provider_mapped_match_count": 0,
    "matches": [
        {
            "id": "11111111-1111-1111-1111-111111111111",
            "match_date": "2026-08-21T18:45:00+00:00",
            "home_team": "Home",
            "away_team": "Away",
            "owns_source_ref": True,
            "provider_mappings": [],
        }
    ],
}
AMBIGUOUS = {
    "source_match_id": "espn-serie-a-event-a-b",
    "league_slug": "serie-a",
    "source_ref_owner_count": 0,
    "provider_mapped_match_count": 0,
    "matches": [
        {
            "id": "22222222-2222-2222-2222-222222222222",
            "match_date": "2026-08-22T18:45:00+00:00",
            "home_team": "A",
            "away_team": "B",
            "owns_source_ref": False,
            "provider_mappings": [],
        }
    ],
}


class ReidentifyPlanTest(unittest.TestCase):
    def test_unresolved_rows_remain_pending_and_no_fk_remap_is_allowed(self):
        unresolved = {
            "match_id": REPLAYABLE["matches"][0]["id"],
            "resolution_state": "UNRESOLVED",
            "reason": "ESPN_EVENT_NOT_FOUND",
        }
        with (
            patch("reidentify_and_invalidate.audit", return_value={"groups": [REPLAYABLE, AMBIGUOUS]}),
            patch("reidentify_and_invalidate._resolve_with_retries", return_value=unresolved),
        ):
            plan = build_identity_plan(None, 100, 1, 1, None)

        self.assertEqual(plan["unresolved_pending_review_count"], 1)
        self.assertEqual(plan["ambiguous_pending_review_count"], 1)
        self.assertFalse(plan["foreign_key_remap_allowed"])
        self.assertFalse(plan["database_writes_executed"])

    def test_invalidation_requires_exact_unresolved_plan_membership(self):
        plan = {
            "resolutions": [
                {"match_id": "unresolved", "resolution_state": "UNRESOLVED"},
                {"match_id": "resolved", "resolution_state": "RESOLVED"},
            ]
        }
        validate_invalidation_approvals(plan, {"unresolved"})
        with self.assertRaisesRegex(RuntimeError, "INVALIDATION_NOT_IN_UNRESOLVED_PLAN"):
            validate_invalidation_approvals(plan, {"resolved"})

    def test_plan_round_trip_requires_matching_sha256(self):
        plan = {
            "repair_scope": "LEGACY_SOURCE_COLLISION",
            "replayable_group_count": 1,
            "ambiguous_group_count": 0,
            "resolutions": [],
            "ambiguous_match_ids": [],
            "database_writes_executed": False,
        }
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "plan.json"
            digest = write_identity_plan(path, plan)
            self.assertEqual(load_identity_plan(path, digest), plan)

    def test_plan_load_rejects_wrong_sha256(self):
        plan = {
            "repair_scope": "LEGACY_SOURCE_COLLISION",
            "replayable_group_count": 1,
            "ambiguous_group_count": 0,
            "resolutions": [],
            "ambiguous_match_ids": [],
            "database_writes_executed": False,
        }
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "plan.json"
            write_identity_plan(path, plan)
            with self.assertRaisesRegex(RuntimeError, "PLAN_SHA256_MISMATCH"):
                load_identity_plan(path, "0" * 64)

    def test_approval_report_must_match_plan_sha256(self):
        plan_sha256 = "a" * 64
        report = {
            "plan_sha256": plan_sha256,
            "approved_invalid_match_ids": ["one", "two"],
        }
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "approval.json"
            payload = json.dumps(report).encode("utf-8")
            path.write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            self.assertEqual(
                load_approved_invalid_ids(path, digest, plan_sha256), {"one", "two"}
            )
            with self.assertRaisesRegex(RuntimeError, "APPROVAL_PLAN_SHA256_MISMATCH"):
                load_approved_invalid_ids(path, digest, "b" * 64)


if __name__ == "__main__":
    unittest.main()
