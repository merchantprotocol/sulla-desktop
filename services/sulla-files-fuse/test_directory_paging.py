# SPDX-License-Identifier: GPL-2.0-or-later
"""Scale regression for the lazy FUSE directory reader (no FUSE mount needed)."""
import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest


ROOT = pathlib.Path(__file__).parent


class Attrs:
    pass


class ReaddirToken:
    def __init__(self):
        self.names = []


class Reply:
    def __init__(self):
        self.names = []
        self.calls = 0

    def __call__(self, token, name, attrs, offset):
        if not isinstance(token, ReaddirToken):
            raise TypeError("expected pyfuse3.ReaddirToken")
        self.calls += 1
        token.names.append(name)
        return True


class DirectoryApi:
    def __init__(self):
        self.calls = []
        self.count = 100_000

    async def directory_page(self, collection_id, path, cursor=None, etag=None):
        self.calls.append((collection_id, path, cursor, etag))
        start = int(cursor or 0)
        end = min(start + 500, self.count)
        rows = [{"path": f"item-{i:06d}", "kind": "file", "size": 1} for i in range(start, end)]
        return {"rootCollectionId": "home", "entries": rows,
                "nextCursor": str(end) if end < self.count else None}, f'"revision-{start}"'


class FUSEError(Exception):
    """Like pyfuse3.FUSEError: carries .errno and is not an OSError."""
    def __init__(self, code):
        super().__init__(code)
        self.errno = code


def load_adapter():
    pyfuse3 = types.ModuleType("pyfuse3")
    pyfuse3.ROOT_INODE = 1
    pyfuse3.Operations = object
    pyfuse3.EntryAttributes = Attrs
    pyfuse3.FUSEError = FUSEError
    pyfuse3.readdir_reply = Reply()
    trio = types.ModuleType("trio")
    async def run_sync(function, *args, limiter=None, abandon_on_cancel=False):
        trio.run_sync_calls.append((limiter, abandon_on_cancel))
        return await asyncio.to_thread(function, *args)
    trio.to_thread = types.SimpleNamespace(run_sync=run_sync)
    trio.Lock = asyncio.Lock
    trio.run_sync_calls = []
    trio.CapacityLimiter = lambda _limit: object()
    class MoveOnAfter:
        def __init__(self, seconds): self.seconds, self.cancelled_caught = seconds, False
        def __enter__(self):
            self.task = asyncio.current_task()
            self.handle = asyncio.get_running_loop().call_later(self.seconds, self.task.cancel)
            return self
        def __exit__(self, exc_type, _exc, _tb):
            self.handle.cancel()
            if exc_type is asyncio.CancelledError:
                self.cancelled_caught = True
                self.task.uncancel()
                return True
            return False
    trio.move_on_after = MoveOnAfter
    yaml = types.ModuleType("yaml")
    urllib3 = types.ModuleType("urllib3")
    urllib3.PoolManager = lambda **_kwargs: types.SimpleNamespace(request=None)
    urllib3.Timeout = lambda **_kwargs: None
    # Same hierarchy as urllib3 2.x: connect failures are ConnectTimeoutError subclasses, and all are HTTPError.
    http_error = type("HTTPError", (Exception,), {})
    timeout_error = type("TimeoutError", (http_error,), {})
    connect_timeout_error = type("ConnectTimeoutError", (timeout_error,), {})
    urllib3.exceptions = types.SimpleNamespace(
        HTTPError=http_error,
        TimeoutError=timeout_error,
        ConnectTimeoutError=connect_timeout_error,
        NewConnectionError=type("NewConnectionError", (connect_timeout_error, http_error), {}),
        ProtocolError=type("ProtocolError", (http_error,), {}),
    )
    sys.modules.update(pyfuse3=pyfuse3, trio=trio, yaml=yaml, urllib3=urllib3)
    spec = importlib.util.spec_from_file_location("sulla_files_fuse_test", ROOT / "sulla_files_fuse.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, pyfuse3


class DirectoryPagingTests(unittest.TestCase):
    # risk: unbounded-memory / OOM when a single directory has many children.
    def test_readdir_only_fetches_open_directory_and_caps_cached_nodes(self):
        adapter, pyfuse3 = load_adapter()
        api = DirectoryApi()
        operations = adapter.SullaFiles(api)
        inode = operations._node("opened", True)
        operations.nodes[inode]["collectionId"] = "home"
        token = ReaddirToken()

        asyncio.run(operations.readdir(inode, 0, token))

        self.assertEqual(len(token.names), 100_000)
        self.assertEqual(len(api.calls), 200)
        self.assertTrue(api.calls)
        self.assertTrue(all(call[0] == "home" and call[1] == "opened" for call in api.calls))
        self.assertLessEqual(len(operations.path_inode), operations.node_limit + 1)
        self.assertLessEqual(len(operations.children.get("opened", {})), operations.node_limit)


if __name__ == "__main__":
    unittest.main()
