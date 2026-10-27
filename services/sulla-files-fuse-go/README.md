# sulla-files-fuse-go (experiment)

A Go rewrite of the Files mount adapter (`services/sulla-files-fuse`, Python +
pyfuse3 + trio). **Experiment branch `exp/go-fuse-adapter` only: never merged
to main.** The Python adapter is untouched.

One static binary (`CGO_ENABLED=0`, ~5 MB stripped) replaces the shell
entrypoint, the Python daemon and the Python healthcheck:

| invocation | role |
|---|---|
| `sulla-files-fuse` / `sulla-files-fuse run [--url U] [--status-file F] [mountpoint]` | entrypoint (token wait, stale-layer cleanup, shared-anchor check) + daemon |
| `sulla-files-fuse healthcheck` | exit 0 iff the mountpoint is this adapter's FUSE mount, a `stat` of it answers within 2 s, and Files `/healthz` answers 200 over TLS |
| `python3 …` (argv[0] symlink) | the same healthcheck, so the HEALTHCHECK that already-installed apps generate (`python3 -c "import os,ssl,…"`) works with no interpreter in the image |

Library: `github.com/hanwen/go-fuse/v2` v2.12.1, raw API (`fuse.RawFileSystem`),
`DirectMount`/`DirectMountStrict` (mount(2) with CAP_SYS_ADMIN, no fusermount).
Verified on the guest kernel (Alpine linux-lts 6.18, arm64).

## Layout

```
cmd/sulla-files-fuse     main: run / healthcheck / python3 shim
cmd/fakefiles            test-only TLS fake of the Files API (+ control port, stat bench)
internal/files           HTTP client: token, TLS, actor header, retry/backoff, error mapping
internal/actor           pid -> container -> actor identity (port of ActorResolver)
internal/tree            snapshot model, stable inodes, snapshot diff -> invalidations
internal/spool           durable write journal (open buffers, pending, conflicts)
internal/fusefs          the FUSE filesystem
internal/metayaml        _folder-metadata.yaml render/parse/diff
internal/mountinfo       /proc/self/mountinfo (entrypoint + healthcheck)
internal/status          status file Desktop polls
internal/fakefiles       in-memory fake Files for unit + integration tests
scripts/                 build-test-image.sh, integration.sh, Dockerfile.prebuilt
patches/                 the long-term compose HEALTHCHECK change (NOT applied)
```

## Compatibility contract (drop-in for the installed app)

Same env (`SULLA_FILES_FUSE_URL`, `_TOKEN_FILE`, `_MOUNT_PATH`, `_SPOOL`,
`_STATUS_FILE`, `_TOKEN_WAIT_SECONDS`, `_LOG_LEVEL`, `SSL_CERT_FILE`), same
volumes (`/run/sulla-files-fuse` ro with `token` and `actors/`, `/host/proc`,
`/mnt/sulla-files:rshared`, the spool volume, `/dev/fuse`), same status file
(`/tmp/sulla-files-fuse-status.json`, phases `waiting-token`, `starting`,
`mounting`, `loading-tree`, `mounted`, `failed`, refreshed every 5 s; adds
`stopped`), same mount identity (source `sulla-files`; type `fuse.sulla-files`,
which `guestMountInfo.ts` already accepts alongside plain `fuse`), `allow_other`.
Works under the compose constraints: read-only rootfs, `cap_drop: ALL` +
`SYS_ADMIN`, `no-new-privileges`, `pid: host`, 16 MB `/tmp` tmpfs,
`pids_limit: 64`, `mem_limit: 256m`, `cpus: 0.5`. `cat` is present for
Desktop's `docker exec … cat` of the status file (Alpine base).

New optional env: `SULLA_FILES_FUSE_ATTR_TIMEOUT`, `_ENTRY_TIMEOUT`,
`_NEGATIVE_TIMEOUT` (seconds, default 2), `_POLL_SECONDS` (default 2),
`_RETRY_BUDGET_SECONDS` (default 60), `_MAX_CONCURRENT_REQUESTS` (default 8),
`_MAX_OPEN_HANDLES` (default 32), `_HEARTBEAT_SECONDS` (60),
`_REQUIRE_SHARED_ANCHOR` (default 1; tests only), `_PROC_ROOT`, `_ACTORS_DIR`,
`GOMEMLIMIT` (default 48 MiB set in code).

