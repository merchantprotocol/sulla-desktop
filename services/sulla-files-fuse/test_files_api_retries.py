# SPDX-License-Identifier: GPL-2.0-or-later
"""Bounded retry and privacy-safe failure reporting for FUSE HTTP calls."""
import errno
import json
import unittest
from unittest.mock import patch

from test_directory_paging import load_adapter


class FilesApiRetryTests(unittest.TestCase):
    # risk: authentication availability — a just-rotated capability must not make a user write fail.
    def test_retries_401_after_rereading_rotated_token_until_request_succeeds(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        calls = []

        def send(path, method, body, headers):
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

        def send(path, method, body, headers):
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

        def send(*_args):
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

        def send(*_args):
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

        def send(*_args):
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
