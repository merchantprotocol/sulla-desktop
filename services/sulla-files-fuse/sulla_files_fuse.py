#!/usr/bin/env python3
# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
# "Sulla" is a trademark. See TRADEMARK.md.

"""Read/write FUSE view of every tracked Sulla Files collection.

Tunables (environment variables, read once at import):

- SULLA_FILES_FUSE_MAX_OPEN_HANDLES (default 4096, minimum 32): open file handles
  the mount keeps before new opens fail with EMFILE (MAX_OPEN_HANDLES).
- SULLA_FILES_FUSE_MAX_WAIT_S (default 75): the deadline for one Files request,
  shared by every retry of it (MAX_WAIT_SECONDS). Connection-refused and connect
  timeouts are retried until this deadline for every method, because nothing was
  sent. Read timeouts and 5xx responses are retried only for idempotent calls, and
  then only until this deadline; after that the caller gets EIO. The connect phase
  itself is capped at 5 seconds.
- SULLA_FILES_FUSE_NETWORK_THREADS (default 64): threads for Files HTTP calls.
- SULLA_FILES_FUSE_MAX_TRANSFERS (default 4): concurrent file transfers.
- SULLA_FILES_FUSE_SPOOL: disk-backed spool directory for open-file buffers.
- SULLA_FILES_FUSE_ATTR_TIMEOUT_S (default 5): kernel attr/entry cache lifetime while the
  authenticated change-feed poller is healthy; zero disables kernel caching.
- SULLA_FILES_FUSE_READ_CACHE_MB (default 512): maximum spool-volume immutable read-cache size.
- SULLA_FILES_FUSE_SLOW_REQUEST_SECONDS (default 1.0) and
  SULLA_FILES_FUSE_HEARTBEAT_SECONDS (default 60): logging thresholds.
"""

import argparse
import datetime
import errno
import hashlib
import functools
import json
import os
import random
import stat
import tempfile
import time
import urllib.parse
import urllib3
import logging
import contextvars
import re
from collections import OrderedDict

import yaml

import pyfuse3
import trio


# Keep per-handle data on the bounded container tmpfs, not in Python heap.
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_OPEN_HANDLES = max(32, int(os.environ.get("SULLA_FILES_FUSE_MAX_OPEN_HANDLES", "4096")))
# Open-file buffers spill to a disk-backed volume, never to RAM (tmpfs counts
# against the container memory limit).
SPOOL_DIR = os.environ.get("SULLA_FILES_FUSE_SPOOL", "/var/spool/sulla-files-fuse")
MAX_TOKEN_BYTES = 4096
MAX_CACHED_NODES = 50_000
DIRECTORY_PAGE_SIZE = 500
# Methods whose outcome doesn't depend on how many times they're applied, so
# retrying a transient 409 from Files' own SERIALIZABLE-conflict retry loop is safe.
IDEMPOTENT_RETRY_METHODS = ("DELETE", "GET", "HEAD", "PUT")
MAX_CONFLICT_RETRIES = 3
# A lost Files database connection, a restart or a saturated VM answers 5xx or times out.
# These failures are retried until the configured request deadline (MAX_WAIT_SECONDS) before clients see EIO.
TRANSIENT_STATUSES = (500, 502, 503, 504)
MAX_WAIT_SECONDS = max(0.1, float(os.environ.get("SULLA_FILES_FUSE_MAX_WAIT_S", "75")))
NETWORK_THREAD_LIMIT = max(1, int(os.environ.get("SULLA_FILES_FUSE_NETWORK_THREADS", "64")))
STREAMING_WRITE_THRESHOLD = 1024 * 1024
STREAM_CHUNK_BYTES = 1024 * 1024
MAX_CONCURRENT_TRANSFERS = max(1, int(os.environ.get("SULLA_FILES_FUSE_MAX_TRANSFERS", "4")))
ATTR_TIMEOUT_SECONDS = max(0.0, float(os.environ.get("SULLA_FILES_FUSE_ATTR_TIMEOUT_S", "5")))
READ_CACHE_MAX_BYTES = max(0, int(os.environ.get("SULLA_FILES_FUSE_READ_CACHE_MB", "512"))) * 1024 * 1024
CHANGE_POLL_SECONDS = 1.0
TRANSFER_SEMAPHORE = __import__("threading").BoundedSemaphore(MAX_CONCURRENT_TRANSFERS)
# One tree snapshot serves every lookup in this window; a single `ls` used to fetch it once per entry.
SNAPSHOT_TTL_SECONDS = 10.0
# Hashing a spooled file to detect a no-op write is only worth it for small files.
UNCHANGED_CHECK_MAX_BYTES = 8 * 1024 * 1024
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
METADATA_NAME = "_folder-metadata.yaml"
METADATA_HEADER = """# Folder metadata for: {path}
# Describes this folder and the files in it. Read this to understand the folder.
# Edit this file to change metadata: changes are saved to Sulla Files, permission-checked and audited.
# When you create a folder, fill in `description` with the folder's purpose for future agents.
"""
log = logging.getLogger("sulla-files-fuse")
request_actor = contextvars.ContextVar("request_actor", default=None)
# Requests slower than this are logged at INFO even when DEBUG is off.
SLOW_REQUEST_SECONDS = float(os.environ.get("SULLA_FILES_FUSE_SLOW_REQUEST_SECONDS", "1.0"))
HEARTBEAT_SECONDS = float(os.environ.get("SULLA_FILES_FUSE_HEARTBEAT_SECONDS", "60"))
# Expected misses (stat of a missing path, absent xattr) stay at DEBUG.
QUIET_ERRNOS = {errno.ENOENT, errno.ENODATA}
stats = {"requests": 0, "requestErrors": 0, "slowRequests": 0, "ops": 0, "opErrors": 0, "snapshots": 0, "snapshotsUnchanged": 0}


class JsonFormatter(logging.Formatter):
    """One JSON object per line, matching the sulla-files service log shape. Never carries tokens or file bodies."""
    def format(self, record):
        entry = {"ts": datetime.datetime.fromtimestamp(record.created, datetime.timezone.utc).isoformat(timespec="milliseconds"),
                 "source": "sulla-files-fuse", "level": record.levelname.lower(), "event": getattr(record, "event", "log")}
        if record.args or not hasattr(record, "event"): entry["message"] = record.getMessage()
        entry.update(getattr(record, "fields", {}))
        if record.exc_info: entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str, separators=(",", ":"))


def emit(event, level=logging.INFO, **fields):
    log.log(level, event, extra={"event": event, "fields": {key: value for key, value in fields.items() if value is not None}})


def _errno_name(code):
    return errno.errorcode.get(code, str(code)) if isinstance(code, int) else str(code)


def _rss_kb():
    try:
        with open("/proc/self/status", encoding="ascii") as status:
            return next((int(line.split()[1]) for line in status if line.startswith("VmRSS:")), None)
    except OSError:
        return None


def _spool_sha256(file, size):
    digest = hashlib.sha256()
    offset = 0
    while offset < size:
        part = os.pread(file.fileno(), min(STREAM_CHUNK_BYTES, size - offset), offset)
        if not part:
            break
        digest.update(part)
        offset += len(part)
    return digest.hexdigest()


class FileBody:
    """Repeatable bounded request body backed by the spool file, not Python heap."""
    def __init__(self, descriptor, size):
        self.descriptor = descriptor
        self.size = size

    def __len__(self):
        return self.size

    def __iter__(self):
        offset = 0
        while offset < self.size:
            chunk = os.pread(self.descriptor, min(STREAM_CHUNK_BYTES, self.size - offset), offset)
            if not chunk:
                raise OSError(errno.EIO, "Files spool ended before its declared size")
            offset += len(chunk)
            yield chunk


