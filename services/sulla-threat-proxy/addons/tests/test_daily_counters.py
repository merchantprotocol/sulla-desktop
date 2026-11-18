# SPDX-License-Identifier: GPL-2.0-or-later
import json
import os
import tempfile
import unittest
from common import DailyCounters
from url_filter import URLFilter


class DailyCountersTest(unittest.TestCase):
    def test_hourly_buckets_flush_periodically_and_load_once(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [1_800_000_000]
            path = os.path.join(directory, "daily-counters.json")
            counters = DailyCounters(path, clock=lambda: now[0])
            counters.increment(now=now[0])
            self.assertFalse(os.path.exists(path))
            counters.increment(blocked=True, now=now[0] + 1)
            self.assertFalse(os.path.exists(path))
            now[0] += 5
            counters.increment(now=now[0])
            with open(counters.path, encoding="utf-8") as source:
                self.assertEqual(json.load(source)["hours"]["2027-01-15T08"], {"scanned": 3, "blocked": 1})
            loaded = DailyCounters(path, clock=lambda: now[0])
            self.assertEqual(loaded._buckets["2027-01-15T08"]["scanned"], 3)

    def test_prunes_buckets_and_final_flush_persists_dirty_state(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [1_800_000_000]
            counters = DailyCounters(os.path.join(directory, "daily-counters.json"), clock=lambda: now[0])
            counters.increment(blocked=True, now=1_800_000_000 - 50 * 3600)
            counters.increment(now=1_800_000_000)
            self.assertEqual(list(counters._buckets), ["2027-01-15T08"])
            counters.flush()
            with open(counters.path, encoding="utf-8") as source:
                self.assertEqual(json.load(source)["hours"]["2027-01-15T08"]["scanned"], 1)

    def test_addon_done_flushes_counters(self):
        with tempfile.TemporaryDirectory() as directory:
            addon = URLFilter.__new__(URLFilter)
            addon.daily_counters = DailyCounters(os.path.join(directory, "daily-counters.json"))
            addon.daily_counters.increment(now=1_800_000_000)
            addon.done()
            self.assertTrue(os.path.exists(addon.daily_counters.path))


if __name__ == "__main__":
    unittest.main()
