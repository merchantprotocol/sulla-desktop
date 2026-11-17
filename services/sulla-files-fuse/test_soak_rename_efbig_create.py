# SPDX-License-Identifier: GPL-2.0-or-later
"""Regressions found by the iMac Files soak (2026-11-17).

1. rename() left the old path in the inode cache: after `mv c.txt d.txt`, `[ -e c.txt ]` was true
   and `rm c.txt` deleted d.txt.
2. A write past the 64 MiB mount limit got EFBIG, but release() still committed the first 64 MiB,
   so a failed 65 MB `cp` left a truncated file in Files.
3. Two writers creating the same new path: the loser's create got EEXIST from Files and open(2)
   failed with "File exists", although neither caller asked for O_EXCL.
"""
import asyncio
import errno
import hashlib
import os
import tempfile
import types
import unittest

from test_directory_paging import load_adapter


def files_error(code, message):
    error = OSError(code, message)
    error.status = 409 if code == errno.EEXIST else 404
    return error


class Api:
    """Files as the adapter sees it: rows keyed by collection path."""

    def __init__(self):
        self.rows = {}
        self.contents = {}
        self.deleted = []
        self.writes = []
        self.create_conflicts = set()

    def add(self, path, file_id, content=b"", kind="file"):
        self.rows[path] = {"id": file_id, "kind": kind, "size": len(content), "collection_id": "home"}
        self.contents[file_id] = content

    async def entry(self, collection_id, path):
        if path not in self.rows:
            raise files_error(errno.ENOENT, "not found")
        return dict(self.rows[path])

    async def rename(self, file_id, collection_id, path):
        old = next(key for key, row in self.rows.items() if row["id"] == file_id)
        self.rows[path] = self.rows.pop(old)

    async def rename_folder(self, collection_id, path, target_collection_id, target_path):
        for key in [key for key in self.rows if key == path or key.startswith(path + "/")]:
            self.rows[target_path + key[len(path):]] = self.rows.pop(key)

    async def delete(self, file_id):
        self.deleted.append(file_id)
        self.rows = {key: row for key, row in self.rows.items() if row["id"] != file_id}

    async def create(self, collection_id, path):
        if path in self.create_conflicts or path in self.rows:
            raise files_error(errno.EEXIST, "a file already exists at that path")
        self.add(path, f"id-{path}")
        return {**self.rows[path], "current_version_id": "v0"}

    async def read_to_file(self, file_id, file):
        content = self.contents.get(file_id, b"")
        file.write(content)
        return "v1", hashlib.sha256(content).hexdigest()

    async def write(self, file_id, file, size, version_id, source_hash):
        self.writes.append((file_id, size))
        return {"versionId": f"v{len(self.writes) + 1}", "sourceHash": "x", "path": "p"}, False


async def no_actor(self, ctx):
    return None


