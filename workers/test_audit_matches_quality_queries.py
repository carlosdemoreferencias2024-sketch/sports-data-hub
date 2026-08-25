import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from audit_matches_quality_queries import find_unapproved_queries


class MatchQualityQueryAuditTest(unittest.TestCase):
    def test_detects_direct_match_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = root / "workers" / "new_model.py"
            worker.parent.mkdir(parents=True)
            worker.write_text("query = 'SELECT * FROM matches m'", encoding="utf-8")
            with patch("audit_matches_quality_queries.SCAN_ROOTS", ("workers",)):
                findings = find_unapproved_queries(root)
            self.assertEqual(findings[0]["file"], "workers/new_model.py")

    def test_accepts_valid_view(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = root / "workers" / "new_model.py"
            worker.parent.mkdir(parents=True)
            worker.write_text("query = 'SELECT * FROM v_valid_matches m'", encoding="utf-8")
            with patch("audit_matches_quality_queries.SCAN_ROOTS", ("workers",)):
                findings = find_unapproved_queries(root)
            self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