class ContentReadCache:
    """Crash-safe spool-volume cache indexed by immutable Files version and content hash."""
    def __init__(self, directory, max_bytes):
        self.directory = directory
        self.max_bytes = max_bytes
        self.entries = OrderedDict()
        self.sizes = {}
        self.disabled = False
        os.makedirs(directory, exist_ok=True)
        self._load()
        self._evict(self.max_bytes)

    def _key(self, version, digest):
        return hashlib.sha256(f"{version}:{digest}".encode()).hexdigest()

    def _load(self):
        for name in os.listdir(self.directory):
            if name.startswith(".readcache-"):
                try: os.unlink(os.path.join(self.directory, name))
                except OSError: pass
                continue
            if not name.endswith(".readcache"):
                continue
            path = os.path.join(self.directory, name)
            try:
                size = os.path.getsize(path)
                if size <= MAX_FILE_BYTES:
                    self.entries[name[:-10]] = path
                    self.sizes[name[:-10]] = size
            except OSError:
                continue

    def get(self, version, digest, expected_size, destination):
        if self.disabled or not version or not digest:
            return False
        key = self._key(version, digest)
        path = self.entries.get(key)
        if not path:
            return False
        try:
            with open(path, "rb") as source:
                data_hash = hashlib.sha256()
                size = 0
                destination.seek(0); destination.truncate(0)
                while True:
                    chunk = source.read(STREAM_CHUNK_BYTES)
                    if not chunk: break
                    data_hash.update(chunk); destination.write(chunk); size += len(chunk)
                if size != expected_size or data_hash.hexdigest().lower() != digest.lower():
                    raise ValueError("cached content failed verification")
            destination.flush()
            self.entries.move_to_end(key)
            return True
        except (OSError, ValueError):
            self._remove(key)
            destination.seek(0); destination.truncate(0)
            return False

    def put(self, version, digest, source, size):
        if self.disabled or not version or not digest or size < 0 or size > MAX_FILE_BYTES or size > self.max_bytes:
            return
        # Never let the cache consume more than a quarter of currently free spool space.
        budget = min(self.max_bytes, os.statvfs(self.directory).f_bavail * os.statvfs(self.directory).f_frsize // 4)
        if size > budget:
            return
        key = self._key(version, digest)
        fd, temporary = tempfile.mkstemp(prefix=".readcache-", dir=self.directory)
        try:
            hasher = hashlib.sha256()
            with os.fdopen(fd, "wb") as output:
                offset = 0
                while offset < size:
                    chunk = os.pread(source.fileno(), min(STREAM_CHUNK_BYTES, size - offset), offset)
                    if not chunk: raise OSError(errno.EIO, "short read while caching Files content")
                    output.write(chunk); hasher.update(chunk); offset += len(chunk)
                output.flush()
            if hasher.hexdigest().lower() != digest.lower():
                return
            target = os.path.join(self.directory, key + ".readcache")
            # Forget the prior index entry without unlinking its path: replace() atomically
            # installs the new complete file at that same pathname.
            self.entries.pop(key, None); self.sizes.pop(key, None)
            os.replace(temporary, target)
            self.entries[key] = target; self.sizes[key] = size
            self._evict(budget)
        finally:
            try: os.unlink(temporary)
            except FileNotFoundError: pass

    def _remove(self, key):
        path = self.entries.pop(key, None); self.sizes.pop(key, None)
        if path:
            try: os.unlink(path)
            except OSError: pass

    def _evict(self, budget):
        total = sum(self.sizes.values())
        while self.entries and total > budget:
            key = next(iter(self.entries)); total -= self.sizes.get(key, 0); self._remove(key)


def traced(operation, describe=None, mutating=False):
    """Time a FUSE operation and log its outcome. Mutations log at INFO; reads only at DEBUG."""
    def decorate(function):
        @functools.wraps(function)
        async def wrapper(self, *args):
            started = time.monotonic()
            stats["ops"] += 1
            # Describe before running: unlink/rmdir/release remove the node or handle.
            details = self._describe(describe, args)
            try:
                result = await function(self, *args)
            except pyfuse3.FUSEError as error:
                code = error.errno
                quiet = code in QUIET_ERRNOS and not mutating
                if not quiet: stats["opErrors"] += 1
                emit("fuse-op", logging.DEBUG if quiet else logging.WARNING, op=operation, ok=False, errno=_errno_name(code),
                     ms=round((time.monotonic() - started) * 1000, 1), **details)
                raise
            except OSError as error:
                # A Files or filesystem failure the operation did not map itself: answer this one
                # request with its errno (404 ENOENT, 401/403 EACCES, 5xx/timeout EIO after the
                # bounded retries) and keep the daemon serving every other request.
                code = HTTP_ERRNO.errno_for_failure(error)
                quiet = code in QUIET_ERRNOS and not mutating
                if not quiet: stats["opErrors"] += 1
                emit("fuse-op", logging.DEBUG if quiet else logging.WARNING, op=operation, ok=False, errno=_errno_name(code),
                     status=getattr(error, "status", None), error=str(error), ms=round((time.monotonic() - started) * 1000, 1), **details)
                raise pyfuse3.FUSEError(code) from error
            except Exception:
                stats["opErrors"] += 1
                log.exception("unhandled error in %s", operation, extra={"event": "fuse-op-crash", "fields": {"op": operation, **details}})
                raise pyfuse3.FUSEError(errno.EIO)
            if mutating or log.isEnabledFor(logging.DEBUG):
                emit("fuse-op", logging.INFO if mutating else logging.DEBUG, op=operation, ok=True,
                     ms=round((time.monotonic() - started) * 1000, 1), **details)
            return result
        return wrapper
    return decorate


class ActorResolver:
    """Resolve FUSE request PIDs through platform-owned container identity files."""
    def __init__(self, proc_root="/host/proc", actors_root="/run/sulla-files-fuse/actors"):
        self.proc_root = proc_root
        self.actors_root = actors_root
        self.cache = {}

    async def resolve(self, pid):
        try:
            cgroup_path = os.path.join(self.proc_root, str(pid), "cgroup")
            cgroup = await trio.to_thread.run_sync(lambda: open(cgroup_path, encoding="utf-8").read())
            ids = re.findall(r"(?:docker[-/]|cri-containerd[-/])([0-9a-f]{64})", cgroup)
            if not ids: ids = re.findall(r"/([0-9a-f]{64})(?:\.scope)?(?:\n|$)", cgroup)
            if not ids: return None
            container_id = ids[-1]
            if container_id in self.cache: return self.cache[container_id]
            actor_path = os.path.join(self.actors_root, container_id)
            actor = (await trio.to_thread.run_sync(lambda: open(actor_path, encoding="utf-8").read(1024))).strip()
            if not actor or "\n" in actor or ":" not in actor:
                emit("actor-invalid", logging.WARNING, pid=pid, container=container_id[:12])
                return None
            self.cache[container_id] = actor
            emit("actor-resolved", pid=pid, container=container_id[:12], actor=actor)
            return actor
        except (OSError, ValueError, json.JSONDecodeError) as error:
            # Host processes have no container identity; that is normal and stays at DEBUG.
            emit("actor-unresolved", logging.DEBUG, pid=pid, reason=f"{type(error).__name__}: {error}")
            return None


class HttpErrno:
    """The one table that turns a Files HTTP failure into the errno a mount client sees.

    404 is ENOENT (a stat before create is the normal case, not an I/O error); EIO is kept for
    server faults that survived the bounded retries in FilesApi._request.
    """

    def errno_for(self, status, detail=None):
        detail = detail or {}
        code = detail.get("code")
        message = str(detail.get("error", "")).lower()
        if code in ("EROFS", "FILE_LOCKED") or status == 423:
            return errno.EROFS
        if status in (400, 415, 422, 428):
            return errno.EINVAL
        if status in (401, 403):
            return errno.EACCES
        if status == 404:
            return errno.ENOENT
        if status == 409:
            if "already occupies" in message or "already exists" in message:
                return errno.EEXIST
            if "not empty" in message:
                return errno.ENOTEMPTY
            # A write raced another writer ("version changed") or lock contention outlived its retries.
            return errno.EPERM
        if status == 413:
            return errno.EFBIG
        return errno.EIO

    def errno_for_failure(self, error):
        """The errno to answer for any OSError: FilesApi already put the mapped errno on it; anything else is EIO."""
        status = getattr(error, "status", None)
        if isinstance(status, int) and not isinstance(error.errno, int):
            return self.errno_for(status, getattr(error, "detail", None))
        return error.errno if isinstance(error.errno, int) and error.errno > 0 else errno.EIO


HTTP_ERRNO = HttpErrno()


def _mtime_ms(value):
    try:
        return int(datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return int(time.time() * 1000)


class FilesApi:
    def __init__(self, base_url: str, token_file: str, actor_resolver=None):
        self.base_url = base_url.rstrip("/")
        self.token_file = token_file
        self.actor_resolver = actor_resolver
        self.max_wait_seconds = MAX_WAIT_SECONDS
        self.http = urllib3.PoolManager(num_pools=4, maxsize=64, block=True)
        # Network waits must not consume Trio's shared worker pool: local spool/handle
        # bookkeeping and actor lookups remain schedulable during a Files outage.
        self.network_limiter = trio.CapacityLimiter(NETWORK_THREAD_LIMIT)
        self._last_auth_retry_log = 0.0

    def _token(self):
        try:
            descriptor = os.open(self.token_file, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError as error:
            failure = OSError(errno.EACCES, "Files mount capability is not ready")
            failure.transient_auth = True
            raise failure from error
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                raise OSError(errno.EACCES, "Files mount capability file is not private")
            token = os.read(descriptor, MAX_TOKEN_BYTES + 1).strip()
        finally:
            os.close(descriptor)
        if not token or len(token) > MAX_TOKEN_BYTES:
            failure = OSError(errno.EACCES, "Files mount capability is invalid")
            failure.transient_auth = True
            raise failure
        return token.decode("ascii")

    def _request(self, path: str, method="GET", body=None, headers=None, idempotent=None, sink=None):
        """Send one Files request with bounded retries.

        `idempotent` marks a POST the caller can safely repeat (create/mkdir reconcile a
        replayed success themselves); GET/HEAD/PUT/DELETE are idempotent by method. A failure
        raised after an ambiguous attempt carries `after_retry=True` so callers can reconcile.
        """
        started = time.monotonic()
        deadline = started + self.max_wait_seconds
        stats["requests"] += 1
        outcome = {"status": None, "bytes": 0, "error": None}
        repeatable = method in IDEMPOTENT_RETRY_METHODS if idempotent is None else idempotent
        try:
            attempt = 0
            transient_attempts = 0
            auth_retry_started = None
            auth_attempts = 0
            last_transient_error = None
            # True once an earlier attempt may have reached Files (a sent request whose outcome is unknown).
            ambiguous_attempts = False
            while True:
                if last_transient_error is not None and time.monotonic() >= deadline:
                    raise last_transient_error
                try:
                    if sink is not None:
                        sink.seek(0)
                        sink.truncate(0)
                    remaining = max(0.01, deadline - time.monotonic())
                    result = self._send(path, method, body, headers, timeout_seconds=remaining) if sink is None else self._send(path, method, body, headers, sink=sink, timeout_seconds=remaining)
                    outcome["status"] = result[0]
                    outcome["bytes"] = sink.tell() if sink is not None else len(result[2])
                    return result
                except OSError as error:
                    if getattr(error, "transient_auth", False) or getattr(error, "status", None) == 401 or getattr(error, "transient", False) or getattr(error, "status", None) in TRANSIENT_STATUSES:
                        last_transient_error = error
                    if getattr(error, "status", None) == 401 or getattr(error, "transient_auth", False):
                        auth_retry_started = time.monotonic() if auth_retry_started is None else auth_retry_started
                        elapsed = time.monotonic() - auth_retry_started
                        if time.monotonic() < deadline:
                            auth_attempts += 1
                            now = time.monotonic()
                            if now - self._last_auth_retry_log >= 1:
                                self._last_auth_retry_log = now
                                emit("files-auth-retry", logging.WARNING, method=method, path=path.split("?", 1)[0], attempt=auth_attempts, elapsed=round(elapsed, 1))
                            time.sleep(min(max(0, deadline - time.monotonic()), 2.0, 0.25 * (2 ** min(auth_attempts - 1, 3))))
                            continue
                    if ambiguous_attempts:
                        error.after_retry = True
                    detail = getattr(error, "detail", None) or {}
                    transient_conflict = getattr(error, "status", None) == 409 and (
                        "concurrently or are busy" in detail.get("error", "").lower()
                        or "serialization failure" in detail.get("error", "").lower()
                    )
                    transient_transport = getattr(error, "transient", False)
                    transient_status = getattr(error, "status", None) in TRANSIENT_STATUSES
                    # A connect-phase failure (not_sent) never reached Files, so every method may retry it.
                    not_sent = getattr(error, "not_sent", False)
                    if (transient_transport or transient_status) and (repeatable or not_sent) and time.monotonic() < deadline:
                        transient_attempts += 1
                        ambiguous_attempts = ambiguous_attempts or not not_sent
                        retry_after = getattr(error, "retry_after", None)
                        delay = max(0, retry_after) if retry_after is not None else min(5.0, 0.1 * (2 ** min(transient_attempts - 1, 6)))
                        time.sleep(min(max(0, deadline - time.monotonic()), delay + random.uniform(0, 0.05)))
                        continue
                    if not transient_conflict:
                        raise
                    if attempt < MAX_CONFLICT_RETRIES:
                        attempt += 1
                        time.sleep(min(0.4, 0.05 * (2 ** (attempt - 1))) + random.uniform(0, 0.05))
                        continue
                    # Files' own SERIALIZABLE-conflict retries were exhausted too: this is
                    # still transient DB contention, not a permission denial, so give agents
                    # a retryable errno instead of EPERM ("Operation not permitted").
                    busy = OSError(errno.EBUSY, str(error))
                    busy.status, busy.detail = error.status, error.detail
                    raise busy from error
        except OSError as error:
            stats["requestErrors"] += 1
            outcome["status"] = getattr(error, "status", None)
            outcome["error"] = True
            outcome["code"] = (getattr(error, "detail", None) or {}).get("code")
            outcome["errno"] = error.errno
            outcome["failure"] = type(error).__name__
            raise
        finally:
            elapsed = time.monotonic() - started
            slow = elapsed >= SLOW_REQUEST_SECONDS
            if slow: stats["slowRequests"] += 1
            # A 404 is how a stat/lookup learns a path does not exist yet (every create starts with one).
            expected_miss = outcome["error"] and outcome.get("errno") == errno.ENOENT
            level = logging.DEBUG if expected_miss and not slow else logging.WARNING if outcome["error"] and not expected_miss else logging.INFO if slow else logging.DEBUG
            if log.isEnabledFor(level):
                emit("files-request", level, method=method, path=path.split("?", 1)[0], status=outcome["status"],
                     ms=round(elapsed * 1000, 1), sent=len(body) if body is not None else 0, received=outcome["bytes"], actor=request_actor.get(),
                     slow=slow or None, failure=outcome.get("failure"), errno=outcome.get("errno"), code=outcome.get("code"))

    def _send(self, path, method, body, headers, sink=None, timeout_seconds=None):
        timeout_seconds = timeout_seconds or self.max_wait_seconds
        try:
            response = self.http.request(
                method, f"{self.base_url}{path}", body=body,
                headers={"Authorization": f"Bearer {self._token()}", **({"X-Sulla-Actor": request_actor.get()} if request_actor.get() else {}), **(headers or {})},
                timeout=urllib3.Timeout(total=timeout_seconds, connect=min(5.0, timeout_seconds), read=min(timeout_seconds, 120.0 if method == "PUT" else 15.0)),
                retries=False, preload_content=False,
            )
            try:
                if response.status >= 400 and response.status != 304:
                    payload = response.read(MAX_RESPONSE_BYTES + 1)
                    try:
                        detail = json.loads(payload or b"{}")
                    except json.JSONDecodeError:
                        detail = {}
                    if not isinstance(detail, dict):
                        detail = {}
                    failure = OSError(HTTP_ERRNO.errno_for(response.status, detail), detail.get("error", f"Files HTTP {response.status}"))
                    failure.status = response.status
                    failure.detail = detail
                    try:
                        failure.retry_after = float(response.headers.get("Retry-After")) if response.headers.get("Retry-After") else None
                    except (TypeError, ValueError):
                        failure.retry_after = None
                    raise failure
                length = response.headers.get("Content-Length")
                limit = MAX_FILE_BYTES if sink is not None else MAX_RESPONSE_BYTES
                if length and int(length) > limit:
                    raise OSError(errno.EFBIG, "Files response exceeds the mount limit")
                if sink is not None:
                    received = 0
                    for chunk in response.stream(STREAM_CHUNK_BYTES, decode_content=False):
                        received += len(chunk)
                        if received > MAX_FILE_BYTES:
                            raise OSError(errno.EFBIG, "Files response exceeds the mount limit")
                        sink.write(chunk)
                    return response.status, dict(response.headers), b""
                payload = response.read(MAX_RESPONSE_BYTES + 1)
                if len(payload) > MAX_RESPONSE_BYTES:
                    raise OSError(errno.EFBIG, "Files response exceeds the mount limit")
                return response.status, dict(response.headers), payload
            finally:
                response.release_conn()
        except OSError:
            raise
        except urllib3.exceptions.HTTPError as error:
            failure = OSError(errno.EIO, "Files service unavailable")
            failure.transient = isinstance(error, (urllib3.exceptions.TimeoutError, urllib3.exceptions.NewConnectionError, urllib3.exceptions.ProtocolError))
            # Connect-phase failures (refused, unreachable, connect timeout) happen before any request byte leaves,
            # so the request was never sent. A read timeout or reset may have reached Files: not_sent stays unset.
            failure.not_sent = isinstance(error, (urllib3.exceptions.ConnectTimeoutError, urllib3.exceptions.NewConnectionError))
            raise failure from error

    async def directory_page(self, collection_id, path, cursor=None, etag=None):
        query = {"path": path, "limit": DIRECTORY_PAGE_SIZE}
        if collection_id: query["collectionId"] = collection_id
        if cursor: query["cursor"] = cursor
        headers = {"If-None-Match": etag} if etag and not cursor else None
        status, response_headers, body = await trio.to_thread.run_sync(
            self._request, f"/v1/fuse/directory?{urllib.parse.urlencode(query)}", "GET", None, headers, limiter=self.network_limiter)
        return (None if status == 304 else json.loads(body)), response_headers.get("ETag", etag)

    async def changes(self, collection_id, revision):
        query = urllib.parse.urlencode({"collectionId": collection_id, "since": revision})
        _, _, body = await trio.to_thread.run_sync(self._request, f"/v1/fuse/changes?{query}", limiter=self.network_limiter)
        return json.loads(body)

    async def entry(self, collection_id, path):
        values = {"path": path}
        if collection_id: values["collectionId"] = collection_id
        query = urllib.parse.urlencode(values)
        _, _, body = await trio.to_thread.run_sync(self._request, f"/v1/fuse/entry?{query}", limiter=self.network_limiter)
        return json.loads(body)

    def _read_to_file_sync(self, file_id, file):
        with TRANSFER_SEMAPHORE:
            _, headers, _ = self._request(f"/v1/fuse/files/{file_id}/content", sink=file)
        # FUSE reads use os.pread on fileno(), bypassing BufferedRandom's Python buffer.
        # Flush here so every caller (including merge-after-write) sees the complete stream.
        file.flush()
        return headers.get("ETag", "").strip('"'), headers.get("X-Sulla-Source-Hash", "")

    async def read_to_file(self, file_id, file):
        return await trio.to_thread.run_sync(self._read_to_file_sync, file_id, file, limiter=self.network_limiter)

    def _write_sync(self, file_id, file, size, version_id, source_hash):
        # The content hash lets Files recognise a retried PUT whose first attempt already committed.
        headers = {"Content-Type": "application/octet-stream", "If-Match": f'"{version_id}"', "X-Sulla-Source-Hash": source_hash,
                   "X-Sulla-Content-Hash": _spool_sha256(file, size)}
        if size > STREAMING_WRITE_THRESHOLD:
            body = FileBody(file.fileno(), size)
            headers["Content-Length"] = str(size)
            path = f"/v1/fuse/files/{file_id}/content/stream"
        else:
            body = os.pread(file.fileno(), size, 0)
            path = f"/v1/fuse/files/{file_id}/content"
        with TRANSFER_SEMAPHORE:
            _, response_headers, payload = self._request(path, "PUT", body, headers)
        return json.loads(payload), response_headers.get("X-Sulla-Merged") == "1"

    async def write(self, file_id, file, size, version_id, source_hash):
        if size > MAX_FILE_BYTES:
            raise OSError(errno.EFBIG, "Files write exceeds the mount limit")
        return await trio.to_thread.run_sync(self._write_sync, file_id, file, size, version_id, source_hash, limiter=self.network_limiter)

    async def replace(self, target_id, source_id):
        body = json.dumps({"sourceFileId": source_id}).encode()
        _, _, payload = await trio.to_thread.run_sync(self._request, f"/v1/fuse/files/{target_id}/replace", "POST", body, {"Content-Type":"application/json"}, limiter=self.network_limiter)
        return json.loads(payload or b"{}")

    async def metadata(self, collection_id, path):
        query = urllib.parse.urlencode({"collectionId": collection_id, "path": path})
        _, _, body = await trio.to_thread.run_sync(self._request, f"/v1/fuse/metadata?{query}", limiter=self.network_limiter)
        return json.loads(body)

    async def folder_metadata(self, collection_id, path):
        query = urllib.parse.urlencode({"collectionId": collection_id, "path": path})
        _, _, body = await trio.to_thread.run_sync(self._request, f"/v1/fuse/folder-metadata?{query}", limiter=self.network_limiter)
        return json.loads(body)

    async def put_metadata(self, collection_id, path, set_values, unset, revision=None):
        value = {"collectionId": collection_id, "path": path, "set": set_values, "unset": unset}
        if revision is not None: value["baseRevision"] = revision
        body = json.dumps(value).encode()
        _, _, payload = await trio.to_thread.run_sync(self._request, "/v1/fuse/metadata", "PUT", body, {"Content-Type":"application/json"}, limiter=self.network_limiter)
        return json.loads(payload)

    def _create_sync(self, collection_id, path):
        query = urllib.parse.urlencode({"collectionId": collection_id, "path": path})
        try:
            _, _, body = self._request(f"/v1/fuse/files?{query}", "POST", b"", {"Content-Type":"application/octet-stream"}, idempotent=True)
            return json.loads(body)
        except OSError as error:
            # The first attempt committed but its reply was lost: the retry finds the empty file it made.
            if error.errno != errno.EEXIST or not getattr(error, "after_retry", False):
                raise
            entry_query = urllib.parse.urlencode({"collectionId": collection_id, "path": path})
            _, _, body = self._request(f"/v1/fuse/entry?{entry_query}")
            row = json.loads(body)
            if row.get("kind") != "file" or int(row.get("size") or 0) != 0:
                raise
            return {**row, "current_version_id": row.get("versionId")}

    async def create(self, collection_id, path):
        return await trio.to_thread.run_sync(self._create_sync, collection_id, path, limiter=self.network_limiter)

    async def rename(self, file_id, collection_id, path):
        body = json.dumps({"path": path, "targetCollectionId": collection_id}).encode()
        await trio.to_thread.run_sync(self._request, f"/v1/fuse/files/{file_id}", "PATCH", body, {"Content-Type":"application/json"}, limiter=self.network_limiter)

    async def rename_folder(self, collection_id, path, target_collection_id, target_path):
        body = json.dumps({"collectionId": collection_id, "path": path,
                           "targetCollectionId": target_collection_id, "targetPath": target_path}).encode()
        await trio.to_thread.run_sync(self._request, "/v1/fuse/folders", "PATCH", body, {"Content-Type":"application/json"}, limiter=self.network_limiter)

    async def delete(self, file_id):
        await trio.to_thread.run_sync(self._request, f"/v1/fuse/files/{file_id}", "DELETE", limiter=self.network_limiter)

    def _mkdir_sync(self, collection_id, path):
        body = json.dumps({"collectionId":collection_id,"path":path}).encode()
        # Creating a folder that exists is a no-op on the server, so a replay is safe.
        self._request("/v1/fuse/folders", "POST", body, {"Content-Type":"application/json"}, idempotent=True)

    async def mkdir(self, collection_id, path):
        await trio.to_thread.run_sync(self._mkdir_sync, collection_id, path, limiter=self.network_limiter)

    async def rmdir(self, collection_id, path):
        query = urllib.parse.urlencode({"collectionId":collection_id,"path":path})
        await trio.to_thread.run_sync(self._request, f"/v1/fuse/folders?{query}", "DELETE", limiter=self.network_limiter)


class SullaFiles(pyfuse3.Operations):
    enable_writeback_cache = False

    def __init__(self, api: FilesApi):
        super().__init__()
        self.api = api
        self.next_inode = pyfuse3.ROOT_INODE + 1
        self.nodes = {pyfuse3.ROOT_INODE: {"path": "", "directory": True}}
        self.path_inode = OrderedDict({"": pyfuse3.ROOT_INODE})
        self.children = OrderedDict()
        self.handles = {}
        self.next_handle = 1
        self.uid = 0
        self.gid = 0
        self.directory_etags = {}
        self.directory_complete = set()
        self.node_limit = MAX_CACHED_NODES
        self.snapshot_at = 0.0
        self.metadata_cache = {}
        self.feed_healthy = False
        self.feed_revisions = {}
        self.mounted_collections = set()
        self.feed_failures = 0
        self.pending_invalidations = OrderedDict()
        self.pending_tree_reset = False
        self.read_cache = None
        self.read_cache_disabled = False

    def _cache(self):
        if self.read_cache is None and not self.read_cache_disabled:
            try:
                self.read_cache = ContentReadCache(SPOOL_DIR, READ_CACHE_MAX_BYTES)
            except OSError as error:
                self.read_cache_disabled = True
                emit("read-cache-disabled", logging.WARNING, error=str(error))
        return self.read_cache

    def queue_invalidation(self, path):
        """Queue request-handler mutations; pyfuse3 invalidation runs only in the background poller."""
        if path:
            self.pending_invalidations[path] = None

    def invalidate_path(self, path):
        """Invalidate a path from the background task, never from a FUSE request handler."""
        inode = self.path_inode.get(path)
        if inode is not None:
            try: pyfuse3.invalidate_inode(inode, attr_only=False)
            except Exception: pass
        parent, name = os.path.split(path)
        parent_inode = self.path_inode.get(parent)
        if parent_inode is not None and name:
            try: pyfuse3.invalidate_entry(parent_inode, os.fsencode(name))
            except Exception: pass
        self.directory_complete.discard(parent)
        self.directory_etags.pop(parent, None)
        # The kernel will look the name up again. Keep the inode stable for in-flight FUSE ops;
        # _resolve refreshes this row from Files before returning it.
        for cached, cached_inode in tuple(self.path_inode.items()):
            if cached == path or cached.startswith(path + "/"):
                node = self.nodes.get(cached_inode)
                if node is not None: node["stale"] = True

    def consume_change_page(self, result):
        """Queue path events, reserving whole-tree invalidation for an explicit cursor reset."""
        if result.get("reset"):
            self.pending_tree_reset = True
            return
        for change in result.get("changes", []):
            for path in (change.get("path"), change.get("oldPath")):
                if path: self.queue_invalidation(path)

    def invalidate_tree(self):
        for inode in tuple(self.nodes):
            try: pyfuse3.invalidate_inode(inode, attr_only=False)
            except (AttributeError, RuntimeError): pass
        for parent, children in tuple(self.children.items()):
            parent_inode = self.path_inode.get(parent)
            if parent_inode is None: continue
            for name in tuple(children):
                try: pyfuse3.invalidate_entry(parent_inode, os.fsencode(name))
                except Exception: pass
        self.directory_complete.clear()
        self.directory_etags.clear()
        for inode, node in tuple(self.nodes.items()):
            if inode != pyfuse3.ROOT_INODE and not node.get("collectionRoot"):
                node["stale"] = True

    async def follow_changes(self):
        """Long-lived background poller; never runs inside a FUSE request handler."""
        while True:
            roots = [(node.get("collectionId"), path) for path, inode in tuple(self.path_inode.items())
                     if (node := self.nodes.get(inode)) and node.get("collectionRoot") and node.get("collectionId")]
            self.mounted_collections.update(collection_id for collection_id, _ in roots)
            try:
                for collection_id in tuple(self.mounted_collections):
                    since = self.feed_revisions.get(collection_id, "")
                    while True:
                        result = await self.api.changes(collection_id, since)
                        self.consume_change_page(result)
                        since = str(result.get("cursor", since))
                        self.feed_revisions[collection_id] = since
                        if not result.get("more"): break
                self.feed_healthy = bool(self.mounted_collections)
                self.feed_failures = 0
                await trio.sleep(CHANGE_POLL_SECONDS)
            except (OSError, ValueError, KeyError, TypeError) as error:
                self.feed_healthy = False
                self.feed_failures += 1
                emit("change-feed-unhealthy", logging.WARNING, error=str(error))
                await trio.sleep(min(30.0, CHANGE_POLL_SECONDS * (2 ** min(self.feed_failures, 5))))

    async def invalidation_worker(self):
        """Apply queued invalidations outside request handlers, independent of network delays."""
        while True:
            if self.pending_tree_reset:
                self.pending_tree_reset = False
                self.pending_invalidations.clear()
                self.invalidate_tree()
            else:
                for path in tuple(self.pending_invalidations):
                    self.pending_invalidations.pop(path, None)
                    self.invalidate_path(path)
            await trio.sleep(0.05)

    def _describe(self, describe, args):
        try:
            return describe(self, args) if describe else {}
        except Exception:  # Logging must never break the operation it describes.
            return {}

    def _inode_info(self, inode, ctx=None):
        return {"path": (self.nodes.get(inode) or {}).get("path"), "inode": inode, "pid": getattr(ctx, "pid", None)}

    def _child_info(self, parent_inode, name, ctx=None):
        parent = (self.nodes.get(parent_inode) or {}).get("path", "")
        return {"path": "/".join(filter(None, [parent, os.fsdecode(name)])), "pid": getattr(ctx, "pid", None)}

    def _handle_info(self, fh):
        handle = self.handles.get(fh) or {}
        return {"path": (self.nodes.get(handle.get("inode")) or {}).get("path"), "fh": fh, "actor": handle.get("actor"),
                "dirty": handle.get("dirty"), "size": handle.get("size")}

    async def _actor(self, ctx):
        return await self.api.actor_resolver.resolve(ctx.pid) if self.api.actor_resolver and ctx else None

    async def _as_actor(self, actor, awaitable):
        token = request_actor.set(actor)
        try:
            return await awaitable
        finally:
            request_actor.reset(token)

    async def refresh(self, force=False):
        """Legacy startup hook; directory contents are deliberately loaded on demand."""
        return

    def _touch_node(self, inode):
        node = self.nodes.get(inode)
        if node is not None and inode != pyfuse3.ROOT_INODE:
            self.path_inode.move_to_end(node["path"])
            self._evict_nodes()
        return node

    def _evict_nodes(self):
        skipped = 0
        while len(self.path_inode) > self.node_limit + 1 and skipped < len(self.path_inode):
            path, inode = next(iter(self.path_inode.items()))
            if inode == pyfuse3.ROOT_INODE or any(handle.get("inode") == inode for handle in self.handles.values()):
                self.path_inode.move_to_end(path)
                skipped += 1
                continue
            self._forget(path)
            skipped = 0

    async def _resolve(self, parent_inode, name):
        parent = self.nodes.get(parent_inode)
        if not parent or not parent.get("directory"):
            raise pyfuse3.FUSEError(errno.ENOENT)
        name = os.fsdecode(name)
        path = "/".join(filter(None, [parent["path"], name]))
        inode = self.path_inode.get(path)
        cached_node = self.nodes.get(inode) if inode is not None else None
        if inode is not None and cached_node is not None and not cached_node.get("stale"):
            return inode
        collection_id = parent.get("collectionId")
        try:
            row = await self.api.entry(collection_id, self._files_path(path, collection_id) if collection_id else path)
            collection_id = collection_id or row.get("collection_id") or row.get("collectionId")
            if collection_id and parent_inode == pyfuse3.ROOT_INODE:
                parent["collectionId"] = collection_id
                self.nodes[pyfuse3.ROOT_INODE]["collectionId"] = collection_id
        except OSError as error:
            if getattr(error, "status", None) == 404 or error.errno == errno.ENOENT:
                if inode is not None: self._forget_subtree(path)
                raise pyfuse3.FUSEError(errno.ENOENT) from error
            raise
        if not collection_id:
            raise pyfuse3.FUSEError(errno.ENOENT)
        if inode is None or cached_node is None:
            inode = self._node(path, row.get("kind") == "directory")
        elif cached_node.get("versionId") != row.get("versionId"):
            cached_node.pop("sourceHash", None)
        self.nodes[inode]["directory"] = row.get("kind") == "directory"
        self.nodes[inode].update({**row, "path": path, "filesPath": self._files_path(path, collection_id), "collectionId": collection_id,
                                  "mtimeMs": _mtime_ms(row.get("updated_at")), "stale": False})
        return inode

    def _node(self, path, directory):
        inode = self.path_inode.get(path)
        if inode is None:
            inode = self.next_inode
            self.next_inode += 1
            self.path_inode[path] = inode
            self.nodes[inode] = {"path": path, "directory": directory}
            self.children.setdefault(os.path.dirname(path), OrderedDict())[os.path.basename(path)] = inode
        self.path_inode.move_to_end(path)
        self._evict_nodes()
        return inode

    def _forget(self, path):
        inode = self.path_inode.pop(path, None)
        self.nodes.pop(inode, None)
        self.children.pop(path, None)
        self.directory_etags.pop(path, None)
        self.directory_complete.discard(path)
        siblings = self.children.get(os.path.dirname(path))
        if siblings is not None:
            siblings.pop(os.path.basename(path), None)

    def _forget_subtree(self, path):
        """Stop resolving `path` (and anything cached under it) from the cache."""
        for cached in [key for key in self.path_inode if key == path or key.startswith(path + "/")]:
            inode = self.path_inode.get(cached)
            if any(handle.get("inode") == inode for handle in self.handles.values()):
                # An open handle still commits through this inode: drop only the path mapping.
                self.path_inode.pop(cached, None)
                siblings = self.children.get(os.path.dirname(cached))
                if siblings is not None:
                    siblings.pop(os.path.basename(cached), None)
            else:
                self._forget(cached)

    def _move_cached_path(self, old_path, new_path, collection_id):
        """Re-key a renamed entry (and, for a folder, everything cached under it) to its new path.

        Without this the old path kept resolving to the moved file's inode and Files id: after
        `mv c d`, `[ -e c ]` was true and `rm c` deleted d (iMac soak, 2026-11-17).
        """
        moved = [key for key in self.path_inode if key == old_path or key.startswith(old_path + "/")]
        if not moved:
            return
        self._forget_subtree(new_path)
        for key in moved:
            target = new_path + key[len(old_path):]
            inode = self.path_inode.pop(key)
            self.path_inode[target] = inode
            node = self.nodes.get(inode)
            if node is not None:
                node["path"] = target
                if not node.get("collectionRoot"):
                    node["collectionId"] = collection_id
                    node["filesPath"] = self._files_path(target, collection_id)
            if key in self.children:
                self.children[target] = self.children.pop(key)
            self.directory_etags.pop(key, None)
            self.directory_complete.discard(key)
        siblings = self.children.get(os.path.dirname(old_path))
        inode = siblings.pop(os.path.basename(old_path), None) if siblings is not None else None
        if inode is None:
            inode = self.path_inode.get(new_path)
        self.children.setdefault(os.path.dirname(new_path), OrderedDict())[os.path.basename(new_path)] = inode

    def _attrs(self, inode):
        node = self.nodes.get(inode)
        if node is None:
            raise pyfuse3.FUSEError(errno.ENOENT)
        attrs = pyfuse3.EntryAttributes()
        attrs.st_ino = inode
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
        timeout = ATTR_TIMEOUT_SECONDS if getattr(self, "feed_healthy", False) else 0.0
        attrs.entry_timeout = timeout
        attrs.attr_timeout = timeout
        return attrs

    @traced("getattr", lambda s, a: s._inode_info(a[0], a[-1]))
    async def getattr(self, inode, ctx=None):
        if inode not in self.nodes:
            raise pyfuse3.FUSEError(errno.ENOENT)
        return self._attrs(inode)

    @traced("lookup", lambda s, a: s._child_info(a[0], a[1], a[-1]))
    async def lookup(self, parent_inode, name, ctx=None):
        try:
            inode = await self._resolve(parent_inode, name)
        except OSError as error:
            raise pyfuse3.FUSEError(error.errno) from error
        return self._attrs(inode)

    @traced("opendir", lambda s, a: s._inode_info(a[0], a[-1]))
    async def opendir(self, inode, ctx):
        if not self.nodes.get(inode, {}).get("directory"):
            raise pyfuse3.FUSEError(errno.ENOTDIR)
        return inode

    @traced("readdir", lambda s, a: s._inode_info(a[0]))
    async def readdir(self, fh, start_id, token):
        directory = self.nodes.get(fh)
        if not directory:
            raise pyfuse3.FUSEError(errno.ENOENT)
        try:
            await self._list_directory(fh, directory, start_id, token)
        except OSError as error:
            if fh != pyfuse3.ROOT_INODE or isinstance(error, pyfuse3.FUSEError):
                raise
            # The root must always list: Desktop agents probe the compatibility symlink with `ls -A /mnt/sulla-files` and
            # recreates the adapter when it fails, so an error here became a restart loop. Answer an
            # empty (or partial) root, log why, and list again on the next readdir.
            self.directory_complete.discard(directory["path"])
            self.directory_etags.pop(directory["path"], None)
            stats["opErrors"] += 1
            emit("root-listing-failed", logging.ERROR, errno=_errno_name(HTTP_ERRNO.errno_for_failure(error)),
                 status=getattr(error, "status", None), code=(getattr(error, "detail", None) or {}).get("code"), error=str(error))

    async def _list_directory(self, fh, directory, start_id, token):
        directory_path = directory["path"]
        collection_id = directory.get("collectionId")
        children = self.children.get(directory_path, {})
        marker = self.directory_etags.get(directory_path)
        if directory_path in self.directory_complete and marker:
            page, _ = await self.api.directory_page(collection_id, self._files_path(directory_path, collection_id), etag=marker)
            if page is None:
                for index, (name, inode) in enumerate(sorted(children.items()), start=1):
                    if index > start_id and not pyfuse3.readdir_reply(token, os.fsencode(name), self._attrs(inode), index):
                        break
                return
        # A changed or uncached directory is streamed in bounded keyset pages.
        # Inodes must stay stable across a refresh: a process may hold a child directory as its cwd
        # or an open path, and forgetting it here made its next operation fail with ENOENT
        # ("nonexistent directory") whenever anything re-listed the parent (health probes, agents).
        # Only names that are gone after a complete listing are pruned, below.
        old_names = set(children)
        seen_names = set()
        listed_fully = False
        cursor = None
        absolute_index = 0
        total = 0
        while True:
            page, marker = await self.api.directory_page(collection_id,
                self._files_path(directory_path, collection_id) if collection_id else "", cursor)
            if page is None:
                break
            if page.get("rootCollectionId"):
                collection_id = page["rootCollectionId"]
                directory["collectionId"] = collection_id
                self.nodes[pyfuse3.ROOT_INODE]["collectionId"] = collection_id
            self.directory_etags[directory_path] = marker
            for row in page["entries"]:
                total += 1
                name = row["path"].rsplit("/", 1)[-1]
                full_path = "/".join(filter(None, [directory_path, name]))
                seen_names.add(name)
                inode = self._node(full_path, row["kind"] == "directory")
                self.nodes[inode].update({**row, "path": full_path, "filesPath": row.get("path", ""),
                    "collectionId": collection_id, "mtimeMs": _mtime_ms(row.get("updated_at"))})
                absolute_index += 1
                if absolute_index > start_id and not pyfuse3.readdir_reply(token, os.fsencode(name), self._attrs(inode), absolute_index):
                    self.directory_complete.discard(directory_path)
                    return
            cursor = page.get("nextCursor")
            if not cursor:
                listed_fully = True
                break
        # Only a fully received listing proves a name is gone (not a 304, not a partial reply).
        if listed_fully:
            for gone in old_names - seen_names:
                self._forget("/".join(filter(None, [directory_path, gone])))
        if total <= MAX_CACHED_NODES and len(self.children.get(directory_path, {})) == total:
            self.directory_complete.add(directory_path)
        else:
            self.directory_complete.discard(directory_path)

    @traced("open", lambda s, a: s._inode_info(a[0], a[-1]))
    async def open(self, inode, flags, ctx):
        node = self.nodes.get(inode)
        if not node or node["directory"]:
            raise pyfuse3.FUSEError(errno.EISDIR)
        if len(self.handles) >= MAX_OPEN_HANDLES:
            raise pyfuse3.FUSEError(errno.EMFILE)
        try:
            if node.get("virtualMetadata"):
                current = await self._get_folder_metadata(node["collectionId"], node["filesPath"])
                data = self._render_folder_metadata(node, current)
                version_id, source_hash = str(current.get("revision", "")), ""
            else:
                # The change feed is an optimization, never the source of truth for an
                # immutable content-cache key: a missed event must not serve old bytes.
                current_entry = await self.api.entry(node["collectionId"], node["filesPath"])
                fresh_version = str(current_entry.get("versionId") or current_entry.get("current_version_id") or "")
                old_version = str(node.get("versionId") or node.get("current_version_id") or "")
                if fresh_version != old_version:
                    node.pop("pageCacheVersion", None)
                    node["versionId"] = fresh_version
                    node["size"] = int(current_entry.get("size") or 0)
                temporary = tempfile.TemporaryFile(mode="w+b", dir=SPOOL_DIR)
                try:
                    version_id = str(node.get("versionId") or node.get("current_version_id") or "")
                    source_hash = str(node.get("sourceHash") or "")
                    cache = self._cache()
                    if not cache or not cache.get(version_id, source_hash, int(node.get("size", 0)), temporary):
                        version_id, source_hash = await self.api.read_to_file(node["id"], temporary)
                        try:
                            cache = self._cache()
                            if cache: cache.put(version_id, source_hash, temporary, temporary.tell())
                        except OSError as error: emit("read-cache-write-failed", logging.WARNING, error=str(error))
                    node["versionId"], node["sourceHash"] = version_id, source_hash
                except BaseException:
                    temporary.close()
                    raise
                temporary.flush()
                data = None
        except OSError as error:
            raise pyfuse3.FUSEError(error.errno) from error
        return await self._open_handle(inode, flags, ctx, data, version_id, source_hash, current if node.get("virtualMetadata") else None, temporary if not node.get("virtualMetadata") else None)

    async def _open_handle(self, inode, flags, ctx, data, version_id, source_hash, metadata=None, temporary=None):
        node = self.nodes[inode]
        handle = self.next_handle
        self.next_handle += 1
        temporary = temporary or tempfile.TemporaryFile(mode="w+b", dir=SPOOL_DIR)
        if data is not None: temporary.write(data)
        temporary.flush()
        self.handles[handle] = {
            "inode": inode, "fileId": node.get("id"), "file": temporary, "size": temporary.tell() if data is None else len(data),
            "versionId": version_id, "sourceHash": source_hash, "dirty": False, "failedErrno": None,
            "append": bool(flags & os.O_APPEND),
            "metadata": metadata,
            "actor": await self._actor(ctx),
        }
        if flags & os.O_TRUNC:
            had_content = self.handles[handle]["size"] > 0
            os.ftruncate(temporary.fileno(), 0)
            self.handles[handle]["size"] = 0
            # Truncating a file that is already empty changes nothing. Marking it dirty made every
            # `echo > newfile` upload an empty "update" version before the real content.
            self.handles[handle]["dirty"] = had_content
            # A shell redirection may flush immediately after O_TRUNC, before its first write.
            # Keep that empty intermediate state from becoming a spurious version.
            self.handles[handle]["truncateOnly"] = had_content
        info = pyfuse3.FileInfo(fh=handle)
        writable = bool(flags & (os.O_WRONLY | os.O_RDWR))
        # Read-only opens may use kernel page cache only while push invalidation is healthy.
        info.keep_cache = bool(not writable and self.feed_healthy and version_id and node.get("pageCacheVersion") == version_id)
        if not writable and version_id:
            node["pageCacheVersion"] = version_id
        info.direct_io = not info.keep_cache
        return info

    def _render_folder_metadata(self, node, current):
        folder = dict(current.get("folder") or {})
        description = folder.pop("description", "")
        naming_hint = folder.pop("naming_hint", "")
        ordered = {"description": description, "naming_hint": naming_hint, **folder,
                   "files": current.get("files") or {}}
        dumped = yaml.safe_dump(ordered, sort_keys=False, allow_unicode=True)
        dumped = dumped.replace("description: ''", "# REQUIRED: what is this folder for?\ndescription: ''", 1)
        display = "/".join(filter(None, [self._collection_name(node["collectionId"]), node["filesPath"]]))
        return (METADATA_HEADER.format(path=display) + dumped).encode()

    async def _get_folder_metadata(self, collection_id, path):
        key = ("folder", collection_id, path)
        if key not in self.metadata_cache:
            self.metadata_cache[key] = await self.api.folder_metadata(collection_id, path)
        return self.metadata_cache[key]

    async def _get_metadata(self, collection_id, path):
        key = ("entry", collection_id, path)
        if key not in self.metadata_cache:
            self.metadata_cache[key] = await self.api.metadata(collection_id, path)
        return self.metadata_cache[key]

    def _invalidate_metadata(self, collection_id, path):
        self.metadata_cache.pop(("entry", collection_id, path), None)
        self.metadata_cache.pop(("folder", collection_id, os.path.dirname(path)), None)
        self.metadata_cache.pop(("folder", collection_id, path), None)

    def _collection_name(self, collection_id):
        root = next((value for value in self.nodes.values() if value.get("collectionRoot") and value.get("collectionId") == collection_id), None)
        return (root or {}).get("path", "").split("/", 1)[0]

    async def _commit_metadata(self, handle, node, data):
        try:
            if hasattr(data, "seek"):
                data.seek(0)
            parsed = yaml.safe_load(data) or {}
            if not isinstance(parsed, dict) or not isinstance(parsed.get("files", {}), dict):
                raise ValueError("metadata document must be a mapping and files must be a mapping")
        except (UnicodeDecodeError, yaml.YAMLError, ValueError) as error:
            log.error("Invalid %s: %s", METADATA_NAME, error)
            raise pyfuse3.FUSEError(errno.EINVAL) from error
        current = handle["metadata"] or {"folder": {}, "files": {}, "revision": None}
        wanted_files = parsed.pop("files", {})
        folder_before = current.get("folder") or {}
        await self._put_metadata_diff(node["collectionId"], node["filesPath"], folder_before, parsed, current.get("revision"))
        file_before = current.get("files") or {}
        for name in sorted(set(file_before) | set(wanted_files)):
            before, after = file_before.get(name) or {}, wanted_files.get(name) or {}
            if before != after:
                file_path = "/".join(filter(None, [node["filesPath"], name]))
                await self._put_metadata_diff(node["collectionId"], file_path, before, after)
        self._invalidate_metadata(node["collectionId"], node["filesPath"])
        refreshed = await self._get_folder_metadata(node["collectionId"], node["filesPath"])
        rendered = self._render_folder_metadata(node, refreshed)
        os.ftruncate(handle["file"].fileno(), 0); os.pwrite(handle["file"].fileno(), rendered, 0)
        handle.update({"metadata": refreshed, "size": len(rendered), "versionId": str(refreshed.get("revision", ""))})

    async def _put_metadata_diff(self, collection_id, path, before, after, revision=None):
        set_values = {key: value for key, value in after.items() if before.get(key) != value}
        unset = [key for key in before if key not in after]
        if set_values or unset:
            await self.api.put_metadata(collection_id, path, set_values, unset, revision)
            self._invalidate_metadata(collection_id, path)

    @traced("read", lambda s, a: s._handle_info(a[0]))
    async def read(self, fh, offset, length):
        handle = self.handles.get(fh)
        if handle is None: raise pyfuse3.FUSEError(errno.EBADF)
        return os.pread(handle["file"].fileno(), length, offset)

    @traced("write", lambda s, a: s._handle_info(a[0]))
    async def write(self, fh, offset, buf):
        handle = self.handles.get(fh)
        if handle is None: raise pyfuse3.FUSEError(errno.EBADF)
        if handle["append"]:
            offset = handle["size"]
        end = offset + len(buf)
        if end > MAX_FILE_BYTES:
            self._refuse_oversize(handle)
        if offset > handle["size"]:
            os.ftruncate(handle["file"].fileno(), end)
        written = os.pwrite(handle["file"].fileno(), buf, offset)
        if written != len(buf):
            raise pyfuse3.FUSEError(errno.EIO)
        handle["size"] = max(handle["size"], end)
        handle["dirty"] = True
        handle["truncateOnly"] = False
        if not handle.get("oversize"):
            handle["failedErrno"] = None
        return len(buf)

    def _refuse_oversize(self, handle):
        """A write past the mount limit fails the whole file, not just that chunk.

        Before, the chunk got EFBIG but the first 64 MiB stayed dirty and release() committed
        them: a 65 MB `cp` failed yet left a truncated file (or replaced a good one) in Files.
        Only an explicit truncate back under the limit makes the handle writable again.
        """
        handle["oversize"] = True
        handle["dirty"] = False
        handle["failedErrno"] = errno.EFBIG
        raise pyfuse3.FUSEError(errno.EFBIG)

    @traced("setattr", lambda s, a: s._inode_info(a[0], a[-1]), mutating=True)
    async def setattr(self, inode, attr, fields, fh, ctx):
        if fields.update_size:
            if fh is None or fh not in self.handles:
                raise pyfuse3.FUSEError(errno.EOPNOTSUPP)
            handle = self.handles[fh]
            size = int(attr.st_size)
            if size > MAX_FILE_BYTES:
                self._refuse_oversize(handle)
            os.ftruncate(handle["file"].fileno(), size)
            handle["size"] = size
            handle["dirty"] = True
            handle["truncateOnly"] = False
            handle["failedErrno"] = None
            handle["oversize"] = False
            self.nodes[inode]["size"] = size
        unsupported = fields.update_mode or fields.update_uid or fields.update_gid or fields.update_atime or fields.update_mtime
        if unsupported:
            raise pyfuse3.FUSEError(errno.EOPNOTSUPP)
        return self._attrs(inode)

    def _content_unchanged(self, handle):
        """True when the spooled bytes hash to the source hash of the version the handle opened."""
        source_hash = handle.get("sourceHash")
        if not source_hash or handle["size"] > UNCHANGED_CHECK_MAX_BYTES:
            return False
        digest = hashlib.sha256(os.pread(handle["file"].fileno(), handle["size"], 0)).hexdigest()
        return digest == str(source_hash).lower()

    async def _commit(self, fh):
        handle = self.handles[fh]
        if handle.get("oversize"):
            handle["dirty"] = False
            raise pyfuse3.FUSEError(errno.EFBIG)
        if not handle["dirty"]:
            if handle["failedErrno"]:
                raise pyfuse3.FUSEError(handle["failedErrno"])
            return
        try:
            handle["file"].flush()
            if handle["size"] > MAX_FILE_BYTES:
                raise pyfuse3.FUSEError(errno.EFBIG)
            node = self.nodes[handle["inode"]]
            if not node.get("virtualMetadata") and self._content_unchanged(handle):
                # Content equals the version it was opened from: no new version, no request.
                handle["dirty"] = False
                handle["failedErrno"] = None
                return
            if node.get("virtualMetadata"):
                data = os.pread(handle["file"].fileno(), handle["size"], 0)
                await self._as_actor(handle.get("actor"), self._commit_metadata(handle, node, data))
                result, merged = {}, False
            else:
                result, merged = await self._as_actor(handle.get("actor"), self.api.write(handle["fileId"], handle["file"], handle["size"], handle["versionId"], handle["sourceHash"]))
                if merged:
                    os.ftruncate(handle["file"].fileno(), 0)
                    merged_version, merged_hash = await self.api.read_to_file(handle["fileId"], handle["file"])
                    handle.update({"size": handle["file"].tell(), "versionId": merged_version, "sourceHash": merged_hash})
        except OSError as error:
            fuse_errno = errno.EINVAL if getattr(error, "status", None) == 400 else errno.EACCES if getattr(error, "status", None) == 403 else error.errno
            handle["dirty"] = False
            handle["failedErrno"] = fuse_errno
            emit("file-commit-rejected", logging.ERROR, path=self.nodes[handle["inode"]].get("path"), fileId=handle.get("fileId"),
                 bytes=handle["size"], errno=_errno_name(fuse_errno), status=getattr(error, "status", None), error=str(error))
            raise pyfuse3.FUSEError(fuse_errno) from error
        if result:
            handle["versionId"] = result["versionId"]
            handle["sourceHash"] = result["sourceHash"]
        handle["dirty"] = False
        handle["failedErrno"] = None
        node = self.nodes[handle["inode"]]
        # The result's `path` is collection-relative; the node keys on its full mount path.
        node.update({key: value for key, value in result.items() if key != "path"})
        node["size"] = handle["size"]
        node["versionId"], node["sourceHash"] = handle.get("versionId"), handle.get("sourceHash")
        self.queue_invalidation(node.get("path", ""))
        self.snapshot_at = 0.0
        emit("file-committed", path=node.get("path"), fileId=handle.get("fileId"), bytes=handle["size"], actor=handle.get("actor"),
             merged=merged or None, metadata=bool(node.get("virtualMetadata")) or None, versionId=handle.get("versionId") or None)

    @traced("flush", lambda s, a: s._handle_info(a[0]))
    async def flush(self, fh):
        handle = self.handles.get(fh)
        if handle is not None and handle.get("truncateOnly"):
            return
        await self._commit(fh)

    @traced("fsync", lambda s, a: s._handle_info(a[0]))
    async def fsync(self, fh, datasync):
        await self._commit(fh)

    @traced("release", lambda s, a: s._handle_info(a[0]))
    async def release(self, fh):
        try:
            await self._commit(fh)
        finally:
            handle = self.handles.pop(fh, None)
            if handle is not None:
                handle["file"].close()

    async def statfs(self, ctx):
        # df and stat -f need filesystem totals. The Files service exposes no quota, so report the
        # disk that holds this client's spool (the local space every write stages through).
        # Without a readable spool dir, fall back to the root filesystem; never fail the call.
        try:
            volume = os.statvfs(SPOOL_DIR)
        except OSError:
            volume = os.statvfs("/")
        data = pyfuse3.StatvfsData()
        data.f_bsize = volume.f_bsize
        data.f_frsize = volume.f_frsize
        data.f_blocks = volume.f_blocks
        data.f_bfree = volume.f_bfree
        data.f_bavail = volume.f_bavail
        data.f_files = volume.f_files
        data.f_ffree = volume.f_ffree
        data.f_favail = volume.f_favail
        data.f_namemax = 255
        return data

    def _child(self, parent_inode, name):
        parent=self.nodes.get(parent_inode)
        if not parent or not parent.get("directory"): raise pyfuse3.FUSEError(errno.ENOTDIR)
        return parent, "/".join(filter(None,[parent["path"],os.fsdecode(name)]))

    def _files_path(self, node_path, collection_id):
        node = next((value for value in self.nodes.values()
                     if value.get("collectionRoot") and value.get("collectionId") == collection_id), None)
        root = node.get("path", "") if node else ""
        if not root:
            return node_path
        return node_path[len(root):].lstrip("/")

    @traced("create", lambda s, a: s._child_info(a[0], a[1], a[-1]), mutating=True)
    async def create(self, parent_inode, name, mode, flags, ctx):
        parent,path=self._child(parent_inode,name)
        if parent.get("collectionRoot") is not True and not parent.get("collectionId"): raise pyfuse3.FUSEError(errno.EPERM)
        try: row=await self._as_actor(await self._actor(ctx), self.api.create(parent["collectionId"],self._files_path(path,parent["collectionId"])))
        except OSError as error:
            if error.errno == errno.EEXIST and not flags & os.O_EXCL:
                # Another writer created it between the kernel's lookup and this create. open(2)
                # without O_EXCL must open the existing file, not fail: 4 of 5 concurrent `cp` to
                # one new path failed with "File exists" (iMac soak, 2026-11-17).
                self._forget(path)
                inode = await self._resolve(parent_inode, name)
                if self.nodes[inode].get("directory"): raise pyfuse3.FUSEError(errno.EISDIR) from error
                return await self.open(inode, flags, ctx), self._attrs(inode)
            log.error("Create rejected: %s", error)
            raise pyfuse3.FUSEError(error.errno) from error
        inode=self._node(path,False); self.nodes[inode].update({**row,"path":path,"filesPath":self._files_path(path,parent["collectionId"]),"collectionId":parent["collectionId"]})
        # The file was just created empty: open it from what we know instead of downloading it back.
        if len(self.handles) >= MAX_OPEN_HANDLES: raise pyfuse3.FUSEError(errno.EMFILE)
        info=await self._open_handle(inode,flags,ctx,b"",str(row.get("current_version_id") or row.get("versionId") or ""),EMPTY_SHA256)
        self.queue_invalidation(path)
        return info,self._attrs(inode)

    @traced("rename", lambda s, a: {**s._child_info(a[0], a[1], a[-1]), "to": s._child_info(a[2], a[3])["path"]}, mutating=True)
    async def rename(self, parent_inode, name, new_parent_inode, new_name, flags, ctx):
        parent,old_path=self._child(parent_inode,name); target_parent,new_path=self._child(new_parent_inode,new_name)
        inode=self.path_inode.get(old_path); node=self.nodes.get(inode) if inode else None
        if not node or node.get("collectionRoot"): raise pyfuse3.FUSEError(errno.EOPNOTSUPP)
        source_collection = node.get("collectionId") or parent.get("collectionId")
        target_collection = target_parent.get("collectionId")
        if not source_collection or not target_collection: raise pyfuse3.FUSEError(errno.EPERM)
        source_files_path = self._files_path(old_path, source_collection)
        target_files_path = self._files_path(new_path, target_collection)
        try:
            target_inode = self.path_inode.get(new_path)
            target = self.nodes.get(target_inode) if target_inode else None
            actor = await self._actor(ctx)
            if target and target.get("virtualMetadata") and not node.get("directory"):
                temporary = tempfile.TemporaryFile(mode="w+b", dir=SPOOL_DIR)
                try:
                    await self.api.read_to_file(node["id"], temporary)
                    temporary.flush()
                except BaseException:
                    temporary.close()
                    raise
                current = await self._get_folder_metadata(target["collectionId"], target["filesPath"])
                metadata_handle = {"metadata": current, "file": temporary}
                try:
                    await self._as_actor(actor, self._commit_metadata(metadata_handle, target, temporary))
                    await self._as_actor(actor, self.api.delete(node["id"]))
                finally:
                    temporary.close()
            elif target and not target.get("directory") and not node.get("directory"):
                await self._as_actor(actor, self.api.replace(target["id"], node["id"]))
            elif node.get("directory"):
                await self._as_actor(actor, self.api.rename_folder(source_collection,source_files_path,target_collection,target_files_path))
            else:
                await self._as_actor(actor, self.api.rename(node["id"],target_collection,target_files_path))
        except OSError as error:
            mapped = errno.EINVAL if getattr(error, "status", None) == 400 else errno.EACCES if getattr(error, "status", None) == 403 else error.errno
            log.error("Rename/save rejected: %s", error)
            raise pyfuse3.FUSEError(mapped) from error
        if target and (target.get("virtualMetadata") or (not target.get("directory") and not node.get("directory"))):
            # Saved into the target (replace or folder metadata): the source path is gone. The
            # target keeps its inode and Files id.
            self._forget_subtree(old_path)
        else:
            self._move_cached_path(old_path, new_path, target_collection)
        self.directory_etags.pop(parent["path"], None)
        self.directory_complete.discard(parent["path"])
        self.directory_etags.pop(target_parent["path"], None)
        self.directory_complete.discard(target_parent["path"])
        self.queue_invalidation(old_path)
        self.queue_invalidation(new_path)

    @traced("unlink", lambda s, a: s._child_info(a[0], a[1], a[-1]), mutating=True)
    async def unlink(self, parent_inode, name, ctx):
        _,path=self._child(parent_inode,name); inode=self.path_inode.get(path); node=self.nodes.get(inode) if inode else None
        if not node or node.get("directory"): raise pyfuse3.FUSEError(errno.ENOENT)
        try: await self._as_actor(await self._actor(ctx), self.api.delete(node["id"]))
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        self._forget(path)
        self.directory_etags.pop(os.path.dirname(path), None)
        self.directory_complete.discard(os.path.dirname(path))
        self.queue_invalidation(path)

    @traced("mkdir", lambda s, a: s._child_info(a[0], a[1], a[-1]), mutating=True)
    async def mkdir(self, parent_inode, name, mode, ctx):
        parent,path=self._child(parent_inode,name)
        if not parent.get("collectionId"): raise pyfuse3.FUSEError(errno.EPERM)
        try: await self._as_actor(await self._actor(ctx), self.api.mkdir(parent["collectionId"],self._files_path(path,parent["collectionId"])))
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        inode=self._node(path,True); self.nodes[inode].update({"collectionId":parent["collectionId"]})
        self.queue_invalidation(path)
        return self._attrs(inode)

    @traced("rmdir", lambda s, a: s._child_info(a[0], a[1], a[-1]), mutating=True)
    async def rmdir(self, parent_inode, name, ctx):
        parent,path=self._child(parent_inode,name); inode=self.path_inode.get(path); node=self.nodes.get(inode) if inode else None
        if not node or node.get("collectionRoot"): raise pyfuse3.FUSEError(errno.EPERM)
        try: await self._as_actor(await self._actor(ctx), self.api.rmdir(parent["collectionId"],self._files_path(path,parent["collectionId"])))
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        self._forget(path)
        self.directory_etags.pop(parent["path"], None)
        self.directory_complete.discard(parent["path"])
        self.queue_invalidation(path)

    def _metadata_path(self, node):
        return self._files_path(node["path"], node["collectionId"])

    def _xattr_key(self, name):
        decoded = os.fsdecode(name)
        prefix = "user.sulla."
        if not decoded.startswith(prefix) or len(decoded) == len(prefix):
            raise pyfuse3.FUSEError(errno.ENODATA)
        return decoded[len(prefix):]

    @traced("getxattr", lambda s, a: {**s._inode_info(a[0], a[-1]), "name": os.fsdecode(a[1])})
    async def getxattr(self, inode, name, ctx):
        node = self.nodes.get(inode)
        if not node or node.get("virtualMetadata"): raise pyfuse3.FUSEError(errno.ENODATA)
        key = self._xattr_key(name)
        try: result = await self._get_metadata(node["collectionId"], self._metadata_path(node))
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        if key not in result.get("metadata", {}): raise pyfuse3.FUSEError(errno.ENODATA)
        value = result["metadata"][key]
        return value.encode() if isinstance(value, str) else json.dumps(value, separators=(",", ":")).encode()

    @traced("listxattr", lambda s, a: s._inode_info(a[0], a[-1]))
    async def listxattr(self, inode, ctx):
        node = self.nodes.get(inode)
        if not node or node.get("virtualMetadata"): return []
        try: result = await self._get_metadata(node["collectionId"], self._metadata_path(node))
        except OSError as error: raise pyfuse3.FUSEError(error.errno) from error
        return [os.fsencode(f"user.sulla.{key}") for key in result.get("metadata", {})]

    @traced("setxattr", lambda s, a: {**s._inode_info(a[0], a[-1]), "name": os.fsdecode(a[1])}, mutating=True)
    async def setxattr(self, inode, name, value, ctx):
        node = self.nodes.get(inode); key = self._xattr_key(name)
        if not node or node.get("virtualMetadata"): raise pyfuse3.FUSEError(errno.ENODATA)
        try:
            text = bytes(value).decode("utf-8")
            parsed = json.loads(text)
            value_to_set = parsed if isinstance(parsed, (dict, list, bool, int, float)) or parsed is None else text
        except (UnicodeDecodeError, json.JSONDecodeError): value_to_set = bytes(value).decode("utf-8", "strict")
        try: await self._as_actor(await self._actor(ctx), self.api.put_metadata(node["collectionId"], self._metadata_path(node), {key:value_to_set}, []))
        except OSError as error: raise pyfuse3.FUSEError(errno.EACCES if getattr(error,"status",None)==403 else errno.EINVAL if getattr(error,"status",None)==400 else error.errno) from error
        self.snapshot_at = 0.0
        self._invalidate_metadata(node["collectionId"], self._metadata_path(node))

    @traced("removexattr", lambda s, a: {**s._inode_info(a[0], a[-1]), "name": os.fsdecode(a[1])}, mutating=True)
    async def removexattr(self, inode, name, ctx):
        node = self.nodes.get(inode); key = self._xattr_key(name)
        if not node or node.get("virtualMetadata"): raise pyfuse3.FUSEError(errno.ENODATA)
        try: await self._as_actor(await self._actor(ctx), self.api.put_metadata(node["collectionId"], self._metadata_path(node), {}, [key]))
        except OSError as error: raise pyfuse3.FUSEError(errno.EACCES if getattr(error,"status",None)==403 else error.errno) from error
        self.snapshot_at = 0.0
        self._invalidate_metadata(node["collectionId"], self._metadata_path(node))


STATUS_SECONDS = 5.0


class StatusFile:
    """Atomically-replaced JSON status Desktop polls; a stale updatedAt means the adapter is wedged."""
    def __init__(self, path):
        self.path = path
        self.fields = {}

    def set(self, phase, **fields):
        self.fields = {"phase": phase, **{key: value for key, value in fields.items() if value is not None}}
        self.write()

    def write(self, **live):
        if not self.path: return
        value = {**self.fields, **live, "pid": os.getpid(), "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
        try:
            with open(f"{self.path}.new", "w", encoding="utf-8") as handle:
                json.dump(value, handle, default=str, separators=(",", ":"))
            os.replace(f"{self.path}.new", self.path)
        except OSError as error:
            emit("status-write-failed", logging.WARNING, path=self.path, error=str(error))


async def main(options):
    token_file = os.environ.get("SULLA_FILES_FUSE_TOKEN_FILE")
    if not token_file:
        raise SystemExit("SULLA_FILES_FUSE_TOKEN_FILE is required")
    status = StatusFile(options.status_file)
    os.makedirs(options.mountpoint, exist_ok=True)
    operations = SullaFiles(FilesApi(options.url, token_file, ActorResolver()))
    emit("daemon-start", pid=os.getpid(), url=options.url, mountpoint=options.mountpoint, spool=SPOOL_DIR,
         logLevel=logging.getLevelName(log.getEffectiveLevel()), pyfuse3=pyfuse3.__version__, snapshotTtlSeconds=SNAPSHOT_TTL_SECONDS,
         maxFileBytes=MAX_FILE_BYTES, maxOpenHandles=MAX_OPEN_HANDLES, slowRequestSeconds=SLOW_REQUEST_SECONDS)
    status.set("mounting")
    try:
        pyfuse3.init(operations, options.mountpoint, {"fsname=sulla-files", "allow_other"})
    except Exception as error:
        log.exception("mount failed", extra={"event": "mount-failed", "fields": {"mountpoint": options.mountpoint}})
        status.set("failed", reason="mount-failed", error=str(error))
        raise
    emit("mounted", mountpoint=options.mountpoint)
    try:
        async with trio.open_nursery() as nursery:
            nursery.start_soon(heartbeat, operations)
            nursery.start_soon(report_status, operations, status)
            nursery.start_soon(warm_tree, operations, status)
            nursery.start_soon(operations.follow_changes)
            nursery.start_soon(operations.invalidation_worker)
            await pyfuse3.main()
            nursery.cancel_scope.cancel()
    except BaseException as error:
        log.exception("daemon stopping", extra={"event": "daemon-stopping", "fields": {"reason": type(error).__name__}})
        status.set("failed", reason="daemon-stopped", error=type(error).__name__)
        raise
    finally:
        pyfuse3.close(unmount=True)
        emit("unmounted", mountpoint=options.mountpoint, **stats)


async def warm_tree(operations, status):
    """Load the tree right after mounting: the mount appears immediately and the first agent `ls` is fast."""
    status.set("loading-tree")
    started = time.monotonic()
    try:
        await operations.refresh(force=True)
    except OSError as error:
        # Lookups retry on every access; the mount stays up and Desktop's directory read decides readiness.
        emit("files-unreachable", logging.WARNING, errno=_errno_name(error.errno), error=str(error))
        status.set("mounted", tree="unavailable", error=str(error))
        return
    nodes = len(operations.path_inode)
    emit("files-reachable", nodes=nodes, ms=round((time.monotonic() - started) * 1000, 1))
    status.set("mounted", tree="loaded", nodes=nodes)


async def report_status(operations, status):
    while True:
        status.write(openHandles=len(operations.handles), requestErrors=stats["requestErrors"],
                     snapshotAgeSeconds=round(time.monotonic() - operations.snapshot_at, 1) if operations.snapshot_at else None)
        await trio.sleep(STATUS_SECONDS)


async def heartbeat(operations):
    """Periodic one-line health summary; counters are cumulative since start."""
    while True:
        await trio.sleep(HEARTBEAT_SECONDS)
        emit("heartbeat", rssKb=_rss_kb(), openHandles=len(operations.handles), nodes=len(operations.path_inode),
             snapshotAgeSeconds=round(time.monotonic() - operations.snapshot_at, 1) if operations.snapshot_at else None,
             metadataCache=len(operations.metadata_cache), actorCache=len(operations.api.actor_resolver.cache) if operations.api.actor_resolver else None,
             **stats)


if __name__ == "__main__":
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=os.environ.get("SULLA_FILES_FUSE_LOG_LEVEL", "INFO").upper(), handlers=[handler])
    # pyfuse3 logs its own per-request noise at DEBUG; keep it at INFO unless explicitly asked for.
    logging.getLogger("pyfuse3").setLevel(os.environ.get("SULLA_FILES_FUSE_PYFUSE3_LOG_LEVEL", "INFO").upper())
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Files service base URL")
    parser.add_argument("--status-file", default=os.environ.get("SULLA_FILES_FUSE_STATUS_FILE"), help="JSON status file Desktop polls")
    parser.add_argument("mountpoint")
    trio.run(main, parser.parse_args())
