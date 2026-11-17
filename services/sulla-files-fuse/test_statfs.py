# SPDX-License-Identifier: GPL-2.0-or-later
"""statfs must answer from the spool volume, so df and stat -f work on the mount instead of ENOSYS."""
import asyncio
import os
import types
import unittest

from test_directory_paging import load_adapter


class StatvfsData(types.SimpleNamespace):
    pass


class StatfsTests(unittest.TestCase):
    # risk: a missing statfs made `stat -f` and df fail on the mount (ENOSYS); the answer must match the spool volume.
    def test_reports_the_spool_volume_with_a_usable_name_limit(self):
        adapter, _ = load_adapter()
        adapter.pyfuse3.StatvfsData = StatvfsData
        ops = adapter.SullaFiles(object())
        data = asyncio.run(ops.statfs(None))
        volume = os.statvfs(adapter.SPOOL_DIR if os.path.isdir(adapter.SPOOL_DIR) else "/")
        self.assertEqual(data.f_bsize, volume.f_bsize)
        self.assertEqual(data.f_blocks, volume.f_blocks)
        self.assertEqual(data.f_bavail, volume.f_bavail)
        self.assertEqual(data.f_namemax, 255)

    # risk: a missing spool dir must not fail df; statfs falls back to the root filesystem.
    def test_falls_back_to_root_when_the_spool_dir_is_missing(self):
        adapter, _ = load_adapter()
        adapter.pyfuse3.StatvfsData = StatvfsData
        adapter.SPOOL_DIR = "/nonexistent-sulla-files-fuse-spool"
        ops = adapter.SullaFiles(object())
        data = asyncio.run(ops.statfs(None))
        self.assertEqual(data.f_blocks, os.statvfs("/").f_blocks)


if __name__ == "__main__":
    unittest.main()
