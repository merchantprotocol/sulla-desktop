# SPDX-License-Identifier: GPL-2.0-or-later
import json
import os
import tempfile
import unittest
from common import DailyCounters


class DailyCountersTest(unittest.TestCase):
    def test_increments_scan_and_actual_block_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            counters = DailyCounters(os.path.join(directory, "daily-counters.json"))
            self.assertEqual(counters.increment(now=1_800_000_000), {"date": "2027-01-15", "scanned": 1, "blocked": 0})
            self.assertEqual(counters.increment(blocked=True, now=1_800_000_001), {"date": "2027-01-15", "scanned": 2, "blocked": 1})
            with open(counters.path, encoding="utf-8") as source:
                self.assertEqual(json.load(source), {"date": "2027-01-15", "scanned": 2, "blocked": 1})

    def test_rolls_over_at_utc_midnight_without_carrying_yesterdays_totals(self):
        with tempfile.TemporaryDirectory() as directory:
            counters = DailyCounters(os.path.join(directory, "daily-counters.json"))
            counters.increment(blocked=True, now=1_800_057_599)
            self.assertEqual(counters.increment(now=1_800_057_600), {"date": "2027-01-16", "scanned": 1, "blocked": 0})


if __name__ == "__main__":
    unittest.main()
