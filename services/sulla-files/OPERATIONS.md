# Database Explorer operation contract

Canonical exported types: `src/databaseOperationBatches.ts`, with file snapshots
from `src/databaseOperations.ts`. This extends the existing endpoint; it does not
add a duplicate mutation API. Apply 025_database_operation_receipts and
027_database_operation_batches through normal service migration before enabling.

## HTTP routes

- GET /v1/database-file-operations/capabilities?collectionId=UUID:
  { enabled: boolean, reason?: 'native-custody-required' }. Missing route on an
  older service means unsupported. Discovery requires current edit access.
- POST /v1/database-file-operations: DatabaseBatchRequest; HTTP 202 durable batch,
  returned before background processing starts. Legacy single-item input is
  accepted but now also returns a batch.
- GET /v1/database-file-operations/:operationId: HTTP 200 DatabaseBatchReceipt.
- POST /v1/database-file-operations/:operationId/cancel: same receipt shape.
- POST /v1/database-file-operations/:operationId/retry: DatabaseRetryRequest,
  same receipt shape before resumed processing starts.
- POST /v1/database-file-operations/:operationId/undo: same receipt shape after
  reverse-order inverse attempts. Individual failures remain visible.
- GET /v1/folders?collectionId=UUID: string[] of authorized explicit folder paths,
  matching PR1230. No placeholder files.

## Exact adapter types

```ts
type DatabaseCollisionPolicy = 'replace' | 'keep-both' | 'skip';
type DatabaseBatchState = 'pending' | 'completed' | 'partial' |
  'failed' | 'cancelled' | 'undone';
type DatabaseItemState = 'pending' | 'completed' | 'skipped' |
  'failed' | 'cancelled' | 'undone';
interface DatabaseOperationState {
  fileId: string; path: string; versionId: string;
  revision: string; deleted: boolean;
}
interface DatabaseFolderState {
  folderId: string; path: string; revision: string;
}
interface DatabaseBatchItem {
  itemId: string;
  action: 'move' | 'copy' | 'rename' | 'trash' | 'create-folder';
  fileId?: string; expectedVersionId?: string; expectedRevision?: string;
  targetPath?: string; collisionPolicy?: DatabaseCollisionPolicy;
  expectedDestination?: DatabaseOperationState;
}
interface DatabaseBatchRequest {
  idempotencyKey: string; collectionId: string;
  items: DatabaseBatchItem[];
}
interface DatabaseRetryRequest {
  items?: {
    itemId: string; collisionPolicy?: DatabaseCollisionPolicy;
    expectedDestination?: DatabaseOperationState;
  }[];
}
interface DatabaseItemError {
  status: number; code: string; message: string;
  destination?: DatabaseOperationState;
}
interface DatabaseBatchItemReceipt {
  itemId: string; action: DatabaseBatchItem['action'];
  state: DatabaseItemState; receiptId: string | null;
  before: DatabaseOperationState | null;
  after: DatabaseOperationState | DatabaseFolderState | null;
  displacedBefore?: DatabaseOperationState;
  displacedAfter?: DatabaseOperationState;
  error: DatabaseItemError | null;
  undoSupported: boolean; retryable: boolean;
}
interface DatabaseBatchReceipt {
  operationId: string; collectionId: string; state: DatabaseBatchState;
  cancelRequested: boolean; undoSupported: boolean; retryable: boolean;
  createdAt: string; updatedAt: string;
  items: DatabaseBatchItemReceipt[];
}
```

All IDs are UUIDs. Supply 1–250 ordered items with unique itemId values.
File actions require fileId, expectedVersionId and expectedRevision. Listing/detail
already return operation_revision as a decimal string; adapters map it to
operationRevision without converting bigint to number. Move/copy/rename require
a canonical relative targetPath. Trash forbids destination/collision fields.
Create-folder requires targetPath and optionally keep-both/skip; no Replace.

Submission keys are scoped to authenticated user/device/agent/job/thread identity.
Identical replay returns the existing batch; a changed payload returns HTTP409
idempotency-conflict. After an ambiguous HTTP result, replay the original key and
payload. Internal per-item keys and receipt IDs are service-generated. The initial
request remains immutable; retry policies are stored separately.

