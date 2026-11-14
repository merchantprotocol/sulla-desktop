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


class Reply:
    def __init__(self):
        self.names = []

    def __call__(self, token, name, attrs, offset):
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


def load_adapter():
    pyfuse3 = types.ModuleType("pyfuse3")
    pyfuse3.ROOT_INODE = 1
    pyfuse3.Operations = object
    pyfuse3.EntryAttributes = Attrs
    pyfuse3.FUSEError = type("FUSEError", (OSError,), {})
    pyfuse3.readdir_reply = Reply()
    trio = types.ModuleType("trio")
    yaml = types.ModuleType("yaml")
    sys.modules.update(pyfuse3=pyfuse3, trio=trio, yaml=yaml)
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
        token = types.SimpleNamespace(names=[])

        asyncio.run(operations.readdir(inode, 0, token))

        self.assertEqual(len(token.names), 100_000)
        self.assertEqual(len(api.calls), 200)
        self.assertTrue(api.calls)
        self.assertTrue(all(call[0] == "home" and call[1] == "opened" for call in api.calls))
        self.assertLessEqual(len(operations.path_inode), operations.node_limit + 1)
        self.assertLessEqual(len(operations.children.get("opened", {})), operations.node_limit)


if __name__ == "__main__":
    unittest.main()