class SoakRegressionTests(unittest.TestCase):
    def setUp(self):
        self.adapter, self.pyfuse3 = load_adapter()
        self.adapter.SPOOL_DIR = tempfile.mkdtemp()
        self.pyfuse3.FileInfo = lambda fh: types.SimpleNamespace(fh=fh)
        self.api = Api()
        self.ops = self.adapter.SullaFiles(self.api)
        self.ops._actor = types.MethodType(no_actor, self.ops)
        self.root = self.pyfuse3.ROOT_INODE
        self.ops.nodes[self.root]["collectionId"] = "home"
        self.ctx = types.SimpleNamespace(pid=1)

    def run_op(self, coroutine):
        return asyncio.run(coroutine)

    def lookup(self, parent, name):
        return self.run_op(self.ops.lookup(parent, name.encode(), self.ctx)).st_ino

    def assert_fuse_errno(self, code, coroutine):
        with self.assertRaises(self.pyfuse3.FUSEError) as caught:
            self.run_op(coroutine)
        self.assertEqual(caught.exception.errno, code)

    # risk: data loss — `mv c d; rm c` deleted d.
    def test_old_path_is_gone_after_rename_and_unlinking_it_deletes_nothing(self):
        self.api.add("c.txt", "file-c", b"KEEPME")
        moved = self.lookup(self.root, "c.txt")

        self.run_op(self.ops.rename(self.root, b"c.txt", self.root, b"d.txt", 0, self.ctx))

        self.assert_fuse_errno(errno.ENOENT, self.ops.lookup(self.root, b"c.txt", self.ctx))
        self.assert_fuse_errno(errno.ENOENT, self.ops.unlink(self.root, b"c.txt", self.ctx))
        self.assertEqual(self.api.deleted, [])
        self.assertEqual(self.lookup(self.root, "d.txt"), moved)
        self.assertEqual(self.ops.nodes[moved]["filesPath"], "d.txt")

    # risk: data loss — files under a renamed folder kept resolving at their old paths.
    def test_renaming_a_folder_moves_its_cached_children(self):
        self.api.add("old", "dir-1", kind="directory")
        self.api.add("old/f.txt", "file-f", b"x")
        folder = self.lookup(self.root, "old")
        child = self.lookup(folder, "f.txt")

        self.run_op(self.ops.rename(self.root, b"old", self.root, b"new", 0, self.ctx))

        self.assert_fuse_errno(errno.ENOENT, self.ops.lookup(self.root, b"old", self.ctx))
        self.assertNotIn("old/f.txt", self.ops.path_inode)
        self.assertEqual(self.ops.path_inode["new/f.txt"], child)
        self.assertEqual(self.ops.nodes[child]["filesPath"], "new/f.txt")
        self.assertEqual(self.ops.nodes[folder]["path"], "new")

    # risk: data loss — rename-over-existing (editor save) left the source path pointing at a deleted id.
    def test_save_over_an_existing_file_forgets_the_source_path(self):
        self.api.add("tmp.swp", "file-tmp", b"new")
        self.api.add("doc.txt", "file-doc", b"old")
        self.lookup(self.root, "tmp.swp")
        target = self.lookup(self.root, "doc.txt")
        replaced = []

        async def replace(target_id, source_id):
            replaced.append((target_id, source_id))
            self.api.rows.pop("tmp.swp")
            return {}
        self.api.replace = replace

        self.run_op(self.ops.rename(self.root, b"tmp.swp", self.root, b"doc.txt", 0, self.ctx))

        self.assertEqual(replaced, [("file-doc", "file-tmp")])
        self.assert_fuse_errno(errno.ENOENT, self.ops.lookup(self.root, b"tmp.swp", self.ctx))
        self.assertEqual(self.lookup(self.root, "doc.txt"), target)

    # risk: data corruption — a failed oversize write left a truncated 64 MiB file in Files.
    def test_write_past_the_limit_fails_the_file_and_commits_nothing(self):
        self.adapter.MAX_FILE_BYTES = 1024
        self.api.add("big.bin", "file-big", b"")
        inode = self.lookup(self.root, "big.bin")
        fh = self.run_op(self.ops.open(inode, os.O_WRONLY | os.O_TRUNC, self.ctx)).fh

        self.run_op(self.ops.write(fh, 0, b"a" * 1000))
        self.assert_fuse_errno(errno.EFBIG, self.ops.write(fh, 1000, b"a" * 100))
        self.run_op(self.ops.write(fh, 1000, b"a" * 10))  # a later in-limit write must not revive it

        self.assert_fuse_errno(errno.EFBIG, self.ops.flush(fh))
        self.assert_fuse_errno(errno.EFBIG, self.ops.release(fh))
        self.assertEqual(self.api.writes, [])
        self.assertNotIn(fh, self.ops.handles)

    # risk: the guard must not block a writer that truncates back under the limit on purpose.
    def test_truncating_back_under_the_limit_makes_the_handle_writable_again(self):
        self.adapter.MAX_FILE_BYTES = 1024
        self.api.add("big.bin", "file-big", b"")
        inode = self.lookup(self.root, "big.bin")
        fh = self.run_op(self.ops.open(inode, os.O_WRONLY | os.O_TRUNC, self.ctx)).fh
        self.assert_fuse_errno(errno.EFBIG, self.ops.write(fh, 0, b"a" * 2000))

        attr = types.SimpleNamespace(st_size=0)
        fields = types.SimpleNamespace(update_size=True, update_mode=False, update_uid=False, update_gid=False,
                                       update_atime=False, update_mtime=False)
        self.run_op(self.ops.setattr(inode, attr, fields, fh, self.ctx))
        self.run_op(self.ops.write(fh, 0, b"small"))
        self.run_op(self.ops.release(fh))

        self.assertEqual(self.api.writes, [("file-big", 5)])

    # risk: lost writes — concurrent `cp` to one new path failed with "File exists".
    def test_create_that_loses_a_race_opens_the_file_the_winner_made(self):
        self.api.add("same.bin", "file-winner", b"winner")
        self.api.create_conflicts.add("same.bin")

        info, attrs = self.run_op(self.ops.create(self.root, b"same.bin", 0o644, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, self.ctx))

        handle = self.ops.handles[info.fh]
        self.assertEqual(handle["fileId"], "file-winner")
        self.assertEqual(attrs.st_ino, handle["inode"])
        self.run_op(self.ops.write(info.fh, 0, b"mine"))
        self.run_op(self.ops.release(info.fh))
        self.assertEqual(self.api.writes, [("file-winner", 4)])

    # risk: O_EXCL semantics (lock files) — exclusive create must still refuse an existing file.
    def test_exclusive_create_still_answers_eexist(self):
        self.api.add("lock", "file-lock", b"")
        self.api.create_conflicts.add("lock")

        self.assert_fuse_errno(errno.EEXIST, self.ops.create(self.root, b"lock", 0o644, os.O_WRONLY | os.O_CREAT | os.O_EXCL, self.ctx))
        self.assertEqual(self.api.writes, [])


if __name__ == "__main__":
    unittest.main()
