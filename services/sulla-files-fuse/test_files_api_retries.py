# SPDX-License-Identifier: GPL-2.0-or-later
"""Bounded retry and privacy-safe failure reporting for FUSE HTTP calls."""
import errno
import json
import unittest
import types
import time
import asyncio
from unittest.mock import patch

from test_directory_paging import load_adapter


class FilesApiRetryTests(unittest.TestCase):
    # risk: availability — sequential Files calls within one kernel op cannot multiply its outage timeout.
    def test_create_then_put_chain_shares_operation_deadline(self):
        adapter, _ = load_adapter()
        clock = [0.0]
        adapter.time = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda delay: clock.__setitem__(0, clock[0] + delay))
        api = adapter.FilesApi("http://files", "/unused")
        api.max_wait_seconds = 1
        calls = []
        def send(path, method, body, headers, sink=None, timeout_seconds=None):
            # Models the real per-attempt bound: urllib3 Timeout(total=remaining) caps each attempt at its budget.
            calls.append(1)
            attempt_cost = min(0.6, timeout_seconds) if timeout_seconds is not None else 0.6
            clock[0] += attempt_cost
            if len(calls) == 1:
                return 201, {}, b"created"
            # Budget consumed mid-attempt: the transport gives up with a timeout-style transient error.
            error = OSError(errno.EIO, "offline (timed out)")
            error.status = 503
            raise error
        api._send = send
        token = adapter.op_deadline.set(1.0)
        try:
            self.assertEqual(api._request("/create", "POST", b"")[2], b"created")
            with self.assertRaises(OSError) as caught:
                api._request("/content")
            self.assertEqual(caught.exception.errno, errno.EIO)
            self.assertEqual(len(calls), 2)  # retry is cut off at the operation deadline
            self.assertLessEqual(clock[0], 1.05)
        finally:
            adapter.op_deadline.reset(token)

    # risk: availability — background feed polling remains request-bounded, not tied to a kernel op.
    def test_request_outside_kernel_op_ignores_operation_deadline(self):
        adapter, _ = load_adapter()
        clock = [0.0]
        adapter.time = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda delay: clock.__setitem__(0, clock[0] + delay))
        api = adapter.FilesApi("http://files", "/unused")
        api.max_wait_seconds = 1
        calls = []
        def send(*_args, **_kwargs):
            calls.append(1)
            if len(calls) == 1:
                clock[0] += 0.6
                error = OSError(errno.EIO, "offline")
                error.status = 503
                raise error
            return 200, {}, b"ok"
        api._send = send
        token = adapter.op_deadline.set(-1.0)
        try:
            # A feed poller is outside a traced operation, so it has no op context.
            adapter.op_deadline.set(None)
            self.assertEqual(api._request("/changes")[2], b"ok")
        finally:
            adapter.op_deadline.reset(token)

    # risk: data integrity — a temporary Files outage must recover within the configured write window.
    def test_bounded_wait_succeeds_when_service_returns_before_deadline(self):
        adapter, _ = load_adapter()
        clock = [0.0]
        adapter.time = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda delay: clock.__setitem__(0, clock[0] + delay))
        api = adapter.FilesApi("http://files", "/unused")
        api.max_wait_seconds = 3
        calls = []

        def send(*_args, **_kwargs):
            calls.append(1)
            if len(calls) < 3:
                error = OSError(errno.EIO, "offline")
                error.status = 503
                raise error
            return 200, {}, b"ok"

        api._send = send
        self.assertEqual(api._request("/v1/fuse/entry")[2], b"ok")

    # risk: bounded availability — a lost Files service must become a clean EIO rather than hang.
    def test_bounded_wait_stops_after_configured_window(self):
        adapter, _ = load_adapter()
        clock = [0.0]
        adapter.MAX_WAIT_SECONDS = 1
        adapter.time = types.SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda delay: clock.__setitem__(0, clock[0] + delay))
        api = adapter.FilesApi("http://files", "/unused")

        def send(*_args, **_kwargs):
            error = OSError(errno.EIO, "offline")
            error.status = 503
            raise error

        api._send = send
        with self.assertRaises(OSError) as caught:
            api._request("/v1/fuse/entry")
        self.assertEqual(caught.exception.errno, errno.EIO)
        self.assertGreaterEqual(clock[0], 1)

    # risk: authentication availability — a partially-written empty token must be re-read, not fail immediately.
    def test_empty_token_retries_until_token_is_populated(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        tokens = iter((b"", b"fresh-token"))
        api._token = lambda: next(tokens)
        calls = []

        def send_with_empty(*_args, **_kwargs):
            token = api._token()
            if not token:
                error = OSError(errno.EACCES, "empty")
                error.transient_auth = True
                calls.append("empty")
                raise error
            calls.append("fresh")
            return 200, {}, b"ok"
        api._send = send_with_empty
        with unittest.mock.patch.object(adapter.time, "sleep"):
            self.assertEqual(api._request("/v1/fuse/entry")[2], b"ok")
        self.assertEqual(calls, ["empty", "fresh"])

    # risk: availability under concurrency — open spools are disk-backed and thousands of handles must not hit EMFILE at 32.
    def test_configured_handle_cap_exceeds_legacy_limit(self):
        adapter, _ = load_adapter()
        self.assertGreater(adapter.MAX_OPEN_HANDLES, 32)

    # risk: availability during an outage — Files work must use its own Trio thread limiter, not consume local-op capacity.
    def test_network_request_uses_dedicated_limiter(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        observed = []
        async def run_sync(function, *args, **kwargs):
            observed.append(kwargs.get("limiter"))
            return function(*args)
        adapter.trio.to_thread.run_sync = run_sync
        api._request = lambda *_args, **_kwargs: (200, {}, b'{"path":"a"}')
        asyncio.run(api.entry(None, "a"))
        self.assertEqual(observed, [api.network_limiter])

    # risk: authentication availability — a just-rotated capability must not make a user write fail.
    def test_retries_401_after_rereading_rotated_token_until_request_succeeds(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        calls = []

        def send(path, method, body, headers, **_kwargs):
            calls.append(1)
            if len(calls) < 3:
                error = OSError(errno.EACCES, "unauthorized")
                error.status = 401
                raise error
            return 200, {}, b"ok"

        api._send = send
        with patch.object(adapter.time, "sleep"):
            self.assertEqual(api._request("/v1/fuse/files?path=a/x", "POST", b"x")[2], b"ok")
        self.assertEqual(len(calls), 3)

    # risk: permission and file-size failures must preserve errno instead of collapsing into generic EIO.
    def test_maps_http_permission_and_size_errors_to_specific_errno(self):
        adapter, _ = load_adapter()

        class Response:
            def __init__(self, status, detail):
                self.status = status
                self.headers = {}
                self.detail = detail

            def read(self, _limit):
                return json.dumps(self.detail).encode()

            def release_conn(self):
                pass

        for status, expected in ((403, errno.EACCES), (413, errno.EFBIG)):
            api = adapter.FilesApi("http://files", "/unused")
            api._token = lambda: "synthetic"
            api.http.request = lambda *args, _status=status, **kwargs: Response(_status, {"code":"TEST", "error":"failure"})
            with self.subTest(status=status), self.assertRaises(OSError) as caught:
                api._send("/v1/fuse/entry", "GET", None, None)
            self.assertEqual(caught.exception.errno, expected)
            self.assertEqual(caught.exception.status, status)

    # risk: transient namespace lock contention used to surface as EIO/EPERM to mount clients.
    def test_retries_lock_contention_then_returns_success(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        calls = []

        def send(path, method, body, headers, **_kwargs):
            calls.append(method)
            if len(calls) < 3:
                error = OSError(errno.EPERM, "busy")
                error.status = 409
                error.detail = {"error": "namespace is concurrently or are busy"}
                raise error
            return 201, {}, b"ok"

        api._send = send
        self.assertEqual(api._request("/v1/fuse/files?path=a/x", "POST")[2], b"ok")
        self.assertEqual(calls, ["POST", "POST", "POST"])

    # risk: transient reads should recover rather than turn an idle healthy mount into EIO.
    def test_retries_transient_gateway_failure_for_idempotent_read(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        calls = []

        def send(*_args, **_kwargs):
            calls.append(1)
            if len(calls) == 1:
                error = OSError(errno.EIO, "gateway")
                error.status = 503
                raise error
            return 200, {}, b"ok"

        api._send = send
        self.assertEqual(api._request("/v1/fuse/entry", "GET")[2], b"ok")
        self.assertEqual(len(calls), 2)

    # risk: retrying a non-idempotent create after an ambiguous transport error can duplicate writes.
    def test_does_not_retry_post_after_transient_transport_failure(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        calls = []

        def send(*_args, **_kwargs):
            calls.append(1)
            error = OSError(errno.EIO, "offline")
            error.transient = True
            raise error

        api._send = send
        with self.assertRaises(OSError):
            api._request("/v1/fuse/files?path=a/x", "POST", b"x")
        self.assertEqual(len(calls), 1)

    # risk: errors must remain diagnosable without leaking request credentials or response bodies.
    def test_logs_status_code_and_latency_without_error_body(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        entries = []
        adapter.emit = lambda event, level, **fields: entries.append((event, fields))

        def send(*_args, **_kwargs):
            error = OSError(errno.EIO, "private response body")
            error.status = 403
            error.detail = {"code": "TEMPORARY", "error": "private response body"}
            raise error

        api._send = send
        with self.assertRaises(OSError):
            api._request("/v1/fuse/files?path=redacted", "GET")
        self.assertEqual(entries[0][0], "files-request")
        self.assertEqual(entries[0][1]["status"], 403)
        self.assertEqual(entries[0][1]["code"], "TEMPORARY")
        self.assertIn("ms", entries[0][1])
        self.assertNotIn("private response body", repr(entries))


if __name__ == "__main__":
    unittest.main()
