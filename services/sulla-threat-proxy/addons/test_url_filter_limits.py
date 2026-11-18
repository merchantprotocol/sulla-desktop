"""Behavioral coverage for URLhaus memory caps."""
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

os.environ["SULLA_PROXY_NO_AUTOLOAD"] = "1"
sys.path.insert(0, os.path.dirname(__file__))
import url_filter


class URLhausLimitTests(unittest.TestCase):
    # risk: malware blocking — invalid oversized refreshes must not erase a working list.
    def test_oversized_delivery_is_rejected_and_current_set_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            delivered = os.path.join(directory, "delivered.txt")
            bundled = os.path.join(directory, "bundled.txt")
            with open(delivered, "wb") as handle:
                handle.truncate(32 * 1024 * 1024 + 1)
            with open(bundled, "w", encoding="utf-8") as handle:
                handle.write("bundled.example\n")
            instance = url_filter.URLFilter.__new__(url_filter.URLFilter)
            instance._urlhaus_hosts = {"known-good.example"}
            instance._urlhaus_loaded_at = 0
            instance._urlhaus_lock = threading.Lock()
            with patch.object(url_filter, "URLHAUS_PATH", delivered), patch.object(
                url_filter, "BUNDLED_URLHAUS_PATH", bundled
            ), patch.object(url_filter, "URLHAUS_RELOAD_SECS", 0):
                instance._reload_urlhaus()
            self.assertEqual(instance._urlhaus_hosts, {"known-good.example"})

    # risk: malware blocking — host-count cap rejects an adversarially large list.
    def test_host_limit_is_checked_during_read(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "hosts.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.writelines(f"host{i}.example\n" for i in range(1_000_001))
            with self.assertRaisesRegex(ValueError, "1,000,000"):
                url_filter.URLFilter.__new__(url_filter.URLFilter)._read_urlhaus_file(path)


if __name__ == "__main__":
    unittest.main()
