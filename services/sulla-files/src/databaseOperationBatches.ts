import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FilesIdentity } from './auth.js';
import { createDatabaseFolder, executeDatabaseOperation, parseDatabaseOperation, transaction, undoDatabaseOperation,
  type DatabaseOperationAccess, type DatabaseOperationRequest, type DatabaseOperationState } from './databaseOperations.js';

export type DatabaseCollisionPolicy = 'replace'|'keep-both'|'skip';
export type DatabaseBatchState = 'pending'|'completed'|'partial'|'failed'|'cancelled'|'undone';
export type DatabaseItemState = 'pending'|'completed'|'skipped'|'failed'|'cancelled'|'undone';
export interface DatabaseFolderState { folderId:string; path:string; revision:string }
export interface DatabaseBatchItem extends Omit<DatabaseOperationRequest,'idempotencyKey'|'collectionId'|'action'|'fileId'|'expectedVersionId'|'expectedRevision'> {
  itemId:string;
  action:'move'|'copy'|'rename'|'trash'|'create-folder';
  fileId?:string; expectedVersionId?:string; expectedRevision?:string;
}
export interface DatabaseBatchRequest { idempotencyKey:string; collectionId:string; items:DatabaseBatchItem[] }
export interface DatabaseRetryRequest { items?:{ itemId:string; collisionPolicy?:DatabaseCollisionPolicy; expectedDestination?:DatabaseOperationState }[] }
export interface DatabaseItemError { status:number; code:string; message:string; destination?:DatabaseOperationState }
export interface DatabaseBatchItemReceipt {
  itemId:string; action:DatabaseBatchItem['action']; state:DatabaseItemState; receiptId:string|null;
  before:DatabaseOperationState|null; after:DatabaseOperationState|DatabaseFolderState|null;
  displacedBefore?:DatabaseOperationState; displacedAfter?:DatabaseOperationState;
  error:DatabaseItemError|null; undoSupported:boolean; retryable:boolean;
}
export interface DatabaseBatchReceipt {
  operationId:string; collectionId:string; state:DatabaseBatchState; cancelRequested:boolean;
  undoSupported:boolean; retryable:boolean; createdAt:string; updatedAt:string; items:DatabaseBatchItemReceipt[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scope = (actor:FilesIdentity):string => JSON.stringify([actor.kind, actor.deviceId, actor.agentId ?? '', actor.jobId ?? '', actor.threadId ?? '']);
const fail = (status:number, message:string, code='invalid-operation'):Error => Object.assign(new Error(message), { status, code });
const pathValid = (path:unknown):path is string => typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes('\0') && path.split('/').every(p => p && p !== '.' && p !== '..');
function validateItem(item:any, collectionId:string):DatabaseBatchItem {
  if (!item || typeof item.itemId !== 'string' || !uuid.test(item.itemId)) throw fail(400, 'itemId must be a UUID');
  if (item.action === 'create-folder') {
    if (!pathValid(item.targetPath) || (item.collisionPolicy !== undefined && !['keep-both','skip'].includes(item.collisionPolicy))) throw fail(400, 'Folder creation requires a canonical path and optional keep-both or skip policy');
    return { itemId: item.itemId.toLowerCase(), action: 'create-folder', targetPath: item.targetPath, ...(item.collisionPolicy ? { collisionPolicy: item.collisionPolicy } : {}) };
  }
  const { idempotencyKey: _key, collectionId: _collection, ...parsed } = parseDatabaseOperation({ ...item, collectionId, idempotencyKey: item.itemId });
  return { ...parsed, itemId: item.itemId.toLowerCase() };
}
export function parseDatabaseBatch(value:any):DatabaseBatchRequest {
  if (!value || typeof value.idempotencyKey !== 'string' || !uuid.test(value.idempotencyKey) || typeof value.collectionId !== 'string' || !uuid.test(value.collectionId)) throw fail(400, 'idempotencyKey and collectionId must be UUIDs');
  // Preserve the original single-item request form on the same endpoint.
  const raw = value.items ?? [{ ...value, itemId: value.idempotencyKey }];
  if (!Array.isArray(raw) || !raw.length || raw.length > 250) throw fail(400, 'Supply 1-250 items');
  const items = raw.map(item => validateItem(item, value.collectionId));
  if (new Set(items.map(item => item.itemId)).size !== items.length) throw fail(400, 'Duplicate itemId');
  return { idempotencyKey: value.idempotencyKey.toLowerCase(), collectionId: value.collectionId.toLowerCase(), items };
}
async function owner(client:pg.PoolClient, id:string, actor:FilesIdentity, lock=true):Promise<any> {
  if (!uuid.test(id)) throw fail(400, 'operationId must be a UUID');
  const row = (await client.query('SELECT * FROM files_database_operation_batches WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3' + (lock ? ' FOR UPDATE' : ''), [id, actor.userId, scope(actor)])).rows[0];
  if (!row) throw fail(404, 'Operation not found');
  return row;
}
async function authorize(client:pg.PoolClient, row:any, access:DatabaseOperationAccess):Promise<void> {
  for (const item of (row.request as DatabaseBatchRequest).items) {
    if (item.fileId) await access.file(client, item.fileId);
    else await access.path(client, row.collection_id, item.targetPath!);
  }
  if (row.item_keys) {
    const receipts = (await client.query('SELECT after_state,displaced_after FROM files_database_operation_receipts WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=ANY($3::uuid[])', [row.actor_user_id,row.actor_scope,Object.values(row.item_keys)])).rows;
    for (const receipt of receipts) {
      for (const state of [receipt.after_state,receipt.displaced_after]) {
        if (state?.fileId) await access.file(client,state.fileId);
        else if (state?.folderId) await access.path(client,row.collection_id,state.path);
      }
    }
    for (const error of Object.values(row.errors) as DatabaseItemError[]) if (error.destination) await access.file(client,error.destination.fileId);
  }
}
async function itemRows(client:pg.PoolClient, row:any, actor:FilesIdentity):Promise<any[]> {
  return (await client.query('SELECT * FROM files_database_operation_receipts WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=ANY($3::uuid[])', [actor.userId, scope(actor), Object.values(row.item_keys)])).rows;
}
async function view(client:pg.PoolClient, row:any, actor:FilesIdentity):Promise<DatabaseBatchReceipt> {
  const receipts = await itemRows(client, row, actor);
  const items:DatabaseBatchItemReceipt[] = row.request.items.map((item:DatabaseBatchItem) => {
    const stored = receipts.find(r => r.idempotency_key === row.item_keys[item.itemId]);
    const error = row.errors[item.itemId] ?? null;
    const state:DatabaseItemState = stored?.state ?? (row.cancelled ? 'cancelled' : error ? 'failed' : 'pending');
    return { itemId: item.itemId, action: item.action, state, receiptId: stored?.id ?? null,
      before: stored?.before_state ?? null, after: stored?.after_state ?? null,
      ...(stored?.displaced_before ? { displacedBefore: stored.displaced_before, displacedAfter: stored.displaced_after } : {}),
      error, undoSupported: state === 'completed', retryable: ['pending','failed','cancelled'].includes(state) };
  });
  const state:DatabaseBatchState = items.some(i => i.state === 'pending') ? 'pending'
    : items.every(i => i.state === 'undone' || i.state === 'skipped') && items.some(i => i.state === 'undone') ? 'undone'
      : items.every(i => i.state === 'completed' || i.state === 'skipped') ? (items.some(i => i.error) ? 'partial' : 'completed')
        : items.some(i => i.state === 'completed' || i.state === 'undone') ? 'partial' : row.cancelled ? 'cancelled' : 'failed';
  return { operationId: row.id, collectionId: row.collection_id, state, cancelRequested: row.cancelled,
    undoSupported: items.some(i => i.undoSupported), retryable: items.some(i => i.retryable),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), items };
}
export async function databaseOperationCapabilities(db:pg.Pool, collectionId:string, access:DatabaseOperationAccess):Promise<{ enabled:boolean; reason?:string }> {
  if (!uuid.test(collectionId)) throw fail(400, 'collectionId must be a UUID');
  return transaction(db, async client => {
    // The caller authorizes collection visibility before invoking discovery.
    const native = (await client.query('SELECT 1 FROM file_roots WHERE collection_id=$1', [collectionId])).rowCount;
    return native ? { enabled: false, reason: 'native-custody-required' } : { enabled: true };
  });
}
export async function submitDatabaseBatch(db:pg.Pool, input:DatabaseBatchRequest, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> {
  await access.prepare?.(input.collectionId);
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([actor.userId, scope(actor), input.idempotencyKey])]);
    const prior = (await client.query('SELECT *,request=$4::jsonb AS same_request FROM files_database_operation_batches WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=$3 FOR UPDATE', [actor.userId, scope(actor), input.idempotencyKey, input])).rows[0];
    if (prior) {
      if (!prior.same_request) throw fail(409, 'Idempotency key already used for another request', 'idempotency-conflict');
      await authorize(client, prior, access);
      return view(client, prior, actor);
    }
    await authorize(client, { request: input, collection_id: input.collectionId }, access);
    if ((await client.query('SELECT 1 FROM file_roots WHERE collection_id=$1', [input.collectionId])).rowCount) throw fail(422, 'Native operations require the custody coordinator', 'native-custody-required');
    const keys = Object.fromEntries(input.items.map(item => [item.itemId, randomUUID()]));
    const row = (await client.query(`INSERT INTO files_database_operation_batches(actor_user_id,actor_scope,idempotency_key,collection_id,request,item_keys)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [actor.userId, scope(actor), input.idempotencyKey, input.collectionId, input, keys])).rows[0];
    return view(client, row, actor);
  });
}
export async function getDatabaseBatch(db:pg.Pool, id:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> {
  await prepareBatch(db,id,actor,access);
  return transaction(db, async client => { const row = await owner(client, id, actor, false); await authorize(client, row, access); return view(client, row, actor) });
}
async function prepareBatch(db:pg.Pool,id:string,actor:FilesIdentity,access:DatabaseOperationAccess):Promise<void> {
  if (!uuid.test(id)) throw fail(400,'operationId must be a UUID');
  const row = (await db.query('SELECT collection_id FROM files_database_operation_batches WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3',[id,actor.userId,scope(actor)])).rows[0];
  if (!row) throw fail(404,'Operation not found');
  await access.prepare?.(row.collection_id);
}
function safeError(error:any):DatabaseItemError {
  const status = typeof error.status === 'number' ? error.status : 500;
  return { status, code: typeof error.code === 'string' && !/^[0-9A-Z]{5}$/.test(error.code) ? error.code : status === 409 ? 'state-conflict' : 'operation-failed',
    message: status < 500 ? error.message : 'The item could not be committed; retry using the same operation.', ...(error.destination ? { destination: error.destination } : {}) };
}
export async function runDatabaseBatch(db:pg.Pool, id:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<void> {
  const batch = await transaction(db, client => owner(client, id, actor));
  for (const original of batch.request.items as DatabaseBatchItem[]) {
    let input:any;
    const guard = async(client:pg.PoolClient) => {
      const row = await owner(client, id, actor);
      if (row.cancelled || row.errors[original.itemId]) throw fail(409, 'Item is not pending', 'item-not-pending');
      const receipts = await itemRows(client, row, actor);
      if (receipts.some(r => r.idempotency_key === row.item_keys[original.itemId])) throw fail(409, 'Item already committed', 'item-not-pending');
      const effective = validateItem({ ...original, ...row.overrides[original.itemId] }, row.collection_id);
      input = { ...effective, collectionId: row.collection_id, idempotencyKey: row.item_keys[original.itemId] };
      // The execution snapshot must match the policies read before starting.
      if (JSON.stringify(input) !== JSON.stringify(planned)) throw fail(409, 'Retry policy changed', 'item-not-pending');
      await client.query('UPDATE files_database_operation_batches SET updated_at=NOW() WHERE id=$1', [id]);
    };
    const row = await transaction(db, client => owner(client, id, actor));
    const planned = { ...validateItem({ ...original, ...row.overrides[original.itemId] }, row.collection_id), collectionId: row.collection_id, idempotencyKey: row.item_keys[original.itemId] };
    try {
      if (planned.action === 'create-folder') await createDatabaseFolder(db, planned as any, actor, access, guard);
      else await executeDatabaseOperation(db, planned as DatabaseOperationRequest, actor, access, guard);
    } catch (error:any) {
      if (error.code === 'item-not-pending') continue;
      await transaction(db, async client => {
        const latest = await owner(client, id, actor);
        // A lost COMMIT response must not turn durable success into failure.
        if ((await itemRows(client, latest, actor)).some(r => r.idempotency_key === latest.item_keys[original.itemId])) return;
        await client.query('UPDATE files_database_operation_batches SET errors=jsonb_set(errors,ARRAY[$2],$3::jsonb),updated_at=NOW() WHERE id=$1', [id, original.itemId, safeError(error)]);
      });
    }
  }
}
export async function controlDatabaseBatch(db:pg.Pool, id:string, action:'cancel'|'retry'|'undo', body:any, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> {
  await prepareBatch(db,id,actor,access);
  const result = await transaction(db, async client => {
    const row = await owner(client, id, actor); await authorize(client, row, access);
    const receipt = await view(client, row, actor);
    if (action === 'retry') {
      if (body?.items !== undefined && (!Array.isArray(body.items) || body.items.length > 250)) throw fail(400, 'retry items must be an array');
      const selected = body?.items ?? receipt.items.filter(i => i.retryable).map(i => ({ itemId: i.itemId }));
      if (new Set(selected.map((i:any) => i.itemId)).size !== selected.length) throw fail(400, 'Duplicate retry item');
      for (const update of selected) {
        const item = receipt.items.find(i => i.itemId === update.itemId);
        if (!item?.retryable) throw fail(409, 'Only pending, failed or cancelled items can be retried');
        const original = row.request.items.find((i:DatabaseBatchItem) => i.itemId === update.itemId);
        const override = { ...row.overrides[update.itemId], ...(update.collisionPolicy !== undefined ? { collisionPolicy: update.collisionPolicy, expectedDestination: update.expectedDestination } : {}) };
        validateItem({ ...original, ...override }, row.collection_id);
        row.overrides[update.itemId] = override; delete row.errors[update.itemId];
      }
      // Non-selected uncommitted items stay paused as durable errors.
      for (const item of receipt.items.filter(i => i.retryable && !selected.some((s:any) => s.itemId === i.itemId))) row.errors[item.itemId] ??= { status:409,code:'not-selected',message:'Not selected for retry' };
      row.cancelled = false;
    } else row.cancelled = true; // Undo first stops forward execution.
    const updated = (await client.query('UPDATE files_database_operation_batches SET cancelled=$2,errors=$3,overrides=$4,updated_at=NOW() WHERE id=$1 RETURNING *', [id, row.cancelled, row.errors, row.overrides])).rows[0];
    return view(client, updated, actor);
  });
  if (action === 'undo') {
    for (const item of [...result.items].reverse().filter(i => i.undoSupported)) {
      try {
        await undoDatabaseOperation(db, item.receiptId!, actor, access, async client => {
          const row = await owner(client,id,actor);
          if (!row.cancelled) throw fail(409, 'Forward execution resumed; undo stopped');
        });
        await transaction(db, async client => { await owner(client,id,actor); await client.query('UPDATE files_database_operation_batches SET errors=errors-$2,updated_at=NOW() WHERE id=$1', [id,item.itemId]) });
      } catch (error:any) {
        await transaction(db, async client => { await owner(client,id,actor); await client.query('UPDATE files_database_operation_batches SET errors=jsonb_set(errors,ARRAY[$2],$3::jsonb),updated_at=NOW() WHERE id=$1', [id,item.itemId,safeError(error)]) });
      }
    }
    return getDatabaseBatch(db,id,actor,access);
  }
  return result;
}
