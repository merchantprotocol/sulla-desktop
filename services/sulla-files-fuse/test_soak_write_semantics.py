# SPDX-License-Identifier: GPL-2.0-or-later
"""Write semantics found broken by the 2026-11-17 iMac Files soak (no FUSE mount needed).

- `printf x > f` on a file with content committed an empty version first: bash opens with
  O_TRUNC, dup2()s and closes the first descriptor (a FUSE flush) before it writes.
- Five `cp src same.bin` at once: four failed with EEXIST although cp never asks for O_EXCL.
- A 65 MB cp failed with EFBIG but its first 64 MiB were committed as a version.
"""
import asyncio
import errno
import hashlib
import os
import tempfile
import types
import unittest

from test_directory_paging import load_adapter


class Api:
    def __init__(self, content=b"", create_error=None, entry_row=None):
        self.content = content
        self.uploads = []
        self.create_error = create_error
        self.entry_row = entry_row
        self.reads = []

    async def read_to_file(self, file_id, file):
        self.reads.append(file_id)
        file.write(self.content)
        return "v1", hashlib.sha256(self.content).hexdigest()

    async def write(self, file_id, file, size, version_id, source_hash):
        file.seek(0)
        self.uploads.append(file.read(size))
        return {"versionId": f"v{len(self.uploads) + 1}", "sourceHash": "x", "path": "p"}, False

    async def create(self, collection_id, path):
        if self.create_error is not None:
            raise self.create_error
        return {"id": "new-file", "current_version_id": "v0"}

    async def entry(self, collection_id, path):
        if self.entry_row is None:
            raise OSError(errno.ENOENT, "not found")
        return dict(self.entry_row)


async def no_actor(self, ctx):
    return None


def make(content=b"", **api_options):
    adapter, _ = load_adapter()
    adapter.SPOOL_DIR = tempfile.mkdtemp()
    adapter.pyfuse3.FileInfo = lambda fh: types.SimpleNamespace(fh=fh)
    api = Api(content, **api_options)
    operations = adapter.SullaFiles(api)
    operations.nodes[adapter.pyfuse3.ROOT_INODE].update({"collectionId": "home", "collectionRoot": True})
    operations._actor = types.MethodType(no_actor, operations)
    inode = operations._node("f.txt", False)
    operations.nodes[inode].update({"id": "file-1", "collectionId": "home", "directory": False})
    return adapter, api, operations, inode


class ShellRedirectTests(unittest.TestCase):
    # risk: data accuracy - every `>` overwrite stored an empty version, and other devices,
    # Cloud backup and readers between the two commits saw the file empty.
    def test_flush_before_the_first_write_uploads_nothing(self):
        _, api, ops, inode = make(b"old content")
        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        asyncio.run(ops.flush(info.fh))  # close() of the descriptor bash dup2()ed away
        self.assertEqual(api.uploads, [])
        asyncio.run(ops.write(info.fh, 0, b"new\n"))
        asyncio.run(ops.flush(info.fh))
        asyncio.run(ops.release(info.fh))
        self.assertEqual(api.uploads, [b"new\n"])

    # risk: data accuracy - deferring the flush must not lose an intentional `: > f` truncate.
    def test_truncate_with_no_write_still_commits_the_empty_file_on_release(self):
        _, api, ops, inode = make(b"old content")
        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        asyncio.run(ops.flush(info.fh))
        self.assertEqual(api.uploads, [])
        asyncio.run(ops.release(info.fh))
        self.assertEqual(api.uploads, [b""])

    # risk: data accuracy - fsync is an explicit durability request and must commit the truncate.
    def test_fsync_commits_a_pending_truncate(self):
        _, api, ops, inode = make(b"old content")
        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        asyncio.run(ops.fsync(info.fh, False))
        self.assertEqual(api.uploads, [b""])

    # risk: data accuracy - ordinary writes without O_TRUNC still commit on the first flush.
    def test_plain_write_commits_on_flush(self):
        _, api, ops, inode = make(b"abc")
        info = asyncio.run(ops.open(inode, os.O_WRONLY, None))
        asyncio.run(ops.write(info.fh, 3, b"def"))
        asyncio.run(ops.flush(info.fh))
        self.assertEqual(api.uploads, [b"abcdef"])


