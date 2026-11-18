# SPDX-License-Identifier: GPL-2.0-or-later
"""Behavioral checks for immutable-version read cache integrity and eviction."""
import hashlib
import os
import tempfile
import unittest

from test_directory_paging import load_adapter


class ReadCacheTests(unittest.TestCase):
    def setUp(self):
        self.adapter, _ = load_adapter()
        self.temp = tempfile.TemporaryDirectory()
        self.cache = self.adapter.ContentReadCache(self.temp.name, 8)

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


if __name__ == "__main__":
    unittest.main()
