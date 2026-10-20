import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FilesIdentity } from './auth.js';
import { executeFolderBatchItem,undoFolderBatchItem } from './folderOperationBatches.js';
import { requestOperationCancellation,clearOperationCancellation } from './operationCancellation.js';
import { createDatabaseFolder, executeDatabaseOperation, parseDatabaseOperation, transaction, undoDatabaseOperation,
  type DatabaseOperationAccess, type DatabaseOperationRequest, type DatabaseOperationState } from './databaseOperations.js';

export type DatabaseCollisionPolicy = 'replace'|'keep-both'|'skip';
export type DatabaseBatchState = 'pending'|'completed'|'partial'|'failed'|'cancelled'|'undone';
export type DatabaseItemState = 'pending'|'completed'|'skipped'|'failed'|'cancelled'|'undone';
export interface DatabaseFolderState { collectionId?:string; folderId?:string; path:string; revision?:string; subtreeSignature?:string }
interface DatabaseBatchItemBase extends Omit<DatabaseOperationRequest,'idempotencyKey'|'collectionId'|'action'|'fileId'|'expectedVersionId'|'expectedRevision'|'expectedDestination'> {
  itemId:string;
  action:'move'|'copy'|'rename'|'trash'|'create-folder';
  fileId?:string; expectedVersionId?:string; expectedRevision?:string;
  kind?:'file'|'folder'; folderPath?:string; expectedFolder?:DatabaseFolderState; sourceSubtreeSignature?:string; targetCollectionId?:string;
}
export interface DatabaseFileBatchItem extends DatabaseBatchItemBase {
  kind?:'file'; action:'move'|'copy'|'rename'|'trash';
  fileId:string; expectedVersionId:string; expectedRevision:string;
  expectedDestination?:DatabaseOperationState;
  folderPath?:never; expectedFolder?:never; sourceSubtreeSignature?:never;
}
export interface DatabaseFolderBatchItem extends DatabaseBatchItemBase {
  kind:'folder'; action:'move'|'copy'|'rename'|'trash'; folderPath:string;
  fileId?:never; expectedVersionId?:never; expectedRevision?:never;
  collisionPolicy?:DatabaseCollisionPolicy;
  expectedDestination?:DatabaseFolderState;
}
export interface DatabaseCreateFolderBatchItem extends DatabaseBatchItemBase {
  kind?:'file'; action:'create-folder'; targetPath:string;
  fileId?:never; expectedVersionId?:never; expectedRevision?:never; folderPath?:never; expectedFolder?:never; sourceSubtreeSignature?:never;
  collisionPolicy?:'keep-both'|'skip';
}
export type DatabaseBatchItem=DatabaseFileBatchItem|DatabaseFolderBatchItem|DatabaseCreateFolderBatchItem;
export interface DatabaseBatchRequest { idempotencyKey:string; collectionId:string; items:DatabaseBatchItem[] }
export interface DatabaseRetryRequest { items?:{ itemId:string; collisionPolicy?:DatabaseCollisionPolicy; expectedDestination?:DatabaseOperationState|DatabaseFolderState }[] }
export interface DatabaseItemError { status:number; code:string; message:string; destination?:DatabaseOperationState|DatabaseFolderState }
export interface DatabaseBatchItemReceipt {
  itemId:string; action:DatabaseBatchItem['action']; state:DatabaseItemState; receiptId:string|null;
  before:DatabaseOperationState|DatabaseFolderState|null; after:DatabaseOperationState|DatabaseFolderState|null;
  displacedBefore?:DatabaseOperationState|DatabaseFolderState; displacedAfter?:DatabaseOperationState|DatabaseFolderState;
  error:DatabaseItemError|null; undoSupported:boolean; retryable:boolean;
}
export interface DatabaseBatchReceipt {
  operationId:string; collectionId:string; state:DatabaseBatchState; cancelRequested:boolean;
  undoSupported:boolean; retryable:boolean; createdAt:string; updatedAt:string; items:DatabaseBatchItemReceipt[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scope = (actor:FilesIdentity):string => JSON.stringify([actor.kind, actor.deviceId, actor.agentId ?? '', actor.jobId ?? '', actor.threadId ?? '']);
const fail = (status:number, message:string, code='invalid-operation'):Error => Object.assign(new Error(message), { status, code });
const pathValid = (path:unknown):path is string => typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes('\0') && path.split('/').every(p => p && p !== '.' && p !== '..' && p!=='.sulla-trash' && p!=='.sulla-operation-recovery');
function validateItem(item:any, collectionId:string):DatabaseBatchItem {
  if (!item || typeof item.itemId !== 'string' || !uuid.test(item.itemId)) throw fail(400, 'itemId must be a UUID');
  if (item.targetCollectionId!==undefined && (typeof item.targetCollectionId!=='string' || !uuid.test(item.targetCollectionId))) throw fail(400,'targetCollectionId must be a UUID');
  if (item.kind!==undefined && !['file','folder'].includes(item.kind)) throw fail(400,'Unknown item kind');
  if (item.kind==='folder') {
    if (!['move','copy','rename','trash'].includes(item.action) || !pathValid(item.folderPath) || item.fileId!==undefined || item.expectedVersionId!==undefined) throw fail(400,'Folder operations require folderPath and no file identity');
    if (item.targetCollectionId!==undefined && !['move','copy'].includes(item.action)) throw fail(400,'Only folder move/copy accept targetCollectionId');
    if (item.action!=='trash' && !pathValid(item.targetPath)) throw fail(400,'Folder targetPath must be canonical');
    if (item.action==='trash' && (item.targetPath!==undefined || item.collisionPolicy!==undefined || item.targetCollectionId!==undefined)) throw fail(400,'Trash has no destination');
    if (item.collisionPolicy!==undefined && !['replace','keep-both','skip'].includes(item.collisionPolicy)) throw fail(400,'Folder collisions support Replace, Keep Both or Skip');
    if (item.expectedFolder && (!uuid.test(item.expectedFolder.folderId) || item.expectedFolder.path!==item.folderPath || typeof item.expectedFolder.revision!=='string' || !/^[0-9]+$/.test(item.expectedFolder.revision) ||
      (item.expectedFolder.collectionId!==undefined && item.expectedFolder.collectionId!==collectionId))) throw fail(400,'Invalid expectedFolder snapshot');
    const sourceSignature=item.sourceSubtreeSignature??item.expectedFolder?.subtreeSignature;
    if (item.targetCollectionId && item.targetCollectionId!==collectionId && (typeof sourceSignature!=='string' || !/^[0-9a-f]{64}$/.test(sourceSignature))) throw fail(400,'Cross-collection folders require the displayed source subtree signature');
    if (item.collisionPolicy==='replace' && (!item.expectedDestination || !uuid.test(item.expectedDestination.folderId) || item.expectedDestination.path!==item.targetPath || typeof item.expectedDestination.revision!=='string' || !/^\d+$/.test(item.expectedDestination.revision) || typeof item.expectedDestination.subtreeSignature!=='string' || !/^[0-9a-f]{64}$/.test(item.expectedDestination.subtreeSignature) ||
      (item.expectedDestination.collectionId!==undefined && item.expectedDestination.collectionId!==(item.targetCollectionId??collectionId)))) throw fail(400,'Folder Replace requires the displayed destination collection, identity, revision and subtree signature');
    if (item.collisionPolicy!=='replace' && item.expectedDestination!==undefined) throw fail(400,'expectedDestination is only accepted for folder Replace');
    return { itemId:item.itemId.toLowerCase(),kind:'folder',action:item.action,folderPath:item.folderPath,
      ...(item.expectedFolder?{expectedFolder:item.expectedFolder}:{}),...(item.targetPath?{targetPath:item.targetPath}:{}),
      ...(sourceSignature?{sourceSubtreeSignature:sourceSignature}:{}),
      ...(item.collisionPolicy?{collisionPolicy:item.collisionPolicy}:{}),...(item.expectedDestination?{expectedDestination:item.expectedDestination}:{}),
      ...(item.targetCollectionId?{targetCollectionId:item.targetCollectionId.toLowerCase()}:{}) };
  }
  if (item.action === 'create-folder') {
    if (!pathValid(item.targetPath) || (item.collisionPolicy !== undefined && !['keep-both','skip'].includes(item.collisionPolicy))) throw fail(400, 'Folder creation requires a canonical path and optional keep-both or skip policy');
    return { itemId: item.itemId.toLowerCase(), action: 'create-folder', targetPath: item.targetPath, ...(item.collisionPolicy ? { collisionPolicy: item.collisionPolicy } : {}) };
  }
  const { idempotencyKey: _key, collectionId: _collection, ...parsed } = parseDatabaseOperation({ ...item, collectionId, idempotencyKey: item.itemId });
  return { ...parsed, itemId: item.itemId.toLowerCase(),...(item.targetCollectionId?{targetCollectionId:item.targetCollectionId.toLowerCase()}:{}) };
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
  const row = (await client.query('SELECT * FROM files_database_operation_batches WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])).rows[0];
  if (!row) throw fail(404, 'Operation not found');
  return row;
}
async function authorize(client:pg.PoolClient, row:any, access:DatabaseOperationAccess):Promise<void> {
  for (const item of (row.request as DatabaseBatchRequest).items) {
    if (item.fileId) await access.file(client, item.fileId);
    else await access.path(client, row.collection_id, item.folderPath ?? item.targetPath!);
    if (item.targetPath) await access.path(client,item.targetCollectionId ?? row.collection_id,item.targetPath);
  }
  if (row.item_keys) {
    const receipts = (await client.query('SELECT after_state,displaced_after FROM files_database_operation_receipts WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=ANY($3::uuid[])', [row.actor_user_id,row.actor_scope,Object.values(row.item_keys)])).rows;
    for (const receipt of receipts) {
      for (const state of [receipt.after_state,receipt.displaced_after]) {
        if (state?.fileId) await access.file(client,state.fileId);
        else if (state?.folderId) await access.path(client,state.collectionId??row.collection_id,state.path);
      }
    }
    for (const [itemId,error] of Object.entries(row.errors) as [string,DatabaseItemError][]) {
      const destination=error.destination;
      if (!destination) continue;
      if ('fileId' in destination) await access.file(client,destination.fileId);
      else {
        const item=(row.request as DatabaseBatchRequest).items.find(candidate=>candidate.itemId===itemId);
        await access.path(client,item?.targetCollectionId ?? row.collection_id,destination.path);
      }
    }
  }
}
async function itemRows(client:pg.PoolClient, row:any, actor:FilesIdentity):Promise<any[]> {
  return (await client.query('SELECT * FROM files_database_operation_receipts WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=ANY($3::uuid[])', [actor.userId, scope(actor), Object.values(row.item_keys)])).rows;
}
async function view(client:pg.PoolClient, row:any, actor:FilesIdentity):Promise<DatabaseBatchReceipt> {
  const receipts = await itemRows(client, row, actor);
  const native=(await client.query(`SELECT operation_id,state,plan,plan->>'itemId' AS item_id,last_error FROM files_path_operations
    WHERE plan->>'operationId'=$1 AND plan->>'version' IN('2','3')`,[row.id])).rows;
  const items:DatabaseBatchItemReceipt[] = row.request.items.map((item:DatabaseBatchItem) => {
    const stored = receipts.find(r => r.idempotency_key === row.item_keys[item.itemId]);
    const nativeRow=native.find(n=>n.item_id===item.itemId);
    const pending=nativeRow && (!['completed','undone','rolled-back'].includes(nativeRow.state)||nativeRow.last_error) ? nativeRow : null;
    const error = pending ? {status:409,code:'recovery-required',message:'Native artifacts require reconciliation before retry or undo'} : row.errors[item.itemId] ?? null;
    const state:DatabaseItemState = stored?.state ?? (error?.code==='recovery-required'?'failed':row.cancelled ? 'cancelled' : error ? 'failed' : 'pending');
    const invalidated=Boolean(stored?.folder_plan?.lifecycle?.disposal?.undoInvalidatedAt || nativeRow?.plan?.disposal?.undoInvalidatedAt);
    return { itemId: item.itemId, action: item.action, state, receiptId: stored?.id ?? null,
      before: stored?.before_state ?? null, after: stored?.after_state ?? null,
      ...(stored?.displaced_before ? { displacedBefore: stored.displaced_before, displacedAfter: stored.displaced_after } : {}),
      error, undoSupported: state === 'completed' && !invalidated, retryable: ['pending','failed','cancelled'].includes(state) };
  });
  const state:DatabaseBatchState = items.some(i=>i.error?.code==='recovery-required')?(items.some(i=>i.state==='completed' || i.state==='undone')?'partial':'failed'):items.some(i => i.state === 'pending') ? 'pending'
    : items.every(i => i.state === 'undone' || i.state === 'skipped') && items.some(i => i.state === 'undone') ? 'undone'
      : items.every(i => i.state === 'completed' || i.state === 'skipped') ? (items.some(i => i.error) ? 'partial' : 'completed')
        : items.some(i => i.state === 'completed' || i.state === 'undone') ? 'partial' : items.some(i=>i.error?.code==='recovery-required')?'failed':row.cancelled ? 'cancelled' : 'failed';
  return { operationId: row.id, collectionId: row.collection_id, state, cancelRequested: row.cancelled,
    undoSupported: items.some(i => i.undoSupported), retryable: items.some(i => i.retryable),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), items };
}
export async function databaseOperationCapabilities(db:pg.Pool, collectionId:string, access:DatabaseOperationAccess):Promise<{
  enabled:boolean; reason?:string; folderReceipts:boolean; nativeFolderReceipts:boolean;
  folderCollisionPolicies:DatabaseCollisionPolicy[]; crossCollectionOperations:'all-authorized'|'stored-authorized'|'unavailable';
}> {
  if (!uuid.test(collectionId)) throw fail(400, 'collectionId must be a UUID');
  return transaction(db, async client => {
    // The caller authorizes collection visibility before invoking discovery.
    const native = (await client.query('SELECT 1 FROM file_roots WHERE collection_id=$1', [collectionId])).rowCount;
    const helperAvailable=Boolean(access.custody && await access.custody.available());
    const enabled=!native || helperAvailable;
    return { enabled,...(!enabled?{reason:access.custody?'native-helper-unavailable':'native-custody-required'}:{}),folderReceipts:enabled,
      nativeFolderReceipts:Boolean(native && enabled),folderCollisionPolicies:['replace','keep-both','skip'],
      crossCollectionOperations:helperAvailable?'all-authorized':native?'unavailable':'stored-authorized' };
  });
}
export async function submitDatabaseBatch(db:pg.Pool, input:DatabaseBatchRequest, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> {
  await access.prepare?.(input.collectionId);
  for (const id of new Set(input.items.map(i=>i.targetCollectionId).filter((id):id is string=>Boolean(id)))) await access.prepare?.(id);
  return transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([actor.userId, scope(actor), input.idempotencyKey])]);
    const prior = (await client.query('SELECT *,request=$4::jsonb AS same_request FROM files_database_operation_batches WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=$3 FOR UPDATE', [actor.userId, scope(actor), input.idempotencyKey, input])).rows[0];
    if (prior) {
      if (!prior.same_request) throw fail(409, 'Idempotency key already used for another request', 'idempotency-conflict');
      await authorize(client, prior, access);
      return view(client, prior, actor);
    }
    await authorize(client, { request: input, collection_id: input.collectionId }, access);
    const collections=[input.collectionId,...input.items.map(item=>item.targetCollectionId).filter((id):id is string=>Boolean(id))];
    const native=(await client.query('SELECT 1 FROM file_roots WHERE collection_id=ANY($1::uuid[]) LIMIT 1',[collections])).rowCount;
    if (!access.custody && native) throw fail(422, 'Native operations require the custody coordinator', 'native-custody-required');
    if (access.custody && native && !await access.custody.available()) throw fail(503,'Atomic native mutation helper is unavailable','native-helper-unavailable');
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
  const row = (await db.query('SELECT collection_id,request FROM files_database_operation_batches WHERE id=$1',[id])).rows[0];
  if (!row) throw fail(404,'Operation not found');
  await access.prepare?.(row.collection_id);
  for (const item of row.request.items) if (item.targetCollectionId) await access.prepare?.(item.targetCollectionId);
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
      input = { ...effective, collectionId: row.collection_id, idempotencyKey: row.item_keys[original.itemId],batchOperationId:id };
      // The execution snapshot must match the policies read before starting.
      if (JSON.stringify(input) !== JSON.stringify(planned)) throw fail(409, 'Retry policy changed', 'item-not-pending');
      await client.query('UPDATE files_database_operation_batches SET updated_at=NOW() WHERE id=$1', [id]);
    };
    const row = await transaction(db, client => owner(client, id, actor));
    const planned = { ...validateItem({ ...original, ...row.overrides[original.itemId] }, row.collection_id), collectionId: row.collection_id, idempotencyKey: row.item_keys[original.itemId],batchOperationId:id };
    try {
      const execute=async() => {
        if (planned.kind==='folder') await executeFolderBatchItem(db,planned,actor,access,guard);
        else if (planned.action === 'create-folder') await createDatabaseFolder(db, planned as any, actor, access, guard);
        else await executeDatabaseOperation(db, planned as DatabaseOperationRequest, actor, access, guard);
      };
      if (access.custody) await access.custody.run(execute); else await execute();
    } catch (error:any) {
      if (error.code === 'item-not-pending') continue;
      await transaction(db, async client => {
        const latest = await owner(client, id, actor);
        // A lost COMMIT response must not turn durable success into failure.
        if ((await itemRows(client, latest, actor)).some(r => r.idempotency_key === latest.item_keys[original.itemId]) && error.code!=='recovery-required') return;
        await client.query('UPDATE files_database_operation_batches SET errors=jsonb_set(errors,ARRAY[$2],$3::jsonb),updated_at=NOW() WHERE id=$1', [id, original.itemId, safeError(error)]);
      });
    }
  }
}
export async function controlDatabaseBatch(db:pg.Pool, id:string, action:'cancel'|'retry'|'undo', body:any, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<DatabaseBatchReceipt> {
  await prepareBatch(db,id,actor,access);
  if (action!=='retry') {
    await transaction(db,async client=>{const row=await owner(client,id,actor,false);await authorize(client,row,access)});
    requestOperationCancellation(id);
  } else if (access.custody) await access.custody.run(async()=>undefined);
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
  }).finally(()=>clearOperationCancellation(id));
  if (action === 'undo') {
    for (const item of [...result.items].reverse().filter(i => i.undoSupported)) {
      try {
        const guard=async(client:pg.PoolClient) => {
          const row = await owner(client,id,actor);
          if (!row.cancelled) throw fail(409, 'Forward execution resumed; undo stopped');
        };
        const stored=(await db.query('SELECT request FROM files_database_operation_receipts WHERE id=$1',[item.receiptId])).rows[0];
        const execute=async() => {
          if (stored?.request.kind==='folder') await undoFolderBatchItem(db,item.receiptId!,actor,access,guard);
          else await undoDatabaseOperation(db,item.receiptId!,actor,access,guard);
        };
        if (access.custody) await access.custody.run(execute); else await execute();
        await transaction(db, async client => { await owner(client,id,actor); await client.query('UPDATE files_database_operation_batches SET errors=errors-$2,updated_at=NOW() WHERE id=$1', [id,item.itemId]) });
      } catch (error:any) {
        await transaction(db, async client => { await owner(client,id,actor); await client.query('UPDATE files_database_operation_batches SET errors=jsonb_set(errors,ARRAY[$2],$3::jsonb),updated_at=NOW() WHERE id=$1', [id,item.itemId,safeError(error)]) });
      }
    }
    return getDatabaseBatch(db,id,actor,access);
  }
  return result;
}
