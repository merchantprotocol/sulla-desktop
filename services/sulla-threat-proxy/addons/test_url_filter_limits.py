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
import common
import url_filter


class RecordingDailyCounters:
    """Stands in for DailyCounters; records the `blocked` flag of each increment."""

    def __init__(self):
        self.calls = []

    def increment(self, blocked=False, now=None):
        self.calls.append(blocked)


def new_url_filter():
    """Build a URLFilter without __init__, with the daily counter URLFilter.requestheaders needs."""
    instance = url_filter.URLFilter.__new__(url_filter.URLFilter)
    instance.daily_counters = RecordingDailyCounters()
    return instance


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
            instance = new_url_filter()
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
                new_url_filter()._read_urlhaus_file(path)

    class Config:
        generation = 1
        def refresh(self):
            pass
        def get(self, key, default=None):
            return {"blockMode": "block", "allowlist": []}.get(key, default)

    def make_flow(self, method="GET"):
        request = SimpleNamespace(pretty_url="https://blocked.example/path", pretty_host="blocked.example", host="blocked.example", method=method, headers={}, stream=True)
        flow = SimpleNamespace(request=request, response=None, metadata={}, server_conn=None, client_conn=None)
        flow.kill_called = False
        flow.kill = lambda: setattr(flow, "kill_called", True)
        return flow

    def make_blocking_instance(self):
        instance = new_url_filter()
        instance.config = self.Config()
        instance._config_generation = -1
        instance._scan = lambda _url, _host, _names: (url_filter.FLAG_BLOCK, ["urlhaus:exact"])
        return instance

    # risk: URL blocking — a bodiless blocked GET (no Content-Length) gets the 451 explanation, not a reset.
    def test_blocked_bodiless_get_is_answered_with_451_not_killed(self):
        instance = self.make_blocking_instance()
        flow = self.make_flow(method="GET")
        instance.requestheaders(flow)
        self.assertFalse(flow.kill_called)
        self.assertFalse(flow.request.stream)
        self.assertIsNone(flow.response)
        instance.request(flow)
        self.assertFalse(flow.kill_called)
        self.assertEqual(flow.response.status_code, 451)

    # risk: availability — chunked uploads have unknown length and are killed before buffering.
    def test_blocked_chunked_post_is_killed(self):
        instance = self.make_blocking_instance()
        flow = self.make_flow(method="POST")
        flow.request.headers["Transfer-Encoding"] = "chunked"
        instance.requestheaders(flow)
        self.assertTrue(flow.kill_called)
        self.assertIsNone(flow.response)
        self.assertTrue(flow.request.stream)

    # risk: availability — a blocked upload over 64 KiB is killed, never buffered.
    def test_blocked_post_over_cap_is_killed(self):
        instance = self.make_blocking_instance()
        flow = self.make_flow(method="POST")
        flow.request.headers["Content-Length"] = "1048576"
        instance.requestheaders(flow)
        self.assertTrue(flow.kill_called)
        self.assertIsNone(flow.response)
        self.assertTrue(flow.request.stream)

    # risk: policy delivery — a small blocked upload is buffered and receives 451.
    def test_blocked_small_post_gets_451(self):
        instance = self.make_blocking_instance()
        flow = self.make_flow(method="POST")
        flow.request.headers["Content-Length"] = str(10 * 1024)
        instance.requestheaders(flow)
        self.assertFalse(flow.kill_called)
        self.assertFalse(flow.request.stream)
        instance.request(flow)
        self.assertEqual(flow.response.status_code, 451)

    # risk: availability — an unframed POST may carry an HTTP/2 body, so it is killed rather than buffered.
    def test_blocked_unframed_post_is_killed(self):
        instance = self.make_blocking_instance()
        flow = self.make_flow(method="POST")
        instance.requestheaders(flow)
        self.assertTrue(flow.kill_called)
        self.assertIsNone(flow.response)

    # risk: URL blocking — blocked requests must not be streamed upstream and get 451.
    def test_block_verdict_is_applied_without_request_streaming(self):
        instance = new_url_filter()
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
        self.assertEqual(instance.daily_counters.calls, [True])

    # risk: policy delivery — warn mode keeps streaming and annotates the outbound request.
    def test_warn_verdict_adds_header_and_keeps_streaming(self):
        instance = new_url_filter()
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
        self.assertEqual(instance.daily_counters.calls, [False])

    # risk: availability — a blocked large upload is killed before body buffering or upstream contact.
    def test_blocked_large_upload_is_killed_at_headers(self):
        instance = new_url_filter()
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
        instance = new_url_filter()
        instance._apply_config = lambda: (_ for _ in ()).throw(RuntimeError("config failure"))
        flow = self.make_flow()
        before_stream = flow.request.stream
        # The fail_open_hook wrapper in common.py emits the line, so patch the logger it resolves.
        with patch.object(common, "log") as logger:
            instance.requestheaders(flow)
        self.assertIsNone(flow.response)
        self.assertEqual(flow.request.stream, before_stream)
        self.assertEqual(flow.metadata, {})
        logger.assert_called_with("url_filter", "warn", "fail_open", reason="RuntimeError", url="https://blocked.example/path", host="blocked.example")


if __name__ == "__main__":
    unittest.main()
