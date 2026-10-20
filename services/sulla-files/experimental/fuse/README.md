# Experimental Sulla Files FUSE adapter

This is a feasibility slice for a real Linux FUSE mount backed by the
authenticated Sulla Files service. It is off unless the service starts with
`SULLA_FILES_FUSE_EXPERIMENT=1`. The bearer capability is read from
`SULLA_FILES_FUSE_TOKEN`; it is never accepted on the command line.

## Native source boundary increment

The repository contains an experimental native source broker in
`pkg/rancher-desktop/main/sullaFilesSourceGateway.ts`. Electron registers one
exact regular file only after a native chooser, pins its descriptor/device/inode,
and returns an opaque random handle. Host paths and source capabilities never
enter Lima or a container.

Electron ingests bounded bytes through the authenticated local Files API.
`files_native_sources` is the durable handle-to-file index, separate from
watched-root configuration, and `files_native_source_operations` records each
source revision, Files base/result version, desired hash, and recovery state.
For FUSE writes, Files commits the new encrypted version and publication action
in one transaction. The production `SullaFilesNativeBroker` then reads that
exact version, conditionally writes the pinned source, verifies the result, and
completes the action before FUSE `flush` or `fsync` can succeed. Lock rejects new broker operations, waits
for active requests and publication work to drain, then closes descriptors and
revokes every session.

Production host-home, external-volume, and broad Darwin-temp mounts are removed
from the staged Lima configuration. Persisted mount arrays are replaced rather
than deep-merged, Files runs stored-only on encrypted chunks/named volumes, and
agent file tools use guest-owned homes/workspaces. Sulla/PostgreSQL application
data remains outside this change and retains its pre-change storage behavior.
The Files mount starts automatically. Authenticated callers can operate on all
non-system files. Logs and Training Data are structurally read-only; sensitive
wallet/vault paths and protected files remain excluded.

The exact staged host acceptance procedure is in
[`MACOS_NATIVE_PROOF.md`](./MACOS_NATIVE_PROOF.md). It uses one disposable
synthetic file and no existing Files, personal, Vault, wallet, credential, or
application data.

## Supported proof boundary

All tracked collections are exposed beneath `/mnt/sulla-files` and support
list, stat, read, create, truncate, positional write, flush, fsync, rename,
mkdir, unlink, rmdir, and close. Each write sends both the Files version in
`If-Match` and the indexed source SHA-256. A stale source leaves the external
source bytes current, imports them into the original Files entry with
base-version CAS, preserves the FUSE bytes as a visible conflict file, and
returns `EIO`.

Recovery never trusts a receipt by itself: it revalidates the opaque session,
source revision/hash, exact Files version, and result before completing the
action. A service or broker outage returns `EIO` from flush/fsync and is never
reported as a durable save.

Hard/symbolic links, xattrs, locks, mmap, cross-collection moves, and executable
workloads fail closed. Files collections appear as stable top-level directories
named `<collection-name>--<id-prefix>`.

Desktop runs one resource-capped FUSE infrastructure container attached to the
VM's shared `/mnt/sulla-files` anchor. Only that daemon receives `/dev/fuse` and
`SYS_ADMIN`; workflow and agent containers receive the propagated mount with
`rslave`, never either privilege. This keeps the adapter's pinned Python/FUSE
runtime reproducible while preserving the one-daemon design.

The reusable Linux proof exercises the same stored-only implementation: the
real Electron source-gateway class owns an exact synthetic descriptor, the real
Files service indexes only its opaque handle, and the real FUSE adapter
publishes through the durable action loop. It does not create a watched root or
bind a host path. The proof covers an ordinary FUSE write and a concurrent
external edit that returns `EIO` while preserving both visible versions. This
is end-to-end Linux evidence, but it is not the remaining native macOS
security-scoped-bookmark acceptance run. A noncooperating process can still
race after the broker's final comparison, so this experiment does not claim a
kernel-atomic CAS against arbitrary applications.

Run the adapter after starting an isolated Files service:

```sh
export SULLA_FILES_FUSE_TOKEN='short-lived capability'
python3 experimental/fuse/sulla_files_fuse.py \
  --url http://127.0.0.1:8792 \
  /path/to/mount
```

With the service web bundle built, the authentic `FilesBrowser` UI is at
`http://127.0.0.1:PORT/files-proof/`. Post a short-lived synthetic capability
from a same-origin parent or the browser console; do not put it in the URL:

```js
window.postMessage({ type: 'sulla:files-session', token: SYNTHETIC_TOKEN, orgId: 'synthetic-proof', email: 'Synthetic proof' }, location.origin)
```

For a reusable isolated demonstration, build the web bundle, then run
`../../node_modules/.bin/tsx experimental/fuse/live-proof.mjs` from
`services/sulla-files`. It loads the current TypeScript service, production
broker, and source gateway, then creates a temporary Postgres cluster,
stored-only Files runtime, synthetic exact-file source, and FUSE mount. The
printed
`/proof-control/` URL embeds the short-lived capability only in its same-origin
HTML response and provides controls for an ordinary FUSE file-descriptor edit,
an external source edit, deterministic lock/drain and session reselection,
reset, and status. Status output contains hashes and
Files ids/versions, not source contents or paths. Stop it with `SIGINT` or
`SIGTERM`, or use **Stop + clean** when a command wrapper does not forward
signals; the runtime unmounts FUSE and removes its synthetic files and database.

On macOS, the same harness has a native mode that runs the source gateway in a
dedicated Electron process, requires the chooser-issued security-scoped
bookmark for its generated synthetic file, and runs the unchanged Linux FUSE
adapter inside a disposable resource-capped Docker container. It does not
launch Desktop or read application data. The exact prerequisites, build/run
commands, evidence restrictions, and cleanup checks are in
[`MACOS_NATIVE_PROOF.md`](./MACOS_NATIVE_PROOF.md).
The harness still cannot retain its isolated state across an actual process
relaunch, so it does not prove the interrupted-publication restart trace and
must not be treated as complete native acceptance evidence.
