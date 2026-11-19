# SPDX-License-Identifier: GPL-2.0-or-later
"""FUSE invalidation must evict both kernel names and adapter-side stale rows."""
import tempfile
import asyncio
import threading
import time
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
        asyncio.run(self.ops.invalidate_path("folder/file.txt"))
        self.assertIn(("inode", child, {"attr_only": False}), self.events)
        self.assertIn(("entry", parent, b"file.txt"), self.events)
        self.assertEqual(self.ops.path_inode["folder/file.txt"], child)
        self.assertTrue(self.ops.nodes[child]["stale"])

    # risk: stale namespace — ordinary feed events invalidate only their changed names, not every inode.
    def test_change_page_queues_exact_old_and_new_paths(self):
        self.ops.consume_change_page({"reset": False, "changes": [{"path": "new.txt", "oldPath": "old.txt", "kind": "rename"}]})
        self.assertEqual(set(self.ops.pending_invalidations), {"new.txt", "old.txt"})
        self.assertFalse(self.ops.pending_tree_reset)

    # risk: stale attrs — self-echo must not invalidate a matching local version or directory listing.
    def test_matching_self_echo_is_skipped(self):
        inode = self.ops._node("folder/file.txt", False)
        self.ops.nodes[inode].update({"versionId": "v1", "size": 7})
        self.ops.directory_complete.add("folder")
        self.ops.consume_change_page({"reset": False, "changes": [{"path": "folder/file.txt", "kind": "update", "versionId": "v1", "size": 7}]})
        self.assertEqual(self.ops.pending_invalidations, {})
        self.assertIn("folder", self.ops.directory_complete)

    # risk: stale attrs — update invalidates changed inode but keeps directory membership cache.
    def test_update_does_not_discard_directory_complete(self):
        self.ops._node("folder/file.txt", False)
        self.ops.directory_complete.add("folder")
        self.ops.consume_change_page({"reset": False, "changes": [{"path": "folder/file.txt", "kind": "update", "versionId": "v2", "size": 8}]})
        self.assertFalse(self.ops.pending_invalidations["folder/file.txt"]["membership_changed"])
        self.assertIn("folder", self.ops.directory_complete)

    # risk: a kernel GETATTR can arrive during reverse invalidation without a LOOKUP or OPEN first.
    def test_getattr_refreshes_the_inode_when_a_remote_edit_invalidates_it(self):
        path = "folder/file.txt"
        inode = self.ops._node(path, False)
        self.ops.nodes[inode].update({"collectionId": "home", "filesPath": path, "versionId": "v1", "size": 7})
        reads = []
        async def entry(collection, name):
            reads.append((collection, name))
            return {"kind": "file", "versionId": "v2", "size": 13}
        self.ops.api = types.SimpleNamespace(entry=entry)
        observed = []
        async def during_notification(_notify, target, **_options):
            observed.append((await self.ops.getattr(target)).st_size)
            return True
        self.ops._run_invalidation = during_notification
        self.ops.consume_change_page({"changes": [{"path": path, "kind": "update", "versionId": "v2", "size": 13}]})
        asyncio.run(self.ops.invalidate_path(path, **self.ops.pending_invalidations.pop(path)))
        self.assertEqual(observed, [13])
        self.assertEqual(self.ops.path_inode[path], inode)
        self.assertEqual(asyncio.run(self.ops.getattr(inode)).st_size, 13)
        self.assertEqual(reads, [("home", path)])

    # risk: namespace correctness — only membership-changing events evict directory listings.
    def test_membership_events_discard_directory_complete(self):
        for kind in ("insert", "delete", "rename"):
            self.ops.directory_complete.add("folder")
            self.ops.consume_change_page({"reset": False, "changes": [{"path": "folder/file.txt", "kind": kind, "versionId": "v", "size": 1}]})
            self.assertNotIn("folder", self.ops.directory_complete)
            self.ops.pending_invalidations.clear()
            self.ops.directory_complete.add("folder")

    # risk: stale namespace — a later content event cannot downgrade an earlier membership invalidation.
    def test_membership_invalidation_is_monotonic(self):
        self.ops.queue_invalidation("folder/file.txt", membership_changed=True)
        self.ops.queue_invalidation("folder/file.txt", membership_changed=False)
        self.assertTrue(self.ops.pending_invalidations["folder/file.txt"]["membership_changed"])

    # risk: stale attrs — a remote event cannot inherit the local-commit fresh-node exemption.
    def test_remote_invalidation_drops_fresh_node_exemption(self):
        self.ops.queue_invalidation("folder/file.txt", membership_changed=False, node_fresh=True)
        self.ops.queue_invalidation("folder/file.txt", membership_changed=False)
        self.assertFalse(self.ops.pending_invalidations["folder/file.txt"]["node_fresh"])

    # risk: stale content — matching deletion/rename must not be mistaken for a self echo.
    def test_matching_delete_and_rename_are_not_skipped(self):
        inode = self.ops._node("folder/file.txt", False)
        self.ops.nodes[inode].update({"versionId": "v1", "size": 7})
        for kind in ("delete", "rename"):
            self.ops.consume_change_page({"reset": False, "changes": [{"path": "folder/file.txt", "kind": kind, "versionId": "v1", "size": 7}]})
            self.assertIn("folder/file.txt", self.ops.pending_invalidations)
            self.ops.pending_invalidations.clear()

    # risk: cache coherence — local commit drops file pages but preserves fresh inode metadata and directory completeness.
    def test_content_only_node_fresh_invalidation_preserves_directory_cache(self):
        inode = self.ops._node("folder/file.txt", False)
        self.ops.directory_complete.add("folder")
        self.ops.queue_invalidation("folder/file.txt", membership_changed=False, node_fresh=True)
        asyncio.run(self.ops.invalidate_path("folder/file.txt", membership_changed=False, node_fresh=True))
        self.assertIn("folder", self.ops.directory_complete)
        self.assertFalse(self.ops.nodes[inode].get("stale", False))
        self.assertEqual(self.events, [("inode", inode, {"attr_only": False})])

    # risk: stale page cache — a local commit must invalidate inode data without invalidating its dentry or fresh node.
    def test_local_commit_queues_only_content_invalidation(self):
        inode = self.ops._node("folder/file.txt", False)
        node = self.ops.nodes[inode]
        node.update({"id": "file-1", "versionId": "v1", "size": 0})
        self.ops.directory_complete.add("folder")
        spool = tempfile.TemporaryFile()
        self.addCleanup(spool.close)
        spool.write(b"fresh")
        self.ops.handles[1] = {"inode": inode, "fileId": "file-1", "file": spool, "size": 5, "versionId": "v1",
                               "sourceHash": "old", "dirty": True, "failedErrno": None, "actor": None}
        self.ops._content_unchanged = lambda _handle: False
        async def write(*_args): return {"versionId": "v2", "sourceHash": "new", "path": "file.txt"}, False
        async def as_actor(_self, _actor, awaitable): return await awaitable
        self.ops.api = types.SimpleNamespace(write=write)
        self.ops._as_actor = types.MethodType(as_actor, self.ops)
        asyncio.run(self.ops._commit(1))
        queued = self.ops.pending_invalidations.pop("folder/file.txt")
        self.assertFalse(queued["membership_changed"])
        self.assertTrue(queued["node_fresh"])
        asyncio.run(self.ops.invalidate_path("folder/file.txt", **queued))
        self.assertIn("folder", self.ops.directory_complete)
        self.assertFalse(node.get("stale", False))
        self.assertEqual(self.events, [("inode", inode, {"attr_only": False})])


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

    # risk: stale namespace — reset avoids kernel-call storms and forces fresh listings before caching.
    def test_reset_marks_tree_stale_without_kernel_invalidations(self):
        child = self.ops._node("folder", True)
        self.ops.nodes[child]["stale"] = False
        self.ops.directory_complete.add("folder")
        asyncio.run(self.ops.invalidate_tree())
        self.assertEqual(self.events, [])
        self.assertFalse(self.ops.directory_complete)
        self.assertTrue(self.ops.nodes[child]["stale"])
        self.assertEqual(self.ops._attrs(child).attr_timeout, 0.0)

    # risk: stale namespace — queue overflow collapses arbitrary events into one bounded full reset.
    def test_queue_overflow_collapses_to_tree_reset(self):
        self.adapter.MAX_PENDING_INVALIDATIONS = 2
        for path in ("a", "b", "c", "d"):
            self.ops.queue_invalidation(path)
        self.assertEqual(len(self.ops.pending_invalidations), 0)
        self.assertTrue(self.ops.pending_tree_reset)

    # risk: stale namespace availability — a stuck call retires its limiter so the next event runs.
    def test_stuck_invalidation_rotates_limiter_and_later_event_runs(self):
        self.adapter.INVALIDATION_TIMEOUT_SECONDS = 0.01
        stuck_limiter = types.SimpleNamespace(borrowed_tokens=1)
        self.ops.invalidation_limiter = stuck_limiter
        self.pyfuse3.invalidate_inode = lambda *_args, **_kwargs: time.sleep(0.1)
        self.ops._node("stuck.txt", False)
        asyncio.run(self.ops.invalidate_path("stuck.txt"))
        fresh_limiter = self.ops.invalidation_limiter
        self.assertIsNot(fresh_limiter, stuck_limiter)
        self.assertEqual(self.ops.abandoned_invalidation_threads, 1)
        self.pyfuse3.invalidate_inode = lambda inode, **kwargs: self.events.append(("inode", inode, kwargs))
        self.ops._node("later.txt", False)
        asyncio.run(self.ops.invalidate_path("later.txt"))
        self.assertIn(("inode", self.ops.path_inode["later.txt"], {"attr_only": False}), self.events)

    # risk: stale namespace — repeated abandoned workers permanently disable positive cache timeouts.
    def test_abandoned_thread_cap_disables_caching(self):
        for _ in range(self.adapter.MAX_ABANDONED_INVALIDATION_THREADS):
            # Each timeout models a newly rotated worker that also becomes stuck.
            self.ops.invalidation_limiter = types.SimpleNamespace(borrowed_tokens=1)
            self.ops.invalidation_stuck_logged = False
            self.ops._record_invalidation_timeout()
        self.assertTrue(self.ops.invalidation_caching_disabled)
        self.ops._finish_invalidation_pass(self.ops.invalidation_timeouts)
        self.assertFalse(self.ops.invalidation_healthy)

    # risk: FUSE deadlock — reverse invalidation runs on its dedicated cancellable worker, not Trio's request loop.
    def test_blocked_kernel_invalidation_does_not_block_concurrent_request(self):
        entered, release = threading.Event(), threading.Event()
        self.pyfuse3.invalidate_inode = lambda *_args, **_kwargs: (entered.set(), release.wait(2))
        inode = self.ops._node("file.txt", False)
        async def exercise():
            invalidation = asyncio.create_task(self.ops.invalidate_path("file.txt"))
            await asyncio.wait_for(asyncio.to_thread(entered.wait), 1)
            request_served = asyncio.Event()
            request = asyncio.create_task(self._fake_request(request_served))
            await asyncio.wait_for(request_served.wait(), 0.2)
            self.assertTrue(request.done())
            release.set()
            await invalidation
        try:
            asyncio.run(exercise())
        finally:
            release.set()
        limiter, abandon_on_cancel = self.adapter.trio.run_sync_calls[-1]
        self.assertIs(limiter, self.ops.invalidation_limiter)
        self.assertTrue(abandon_on_cancel)
        self.assertIn(inode, self.ops.nodes)

    # risk: stale reads — a failed inode notification must disable positive caching even if the dentry notification works.
    def test_failed_notification_disables_caching(self):
        def fail(*_args, **_options):
            raise RuntimeError("notification failed")
        self.pyfuse3.invalidate_inode = fail
        parent = self.ops._node("folder", True)
        inode = self.ops._node("folder/file.txt", False)
        self.ops.nodes[inode]["collectionId"] = "home"
        self.ops.feed_healthy = True
        self.ops.feed_ready_collections.add("home")
        asyncio.run(self.ops.invalidate_path("folder/file.txt"))
        self.assertIn(("entry", parent, b"file.txt"), self.events)
        self.assertFalse(self.ops.invalidation_healthy)

    async def _fake_request(self, served):
        served.set()

    # risk: stale namespace after kernel stalls — a bounded invalidation timeout disables caching.
    def test_invalidation_timeout_marks_feed_unhealthy(self):
        self.adapter.INVALIDATION_TIMEOUT_SECONDS = 0.01
        self.pyfuse3.invalidate_inode = lambda *_args, **_kwargs: time.sleep(0.1)
        inode = self.ops._node("file.txt", False)
        self.ops.feed_healthy = True
        asyncio.run(self.ops.invalidate_path("file.txt"))
        self.assertFalse(self.ops.invalidation_healthy)
        attrs = self.ops._attrs(inode)
        self.assertEqual(attrs.attr_timeout, 0.0)
        self.assertEqual(attrs.entry_timeout, 0.0)

    # risk: stale namespace after kernel stalls — one later successful call must not re-enable caching mid-pass.
    def test_success_after_timeout_in_same_pass_does_not_restore_health(self):
        self.adapter.INVALIDATION_TIMEOUT_SECONDS = 0.01
        self.pyfuse3.invalidate_inode = lambda *_args, **_kwargs: time.sleep(0.1)
        self.ops._node("folder", True)
        self.ops._node("folder/file.txt", False)
        asyncio.run(self.ops.invalidate_path("folder/file.txt"))
        self.assertFalse(self.ops.invalidation_healthy)
        self.assertEqual(self.ops.invalidation_timeouts, 1)
        self.assertIn(("entry", self.ops.path_inode["folder"], b"file.txt"), self.events)

    # risk: stale namespace — a whole pass with no timeouts after a stall restores caching.
    def test_clean_full_pass_after_stall_restores_health(self):
        self.adapter.INVALIDATION_TIMEOUT_SECONDS = 0.01
        calls = []
        def invalidate_inode(*_args, **_kwargs):
            calls.append(1)
            if len(calls) == 1: time.sleep(0.1)  # only the first kernel call stalls
        self.pyfuse3.invalidate_inode = invalidate_inode
        self.ops._node("file.txt", False)
        asyncio.run(self.ops.invalidate_path("file.txt"))
        self.assertFalse(self.ops.invalidation_healthy)
        asyncio.run(self.ops.invalidate_path("file.txt"))
        self.assertTrue(self.ops.invalidation_healthy)

    # risk: stale namespace — a quiet period alone restores caching, but never while the kernel call is still stuck.
    def test_quiet_period_restores_health_only_when_no_thread_is_stuck(self):
        self.ops.invalidation_healthy = False
        self.ops.invalidation_timed_out_at = time.monotonic() - self.adapter.INVALIDATION_QUIET_SECONDS - 1
        self.ops.invalidation_limiter = types.SimpleNamespace(borrowed_tokens=1)
        self.ops.recover_invalidation_health()
        self.assertFalse(self.ops.invalidation_healthy)
        self.ops.invalidation_limiter = types.SimpleNamespace(borrowed_tokens=0)
        self.ops.recover_invalidation_health()
        self.assertTrue(self.ops.invalidation_healthy)

    # risk: operability — a stuck kernel call is reported once, not on every queued invalidation.
    def test_stuck_invalidation_thread_is_logged_once(self):
        self.adapter.INVALIDATION_TIMEOUT_SECONDS = 0.01
        self.pyfuse3.invalidate_inode = lambda *_args, **_kwargs: time.sleep(0.1)
        self.ops.invalidation_limiter = types.SimpleNamespace(borrowed_tokens=1)
        emitted = []
        self.adapter.emit = lambda event, *_args, **_kwargs: emitted.append(event)
        self.ops._node("a.txt", False)
        self.ops._node("b.txt", False)
        asyncio.run(self.ops.invalidate_path("a.txt"))
        asyncio.run(self.ops.invalidate_path("b.txt"))
        self.assertEqual(emitted.count("invalidation-thread-stuck"), 1)
        self.assertEqual(emitted.count("invalidation-timeout"), 2)

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


    # risk: missed remote changes — home-rooted mounts must poll the collection stored on ROOT_INODE.
    def test_change_poller_registers_home_collection_root(self):
        self.ops.initial_tree_loaded = True
        self.ops.nodes[1]["collectionId"] = "home"
        self.ops.nodes[1]["collectionRoot"] = False
        calls = []
        async def changes(collection_id, cursor):
            calls.append((collection_id, cursor))
            return {"cursor": "c1", "changes": [], "more": False}
        async def stop_after_poll(_seconds):
            raise asyncio.CancelledError()
        self.adapter.trio.sleep = stop_after_poll
        events = []
        self.adapter.emit = lambda name, *_args, **fields: events.append((name, fields))
        self.ops.api = types.SimpleNamespace(changes=changes)
        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(self.ops.follow_changes())
        self.assertEqual(calls, [("home", "")])
        self.assertIn(("change-feed-started", {"collections": 1}), events)

    # risk: change-feed liveness — a single unexpected poll exception must back off and retry, not end the task.
    def test_change_poller_survives_unexpected_exception(self):
        self.ops.nodes[1]["collectionId"] = "home"
        calls = []
        async def changes(collection_id, cursor):
            calls.append(collection_id)
            if len(calls) == 1:
                raise RuntimeError("unexpected adapter failure")
            return {"cursor": "c1", "changes": [], "more": False}
        sleeps = []
        async def stop_after_retry(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 2:
                raise asyncio.CancelledError()
        events = []
        self.adapter.trio.sleep = stop_after_retry
        self.adapter.emit = lambda name, *_args, **fields: events.append((name, fields))
        self.ops.api = types.SimpleNamespace(changes=changes)
        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(self.ops.follow_changes())
        self.assertEqual(calls, ["home", "home"])
        self.assertTrue(any(name == "change-feed-unhealthy" for name, _ in events))
        self.assertTrue(self.ops.feed_healthy)

    # risk: stale metadata — a collection must have a successful poll before kernel positive caching is enabled.
    def test_cache_stays_off_until_collection_poll_succeeds(self):
        inode = self.ops._node("home/file.txt", False)
        self.ops.nodes[inode].update({"collectionId": "home", "size": 9})
        self.ops.directory_complete.add("home")
        self.ops.feed_healthy = True
        self.assertEqual(self.ops._attrs(inode).attr_timeout, 0.0)
        self.ops.feed_ready_collections.add("home")
        self.assertEqual(self.ops._attrs(inode).attr_timeout, self.adapter.ATTR_TIMEOUT_SECONDS)

if __name__ == "__main__":
    unittest.main()
