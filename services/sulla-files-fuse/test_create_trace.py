# SPDX-License-Identifier: GPL-2.0-or-later
"""Each kernel op line reports the Files request time spent inside it (files_ms).

Create-latency trace: adapter time = op ms - files_ms. The Files requests run on a worker thread
(trio.to_thread.run_sync in production, asyncio.to_thread in the fake), so this also checks that the
per-op accumulator follows the call into the thread. Not run in this PR; the manager runs it once.
"""
import asyncio
import logging
import time
import unittest

from test_directory_paging import load_adapter


class FakeFilesApi:
    """Stands in for the Files HTTP layer: `_request` runs for real, only the socket call is replaced."""
    def __init__(self, adapter, delay_seconds):
        self.adapter = adapter
        self.delay_seconds = delay_seconds
        self.api = adapter.FilesApi.__new__(adapter.FilesApi)
        self.api.max_wait_seconds = 5
        self.api._send = self.send

    def send(self, path, method, body, headers, sink=None, timeout_seconds=None):
        time.sleep(self.delay_seconds)
        return 201, {}, b"{}"


class CreateTraceTests(unittest.TestCase):
    def setUp(self):
        self.adapter, self.pyfuse3 = load_adapter()
        self.events = []
        self.adapter.emit = lambda event, level=logging.INFO, **fields: self.events.append((event, level, fields))
        self.files = FakeFilesApi(self.adapter, delay_seconds=0.03)

    def op_lines(self, operation):
        return [fields for event, _level, fields in self.events if event == "fuse-op" and fields.get("op") == operation]

    # risk: diagnosis — the mkdir line must show how much of its time was Files, so adapter vs Files can be split from logs.
    def test_mutating_op_line_sums_every_files_request_made_inside_it(self):
        adapter, files = self.adapter, self.files

        class Ops:
            def _describe(self, describe, args):
                return {"path": "/dir"}

            @adapter.traced("mkdir", mutating=True)
            async def mkdir(self, *args):
                for _ in range(2):
                    await adapter.trio.to_thread.run_sync(files.api._request, "/v1/fuse/folders", "POST", b"{}", {"Content-Type": "application/json"})
                return "ok"

        self.assertEqual(asyncio.run(Ops().mkdir(1, "dir", 0, None)), "ok")
        lines = self.op_lines("mkdir")
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertTrue(line["ok"])
        # Two 30 ms Files requests: files_ms is at least their sleeps and never more than the op total.
        self.assertGreaterEqual(line["files_ms"], 55)
        self.assertLessEqual(line["files_ms"], line["ms"])
        # The op line is INFO because it mutates, and no accumulator leaks past the op.
        self.assertEqual(self.events[-1][1], logging.INFO)
        self.assertIsNone(adapter.op_files_ms.get())

    # risk: availability — a Files request made outside any traced op (warm-up, heartbeat) must still work and count nothing.
    def test_request_outside_an_op_has_no_accumulator_and_still_answers(self):
        status, _headers, body = self.files.api._request("/v1/fuse/entry?x=1")
        self.assertEqual((status, body), (201, b"{}"))
        self.assertIsNone(self.adapter.op_files_ms.get())
        self.assertFalse([fields for event, _l, fields in self.events if event == "fuse-op"])


if __name__ == "__main__":
    unittest.main()
