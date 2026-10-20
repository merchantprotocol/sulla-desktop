#!/usr/bin/env python3
"""Read/write FUSE view of every tracked Sulla Files collection."""

import argparse
import errno
import json
import os
import stat
import time
import urllib.error
import urllib.parse
import urllib.request

import pyfuse3
import trio


MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_OPEN_HANDLES = 128
MAX_TOKEN_BYTES = 4096


class FilesApi:
    def __init__(self, base_url: str, token_file: str):
        self.base_url = base_url.rstrip("/")
        self.token_file = token_file

    def _token(self):
        descriptor = os.open(self.token_file, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                raise OSError(errno.EACCES, "Files mount capability file is not private")
            token = os.read(descriptor, MAX_TOKEN_BYTES + 1).strip()
        finally:
            os.close(descriptor)
        if not token or len(token) > MAX_TOKEN_BYTES:
            raise OSError(errno.EACCES, "Files mount capability is invalid")
        return token.decode("ascii")

    def _request(self, path: str, method="GET", body=None, headers=None):
        request = urllib.request.Request(
            f"{self.base_url}{path}", method=method, data=body,
            headers={"Authorization": f"Bearer {self._token()}", **(headers or {})},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                length = response.headers.get("Content-Length")
                if length and int(length) > MAX_FILE_BYTES:
                    raise OSError(errno.EFBIG, "Files response exceeds the mount limit")
                payload = response.read(MAX_FILE_BYTES + 1)
                if len(payload) > MAX_FILE_BYTES:
                    raise OSError(errno.EFBIG, "Files response exceeds the mount limit")
                return response.status, dict(response.headers), payload
        except urllib.error.HTTPError as error:
            payload = error.read(MAX_FILE_BYTES + 1)
            try:
                detail = json.loads(payload or b"{}")
            except json.JSONDecodeError:
                detail = {}
            failure = OSError(errno.EIO, detail.get("error", f"Files HTTP {error.code}"))
            failure.status = error.code
            failure.detail = detail
            raise failure from error
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            raise OSError(errno.EIO, f"Files service unavailable: {error}") from error

    async def snapshot(self):
        _, _, body = await trio.to_thread.run_sync(self._request, "/v1/fuse/tree")
        return json.loads(body)

    async def read(self, file_id):
        _, headers, body = await trio.to_thread.run_sync(self._request, f"/v1/fuse/files/{file_id}/content")
        return body, headers.get("ETag", "").strip('"'), headers.get("X-Sulla-Source-Hash", "")

    async def write(self, file_id, data, version_id, source_hash):
        if len(data) > MAX_FILE_BYTES:
            raise OSError(errno.EFBIG, "Files write exceeds the mount limit")
        headers = {"Content-Type": "application/octet-stream", "If-Match": f'"{version_id}"', "X-Sulla-Source-Hash": source_hash}
        _, _, body = await trio.to_thread.run_sync(self._request, f"/v1/fuse/files/{file_id}/content", "PUT", bytes(data), headers)
        return json.loads(body)

    async def create(self, collection_id, path):
        query = urllib.parse.urlencode({"collectionId": collection_id, "path": path})
        _, _, body = await trio.to_thread.run_sync(self._request, f"/v1/fuse/files?{query}", "POST", b"", {"Content-Type":"application/octet-stream"})
        return json.loads(body)

    async def rename(self, file_id, path):
        body = json.dumps({"path": path}).encode()
        await trio.to_thread.run_sync(self._request, f"/v1/fuse/files/{file_id}", "PATCH", body, {"Content-Type":"application/json"})

    async def delete(self, file_id):
        await trio.to_thread.run_sync(self._request, f"/v1/fuse/files/{file_id}", "DELETE")

    async def mkdir(self, collection_id, path):
        body = json.dumps({"collectionId":collection_id,"path":path}).encode()
        await trio.to_thread.run_sync(self._request, "/v1/fuse/folders", "POST", body, {"Content-Type":"application/json"})

    async def rmdir(self, collection_id, path):
        query = urllib.parse.urlencode({"collectionId":collection_id,"path":path})
        await trio.to_thread.run_sync(self._request, f"/v1/fuse/folders?{query}", "DELETE")


class SullaFiles(pyfuse3.Operations):
    enable_writeback_cache = False

    def __init__(self, api: FilesApi):
        super().__init__()
        self.api = api
        self.next_inode = pyfuse3.ROOT_INODE + 1
        self.nodes = {pyfuse3.ROOT_INODE: {"path": "", "directory": True}}
        self.path_inode = {"": pyfuse3.ROOT_INODE}
        self.handles = {}
        self.next_handle = 1
        self.uid = 0
        self.gid = 0

    async def refresh(self):
        snapshot = await self.api.snapshot()
        present = {""}
        for collection in snapshot["collections"]:
            root = f"{collection['name'].replace('/', '_')}--{collection['id'][:8]}"
            present.add(root)
            inode = self._node(root, True)
            self.nodes[inode].update({"collectionId":collection["id"], "collectionRoot":True})
        roots = {node.get("collectionId"):path for path,inode in self.path_inode.items() for node in [self.nodes[inode]] if node.get("collectionRoot")}
        for folder in snapshot["folders"]:
            root = roots.get(folder["collection_id"])
            if not root: continue
            full = f"{root}/{folder['path']}"
            for index in range(1, len(full.split('/')) + 1):
                path = "/".join(full.split('/')[:index]); present.add(path)
                inode = self._node(path, True); self.nodes[inode].update({"collectionId":folder["collection_id"]})
        for row in snapshot["files"]:
            root = roots.get(row["collection_id"])
            if not root: continue
            full = f"{root}/{row['path']}"; parts=full.split('/')
            for index in range(1,len(parts)):
                path="/".join(parts[:index]); present.add(path)
                inode=self._node(path,True); self.nodes[inode].update({"collectionId":row["collection_id"]})
            present.add(full); inode=self._node(full,False)
            self.nodes[inode].update({**row,"path":full,"filesPath":row["path"],"collectionId":row["collection_id"],"mtimeMs":int(time.time()*1000)})
        for path, inode in list(self.path_inode.items()):
            if path and path not in present:
                self.path_inode.pop(path, None); self.nodes.pop(inode, None)

    def _node(self, path, directory):
        inode = self.path_inode.get(path)
        if inode is None:
            inode = self.next_inode
            self.next_inode += 1
            self.path_inode[path] = inode
            self.nodes[inode] = {"path": path, "directory": directory}
        return inode

    def _attrs(self, inode):
        node = self.nodes.get(inode)
        if node is None:
            raise pyfuse3.FUSEError(errno.ENOENT)
        attrs = pyfuse3.EntryAttributes()
        attrs.st_ino = inode
        # Only explicitly admitted containers receive this mount.  The Files
        # capability remains the authorization boundary; allow any numeric
        # runtime UID to exercise that scoped view without guessing its ID.
        attrs.st_mode = (stat.S_IFDIR | 0o777) if node["directory"] else (stat.S_IFREG | 0o666)
        attrs.st_nlink = 2 if node["directory"] else 1
        attrs.st_uid = self.uid
        attrs.st_gid = self.gid
        attrs.st_rdev = 0
        attrs.st_size = 0 if node["directory"] else int(node.get("size", 0))
        attrs.st_blksize = 4096
        attrs.st_blocks = (attrs.st_size + 511) // 512
        timestamp = int(node.get("mtimeMs", time.time() * 1000) * 1_000_000)
        attrs.st_atime_ns = attrs.st_mtime_ns = attrs.st_ctime_ns = timestamp
        attrs.generation = 0
        attrs.entry_timeout = 0
        attrs.attr_timeout = 0
        return attrs

    async def getattr(self, inode, ctx=None):
        if inode == pyfuse3.ROOT_INODE:
            try:
                await self.refresh()
            except OSError as error:
                raise pyfuse3.FUSEError(error.errno) from error
        return self._attrs(inode)

    async def lookup(self, parent_inode, name, ctx=None):
        try:
            await self.refresh()
        except OSError as error:
            raise pyfuse3.FUSEError(error.errno) from error
        parent = self.nodes.get(parent_inode)
        if not parent or not parent["directory"]:
            raise pyfuse3.FUSEError(errno.ENOENT)
        path = "/".join(filter(None, [parent["path"], os.fsdecode(name)]))
        inode = self.path_inode.get(path)
        if inode is None:
            raise pyfuse3.FUSEError(errno.ENOENT)
        return self._attrs(inode)

    async def opendir(self, inode, ctx):
        if not self.nodes.get(inode, {}).get("directory"):
            raise pyfuse3.FUSEError(errno.ENOTDIR)
        return inode

    async def readdir(self, fh, start_id, token):
        try:
            await self.refresh()
        except OSError as error:
            raise pyfuse3.FUSEError(error.errno) from error
        parent = self.nodes[fh]["path"]
        children = []
        for path, inode in self.path_inode.items():
            if path and os.path.dirname(path) == parent:
                children.append((os.path.basename(path), inode))
        for index, (name, inode) in enumerate(sorted(children), start=1):
            if index <= start_id:
                continue
            if not pyfuse3.readdir_reply(token, os.fsencode(name), self._attrs(inode), index):
                break

    async def open(self, inode, flags, ctx):
        node = self.nodes.get(inode)
        if not node or node["directory"]:
            raise pyfuse3.FUSEError(errno.EISDIR)
        if flags & (os.O_APPEND | os.O_EXCL):
            raise pyfuse3.FUSEError(errno.EOPNOTSUPP)
        if len(self.handles) >= MAX_OPEN_HANDLES:
            raise pyfuse3.FUSEError(errno.EMFILE)
        try:
            data, version_id, source_hash = await self.api.read(node["id"])
        except OSError as error:
            raise pyfuse3.FUSEError(error.errno) from error
        handle = self.next_handle
        self.next_handle += 1
        self.handles[handle] = {
            "inode": inode, "fileId": node["id"], "data": bytearray(data),
            "versionId": version_id, "sourceHash": source_hash, "dirty": False, "failed": False,
        }
        if flags & os.O_TRUNC:
            self.handles[handle]["data"].clear()
            self.handles[handle]["dirty"] = True
        info = pyfuse3.FileInfo(fh=handle)
        info.keep_cache = False
        info.direct_io = True
        return info

    async def read(self, fh, offset, length):
        data = self.handles[fh]["data"]
        return bytes(data[offset:offset + length])

    async def write(self, fh, offset, buf):
        handle = self.handles[fh]
        data = handle["data"]
        end = offset + len(buf)
        if end > MAX_FILE_BYTES:
            raise pyfuse3.FUSEError(errno.EFBIG)
        if end > len(data):
            data.extend(b"\0" * (end - len(data)))
        data[offset:end] = buf
        handle["dirty"] = True
        return len(buf)

    async def setattr(self, inode, attr, fields, fh, ctx):
        if fields.update_size:
            if fh is None or fh not in self.handles:
                raise pyfuse3.FUSEError(errno.EOPNOTSUPP)
            data = self.handles[fh]["data"]
            size = int(attr.st_size)
            if size > MAX_FILE_BYTES:
                raise pyfuse3.FUSEError(errno.EFBIG)
            if size < len(data):
                del data[size:]
            else:
                data.extend(b"\0" * (size - len(data)))
            self.handles[fh]["dirty"] = True
            self.nodes[inode]["size"] = size
        unsupported = fields.update_mode or fields.update_uid or fields.update_gid or fields.update_atime or fields.update_mtime
        if unsupported:
            raise pyfuse3.FUSEError(errno.EOPNOTSUPP)
        return self._attrs(inode)

    async def _commit(self, fh):
        handle = self.handles[fh]
        if not handle["dirty"]:
            if handle["failed"]:
                raise pyfuse3.FUSEError(errno.EIO)
            return
        try:
            result, _ = await self.api.write(handle["fileId"], handle["data"], handle["versionId"], handle["sourceHash"])
        except OSError as error:
            if getattr(error, "status", None) == 409:
                handle["dirty"] = False
                handle["failed"] = True
            raise pyfuse3.FUSEError(errno.EIO) from error
        handle["versionId"] = result["versionId"]
        handle["sourceHash"] = result["sourceHash"]
        handle["dirty"] = False
        handle["failed"] = False
        node = self.nodes[handle["inode"]]
        node.update(result)

    async def flush(self, fh):
        await self._commit(fh)

    async def fsync(self, fh, datasync):
        await self._commit(fh)

    async def release(self, fh):
        try:
            await self._commit(fh)
        finally:
            self.handles.pop(fh, None)

    def _child(self, parent_inode, name):
        parent=self.nodes.get(parent_inode)
        if not parent or not parent.get("directory"): raise pyfuse3.FUSEError(errno.ENOTDIR)
        return parent, "/".join(filter(None,[parent["path"],os.fsdecode(name)]))

    def _files_path(self, node_path):
        return node_path.split("/",1)[1] if "/" in node_path else ""

    async def create(self, parent_inode, name, mode, flags, ctx):
        parent,path=self._child(parent_inode,name)
        if parent.get("collectionRoot") is not True and not parent.get("collectionId"): raise pyfuse3.FUSEError(errno.EPERM)
        try: row=await self.api.create(parent["collectionId"],self._files_path(path))
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        inode=self._node(path,False); self.nodes[inode].update({**row,"path":path,"filesPath":self._files_path(path),"collectionId":parent["collectionId"]})
        info=await self.open(inode,flags,ctx)
        return info,self._attrs(inode)

    async def rename(self, parent_inode, name, new_parent_inode, new_name, flags, ctx):
        parent,old_path=self._child(parent_inode,name); target_parent,new_path=self._child(new_parent_inode,new_name)
        inode=self.path_inode.get(old_path); node=self.nodes.get(inode) if inode else None
        if not node or node.get("directory") or parent.get("collectionId") != target_parent.get("collectionId"): raise pyfuse3.FUSEError(errno.EOPNOTSUPP)
        try: await self.api.rename(node["id"],self._files_path(new_path))
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        self.path_inode.pop(old_path,None); self.path_inode[new_path]=inode; node.update({"path":new_path,"filesPath":self._files_path(new_path)})

    async def unlink(self, parent_inode, name, ctx):
        _,path=self._child(parent_inode,name); inode=self.path_inode.get(path); node=self.nodes.get(inode) if inode else None
        if not node or node.get("directory"): raise pyfuse3.FUSEError(errno.ENOENT)
        try: await self.api.delete(node["id"])
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        self.path_inode.pop(path,None); self.nodes.pop(inode,None)

    async def mkdir(self, parent_inode, name, mode, ctx):
        parent,path=self._child(parent_inode,name)
        if not parent.get("collectionId"): raise pyfuse3.FUSEError(errno.EPERM)
        try: await self.api.mkdir(parent["collectionId"],self._files_path(path))
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        inode=self._node(path,True); self.nodes[inode].update({"collectionId":parent["collectionId"]})
        return self._attrs(inode)

    async def rmdir(self, parent_inode, name, ctx):
        parent,path=self._child(parent_inode,name); inode=self.path_inode.get(path); node=self.nodes.get(inode) if inode else None
        if not node or node.get("collectionRoot"): raise pyfuse3.FUSEError(errno.EPERM)
        try: await self.api.rmdir(parent["collectionId"],self._files_path(path))
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        self.path_inode.pop(path,None); self.nodes.pop(inode,None)


async def main(options):
    token_file = os.environ.get("SULLA_FILES_FUSE_TOKEN_FILE")
    if not token_file:
        raise SystemExit("SULLA_FILES_FUSE_TOKEN_FILE is required")
    os.makedirs(options.mountpoint, exist_ok=True)
    operations = SullaFiles(FilesApi(options.url, token_file))
    pyfuse3.init(operations, options.mountpoint, {"fsname=sulla-files", "default_permissions", "allow_other"})
    try:
        await pyfuse3.main()
    finally:
        pyfuse3.close(unmount=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Files service base URL")
    parser.add_argument("mountpoint")
    trio.run(main, parser.parse_args())
