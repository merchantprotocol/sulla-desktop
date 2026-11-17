# SPDX-License-Identifier: GPL-2.0-or-later
"""Bounded-memory file-body transfers."""
import errno
import tempfile
import unittest
from unittest.mock import patch

from test_directory_paging import load_adapter


class BoundedTransferTests(unittest.TestCase):
    # risk: file availability and integrity — large downloads must never buffer the whole body.
    def test_download_streams_large_body_in_fixed_chunks_to_spool(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        api._token = lambda: "synthetic"
        body = b"x" * (20 * 1024 * 1024)

        class Response:
            status = 200
            headers = {"Content-Length": str(len(body)), "ETag": '"v1"'}
            def stream(self, amount, decode_content=False):
                self.assert_amount = amount
                for offset in range(0, len(body), amount): yield body[offset:offset + amount]
            def read(self, *_args): raise AssertionError("whole-body read used")
            def release_conn(self): pass

        response = Response()
        api.http.request = lambda *args, **kwargs: response
        with tempfile.TemporaryFile() as spool:
            api.read_to_file("file", spool)
            spool.seek(0)
            self.assertEqual(spool.read(), body)
        self.assertEqual(response.assert_amount, adapter.STREAM_CHUNK_BYTES)

    # risk: file integrity — a transient retry must discard partial bytes from its failed attempt.
    def test_retry_truncates_partial_download_before_restreaming(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        attempts = []
        def send(path, method, body, headers, sink=None):
            attempts.append(1)
            sink.write(b"partial" if len(attempts) == 1 else b"complete")
            if len(attempts) == 1:
                error = OSError(errno.EIO, "transient")
                error.transient = True
                raise error
            return 200, {}, b""
        api._send = send
        with tempfile.TemporaryFile() as spool, patch.object(adapter.time, "sleep"):
            api._request("/content", sink=spool)
            spool.seek(0)
            self.assertEqual(spool.read(), b"complete")

    # risk: memory pressure — independent body transfers cannot exceed the configured concurrency.
    def test_transfer_semaphore_is_bounded(self):
        adapter, _ = load_adapter()
        self.assertEqual(adapter.TRANSFER_SEMAPHORE._initial_value, adapter.MAX_CONCURRENT_TRANSFERS)
        self.assertEqual(adapter.MAX_CONCURRENT_TRANSFERS, 4)
