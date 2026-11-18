# SPDX-License-Identifier: GPL-2.0-or-later
"""Behavioral checks for immutable-version read cache integrity and eviction."""
import hashlib
import os
import tempfile
import unittest
import asyncio
import errno
from unittest.mock import patch

from test_directory_paging import load_adapter


class ReadCacheTests(unittest.TestCase):
    def setUp(self):
        self.adapter, _ = load_adapter()
        self.temp = tempfile.TemporaryDirectory()
        self.cache = self.adapter.ContentReadCache(self.temp.name, 64)

    def tearDown(self):
        self.temp.cleanup()

    def put(self, version, body):
        source = tempfile.TemporaryFile(dir=self.temp.name)
        source.write(body); source.flush()
        digest = hashlib.sha256(body).hexdigest()
        self.cache.put(version, digest, source, len(body))
        source.close()
        return digest

    # risk: data integrity — only the exact immutable version/hash can hit the cache.
    def test_hit_miss_and_stale_version_rejection(self):
        content = b"verified payload"; digest = self.put("v1", content)
        result = tempfile.TemporaryFile(dir=self.temp.name)
        self.assertFalse(self.cache.get("v2", digest, len(content), result))
        self.assertTrue(self.cache.get("v1", digest, len(content), result))
        self.assertEqual(os.pread(result.fileno(), len(content), 0), content)
        result.close()

    # risk: mount availability — an unwritable cache spool must not prevent Files mount initialization or reads.
    def test_unavailable_spool_disables_cache_without_failing_operations(self):
        ops = self.adapter.SullaFiles(object())
        with patch.object(self.adapter, "SPOOL_DIR", "/unavailable/sulla-files-spool"), \
             patch.object(self.adapter.os, "makedirs", side_effect=PermissionError("read-only")):
            self.assertIsNone(ops._cache())
            self.assertIsNone(ops._cache())
        self.assertTrue(ops.read_cache_disabled)

    # risk: data integrity — corrupt cache files must never be served as file contents.
    def test_corrupt_entry_is_rejected_and_removed(self):
        content = b"good"; digest = self.put("v1", content)
        key = self.cache._key("v1", digest)
        with open(self.cache.entries[key], "wb") as cached:
            cached.write(b"evil")
        destination = tempfile.TemporaryFile(dir=self.temp.name)
        self.assertFalse(self.cache.get("v1", digest, len(content), destination))
        self.assertNotIn(key, self.cache.entries)
        destination.close()

    # risk: availability — configured cache bounds evict least-recently-used data first.
    def test_lru_evicts_oldest_entry_to_fit_budget(self):
        self.cache.max_bytes = 6
        first = self.put("v1", b"1234")
        second = self.put("v2", b"abcd")
        self.assertFalse(self.cache.get("v1", first, 4, tempfile.TemporaryFile(dir=self.temp.name)))
        self.assertTrue(self.cache.get("v2", second, 4, tempfile.TemporaryFile(dir=self.temp.name)))

    # risk: availability and data integrity — failed version revalidation must not trigger a second unbounded content fetch.
    def test_open_stops_after_transient_revalidation_exhaustion(self):
        class Api:
            def __init__(self):
                self.calls = []
            async def entry(self, *_args):
                self.calls.append("entry")
                error = OSError(errno.EIO, "offline")
                error.status = 503
                raise error
            async def read_to_file(self, *_args):
                self.calls.append("content")
                raise AssertionError("content request must not follow exhausted revalidation")
        api = Api()
        ops = self.adapter.SullaFiles(api)
        ops.nodes[2] = {"directory": False, "id": "file-id", "collectionId": "collection-id",
                        "filesPath": "outage/probe.txt", "versionId": "v1", "size": 4}
        with patch.object(self.adapter, "MAX_WAIT_SECONDS", 0.05):
            with self.assertRaises(self.adapter.pyfuse3.FUSEError) as caught:
                asyncio.run(ops.open(2, os.O_RDONLY, object()))
        self.assertEqual(caught.exception.errno, errno.EIO)
        self.assertEqual(api.calls, ["entry"])


if __name__ == "__main__":
    unittest.main()
