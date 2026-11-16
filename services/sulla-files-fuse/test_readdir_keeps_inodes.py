# SPDX-License-Identifier: GPL-2.0-or-later
"""Re-listing a directory must not forget inodes a process may still hold (its cwd)."""
import asyncio
import types
import unittest

from test_directory_paging import load_adapter


class ListingApi:
    def __init__(self):
        self.entries = [{"path": "work", "kind": "directory", "size": 0}, {"path": "a.txt", "kind": "file", "size": 1}]

    async def directory_page(self, collection_id, path, cursor=None, etag=None):
        return {"rootCollectionId": "home", "entries": list(self.entries), "nextCursor": None}, '"r"'


class Reply:
    def __call__(self, token, name, attrs, offset):
        return True


class ReaddirKeepsInodesTests(unittest.TestCase):
    # risk: a refresh of the parent deleted the inode of a child directory in use -> ENOENT mid-work.
    def test_relisting_keeps_child_directory_inodes(self):
        adapter, pyfuse3 = load_adapter()
        pyfuse3.readdir_reply = Reply()
        api = ListingApi()
        ops = adapter.SullaFiles(api)
        root = pyfuse3.ROOT_INODE
        ops.nodes[root]["collectionId"] = "home"
        token = types.SimpleNamespace(names=[])
        asyncio.run(ops.readdir(root, 0, token))
        work = ops.path_inode["work"]
        asyncio.run(ops.readdir(root, 0, token))  # a health probe / agent re-lists the parent
        self.assertEqual(ops.path_inode["work"], work)
        self.assertIn(work, ops.nodes)

    def test_names_gone_from_a_complete_listing_are_pruned(self):
        adapter, pyfuse3 = load_adapter()
        pyfuse3.readdir_reply = Reply()
        api = ListingApi()
        ops = adapter.SullaFiles(api)
        root = pyfuse3.ROOT_INODE
        ops.nodes[root]["collectionId"] = "home"
        token = types.SimpleNamespace(names=[])
        asyncio.run(ops.readdir(root, 0, token))
        gone = ops.path_inode["a.txt"]
        api.entries = [e for e in api.entries if e["path"] != "a.txt"]
        asyncio.run(ops.readdir(root, 0, token))
        self.assertNotIn("a.txt", ops.path_inode)
        self.assertNotIn(gone, ops.nodes)
        self.assertIn("work", ops.path_inode)


if __name__ == "__main__":
    unittest.main()
