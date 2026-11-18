# SPDX-License-Identifier: GPL-2.0-or-later
"""Files HTTP status -> errno table, and bounded retries that keep a dropped connection from failing a write."""
import errno
import json
import logging
import tempfile
import time
import types
import unittest

from test_directory_paging import load_adapter


class Response:
    def __init__(self, status, detail=None, headers=None):
        self.status = status
        self.headers = headers or {}
        self.detail = detail or {}

    def read(self, _limit):
        return json.dumps(self.detail).encode()

    def release_conn(self):
        pass


def failure(code, status, detail=None, transient=False):
    error = OSError(code, "synthetic")
    error.status = status
    error.detail = detail or {}
    if transient:
        error.transient = True
    return error


class ErrnoTableTests(unittest.TestCase):
    # risk: data loss / agent confusion — a stat before create (404) was reported as EIO, and
    # other statuses collapsed into EIO/EPERM so callers could not tell "missing" from "broken".
    def test_maps_each_files_status_to_the_errno_a_mount_client_expects(self):
        adapter, _ = load_adapter()
        cases = (
            (400, {}, errno.EINVAL), (428, {}, errno.EINVAL), (415, {}, errno.EINVAL),
            (401, {}, errno.EACCES), (403, {}, errno.EACCES),
            (404, {"error": "Files entry not found"}, errno.ENOENT),
            (409, {"error": "A file already occupies Stress/a.txt"}, errno.EEXIST),
            (409, {"error": "folder is not empty"}, errno.ENOTEMPTY),
            (409, {"error": "Files mount version changed"}, errno.EPERM),
            (413, {}, errno.EFBIG), (423, {}, errno.EROFS), (409, {"code": "FILE_LOCKED"}, errno.EROFS),
            (500, {}, errno.EIO), (503, {"code": "FILES_DB_RETRYABLE"}, errno.EIO),
        )
        for status, detail, expected in cases:
            api = adapter.FilesApi("http://files", "/unused")
            api._token = lambda: "synthetic"
            api.http.request = lambda *args, _status=status, _detail=detail, **kwargs: Response(_status, _detail)
            with self.subTest(status=status, detail=detail), self.assertRaises(OSError) as caught:
                api._send("/v1/fuse/entry", "GET", None, None)
            self.assertEqual(caught.exception.errno, expected)

    # risk: log noise hides real faults — the expected pre-create miss logged a WARNING per file.
    def test_entry_lookup_miss_is_enoent_and_not_a_warning(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        entries = []
        adapter.emit = lambda event, level, **fields: entries.append((event, level, fields))
        adapter.log.setLevel(logging.DEBUG)
        api._send = lambda *_args: (_ for _ in ()).throw(failure(errno.ENOENT, 404, {"error": "Files entry not found"}))
        with self.assertRaises(OSError) as caught:
            api._request("/v1/fuse/entry?path=new.txt")
        self.assertEqual(caught.exception.errno, errno.ENOENT)
        self.assertEqual([level for _, level, _ in entries], [logging.DEBUG])

    # risk: Retry-After from Files must be parsed so the mount backs off as asked.
    def test_parses_retry_after_from_a_retryable_response(self):
        adapter, _ = load_adapter()
        api = adapter.FilesApi("http://files", "/unused")
        api._token = lambda: "synthetic"
        api.http.request = lambda *args, **kwargs: Response(503, {"code": "FILES_DB_RETRYABLE"}, {"Retry-After": "1"})
        with self.assertRaises(OSError) as caught:
            api._send("/v1/fuse/files/x/content", "PUT", b"x", None)
        self.assertEqual(caught.exception.retry_after, 1.0)


class TransientRetryTests(unittest.TestCase):
    def setUp(self):
        self.adapter, _ = load_adapter()
        self.sleeps = []
        # Replace the module's clock only, never the shared `time` module.
        self.adapter.time = types.SimpleNamespace(monotonic=time.monotonic, sleep=self.sleeps.append)

    # risk: data loss — a Files 500/503 from one dropped DB connection failed the user's write with EIO.
    def test_write_survives_server_errors_from_a_lost_database_connection(self):
        api = self.adapter.FilesApi("http://files", "/unused")
        calls = []

        def send(path, method, body, headers, **_kwargs):
            calls.append(method)
            if len(calls) == 1:
                raise failure(errno.EIO, 500, {"error": "Client has encountered a connection error and is not queryable"})
            if len(calls) == 2:
                raise failure(errno.EIO, 503, {"code": "FILES_DB_RETRYABLE"})
            return 200, {}, b'{"versionId":"v2","sourceHash":"h"}'

        api._send = send
        self.assertEqual(api._request("/v1/fuse/files/f/content", "PUT", b"data")[0], 200)
        self.assertEqual(calls, ["PUT", "PUT", "PUT"])

    # risk: unbounded retry loops wedge a mount thread forever; a persistent outage must surface as EIO.
    def test_persistent_server_failure_surfaces_eio_after_bounded_retries(self):
        api = self.adapter.FilesApi("http://files", "/unused")
        api.max_wait_seconds = 0.5
        now = [0.0]
        self.adapter.time = types.SimpleNamespace(monotonic=lambda: now[0], sleep=lambda delay: (self.sleeps.append(delay), now.__setitem__(0, now[0] + delay)))
        calls = []

        def send(*_args, **_kwargs):
            calls.append(1)
            raise failure(errno.EIO, 503)

        api._send = send
        with self.assertRaises(OSError) as caught:
            api._request("/v1/fuse/files/f/content", "PUT", b"data")
        self.assertEqual(caught.exception.errno, errno.EIO)
        self.assertGreater(len(calls), self.adapter.MAX_TRANSIENT_RETRIES)
        self.assertGreaterEqual(now[0], 0.5)

    # risk: duplicate files — a create whose reply was lost must not fail or create twice on retry.
    def test_create_replay_after_lost_reply_returns_the_empty_file_it_made(self):
        api = self.adapter.FilesApi("http://files", "/unused")
        calls = []

        def send(path, method, body, headers, **_kwargs):
            calls.append((method, path.split("?", 1)[0]))
            if method == "POST" and len(calls) == 1:
                raise failure(errno.EIO, None, transient=True)
            if method == "POST":
                raise failure(errno.EEXIST, 409, {"error": "A file already occupies Stress/a.txt"})
            return 200, {}, json.dumps({"kind": "file", "id": "f1", "size": 0, "versionId": "v1"}).encode()

        api._send = send
        row = api._create_sync("c1", "Stress/a.txt")
        self.assertEqual(row["id"], "f1")
        self.assertEqual(row["current_version_id"], "v1")
        self.assertEqual(calls, [("POST", "/v1/fuse/files"), ("POST", "/v1/fuse/files"), ("GET", "/v1/fuse/entry")])

    # risk: overwriting someone else's file — without an ambiguous first attempt, an occupied path stays EEXIST.
    def test_create_on_an_occupied_path_without_a_retry_is_eexist(self):
        api = self.adapter.FilesApi("http://files", "/unused")
        calls = []

        def send(path, method, body, headers, **_kwargs):
            calls.append(method)
            raise failure(errno.EEXIST, 409, {"error": "A file already occupies Stress/a.txt"})

        api._send = send
        with self.assertRaises(OSError) as caught:
            api._create_sync("c1", "Stress/a.txt")
        self.assertEqual(caught.exception.errno, errno.EEXIST)
        self.assertEqual(calls, ["POST"])

    # risk: data loss — a replayed create must not adopt a path someone already filled with content.
    def test_create_replay_does_not_adopt_a_non_empty_file(self):
        api = self.adapter.FilesApi("http://files", "/unused")
        calls = []

        def send(path, method, body, headers, **_kwargs):
            calls.append(method)
            if method == "POST" and len(calls) == 1:
                raise failure(errno.EIO, 503)
            if method == "POST":
                raise failure(errno.EEXIST, 409, {"error": "A file already occupies Stress/a.txt"})
            return 200, {}, json.dumps({"kind": "file", "id": "f1", "size": 12, "versionId": "v1"}).encode()

        api._send = send
        with self.assertRaises(OSError) as caught:
            api._create_sync("c1", "Stress/a.txt")
        self.assertEqual(caught.exception.errno, errno.EEXIST)

    # risk: duplicate versions — the PUT carries the new content hash so Files can recognise a replay.
    def test_write_sends_the_new_content_hash(self):
        api = self.adapter.FilesApi("http://files", "/unused")
        seen = {}

        def request(path, method, body, headers):
            seen.update(headers)
            return 200, {}, b'{"versionId":"v2","sourceHash":"h"}'

        api._request = request
        with tempfile.TemporaryFile() as spool:
            spool.write(b"hello")
            spool.flush()
            api._write_sync("f1", spool, 5, "v1", "base")
        self.assertEqual(seen["X-Sulla-Content-Hash"], "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")


if __name__ == "__main__":
    unittest.main()
