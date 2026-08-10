import os
import unittest
from unittest.mock import patch

from pre_bet_validator import validate_mlb_fixture


class MlbFixtureLocalDateTests(unittest.TestCase):
    def validate(self, match_date: str):
        with patch.dict(
            os.environ,
            {
                "PREBET_TARGET_DATE": "2026-08-10",
                "TRADING_TIME_ZONE": "America/Matamoros",
            },
            clear=False,
        ):
            return validate_mlb_fixture(
                match_date=match_date,
                home_team="Arizona Diamondbacks",
                away_team="Colorado Rockies",
                status="scheduled",
            )

    def test_accepts_next_utc_day_when_still_target_local_date(self):
        result = self.validate("2026-08-11T01:40:00Z")
        self.assertTrue(result.ok)
        self.assertEqual(result.reason, "OK")

    def test_rejects_next_local_day(self):
        result = self.validate("2026-08-11T06:00:00Z")
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "INVALID_DATE")


if __name__ == "__main__":
    unittest.main()
