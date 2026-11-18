# SPDX-License-Identifier: GPL-2.0-or-later
"""FUSE invalidation must evict both kernel names and adapter-side stale rows."""
import tempfile
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

    # risk: stale namespace — a reset invalidates every known inode and removes cached rows.
    def test_reset_invalidates_whole_known_tree(self):
        child = self.ops._node("folder", True)
        self.ops.invalidate_tree()
        self.assertTrue(any(event[:2] == ("inode", child) for event in self.events))
        self.assertTrue(self.ops.nodes[child]["stale"])


if __name__ == "__main__":
    unittest.main()