class OversizeWriteTests(unittest.TestCase):
    # risk: data accuracy - a refused 65 MB cp committed its first 64 MiB as a real version.
    def test_a_write_refused_for_size_never_commits_the_truncated_copy(self):
        adapter, api, ops, inode = make(b"")
        adapter.MAX_FILE_BYTES = 8
        info = asyncio.run(ops.open(inode, os.O_WRONLY | os.O_TRUNC, None))
        asyncio.run(ops.write(info.fh, 0, b"12345678"))
        with self.assertRaises(adapter.pyfuse3.FUSEError) as refused:
            asyncio.run(ops.write(info.fh, 8, b"9"))
        self.assertEqual(refused.exception.errno, errno.EFBIG)
        for close in (ops.flush, ops.release):
            with self.assertRaises(adapter.pyfuse3.FUSEError) as closed:
                asyncio.run(close(info.fh))
            self.assertEqual(closed.exception.errno, errno.EFBIG)
        self.assertEqual(api.uploads, [])

    # risk: data accuracy - a writer that truncates back under the limit keeps what it chose.
    def test_truncating_after_an_oversize_write_commits_the_kept_bytes(self):
        adapter, api, ops, inode = make(b"")
        adapter.MAX_FILE_BYTES = 8
        info = asyncio.run(ops.open(inode, os.O_WRONLY, None))
        asyncio.run(ops.write(info.fh, 0, b"12345678"))
        with self.assertRaises(adapter.pyfuse3.FUSEError):
            asyncio.run(ops.write(info.fh, 8, b"9"))
        fields = types.SimpleNamespace(update_size=True, update_mode=False, update_uid=False,
                                       update_gid=False, update_atime=False, update_mtime=False)
        asyncio.run(ops.setattr(inode, types.SimpleNamespace(st_size=4), fields, info.fh, None))
        asyncio.run(ops.release(info.fh))
        self.assertEqual(api.uploads, [b"1234"])


class ConcurrentCreateTests(unittest.TestCase):
    # risk: concurrent writers - open(O_CREAT) without O_EXCL failed EEXIST when another
    # process created the same name first.
    def test_losing_a_create_race_opens_the_existing_file(self):
        adapter, api, ops, _ = make(
            b"winner bytes",
            create_error=OSError(errno.EEXIST, "already exists"),
            entry_row={"id": "existing-file", "kind": "file", "size": 12})
        info, _attrs = asyncio.run(ops.create(adapter.pyfuse3.ROOT_INODE, b"same.bin", 0o644,
                                              os.O_WRONLY | os.O_CREAT | os.O_TRUNC, None))
        handle = ops.handles[info.fh]
        self.assertEqual(handle["fileId"], "existing-file")
        self.assertEqual(handle["size"], 0)  # O_TRUNC still applies to the file it opened
        asyncio.run(ops.write(info.fh, 0, b"loser bytes"))
        asyncio.run(ops.release(info.fh))
        self.assertEqual(api.uploads, [b"loser bytes"])

    # risk: O_EXCL callers (lock files, mkstemp) rely on EEXIST to detect the race.
    def test_exclusive_create_still_fails_with_eexist(self):
        adapter, _, ops, _ = make(
            create_error=OSError(errno.EEXIST, "already exists"),
            entry_row={"id": "existing-file", "kind": "file", "size": 0})
        with self.assertRaises(adapter.pyfuse3.FUSEError) as raised:
            asyncio.run(ops.create(adapter.pyfuse3.ROOT_INODE, b"lock", 0o644,
                                   os.O_WRONLY | os.O_CREAT | os.O_EXCL, None))
        self.assertEqual(raised.exception.errno, errno.EEXIST)

    # risk: a name taken by a folder must not be opened as a file.
    def test_create_race_against_a_folder_is_eisdir(self):
        adapter, _, ops, _ = make(
            create_error=OSError(errno.EEXIST, "already exists"),
            entry_row={"id": "folder-1", "kind": "directory"})
        with self.assertRaises(adapter.pyfuse3.FUSEError) as raised:
            asyncio.run(ops.create(adapter.pyfuse3.ROOT_INODE, b"dir", 0o644, os.O_WRONLY | os.O_CREAT, None))
        self.assertEqual(raised.exception.errno, errno.EISDIR)


if __name__ == "__main__":
    unittest.main()
