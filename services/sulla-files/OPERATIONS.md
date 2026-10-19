# Database operation receipt foundation

This is stage one. It does not complete the Explorer operation feature set.
The exported request/response types are in `src/databaseOperations.ts`.
Apply `025_database_operation_receipts.sql` through normal service migration
before using these routes. No migration is run by this change.

## HTTP contract

`POST /v1/database-file-operations` accepts:

```ts
interface DatabaseOperationRequest {
  idempotencyKey: string; // caller-generated UUID, retained across retries
  collectionId: string;  // UUID
  action: 'move' | 'rename' | 'trash';
  fileId: string;        // UUID from service listing/detail
  expectedVersionId: string;
  expectedRevision: string; // operation_revision from listing/detail, decimal bigint
  targetPath?: string;   // required for move/rename; canonical relative path
  collisionPolicy?: 'keep-both' | 'skip'; // omitted means conflict
}
interface DatabaseOperationState {
  fileId: string;
  path: string;
  versionId: string;
  revision: string;
  deleted: boolean;
}
interface DatabaseOperationReceipt {
  operationId: string; // service-generated UUID, never inferred from listing
  collectionId: string;
  action: 'move' | 'rename' | 'trash';
  state: 'completed' | 'skipped' | 'undone';
  undoSupported: boolean; // true only for completed
  before: DatabaseOperationState;
  after: DatabaseOperationState;
  createdAt: string;
  undoneAt: string | null;
}
```

Trash forbids destination/collision fields. Successful requests return 200 and
the receipt. Replaying the identical request with the same actor/session scope
and key returns the existing receipt, including its current undone state.
Reusing a key for a different payload returns 409. After an ambiguous network
outcome, replay the original payload/key; do not generate a fresh key.
There is no automatic retry. Permissions are checked again on replay.

`POST /v1/database-file-operations/:operationId/undo` accepts no required body
and returns the same receipt shape. Repeated undo returns the undone receipt
after current authorization. Undo uses the recorded file/version/path/revision;
any intervening file update, including an ABA change, returns 409. Purged
files are never recreated. Copy is not implemented and cannot be undone.

The existing `POST /v1/trash/:id/restore` retains
`{ ok: true, versionId: string }`. It optionally accepts
`{ expectedVersionId: string }` for the selected tombstone. It locks the file,
rechecks permission and trash state, follows the current tombstone ancestry,
locks the source version, and inserts the restored version, refcounts,
journal and audit within one transaction. A second concurrent restore sees
the first result and returns 409 rather than creating a duplicate restore.
The legacy DELETE file route also reads its parent under the same lock and
keeps its 204 response, preventing a concurrent stale trash from branching off
the pre-restore parent. It does not issue a receipt.

## Concurrency and permissions

The receipt is inserted and finalized within the mutation transaction. A
transaction-scoped advisory lock serializes keys. A file table SHARE ROW
EXCLUSIVE lock also constrains legacy upload/restore/purge/watcher writers,
including namespace inserts that would not honor the advisory lock. File and
receipt row locks protect decisions. SHARE locks protect local ACL, protected
file and tracked-root metadata. Normal READ COMMITTED reads after acquiring
these locks see the latest committed state. Deadlocks, lock/statement timeouts,
serialization failures and unique conflicts return 409 without automatic retry.

This deliberately serializes file writes service-wide for a bounded operation;
lock timeout is 5 seconds and statement timeout is 15 seconds. Replace this
with a common per-collection namespace protocol only after every writer uses
it. The external organization identity database is rechecked during execution
but is not part of the Files database transaction.

Every file UPDATE advances `operation_revision`; background indexing can
therefore conservatively invalidate undo. Single-file moves retain file ID,
versions and direct grants. Moves across inherited folder-grant or public-link
boundaries are rejected. Trash adds a tombstone and keeps publication metadata;
undo restores its exact surviving parent pointer and retains the tombstone,
without deleting content/history. Current checkout and record locks apply.

## Exact remaining work

Copy, Replace, explicit empty folders, folder/batch operations, cancellation,
retry queues, adapters and renderer wiring are not implemented here. Those
actions return 422 on the new endpoint. Replace must preserve both source and
displaced identities/history and record/guard both states on undo. Copy and
Replace need lifecycle/publication and inherited-permission rules before a
receipt can promise a correct inverse. Empty-folder integration must reconcile
the separately owned stored-folder implementation.

Watched files and entire tracked-root collections are rejected with 422 by the
new receipt API, even if temporarily detached. The legacy
`POST /v1/file-operations` remains completion-only and explicitly reports
`undoSupported:false`; it produces no operation ID.

Native integration must extend the existing `files_path_operations` recovery
journal and `FilesMutationCoordinator`: persist source/target fingerprints,
root identity, displaced artifacts and inverse plan; validate current
permissions and file/version/revision under the native custody lock; persist
the user receipt in the same metadata commit as native publication state;
recover ambiguous commit/publication outcomes before retry; and run inverse
publication/quarantine through that coordinator. A metadata-only inverse or
unlink is not sufficient.

## Review evidence

Source and SQL reviewed against existing migrations, ACL resolution, lifecycle
triggers, native recovery and route callers. No builds, lint, typechecks, tests,
installs, production data reads, service changes or migration execution were
performed. Runtime PostgreSQL acceptance remains unverified.
