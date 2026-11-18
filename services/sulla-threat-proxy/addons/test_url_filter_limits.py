"""Behavioral coverage for URLhaus memory caps."""
import os
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
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

    class Config:
        generation = 1
        def refresh(self):
            pass
        def get(self, key, default=None):
            return {"blockMode": "block", "allowlist": []}.get(key, default)

    def make_flow(self):
        request = SimpleNamespace(pretty_url="https://blocked.example/path", pretty_host="blocked.example", host="blocked.example", headers={}, stream=True)
        return SimpleNamespace(request=request, response=None, metadata={}, server_conn=None, client_conn=None)

    # risk: URL blocking — blocked requests must not be streamed upstream and get 451.
    def test_block_verdict_is_applied_without_request_streaming(self):
        instance = url_filter.URLFilter.__new__(url_filter.URLFilter)
        instance.config = self.Config()
        instance._config_generation = -1
        instance._scan = lambda _url, _host, _names: (url_filter.FLAG_BLOCK, ["urlhaus:exact"])
        flow = self.make_flow()
        flow.request.headers["Content-Length"] = "1024"
        instance.requestheaders(flow)
        self.assertFalse(flow.request.stream)
        self.assertIsNone(flow.response)
        instance.request(flow)
        self.assertEqual(flow.response.status_code, 451)

    # risk: policy delivery — warn mode keeps streaming and annotates the outbound request.
    def test_warn_verdict_adds_header_and_keeps_streaming(self):
        instance = url_filter.URLFilter.__new__(url_filter.URLFilter)
        instance.config = self.Config()
        instance.config.get = lambda key, default=None: {"blockMode": "warn", "allowlist": []}.get(key, default)
        instance._config_generation = -1
        instance._scan = lambda _url, _host, _names: (url_filter.FLAG_BLOCK, ["urlhaus:exact"])
        flow = self.make_flow()
        instance.requestheaders(flow)
        self.assertTrue(flow.request.stream)
        self.assertEqual(flow.request.headers["X-Sulla-Threat"], "urlhaus:exact")
        instance.request(flow)
        self.assertIsNone(flow.response)

    # risk: availability — a blocked large upload is killed before body buffering or upstream contact.
    def test_blocked_large_upload_is_killed_at_headers(self):
        instance = url_filter.URLFilter.__new__(url_filter.URLFilter)
        instance.config = self.Config()
        instance._config_generation = -1
        instance._scan = lambda _url, _host, _names: (url_filter.FLAG_BLOCK, ["urlhaus:exact"])
        flow = self.make_flow()
        flow.request.headers["Content-Length"] = "1048576"
        flow.kill_called = False
        flow.kill = lambda: setattr(flow, "kill_called", True)
        instance.requestheaders(flow)
        self.assertTrue(flow.kill_called)
        self.assertIsNone(flow.response)
        self.assertTrue(flow.request.stream)

    # risk: availability — an internal reputation exception leaves the request unchanged.
    def test_hook_exception_is_fail_open(self):
        instance = url_filter.URLFilter.__new__(url_filter.URLFilter)
        instance._apply_config = lambda: (_ for _ in ()).throw(RuntimeError("config failure"))
        flow = self.make_flow()
        before_stream = flow.request.stream
        with patch.object(url_filter, "log") as logger:
            instance.requestheaders(flow)
        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.stream, before_stream)
        self.assertEqual(flow.metadata, {})
        logger.assert_called_with("url_filter", "warn", "fail_open", reason="RuntimeError", url="https://blocked.example/path", host="blocked.example")


if __name__ == "__main__":
    unittest.main()
