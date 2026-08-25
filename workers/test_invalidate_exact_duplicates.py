import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from invalidate_exact_duplicates import (
    EXPECTED_ORIGINAL_BATCH_ID,
    EXPECTED_PLAN_SHA256,
    load_signed_collision_report,
)


def report_fixture() -> dict:
    rows = []
    for index in range(4):
        rows.append({
            "match_id": f"duplicate-{index}",
            "classification": "EXACT_EVENT_DUPLICATE_OWNER_PRESENT",
            "current_owner": {"match_id": f"owner-{index}"},
        })
    rows.append({"match_id": "alias", "classification": "DATA_SOURCE_ALIAS_MISSING"})
    return {
        "mode": "READ_ONLY_REVIEW",
        "batch_id": EXPECTED_ORIGINAL_BATCH_ID,
        "plan_sha256": EXPECTED_PLAN_SHA256,
        "collision_count": 5,
        "database_writes_executed": False,
        "rows": rows,
    }


class SignedCollisionReportTests(unittest.TestCase):
    def write_report(self, report: dict) -> tuple[Path, str, tempfile.TemporaryDirectory]:
        temporary = tempfile.TemporaryDirectory()
        path = Path(temporary.name) / "collision.json"
        payload = json.dumps(report).encode("utf-8")
        path.write_bytes(payload)
        return path, hashlib.sha256(payload).hexdigest(), temporary

    def test_accepts_exactly_four_unique_owners(self):
        path, digest, temporary = self.write_report(report_fixture())
        self.addCleanup(temporary.cleanup)
        loaded = load_signed_collision_report(path, digest)
        self.assertEqual(len(loaded["approved_exact_duplicate_rows"]), 4)

    def test_rejects_hash_mismatch(self):
        path, _, temporary = self.write_report(report_fixture())
        self.addCleanup(temporary.cleanup)
        with self.assertRaisesRegex(RuntimeError, "COLLISION_REPORT_SHA256_MISMATCH"):
            load_signed_collision_report(path, "0" * 64)

    def test_rejects_duplicate_owner(self):
        report = report_fixture()
        report["rows"][1]["current_owner"]["match_id"] = "owner-0"
        path, digest, temporary = self.write_report(report)
        self.addCleanup(temporary.cleanup)
        with self.assertRaisesRegex(RuntimeError, "EXACT_DUPLICATE_OWNER_SET_INVALID"):
            load_signed_collision_report(path, digest)


if __name__ == "__main__":
    unittest.main()
