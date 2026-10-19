# Native macOS Files/FUSE acceptance proof

This is the required acceptance run before `SULLA_FILES_NATIVE_SOURCE_READY`
can become `true`. It is deliberately staged, not executed by this change. The
run must use a reviewed Desktop proof build and disposable synthetic data only.
It must not inspect, copy, migrate, mount, or modify personal files, credentials,
wallet/vault data, existing Files data, or Sulla/PostgreSQL application data.

## Setup

1. Confirm the build contains no broad Home mount and keeps
   `SULLA_FILES_NATIVE_SOURCE_READY=false` in committed source.
2. For the reviewed proof build only, enable the native readiness constant and
   start with `SULLA_FILES_FUSE_EXPERIMENT=1`. Do not remount or restart a live
   installation; use the isolated proof instance.
3. Create a new temporary directory containing one short text file with a known
   synthetic value. Do not reuse any existing user file.
4. In Files, choose **Add native file** and select exactly that file. Confirm the
   Files service receives an opaque handle and display name, never its host path
   or a source capability.

## Required traces

Record identifiers, revisions, hashes, and status codes only. Do not record file
contents, credentials, bookmarks, capabilities, or host paths.

1. **Reachability:** refresh Files and the FUSE mount. The selected file must be
   visible from the durable native-source index despite the runtime having no
   configured watched root.
2. **Ordinary write:** open the existing mounted file in place, change its
   synthetic bytes, call `fsync`, and close it. `fsync` must wait until the
   native source hash/revision and Files current version match the durable
   publication result. Read both surfaces and compare hashes.
3. **External refresh:** edit the selected source directly, wait for the bounded
   Electron poll, and refresh the mount. Files must advance from the recorded
   base version with CAS and expose the new hash.
4. **Concurrent conflict:** hold a stale in-place FUSE edit, change the native
   source directly, then flush the FUSE handle. Flush must return `EIO`; the
   external bytes must remain in the original Files entry and the stale FUSE
   bytes must exist in a visible `conflicted copy Files` entry. Verify both
   hashes and their Files version ids.
5. **Lock and drain:** begin a publication, lock Files, and confirm lock rejects
   new broker requests and does not complete until in-flight source and Files
   operations have drained or reached durable recovery. The old opaque handle
   must fail after lock.
6. **Session recovery:** unlock/relaunch without reusing the old handle. Files
   must show **Reselect source**. Reselect the same disposable file, confirm a
   new handle is indexed, and confirm the revoked handle remains unusable.
7. **Interrupted publication:** stop the isolated proof instance after source
   publication but before acknowledgement, then relaunch and reselect. Recovery
   may complete only after comparing the revalidated source revision/hash with
   the exact Files base/result versions; an operation receipt alone is not
   sufficient.

## Exit criteria

The readiness constant may be proposed for review only when every trace above
is captured from the same implementation used by Desktop, no direct host mount
or FUSE-to-host path exists, and all temporary synthetic data is removed. Any
unexpected acknowledgement, missing visible conflict, reused revoked handle,
or source/Files hash mismatch fails the proof.
