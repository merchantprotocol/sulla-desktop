# SPDX-License-Identifier: GPL-2.0-or-later
"""Bounded-memory file-body transfers."""
import errno
import asyncio
import os
import tempfile
import threading
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
            asyncio.run(api.read_to_file("file", spool))
            spool.seek(0)
            self.assertEqual(spool.read(), body)
        self.assertEqual(response.assert_amount, adapter.STREAM_CHUNK_BYTES)

    # risk: file integrity — a transient retry must discard partial bytes from its failed attempt.
    def test_retry_truncates_partial_download_before_restreaming(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        attempts = []
        def send(path, method, body, headers, sink=None, **_kwargs):
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
        api = adapter.FilesApi("http://files", "/unused")
        started = threading.Event()
        release = threading.Event()
        lock = threading.Lock()
        active = 0
        maximum = 0

        def send(*_args, **_kwargs):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
                if active == adapter.MAX_CONCURRENT_TRANSFERS:
                    started.set()
            release.wait(5)
            with lock:
                active -= 1
            return 200, {"ETag": '"v1"'}, b""

        api._send = send
        async def transfers():
            files = [tempfile.TemporaryFile() for _ in range(8)]
            try:
                tasks = [asyncio.create_task(api.read_to_file(f"file-{i}", file)) for i, file in enumerate(files)]
                await asyncio.to_thread(started.wait, 5)
                release.set()
                await asyncio.gather(*tasks)
            finally:
                release.set()
                for file in files:
                    file.close()
        asyncio.run(transfers())
        self.assertEqual(maximum, adapter.MAX_CONCURRENT_TRANSFERS)

    # risk: file availability and integrity — merge-after-write must support bodies larger than the metadata response cap.
    def test_large_merge_after_write_uses_streaming(self):
        adapter, _ = load_adapter()
        adapter.SPOOL_DIR = tempfile.gettempdir()
        api = adapter.FilesApi("http://files", "/unused")
        api._token = lambda: "synthetic"
        body = b"m" * (adapter.MAX_RESPONSE_BYTES + 1024)

        class Response:
            status = 200
            headers = {"Content-Length": str(len(body)), "ETag": '"v2"', "X-Sulla-Source-Hash": "hash"}
            def stream(self, amount, decode_content=False):
                for offset in range(0, len(body), amount):
                    yield body[offset:offset + amount]
            def read(self, *_args):
                raise AssertionError("whole-body read used")
            def release_conn(self): pass

        api.http.request = lambda *args, **kwargs: Response()
        class Ops(adapter.SullaFiles):
            def _content_unchanged(self, handle): return False
            async def _as_actor(self, actor, awaitable): return await awaitable
        operations = Ops(api)
        inode = operations._node("large", False)
        operations.nodes[inode].update({"id": "file-1", "directory": False})
        spool = tempfile.TemporaryFile()
        operations.handles[1] = {"inode": inode, "fileId": "file-1", "file": spool, "size": 1,
                                 "versionId": "v1", "sourceHash": "old", "dirty": True,
                                 "failedErrno": None, "actor": None}
        async def merged_write(*_args): return ({}, True)
        api.write = merged_write
        asyncio.run(operations._commit(1))
        self.assertEqual(operations.handles[1]["size"], len(body))
        self.assertEqual(os.pread(spool.fileno(), len(body), 0), body)
        spool.close()
