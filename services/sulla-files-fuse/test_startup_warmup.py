# SPDX-License-Identifier: GPL-2.0-or-later
"""Startup namespace requests wait until the first root snapshot is complete."""
import asyncio
import types
import unittest

from test_directory_paging import load_adapter


class WarmupApi:
    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def directory_page(self, collection_id, path, cursor=None, etag=None):
        self.started.set()
        await self.release.wait()
        return {"rootCollectionId": None, "entries": [
            {"path": "QA", "kind": "directory", "size": 0},
            {"path": "Projects", "kind": "directory", "size": 0},
        ], "nextCursor": None}, '"root"'

    async def entry(self, collection_id, path):
        return {"kind": "directory", "collection_id": "qa-collection", "path": "QA"}


class StartupWarmupTests(unittest.TestCase):
    # risk: namespace/data integrity — don't expose an existing collection as ENOENT during adapter startup.
    def test_lookup_waits_for_root_load_then_resolves_collection(self):
        adapter, pyfuse3 = load_adapter()
        api = WarmupApi()
        ops = adapter.SullaFiles(api)

        async def exercise():
            task = asyncio.create_task(ops.lookup(pyfuse3.ROOT_INODE, b"QA"))
            await api.started.wait()
            self.assertFalse(task.done())
            api.release.set()
            result = await task
            self.assertTrue(ops.initial_tree_loaded)
            self.assertEqual(ops.nodes[result.st_ino]["collectionId"], "qa-collection")
        asyncio.run(exercise())

    # risk: namespace completeness — root readdir must not return an empty/partial list during warm-up.
    def test_readdir_waits_and_returns_full_loaded_root(self):
        adapter, pyfuse3 = load_adapter()
        api = WarmupApi()
        ops = adapter.SullaFiles(api)
        token = types.SimpleNamespace(names=[])

        async def exercise():
            task = asyncio.create_task(ops.readdir(pyfuse3.ROOT_INODE, 0, token))
            await api.started.wait()
            self.assertFalse(task.done())
            api.release.set()
            await task
        asyncio.run(exercise())
        self.assertEqual(token.names, [b"QA", b"Projects"])

    # risk: stale/missing data — an incomplete directory cannot grant a cached positive or negative timeout.
    def test_unhealthy_or_incomplete_directory_has_zero_entry_timeout(self):
        adapter, _ = load_adapter()
        ops = adapter.SullaFiles(object())
        inode = ops._node("QA", True)
        ops.feed_healthy = True
        attrs = ops._attrs(inode)
        self.assertEqual(attrs.entry_timeout, 0.0)
        self.assertEqual(attrs.attr_timeout, 0.0)
        self.assertIn("negative_timeout=0", adapter.FUSE_MOUNT_OPTIONS)


if __name__ == "__main__":
    unittest.main()