## Parity table

| Operation / concern | Python adapter | Go adapter |
|---|---|---|
| Actor resolution | `/host/proc/<pid>/cgroup` -> last `(docker\|cri-containerd)[-/]<64hex>`, else last `/<64hex>(.scope)?` at line end -> read ≤1024 B of `/run/sulla-files-fuse/actors/<id>`, strip; valid iff non-empty, single line, contains `:`; valid actors cached per container forever; invalid -> warning, not cached, no actor; any read error -> no actor (host processes) | Identical (same regexes, same 1024-byte read, same strip, same lenient validity check: a stricter local check would fail *open*; Files' 400 on a malformed header fails *closed*) |
| Which requests carry `X-Sulla-Actor` | create, rename/replace/rename-folder, unlink, mkdir, rmdir, setxattr/removexattr, metadata edits, and the content PUT on commit (actor captured at open). Reads (tree, content GET in open, getxattr/listxattr, folder metadata) carry none | Identical |
| Auth | `Authorization: Bearer <token>`; token file re-read per request: `O_NOFOLLOW`, regular, no group/other bits, 1..4096 bytes ASCII, else EACCES | Identical checks on every request; contents re-read only when the file's inode/size/mtime/mode change |
| TLS | urllib default context (`SSL_CERT_FILE` / system roots), CA re-read per connection | Verifies against `SSL_CERT_FILE` (system roots if unset), re-read when the file changes, hostname checked |
| HTTP error -> errno | `code` EROFS/FILE_LOCKED or 423 -> EROFS; 409 -> EPERM; 403 -> EACCES; else EIO; transport error -> EIO; response > 64 MiB -> EFBIG | Identical mapping |
| Per-op remap | create/rename/commit/setxattr: 400 -> EINVAL, 403 -> EACCES; removexattr: 403 -> EACCES | Identical |
| 409 "concurrently or are busy" | DELETE/PUT retried 3x (50 ms·n + jitter), then EBUSY | Identical |
| Transient outage (conn error, timeout, 5xx) | immediate EIO | **Blocks and retries** (see durability a) |
| lookup | refresh tree if older than 10 s (errors -> errno); ENOENT if missing | served from the tree kept fresh by the poller; first load blocks with retries; misses are cached negative entries (nodeid 0) |
| getattr | root refreshes tree; attrs from node; attr/entry timeout 0 | root waits only for the first load; 2 s attr/entry timeouts; a dirty open handle's size is reported |
| Attributes | dirs `S_IFDIR\|0777` nlink 2 size 0; files `S_IFREG\|0666` nlink 1; uid/gid 0; blksize 4096; blocks = ceil(size/512); a/m/ctime = `updated_at` (now if unknown) | Identical |
| readdir | sorted children, refresh first | sorted children snapshotted at opendir, plus `.`/`..`; readdirplus fills attributes |
| open | EISDIR for dirs/missing; EMFILE at 32 handles; content GET (or rendered metadata) into a spool tempfile; O_TRUNC -> empty+dirty; O_APPEND honoured; `direct_io`, no keep_cache | Identical, but the buffer is a named file under `<spool>/open/` and the body is streamed (no 64 MB in RAM); if a pending (unacknowledged) write exists for the file its bytes are served instead (read-your-writes) |
| read / write | pread/pwrite on the buffer; > 64 MiB -> EFBIG | Identical |
| flush / fsync / release | commit if dirty: PUT `/content` with `If-Match: "<version>"` + `X-Sulla-Source-Hash`; on `X-Sulla-Merged: 1` re-read; one Files version per dirty close; 409 -> handle marked failed, EPERM; release closes the handle | Identical HTTP semantics, plus the journal (durability b). A 409/403/400 refusal keeps the bytes in `<spool>/conflicts/` instead of dropping them |
| create | parent needs a collection (else EPERM); POST `/files?collectionId&path` empty body; then open (a second GET) | Identical POST; the GET is skipped for the brand-new empty file (version from the create reply, hash of empty) |
| mkdir | parent needs a collection; POST `/folders`; errors -> errno | Identical |
| unlink | missing/dir -> ENOENT; DELETE `/files/{id}` | Identical; the virtual metadata file -> EPERM (Python: KeyError -> EIO) |
| rmdir | missing/collection root -> EPERM; DELETE `/folders?…`; 409 -> EPERM | Identical, except Files' 409 "folder is not empty" -> **ENOTEMPTY** |
| rename | file over virtual metadata: read source, apply as metadata, delete source; file over file: POST `/replace`; folder: PATCH `/folders`; else PATCH `/files/{id}`; collection roots -> EOPNOTSUPP; flags ignored; then forced synchronous tree refresh (a refresh failure turned a successful rename into EIO) | Same four cases and errors; `RENAME_NOREPLACE` honoured (EEXIST), `RENAME_EXCHANGE` -> EINVAL; virtual source -> EPERM; local view updated in place keeping inode numbers, then an async refresh |
| setattr size | needs an open handle (else EOPNOTSUPP); truncates the buffer, dirty (O_TRUNC came in open flags via atomic_o_trunc) | With a handle: identical. Without one: applied to the newest open handle on the inode (this is how `open(O_TRUNC)` arrives under go-fuse); with nothing open (`truncate(1)`): open, resize, commit, close. A truncate-only change is committed at the next write's flush or at release |
| setattr mode/uid/gid | EOPNOTSUPP | Identical |
| setattr atime/mtime (utimens, `touch`) | EOPNOTSUPP | **Accepted as a no-op** (Files owns timestamps). Required because go-fuse does not negotiate atomic O_TRUNC, so `open(O_TRUNC)` arrives as setattr(size+mtime) |
| xattrs | `user.sulla.<key>` only (else ENODATA); get: strings raw, other JSON compact; list; set: JSON object/array/bool/number/null stored as JSON, anything else as text; remove; virtual file -> ENODATA/empty; metadata cache cleared on every applied snapshot | Identical (invalid UTF-8 on set -> EINVAL instead of a crash/EIO) |
| `_folder-metadata.yaml` | virtual file per collection folder, not inside git repos, a real file wins; rendered YAML (header, `description`, `naming_hint`, other folder keys, `files`); on save: parse, folder diff with `baseRevision`, per-file diffs, re-render | Identical logic. YAML via yaml.v3: semantically identical, cosmetic differences (sequences indented under keys) |
| statfs | not implemented (zeros) | large constant free space, namelen 255 |
| Mount | `fsname=sulla-files,allow_other` via libfuse (type `fuse`) | `DirectMount`, source `sulla-files`, type `fuse.sulla-files`, `allow_other`, nosuid,nodev, max_write 1 MiB |
| Entrypoint | wait ≤300 s for the token, detach up to 8 stale FUSE layers, require a `shared:` anchor, status file | Identical, in Go (`umount2(MNT_DETACH)` instead of `fusermount3 -uz`/`umount -l`) |
| Logs | JSON lines `ts,source,level,event,…`; heartbeat every 60 s | Same shape and event names (+ `files-outage-retry`, `write-kept-for-replay`, `write-replayed`, `write-already-applied`, `write-refused`, `snapshot-recovered`) |
| Shutdown | trio cancelled, `pyfuse3.close(unmount=True)` | SIGTERM/SIGINT: unmount (lazy detach if busy), status `stopped`, pending writes stay for replay |

Not ported (removed upstream): system-area / read-only mounts, logs and
training-data mounts.

## Durability and fit behaviour

**a. Outages never surface as errors (until a bound).** Connection errors,
timeouts and 5xx are retried with exponential backoff (100 ms doubling to 5 s,
equal jitter) for up to 60 s per request, interruptible: a FUSE INTERRUPT
cancels the request context and the op returns EINTR at once. Only after the
budget: EIO. Requests that may already have reached Files (sent, no reply) are
retried only when idempotent (GET, DELETE — a 404 on a retry counts as done —
metadata PUT); a non-idempotent POST/PATCH is retried only when it provably
never left (dial/DNS/TLS-handshake failure, 502/503/504). The content PUT is
retried by the spool, which first proves by hash whether the previous attempt
landed. Once a tree is loaded, lookups/readdir/getattr never wait on Files:
they serve the last snapshot during an outage. Counters: `transientRetries`,
`transientGiveUps` (heartbeat), `files-outage-retry` / `files-outage-giveup`
log events.

**b. Durable write path.** `<spool>/open/<id>.buf` per handle (named, on the
volume). On commit the first `size` bytes are copied to
`<spool>/pending/<id>.data` (fsync), then `<id>.json` (fileId, path, actor,
base version, base hash, data hash, size) is written to a temp name, fsynced,
renamed, and the directory fsynced: from here the write survives a crash.
The upload follows; the journal is removed only after Files acknowledges.
Crash points and what restart does (`Recover` + replay loop every 15 s):

| crash point | on disk | restart |
|---|---|---|
| before the journal (`spooled`) | `.data` only | discarded: the writer never got a successful close |
| journal durable, not uploaded (`journaled`) | `.json` + `.data` | replayed |
| uploaded, ack not recorded (`uploaded`) | `.json` + `.data` | replay GETs the current hash; equal -> journal dropped, **no second version** |
| journal removed, data not (`unjournaled`) | `.data` only | discarded |
| half-written temp files | `*.tmp` | discarded |
| open handles | `open/*.buf` | discarded (never closed) |

If a commit cannot be delivered within the budget, close() returns EIO but the
write stays pending and is replayed in the background and after restarts;
reopening the file serves the pending bytes, and a later write on top of them
supersedes the pending entry (one version, not two). A definitive refusal
(409 version conflict, 403, 400) moves the bytes to `<spool>/conflicts/`
(kept 7 days, logged `write-refused` with the path).

**c. Kernel caching and precise invalidation.** attr/entry/negative timeouts
2 s (env). A poller does a conditional `GET /v1/fuse/tree` every 2 s
(`If-None-Match`; Files answers 304 from a scalar revision read). When it
changes, the snapshot is diffed against the current view and only the changed
entries are invalidated (`EntryNotify` for added/removed names, including
cached negative entries; `InodeNotify` for files whose size/version/mtime
changed), from a goroutine outside any FUSE request. Mutations through this
mount update the view in place (keeping inode numbers across renames) and
poke the poller; a snapshot that raced a local mutation is discarded and
refetched. Files has no change feed today, so the snapshot diff is the
external-change mechanism.

**d. One persistent HTTP client.** keep-alive pool, HTTP/2 negotiated when the
server offers it (Files' Node https server speaks HTTP/1.1), 5 s dial/TLS
timeouts, 30 s per attempt (120 s for content bodies), at most 8 requests in
flight (semaphore held until the body is consumed).

**e. Memory.** static binary, `debug.SetMemoryLimit(48 MiB)` unless
`GOMEMLIMIT` is set, bodies streamed to/from the spool (never buffered),
contexts/goroutines scoped to each op.

**f. Healthcheck.** `sulla-files-fuse healthcheck` (and the `python3` shim).

**g. Graceful shutdown.** SIGTERM -> unmount (lazy detach if files are open)
-> status `stopped` -> exit 0; never leaves a dead mount; pending writes stay.

## Tests

```
cd services/sulla-files-fuse-go
GOWORK=off go vet ./... && GOWORK=off go test ./...
BASE=<local alpine ref> scripts/build-test-image.sh          # sulla-files-fuse:gotest + gofuse-itest
docker --context sulla-desktop run --rm --privileged --cgroupns host --device /dev/fuse \
  -e IDLE_MINUTES=10 --name gofuse-itest-run gofuse-itest
```

Unit tests (httptest fake Files): actor resolution (cgroup v1/v2/cri,
nesting, invalid/missing actor files, caching), error mapping, backoff bounds,
outage riding (drops and 503s), budget bound, interrupt, no retry of a sent
POST, retry of a refused-connection POST, 409-busy -> EBUSY, DELETE 404 after
retry, conditional snapshots, every spool crash point, outage -> kept ->
replay, conflicts kept, subsumed entries, recovery cleanup, tree build /
virtual metadata / git exclusion / snapshot diff / type change / rename
inode stability, YAML render/parse/diff, and the filesystem ops through the
raw API (attributes, negative entries, create/write/flush, rename-replace,
NOREPLACE, unlink, metadata save, xattrs, read-your-writes during an outage).

### Results so far

Unit tests: all pass (`go vet` clean for darwin and linux/arm64).

One partial integration run (privileged throwaway container, fake Files over
TLS, Alpine 6.18 arm64 kernel, before the O_TRUNC fix below):

- mount type `fuse.sulla-files`, source `sulla-files`, shared anchor detected;
  ls/cat/write/append/mkdir/rename file+folder/touch/rm/rmdir/ENOTEMPTY,
  actor header on mutations, metadata save via `sed -i` (temp + rename),
  external create visible within the poll window: all passed.
- 50 MiB copy + sha256 round trip passed; RSS after it **22.6 MB**
  (Python adapter in production: 28.6 MiB cgroup usage idle, ~86 MB under load).
- `stat` x20000 with the 2 s attr cache: **0.6 µs/op**, zero Files requests.
- 20 s Files outage (connections dropped) during a read: the reader blocked
  22 s and then succeeded; `ls` kept working from the cached tree throughout.
  During a write: blocked 24 s then succeeded. 5 s of 503s: rode out.
- A reader blocked on a down Files was killed in < 1 ms (INTERRUPT honoured).
- kill -9 mid-upload: the stale FUSE layer was detached on restart, the
  pending entry replayed and was recognised by hash (no duplicate version).
- kill -9 with Files down: close gave up after the (test) 5 s budget, the
  write stayed in the spool and was delivered after restart + recovery.

Bug found by that run and fixed since (regression test
`TestShellRedirectOverExistingFile`): go-fuse does not negotiate atomic
O_TRUNC, so `open(O_TRUNC)` reaches the adapter as `setattr(size=0)` with no
file handle. It was committed as a separate empty version, after which the
opener's own commit failed If-Match (409 -> conflicts/, file left empty):
`printf x > existing` lost its content and concurrent rewriters conflicted.
Now the fh-less truncate applies to the newest open handle on that inode, and
a flush whose only change is that truncation is deferred (no empty
intermediate version; truncate-and-close still commits on release).

**Not yet re-run after the fix:** the full integration script, the idle
(10 min) RSS series, the SIGTERM/healthcheck steps at the end of the script,
and a boot as the real `sulla_files_fuse` service under the compose
constraints. Runtime tests must run in an isolated VM, never the live one.

## Wish list for the Files service (not changed in this experiment)

1. **Change feed** — a cursor-based `GET /v1/fuse/changes?since=<revision>`
   (or a stream over a unix socket shared with the adapter) returning
   `{revision, upserts[], deletes[]}`; replaces the 2 s poll + full-tree diff
   and makes invalidation O(changes).
2. **Range reads** — `Range:` support on `GET /files/{id}/content` (and a
   `HEAD` with ETag + `X-Sulla-Source-Hash`): open without downloading whole
   files, and verify-before-replay without a body.
3. **Chunk-level / resumable replace** — upload sessions with chunk hashes so a
   64 MB file edit does not resend 64 MB, and a crash mid-upload resumes.
4. **Idempotency keys** on POST/PATCH/replace (`Idempotency-Key` header) so
   non-idempotent mutations can be retried safely after a lost reply.
5. **Server-side `If-Match` on DELETE and rename** to close the remaining
   races between external edits and mount mutations.
6. A unix-socket listener for the adapter (no TLS, no TCP) inside the VM.

## Long-term compose change

`patches/compose-healthcheck.patch` switches the generated HEALTHCHECK to
`['CMD', '/usr/local/bin/sulla-files-fuse', 'healthcheck']`. It is not applied
on this branch and is not needed for the test (the `python3` shim covers the
installed app's command).
