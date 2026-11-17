"""Behavioral coverage for URLhaus bundled-default selection."""
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import url_filter


class URLhausFallbackTests(unittest.TestCase):
    def make_filter(self):
        instance = url_filter.URLFilter.__new__(url_filter.URLFilter)
        instance._urlhaus_hosts = set()
        instance._urlhaus_loaded_at = 0.0
        instance._urlhaus_lock = threading.Lock()
        return instance

    # risk: malware blocking — fresh installs/offline startup must use the shipped host snapshot.
    def test_missing_desktop_file_uses_bundled_default_and_logs_snapshot_date(self):
        with tempfile.TemporaryDirectory() as directory:
            delivered = os.path.join(directory, "delivered.txt")
            bundled = os.path.join(directory, "default.txt")
            with open(bundled, "w", encoding="utf-8") as handle:
                handle.write("# Updated: 2026-11-17T00:11:12Z\n0.0.0.0 malware.example\n")
            instance = self.make_filter()
            with patch.object(url_filter, "URLHAUS_PATH", delivered), patch.object(
                url_filter, "BUNDLED_URLHAUS_PATH", bundled
            ), patch.object(url_filter, "log") as logger:
                instance._reload_urlhaus()
            self.assertEqual(instance._urlhaus_hosts, {"malware.example"})
            logger.assert_any_call(
                "url_filter", "info", "using bundled URLhaus default list",
                host_count=1, updated="2026-11-17T00:11:12Z", path=bundled,
            )

    # risk: list freshness — Desktop-delivered list must supersede bundled data once it arrives.
    def test_delivered_list_replaces_default_after_reload_interval(self):
        with tempfile.TemporaryDirectory() as directory:
            delivered = os.path.join(directory, "delivered.txt")
            bundled = os.path.join(directory, "default.txt")
            with open(bundled, "w", encoding="utf-8") as handle:
                handle.write("0.0.0.0 bundled.example\n")
            instance = self.make_filter()
            with patch.object(url_filter, "URLHAUS_PATH", delivered), patch.object(
                url_filter, "BUNDLED_URLHAUS_PATH", bundled
            ), patch.object(url_filter, "URLHAUS_RELOAD_SECS", 0):
                instance._reload_urlhaus()
                with open(delivered, "w", encoding="utf-8") as handle:
                    handle.write("delivered.example\n")
                instance._reload_urlhaus()
            self.assertEqual(instance._urlhaus_hosts, {"delivered.example"})

    # risk: malware blocking — a zero-entry delivery must not erase the working bundled list.
    def test_empty_delivered_list_keeps_bundled_default(self):
        with tempfile.TemporaryDirectory() as directory:
            delivered = os.path.join(directory, "delivered.txt")
            bundled = os.path.join(directory, "default.txt")
            open(delivered, "w", encoding="utf-8").close()
            with open(bundled, "w", encoding="utf-8") as handle:
                handle.write("fallback.example\n")
            instance = self.make_filter()
            with patch.object(url_filter, "URLHAUS_PATH", delivered), patch.object(
                url_filter, "BUNDLED_URLHAUS_PATH", bundled
            ):
                instance._reload_urlhaus()
            self.assertEqual(instance._urlhaus_hosts, {"fallback.example"})


if __name__ == "__main__":
    unittest.main()