Omit retry items to resume pending/failed/cancelled items unchanged. An explicit
array selects only those items. Completed/skipped/undone items cannot be rerun or
overridden. Apply All expands to explicit item overrides; Replace needs a separately
acknowledged destination snapshot for EACH item. Source CAS never silently refreshes:
a changed source requires a new operation.

Destination collisions return failed items with error.status=409 and
error.code='destination-conflict'. Exact destination snapshots are included only
after edit authorization. Folder/prefix collisions can lack a destination snapshot;
do not offer Replace then. Other CAS/race errors use state-conflict. Request errors
use HTTP status plus { error: string, code: string }. Native-root submission returns
HTTP422 native-custody-required. Never silently fall back after an ambiguous request.

## Atomicity, cancellation and recovery

The batch header is durable before work starts. Each successful/skipped item receipt,
mutation, journal/audit and batch timestamp commit together. Failure bookkeeping
follows rollback and checks for a committed receipt first, including after an
ambiguous COMMIT response. A crash before error bookkeeping leaves a pending item
safe to resume. No startup worker retains old authorization: explicit retry obtains
fresh membership and resumes uncommitted items. Pending does not promise a running
process. Polling does not acquire batch row write locks. Cancel waits only for the
current metadata transaction and stops subsequent items; committed work remains.

Undo first stops forward execution, then attempts completed items in reverse order.
It is not whole-batch rollback. Successful inverses remain committed if another
fails. Failed inverses retain their completed state with error information.

External identity membership queries run before transactions and refresh for each
attempted item. Local ACL/protected-file/native-root/CAS decisions are rechecked
inside SERIALIZABLE transactions. Namespace triggers make legacy path writers
participate in the per-collection advisory-lock protocol. No service-wide files
table lock spans network/content operations; new item transactions only manipulate
database metadata. Lock/serialization/deadlock conflicts fail without automatic
retry. External membership revocation is not atomically coupled to Files; the
prepared membership is the authorization snapshot for that item.

## Copy, Replace and guarded inverses

Copy references immutable manifests/chunks and increments refcounts, including
remote key-context records. It preserves current/published visibility, lifecycle
policy and direct grants. Original history is unchanged; historical versions and
public-link bearer tokens are not duplicated into the new identity. Moves/copies
across inherited folder/public-link audience boundaries are rejected.

Replace CAS-checks the displayed destination identity/version/revision. The displaced
file moves to a unique .replaced-<receipt UUID>-<name> sibling, preserving its ID,
history, publication and direct grants. It remains a real visible recovery file.
The incoming identity occupies the requested path. Undo guards both identities;
changing the recovery file invalidates it. Copy undo moves the copy into Trash at
a unique .undone-<receipt UUID> path, preserving history/chunks. No inverse purges.

Semantic revisions and permission/public-link signatures guard undo. Indexing-only
fields do not advance revision; file/lifecycle/path/expiry and version-publication
changes do. Empty-folder undo requires its same ID/revision and no children/grants.
It deletes only the created metadata row.

Folder schema reconciles 026_stored_folders from feat/files-fuse-proof:
file_folders(collection_id,path,created_by_type,created_by_id,created_at,updated_at).
027 adds folder identity/revision. When integrating PR1230, keep its unchanged 026
before 027; do not create a competing folder table.

## Native boundary and outstanding acceptance

Folder move/copy/trash remain legacy completion-only operations. Do not invent file
IDs for folders or advertise receipt/undo/cancel/retry for those paths. This database
slice does not complete all 14 Explorer features or native custody undo.

Legacy native Trash/restore retain their old metadata-only semantics, now with locked
current tombstone ancestry. They do not issue native receipts or promise local
filesystem publication/inversion. New receipts reject tracked-root collections and
watched identities even if temporarily detached.

Native follow-up must extend files_path_operations and FilesMutationCoordinator:
persist root identities/fingerprints/displaced artifacts/inverse plans; validate
permission and CAS under custody; commit user receipts with metadata; recover
ambiguous publication/commit before retry; run inverse publication/quarantine
through that coordinator. Metadata-only inversion or direct unlink is insufficient.

Validation: source/SQL/caller review and git diff --check only. No production builds,
lint, typechecks, tests, installs, migrations, service changes, host commands or
private-data reads. Runtime PostgreSQL and integrated adapter/browser acceptance
remain parent verification work.
