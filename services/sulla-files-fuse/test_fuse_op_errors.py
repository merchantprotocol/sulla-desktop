# SPDX-License-Identifier: GPL-2.0-or-later
"""A failed Files request answers one FUSE op with an errno; it never stops the mount.

iMac regression (Desktop 22f0e63): Files answered the root listing with 404 "Files collection
not found"; readdir surfaced it as an I/O error, Desktop's `ls -A /mnt/sulla-files` probe failed,
and the adapter was recreated every few seconds, so the mount never stayed up.
"""
import asyncio
import errno
import logging
import types
import unittest

from test_directory_paging import load_adapter


def files_failure(status, message, code=None):
    """The OSError FilesApi._send raises for an HTTP failure (404 becomes FileNotFoundError)."""
    adapter, _ = load_adapter()
    error = OSError(adapter.HTTP_ERRNO.errno_for(status, {"error": message}), message)
    error.status = status
    error.detail = {"error": message, **({"code": code} if code else {})}
    return error


class ScriptedApi:
    """directory_page answers from a queue: an exception is raised, a page is returned."""
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    async def directory_page(self, collection_id, path, cursor=None, etag=None):
        self.calls.append((collection_id, path, cursor, etag))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome, '"r1"'

    async def read_to_file(self, file_id, file):
        file.write(b"synthetic")
        return "v1", "synthetic-hash"


def page(*names):
    return {"rootCollectionId": "home", "entries": [{"path": name, "kind": "file", "size": 1} for name in names], "nextCursor": None}


class Replies:
    def __init__(self):
        self.names = []

    def __call__(self, token, name, attrs, offset):
        self.names.append(name)
        return True


class FuseOpErrorTests(unittest.TestCase):
    def setUp(self):
        self.adapter, self.pyfuse3 = load_adapter()
        self.replies = Replies()
        self.pyfuse3.readdir_reply = self.replies
        self.events = []
        self.adapter.emit = lambda event, level=logging.INFO, **fields: self.events.append((event, level, fields))

    def readdir(self, ops, inode):
        return asyncio.run(ops.readdir(inode, 0, types.SimpleNamespace()))

    # risk: availability — the root listing failing made Desktop recreate the adapter in a loop.
    def test_root_listing_404_answers_an_empty_root_logs_it_and_lists_again_later(self):
        api = ScriptedApi(files_failure(404, "Files collection not found"), page("a.txt", "b.txt"))
        ops = self.adapter.SullaFiles(api)
        root = self.pyfuse3.ROOT_INODE

        self.readdir(ops, root)  # must not raise

        self.assertEqual(self.replies.names, [])
        failed = [fields for event, level, fields in self.events if event == "root-listing-failed"]
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]["status"], 404)
        self.assertEqual(failed[0]["errno"], "ENOENT")
        self.assertEqual([level for event, level, _ in self.events if event == "root-listing-failed"], [logging.ERROR])
        self.assertNotIn("", ops.directory_complete)

        self.readdir(ops, root)  # Files recovered: the very next listing shows the files

        self.assertEqual(self.replies.names, [b"a.txt", b"b.txt"])
        self.assertEqual(len(api.calls), 2)

    # risk: availability — 401/403 and 5xx on the root are no reason to drop the mount either.
    def test_root_listing_denied_or_server_fault_still_answers(self):
        for failure in (files_failure(403, "access denied"), files_failure(503, "Files busy", "FILES_DB_RETRYABLE")):
            with self.subTest(status=failure.status):
                self.events.clear()
                ops = self.adapter.SullaFiles(ScriptedApi(failure))
                self.readdir(ops, self.pyfuse3.ROOT_INODE)
                self.assertTrue(any(event == "root-listing-failed" for event, _, _ in self.events))

    # risk: agent confusion — a missing/denied/broken subdirectory must say which, as an errno.
    def test_subdirectory_listing_failure_maps_to_its_errno(self):
        cases = ((404, errno.ENOENT), (401, errno.EACCES), (403, errno.EACCES), (500, errno.EIO), (504, errno.EIO))
        for status, expected in cases:
            with self.subTest(status=status):
                ops = self.adapter.SullaFiles(ScriptedApi(files_failure(status, "synthetic")))
                inode = ops._node("docs", True)
                ops.nodes[inode]["collectionId"] = "home"
                with self.assertRaises(self.pyfuse3.FUSEError) as caught:
                    self.readdir(ops, inode)
                self.assertEqual(caught.exception.errno, expected)

    # risk: availability — an unexpected bug in one op is answered with EIO, never propagated to pyfuse3.main().
    def test_unexpected_exception_in_an_op_is_answered_with_eio(self):
        ops = self.adapter.SullaFiles(ScriptedApi(ValueError("bad page")))
        inode = ops._node("docs", True)
        ops.nodes[inode]["collectionId"] = "home"
        with self.assertRaises(self.pyfuse3.FUSEError) as caught:
            self.readdir(ops, inode)
        self.assertEqual(caught.exception.errno, errno.EIO)

    # risk: availability — read/write on a closed handle raised KeyError straight into the FUSE loop.
    def test_read_and_write_on_an_unknown_handle_answer_ebadf(self):
        ops = self.adapter.SullaFiles(ScriptedApi())
        for call in (lambda: ops.read(99, 0, 10), lambda: ops.write(99, 0, b"x")):
            with self.assertRaises(self.pyfuse3.FUSEError) as caught:
                asyncio.run(call())
            self.assertEqual(caught.exception.errno, errno.EBADF)

    def test_failure_errno_falls_back_to_eio(self):
        table = self.adapter.HTTP_ERRNO
        self.assertEqual(table.errno_for_failure(files_failure(404, "gone")), errno.ENOENT)
        self.assertEqual(table.errno_for_failure(OSError("no errno")), errno.EIO)
        bare = OSError("status only")
        bare.status = 403
        self.assertEqual(table.errno_for_failure(bare), errno.EACCES)


if __name__ == "__main__":
    unittest.main()
