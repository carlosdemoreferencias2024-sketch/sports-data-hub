import unittest

from market_integrity_policy import closing_window_quality


class PreflightClosingQualityWindowTest(unittest.TestCase):
    def test_inclusive_window_edges(self):
        kickoff = "2026-08-10T23:00:00Z"
        self.assertEqual(closing_window_quality("2026-08-10T22:50:00Z", kickoff), "CAPTURED_ON_TIME")
        self.assertEqual(closing_window_quality("2026-08-10T22:57:00Z", kickoff), "CAPTURED_ON_TIME")
        self.assertEqual(closing_window_quality("2026-08-10T22:49:59.999Z", kickoff), "CAPTURED_TOO_EARLY")
        self.assertEqual(closing_window_quality("2026-08-10T22:57:00.001Z", kickoff), "CAPTURED_LATE")


if __name__ == "__main__":
    unittest.main()
