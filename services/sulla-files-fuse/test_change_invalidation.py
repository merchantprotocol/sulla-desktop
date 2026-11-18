# SPDX-License-Identifier: GPL-2.0-or-later
"""FUSE invalidation must evict both kernel names and adapter-side stale rows."""
import tempfile
import asyncio
import types
import unittest

from test_directory_paging import load_adapter


class ChangeInvalidationTests(unittest.TestCase):
    def setUp(self):
        self.adapter, self.pyfuse3 = load_adapter()
        self.temp = tempfile.TemporaryDirectory()
        self.adapter.SPOOL_DIR = self.temp.name
        self.events = []
        self.pyfuse3.invalidate_inode = lambda inode, **kwargs: self.events.append(("inode", inode, kwargs))
        self.pyfuse3.invalidate_entry = lambda parent, name: self.events.append(("entry", parent, name))
        self.ops = self.adapter.SullaFiles(object())

    def tearDown(self):
        for handle in self.ops.handles.values(): handle["file"].close()
        self.temp.cleanup()

    # risk: stale reads — a changed path invalidates its inode and parent entry, then marks adapter row stale.
    def test_changed_path_invalidates_correct_inode_and_parent_entry(self):
        parent = self.ops._node("folder", True)
        child = self.ops._node("folder/file.txt", False)
        self.ops.invalidate_path("folder/file.txt")
        self.assertIn(("inode", child, {"attr_only": False}), self.events)
        self.assertIn(("entry", parent, b"file.txt"), self.events)
        self.assertEqual(self.ops.path_inode["folder/file.txt"], child)
        self.assertTrue(self.ops.nodes[child]["stale"])

    # risk: stale namespace — ordinary feed events invalidate only their changed names, not every inode.
    def test_change_page_queues_exact_old_and_new_paths(self):
        self.ops.consume_change_page({"reset": False, "changes": [{"path": "new.txt", "oldPath": "old.txt", "kind": "rename"}]})
        self.assertEqual(set(self.ops.pending_invalidations), {"new.txt", "old.txt"})
        self.assertFalse(self.ops.pending_tree_reset)

    # risk: namespace completeness — a cursor reset invalidates the full known tree.
    def test_change_page_reset_requests_tree_invalidation(self):
        self.ops.consume_change_page({"reset": True, "changes": []})
        self.assertTrue(self.ops.pending_tree_reset)

    # risk: stale reads — a failed change feed disables kernel attribute caching immediately.
    def test_unhealthy_feed_sets_attribute_timeout_to_zero(self):
        inode = self.ops._node("file.txt", False)
        self.ops.feed_healthy = False
        attrs = self.ops._attrs(inode)
        self.assertEqual(attrs.attr_timeout, 0.0)
        self.assertEqual(attrs.entry_timeout, 0.0)

    # risk: stale namespace — a reset invalidates every known inode and removes cached rows.
    def test_reset_invalidates_whole_known_tree(self):
        child = self.ops._node("folder", True)
        self.ops.invalidate_tree()
        self.assertTrue(any(event[:2] == ("inode", child) for event in self.events))
        self.assertTrue(self.ops.nodes[child]["stale"])

    # risk: stale file contents — kernel pages from an older immutable version must be dropped.
    def test_readonly_page_cache_is_kept_only_for_the_version_it_tracks(self):
        self.pyfuse3.FileInfo = lambda fh: types.SimpleNamespace(fh=fh)
        self.ops.api = types.SimpleNamespace(actor_resolver=None)
        inode = self.ops._node("file.txt", False)
        self.ops.nodes[inode].update({"versionId": "v1", "size": 0, "pageCacheVersion": "v1"})
        self.ops.feed_healthy = True
        first = asyncio.run(self.ops._open_handle(inode, 0, None, b"", "v1", ""))
        self.assertTrue(first.keep_cache)
        self.ops.nodes[inode]["versionId"] = "v2"
        second = asyncio.run(self.ops._open_handle(inode, 0, None, b"", "v2", ""))
        self.assertFalse(second.keep_cache)

    # risk: stale file contents — a missed feed event must still revalidate immutable version metadata before cache lookup.
    def test_open_revalidates_version_before_using_read_cache(self):
        self.pyfuse3.FileInfo = lambda fh: types.SimpleNamespace(fh=fh)
        cached = types.SimpleNamespace(versions=[], get=lambda version, *_args: cached.versions.append(version) or False)
        class Api:
            actor_resolver = None
            async def entry(self, _collection, _path):
                return {"versionId": "v2", "size": 3}
            async def read_to_file(self, _file_id, target):
                target.write(b"new")
                return "v2", "hash-v2"
        self.ops.api = Api()
        self.ops.read_cache = cached
        inode = self.ops._node("file.txt", False)
        self.ops.nodes[inode].update({"id": "file-id", "collectionId": "collection", "filesPath": "file.txt",
                                      "versionId": "v1", "sourceHash": "hash-v1", "size": 3,
                                      "pageCacheVersion": "v1"})
        info = asyncio.run(self.ops.open(inode, 0, None))
        handle = self.ops.handles[info.fh]
        self.assertEqual(cached.versions, ["v2"])
        self.assertEqual(handle["versionId"], "v2")
        self.assertEqual(__import__("os").pread(handle["file"].fileno(), 3, 0), b"new")
        handle["file"].close()

    # risk: availability — optional revalidation/cache failures must not turn an ordinary full read into EIO.
    def test_open_falls_back_to_download_when_revalidation_and_cache_are_unavailable(self):
        self.pyfuse3.FileInfo = lambda fh: types.SimpleNamespace(fh=fh)
        class Api:
            actor_resolver = None
            async def entry(self, _collection, _path):
                raise OSError("metadata endpoint unavailable")
            async def read_to_file(self, _file_id, target):
                target.write(b"fresh")
                return "v2", "hash-v2"
        self.ops.api = Api()
        self.ops.read_cache = types.SimpleNamespace()  # older/partial cache implementations are optional.
        inode = self.ops._node("file.txt", False)
        self.ops.nodes[inode].update({"id": "file-id", "collectionId": "collection", "filesPath": "file.txt",
                                      "versionId": "v1", "sourceHash": "hash-v1", "size": 5})

        info = asyncio.run(self.ops.open(inode, 0, None))
        handle = self.ops.handles[info.fh]
        self.assertEqual(__import__("os").pread(handle["file"].fileno(), 5, 0), b"fresh")
        self.assertEqual(handle["versionId"], "v2")
        handle["file"].close()


if __name__ == "__main__":
    unittest.main()
