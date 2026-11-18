# SPDX-License-Identifier: GPL-2.0-or-later
"""An O_TRUNC open must not download the old content, so a file whose chunk can't be decrypted stays overwritable."""
import asyncio
import errno
import hashlib
import os
import tempfile
import types
import unittest

from test_directory_paging import load_adapter


class FileInfo:
    """Like pyfuse3.FileInfo: takes fh, and only the documented attributes exist."""
    __slots__ = ("fh", "direct_io", "keep_cache", "nonseekable")

    def __init__(self, fh=None):
        self.fh = fh
        self.direct_io = False
        self.keep_cache = False
        self.nonseekable = False


class Api:
    """Counts content downloads. With chunk_key_mismatch set, a download fails like Files' 422."""

    def __init__(self, content=b"", chunk_key_mismatch=False):
        self.content = content
        self.chunk_key_mismatch = chunk_key_mismatch
        self.reads = 0
        self.writes = []

    async def read_to_file(self, file_id, file):
        self.reads += 1
        if self.chunk_key_mismatch:
            error = OSError(errno.EIO, "chunk_key_mismatch")
            error.status = 422
            raise error
        file.write(self.content)
        return "v1", hashlib.sha256(self.content).hexdigest()

    async def write(self, file_id, file, size, version_id, source_hash):
        self.writes.append(os.pread(file.fileno(), size, 0))
        return {"versionId": f"v{len(self.writes) + 1}", "sourceHash": hashlib.sha256(self.writes[-1]).hexdigest(), "path": "p"}, False


async def noop_actor(self, ctx):
    return None


def make(adapter, content, chunk_key_mismatch=False):
    adapter.SPOOL_DIR = tempfile.mkdtemp()
    adapter.pyfuse3.FileInfo = FileInfo
    api = Api(content, chunk_key_mismatch)
    operations = adapter.SullaFiles(api)
    inode = operations._node("f.txt", False)
    operations.nodes[inode].update({"id": "file-1", "collectionId": "home", "directory": False,
                                    "versionId": "v0", "sourceHash": hashlib.sha256(content).hexdigest(),
                                    "size": len(content)})
    operations._actor = types.MethodType(noop_actor, operations)
    return api, operations, inode


class OTruncNoPrefetchTests(unittest.TestCase):
    # risk: data integrity. A file whose current chunk the key can't decrypt could never be overwritten
    # through the mount, because open() downloaded the old bytes first and failed with EIO.
    def test_truncating_open_of_undecryptable_file_succeeds_without_fetching_and_commits_new_bytes(self):
        adapter, pyfuse3 = load_adapter()
        api, ops, inode = make(adapter, b"old bytes", chunk_key_mismatch=True)

        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        self.assertEqual(api.reads, 0)

        asyncio.run(ops.write(info.fh, 0, b"new bytes"))
        asyncio.run(ops.flush(info.fh))  # truncateOnly is cleared by the write, so flush commits
        asyncio.run(ops.release(info.fh))

        self.assertEqual(api.reads, 0)
        self.assertEqual(api.writes, [b"new bytes"])
        self.assertNotIn(info.fh, ops.handles)

    # risk: data integrity. Truncating a file to empty must still be committed, not swallowed.
    def test_truncating_open_then_release_without_write_commits_the_empty_file(self):
        adapter, pyfuse3 = load_adapter()
        api, ops, inode = make(adapter, b"old bytes", chunk_key_mismatch=True)

        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        asyncio.run(ops.release(info.fh))

        self.assertEqual(api.reads, 0)
        self.assertEqual(api.writes, [b""])

    # risk: data integrity. A non-truncating write-open must not fabricate content for an undecryptable chunk.
    def test_write_open_without_truncate_still_fails_with_eio_and_leaks_no_handle(self):
        adapter, pyfuse3 = load_adapter()
        api, ops, inode = make(adapter, b"old bytes", chunk_key_mismatch=True)

        with self.assertRaises(pyfuse3.FUSEError) as caught:
            asyncio.run(ops.open(inode, os.O_WRONLY, None))

        self.assertEqual(caught.exception.errno, errno.EIO)
        self.assertEqual(api.reads, 1)
        self.assertEqual(api.writes, [])
        self.assertEqual(ops.handles, {})

    # risk: money/availability. A healthy truncating open must not spend a download it does not need.
    def test_truncating_open_of_healthy_file_makes_no_content_fetch(self):
        adapter, pyfuse3 = load_adapter()
        api, ops, inode = make(adapter, b"old bytes")

        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))

        self.assertEqual(api.reads, 0)
        self.assertTrue(ops.handles[info.fh]["truncateOnly"])
        self.assertEqual(ops.handles[info.fh]["size"], 0)

    # risk: data integrity. An empty file truncated by O_TRUNC is not a write, so it must not create a version.
    def test_truncating_open_of_empty_file_is_not_a_write(self):
        adapter, pyfuse3 = load_adapter()
        api, ops, inode = make(adapter, b"")

        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        asyncio.run(ops.release(info.fh))

        self.assertEqual(api.reads, 0)
        self.assertEqual(api.writes, [])


class VirtualMetadataOpenTests(unittest.TestCase):
    # risk: data integrity. Opening the virtual _folder-metadata.yaml node must not hit an unbound
    # `truncating`/`prior_size` in open(); a NameError there breaks every read of folder metadata.
    def _folder_metadata_node(self):
        adapter, pyfuse3 = load_adapter()
        api, ops, _ = make(adapter, b"")

        async def folder_metadata(collection_id, path):
            return {"revision": "rev-1", "folder": {"description": "Docs"}, "files": {}}

        api.folder_metadata = folder_metadata
        ops._collection_name = types.MethodType(lambda self, collection_id: "Home", ops)
        inode = ops._node("_folder-metadata.yaml", False)
        ops.nodes[inode].update({"id": None, "collectionId": "home", "filesPath": "docs",
                                 "directory": False, "virtualMetadata": True})
        return adapter, pyfuse3, api, ops, inode

    def test_opening_virtual_metadata_without_o_trunc_renders_folder_metadata(self):
        adapter, pyfuse3, api, ops, inode = self._folder_metadata_node()

        info = asyncio.run(ops.open(inode, os.O_RDONLY, None))

        handle = ops.handles[info.fh]
        self.assertEqual(api.reads, 0)
        self.assertIsNotNone(handle["metadata"])
        self.assertIn(b"description: Docs", os.pread(handle["file"].fileno(), handle["size"], 0))
        asyncio.run(ops.release(info.fh))
        self.assertNotIn(info.fh, ops.handles)

    # risk: data integrity. O_TRUNC on the virtual node must open without NameError and leave an empty spool.
    def test_opening_virtual_metadata_with_o_trunc_does_not_raise_and_empties_the_spool(self):
        adapter, pyfuse3, api, ops, inode = self._folder_metadata_node()

        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))

        handle = ops.handles[info.fh]
        self.assertEqual(api.reads, 0)
        self.assertEqual(handle["size"], 0)
        self.assertIsNotNone(handle["metadata"])
        # Not released: the commit path for a truncated metadata document needs Files' metadata writer,
        # which this stub does not model. The open itself is what this spec covers.


if __name__ == "__main__":
    unittest.main()
