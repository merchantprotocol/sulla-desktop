# Experimental Sulla Files FUSE adapter

This is a feasibility slice for a real Linux FUSE mount backed by the authenticated Sulla Files service. It is off unless the service starts with `SULLA_FILES_FUSE_EXPERIMENT=1`. The bearer capability is read from `SULLA_FILES_FUSE_TOKEN`; it is never accepted on the command line.

The proof boundary is narrow. Existing tracked regular files support list, stat, read, truncate, positional write, flush, fsync, and close. Each write sends both the Files version in `If-Match` and the tracked source SHA-256. The service stages and fsyncs the replacement, keeps the prior source inode in a private recovery path, syncs the affected directories, replaces the source path, ingests the result into Files, and only then acknowledges success. A stale source detected before publication leaves the source untouched and retains the agent bytes as a visible conflicted copy. If verification or ingestion fails after publication, the service keeps both versions and refuses success; it does not risk overwriting the current path with an automatic rollback. A service outage returns `EIO` from flush/fsync and is never reported as a durable save.

Creation, deletion, directory mutation, rename, hard/symbolic links, xattrs, locks, mmap, and executable workloads fail closed. Temp-file-plus-rename editor saves are therefore unsupported in this slice. Use in-place tools such as `python` opening an existing file with `r+b`, or shell redirection to an existing file.

This is VM synthetic-source evidence only. The source root used by the proof lives inside Lima. It does not implement or prove the native host broker, selected-host-file custody, host event delivery, or protection from a non-cooperating writer that retains an old file descriptor or replaces the source pathname during publication. A plain rename is not a race-safe compare-and-swap against those writers. The remaining native leg must keep opaque handles to explicitly selected host files, provide broker-owned exchange/CAS and event delivery, and make recovery decisions before any host pathname is replaced. No direct host mount is used.

Run the adapter after starting an isolated Files service:

```sh
export SULLA_FILES_FUSE_TOKEN='short-lived capability'
python3 experimental/fuse/sulla_files_fuse.py \
  --url http://127.0.0.1:8792 \
  --collection COLLECTION_UUID \
  /path/to/mount
```

With the service web bundle built, the authentic `FilesBrowser` UI is at `http://127.0.0.1:PORT/files-proof/`. Post a short-lived synthetic capability from a same-origin parent or the browser console; do not put it in the URL:

```js
window.postMessage({ type: 'sulla:files-session', token: SYNTHETIC_TOKEN, orgId: 'synthetic-proof', email: 'Synthetic proof' }, location.origin)
```

For a reusable isolated demonstration, build the service TypeScript and web bundle, then run `node experimental/fuse/live-proof.mjs`. It creates a temporary Postgres cluster, synthetic source tree, authenticated Files runtime, and FUSE mount. The printed `/proof-control/` URL embeds the short-lived capability only in its same-origin HTML response and provides controls for an ordinary FUSE file-descriptor edit, an external source edit, reset, and status. Stop it with `SIGINT` or `SIGTERM`; the runtime unmounts FUSE and removes its synthetic files and database.
