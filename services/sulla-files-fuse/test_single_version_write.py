# SPDX-License-Identifier: GPL-2.0-or-later
"""A new file written once must cost one content upload, not an empty one plus the content."""
import asyncio
import hashlib
import os
import tempfile
import types
import unittest

from test_directory_paging import load_adapter


class Api:
    def __init__(self, content=b""):
        self.content = content
        self.writes = 0

    async def read_to_file(self, file_id, file):
        file.write(self.content)
        return "v1", hashlib.sha256(self.content).hexdigest()

    async def write(self, file_id, file, size, version_id, source_hash):
        self.writes += 1
        return {"versionId": f"v{self.writes + 1}", "sourceHash": "x", "path": "p"}, False


async def noop_actor(self, ctx):
    return None


def make(adapter, content):
    adapter.SPOOL_DIR = tempfile.mkdtemp()
    adapter.pyfuse3.FileInfo = lambda fh: types.SimpleNamespace(fh=fh)
    api = Api(content)
    operations = adapter.SullaFiles(api)
    inode = operations._node("f.txt", False)
    operations.nodes[inode].update({"id": "file-1", "collectionId": "home", "directory": False, "size": len(content)})
    operations._actor = types.MethodType(noop_actor, operations)
    return api, operations, inode


class SingleVersionWriteTests(unittest.TestCase):
    # risk: every `echo > newfile` uploaded an empty version first (3 versions per write).
    def test_truncating_an_empty_file_is_not_a_write(self):
        adapter, _ = load_adapter()
        api, ops, inode = make(adapter, b"")
        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        self.assertFalse(ops.handles[info.fh]["dirty"])
        asyncio.run(ops._commit(info.fh))
        self.assertEqual(api.writes, 0)

    def test_truncating_a_file_with_content_is_still_a_write(self):
        adapter, _ = load_adapter()
        api, ops, inode = make(adapter, b"old")
        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        self.assertTrue(ops.handles[info.fh]["dirty"])
        asyncio.run(ops._commit(info.fh))
        self.assertEqual(api.writes, 1)

    def test_rewriting_identical_content_makes_no_version(self):
        adapter, _ = load_adapter()
        api, ops, inode = make(adapter, b"same")
        info = asyncio.run(ops.open(inode, os.O_WRONLY, None))
        handle = ops.handles[info.fh]
        os.pwrite(handle["file"].fileno(), b"same", 0)
        handle["dirty"] = True
        asyncio.run(ops._commit(info.fh))
        self.assertEqual(api.writes, 0)
        self.assertFalse(handle["dirty"])

    def test_changed_content_is_uploaded_once(self):
        adapter, _ = load_adapter()
        api, ops, inode = make(adapter, b"")
        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        handle = ops.handles[info.fh]
        os.pwrite(handle["file"].fileno(), b"hi\n", 0)
        handle["size"] = 3
        handle["dirty"] = True
        asyncio.run(ops._commit(info.fh))
        asyncio.run(ops._commit(info.fh))  # flush then release: second commit must be a no-op
        self.assertEqual(api.writes, 1)


if __name__ == "__main__":
    unittest.main()
