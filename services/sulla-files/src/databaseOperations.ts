import type pg from 'pg';
import type { FilesIdentity } from './auth.js';
import { assertUnprotectedFile, isProtectedPath, protectedPathError } from './protectedFiles.js';

export interface DatabaseOperationRequest {
  idempotencyKey:string;
  collectionId:string;
  action:'move' | 'copy' | 'rename' | 'trash';
  fileId:string;
  expectedVersionId:string;
  expectedRevision:string;
  targetPath?:string;
  collisionPolicy?:'replace' | 'keep-both' | 'skip';
  expectedDestination?:DatabaseOperationState;
}
export interface DatabaseOperationState {
  fileId:string;
  path:string;
  versionId:string;
  revision:string;
  deleted:boolean;
}
export interface DatabaseOperationReceipt {
  operationId:string;
  collectionId:string;
  action:DatabaseOperationRequest['action'];
  state:'completed' | 'skipped' | 'undone';
  undoSupported:boolean;
  before:DatabaseOperationState;
  after:DatabaseOperationState;
  createdAt:string;
  undoneAt:string | null;
  displacedBefore?:DatabaseOperationState;
  displacedAfter?:DatabaseOperationState;
}
export interface DatabaseOperationAccess {
  prepare?(collectionId:string):Promise<void>;
  file(client:pg.PoolClient, fileId:string):Promise<any>;
  path(client:pg.PoolClient, collectionId:string, path:string):Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status:number, message:string):Error => Object.assign(new Error(message), { status });
const scope = (actor:FilesIdentity):string => JSON.stringify([actor.kind, actor.deviceId, actor.agentId ?? '', actor.jobId ?? '', actor.threadId ?? '']);
const snapshot = (file:any):DatabaseOperationState => ({
  fileId: file.id, path: file.path, versionId: file.current_version_id,
  revision: String(file.operation_revision), deleted: Boolean(file.deleted_at),
});
const receipt = (row:any):DatabaseOperationReceipt => ({
  operationId: row.id, collectionId: row.collection_id, action: row.action, state: row.state,
  undoSupported: row.state === 'completed', before: row.before_state, after: row.after_state,
  createdAt: row.created_at.toISOString(), undoneAt: row.undone_at?.toISOString() ?? null,
  ...(row.displaced_before ? { displacedBefore: row.displaced_before, displacedAfter: row.displaced_after } : {}),
});

export function parseDatabaseOperation(value:any):DatabaseOperationRequest {
  if (!value || !['move', 'copy', 'rename', 'trash'].includes(value.action)) throw fail(422, 'Unsupported database operation');
  for (const key of ['idempotencyKey', 'collectionId', 'fileId', 'expectedVersionId']) {
    if (typeof value[key] !== 'string' || !uuid.test(value[key])) throw fail(400, key + ' must be a UUID');
  }
  if (typeof value.expectedRevision !== 'string' || !/^[0-9]+$/.test(value.expectedRevision)) throw fail(400, 'expectedRevision must be the file operation_revision string');
  if (value.collisionPolicy !== undefined && !['replace', 'keep-both', 'skip'].includes(value.collisionPolicy)) throw fail(422, 'Unsupported collision policy');
  if (value.collisionPolicy === 'replace' && (!value.expectedDestination || !uuid.test(value.expectedDestination.fileId) || !uuid.test(value.expectedDestination.versionId) || !/^[0-9]+$/.test(value.expectedDestination.revision))) throw fail(400, 'Replace requires the displayed destination identity, version and revision');
  if (value.action !== 'trash' && (typeof value.targetPath !== 'string' || !value.targetPath || value.targetPath.includes('\\') ||
    value.targetPath.includes('\0') || value.targetPath.split('/').some((part:string) => !part || part === '.' || part === '..'))) throw fail(400, 'targetPath must be a canonical relative Files path');
  if (value.action === 'trash' && (value.targetPath !== undefined || value.collisionPolicy !== undefined)) throw fail(400, 'Trash does not accept a destination or collision policy');
  return {
    idempotencyKey: value.idempotencyKey.toLowerCase(), collectionId: value.collectionId.toLowerCase(),
    fileId: value.fileId.toLowerCase(), expectedVersionId: value.expectedVersionId.toLowerCase(),
    expectedRevision: value.expectedRevision, action: value.action,
    ...(value.action === 'trash' ? {} : { targetPath: value.targetPath, collisionPolicy: value.collisionPolicy }),
    ...(value.expectedDestination ? { expectedDestination: value.expectedDestination } : {}),
  };
}

export async function transaction<T>(db:pg.Pool, run:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    // Namespace triggers serialize legacy writers per collection. SERIALIZABLE
    // protects ACL/custody predicates without a service-wide lock across the
    // operation. External identity membership is prepared before BEGIN.
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error:any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (['40001', '40P01', '23505', '55P03', '57014'].includes(error?.code)) throw fail(409, 'Files changed concurrently or are busy; refresh before retrying. Receipt requests must reuse their idempotency key');
    throw error;
  } finally { client.release() }
}

async function lockedFile(client:pg.PoolClient, id:string, access:DatabaseOperationAccess):Promise<any> {
  const row = (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!row) throw fail(409, 'The file no longer exists');
  await assertUnprotectedFile(client, row);
  await access.file(client, id);
  const native = await client.query(`SELECT 1 FROM file_roots WHERE collection_id=$1
    UNION ALL SELECT 1 FROM watched_folder_state WHERE file_id=$2 LIMIT 1`, [row.collection_id, id]);
  if (native.rowCount) throw Object.assign(fail(422, 'Native Files receipt and undo are unsupported; a custody-coordinated native operation is required'), { code:'native-custody-required' });
  return row;
}
function editable(file:any, actor:FilesIdentity):void {
  if (file.record_lock_type !== 'none') throw fail(423, 'The record is locked');
  if (file.checked_out_by_user_id && (file.checked_out_by_user_id !== actor.userId ||
    (file.checked_out_by_device_id && file.checked_out_by_device_id !== (actor.deviceId || 'server-web')))) throw fail(409, 'The file is checked out by another editor');
  if (file.require_checkout && !file.checked_out_by_user_id) throw fail(409, 'The file must be checked out first');
}
async function journal(client:pg.PoolClient, actor:FilesIdentity, file:any, op:'put' | 'delete' | 'rename' | 'restore', operationId:string):Promise<void> {
  await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [file.collection_id, file.id, file.current_version_id, op]);
  await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, file.id, file.current_version_id, 'database-operation-' + op, { operationId }]);
}
async function permissionBoundary(client:pg.PoolClient, collectionId:string, from:string, to:string):Promise<void> {
  // Moving across inherited grant/public-link boundaries can expose content to
  // new readers. Stage one refuses that transition; direct file grants stay put.
  const changed = await client.query(`SELECT 1 FROM folder_shares WHERE collection_id=$1 AND
    (($2=folder_path OR starts_with($2,folder_path||'/')) IS DISTINCT FROM ($3=folder_path OR starts_with($3,folder_path||'/')))
    UNION ALL SELECT 1 FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND revoked_at IS NULL AND
    (($2=folder_path OR starts_with($2,folder_path||'/')) IS DISTINCT FROM ($3=folder_path OR starts_with($3,folder_path||'/'))) LIMIT 1`, [collectionId, from, to]);
  if (changed.rowCount) throw fail(422, 'Moving across folder permission boundaries is not supported by this receipt API');
}

async function permissionSignature(client:pg.PoolClient, collectionId:string, operationId:string):Promise<string> {
  return (await client.query(`SELECT md5(jsonb_build_array(
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY principal_type,principal_id),'[]') FROM collection_acl a WHERE collection_id=$1),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM folder_shares a WHERE collection_id=$1),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM file_shares a WHERE a.file_id::text IN
      (SELECT unnest(ARRAY[before_state->>'fileId',after_state->>'fileId',displaced_after->>'fileId']) FROM files_database_operation_receipts WHERE id=$2)),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM file_share_links a WHERE collection_id=$1))::text) AS signature`, [collectionId,operationId])).rows[0].signature;
}

async function copyReceiptFile(client:pg.PoolClient, source:any, target:string, actor:FilesIdentity):Promise<any> {
  const copied = (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,expires_at,
    versioning_enabled,major_minor_enabled,require_approval)
    VALUES($1,$2,'user',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
  [source.collection_id, target, actor.userId, source.mime, source.size, source.expires_at, source.versioning_enabled, source.major_minor_enabled, source.require_approval])).rows[0];
  const ids = [...new Set([source.published_version_id, source.current_version_id].filter(Boolean))];
  let current:string | undefined;
  for (const id of ids) {
    const version = (await client.query(`SELECT v.*,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.file_id=$2 AND v.deleted=FALSE FOR SHARE OF v,m`, [id, source.id])).rows[0];
    if (!version) throw fail(409, 'Copy source version is unavailable');
    const next = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,publication_status,version_kind)
      VALUES($1,$2,$3,$4,'user',$5,'Copied document',$6,$7,$8) RETURNING id`,
    [copied.id, version.chunk_collection_id, version.manifest_hash, version.size, actor.userId, actor.deviceId || 'server-web', version.publication_status, version.version_kind])).rows[0];
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [version.chunk_collection_id, version.chunk_ids]);
    await client.query(`INSERT INTO file_version_key_contexts(version_id,collection_id,principal_id,key_version,key_epoch)
      SELECT $2,collection_id,principal_id,key_version,key_epoch FROM file_version_key_contexts WHERE version_id=$1`, [id,next.id]);
    if (id === source.current_version_id) current = next.id;
  }
  if (!current) throw fail(409, 'Copy source has no current version');
  await client.query(`INSERT INTO file_shares(file_id,principal_type,principal_id,role,created_by)
    SELECT $2,principal_type,principal_id,role,$3 FROM file_shares WHERE file_id=$1`, [source.id, copied.id, actor.userId]);
  return (await client.query(`UPDATE files SET current_version_id=$2,require_checkout=$3,
    retention_mode=$4,retain_until=$5,retention_event_type=$6,retention_event_at=$7,retention_duration_days=$8,
    disposal_status=$9,disposal_review_at=$10,disposal_extended_until=$11,
    checked_out_by_user_id=CASE WHEN $3 THEN $12 ELSE NULL END,
    checked_out_by_device_id=CASE WHEN $3 THEN $13 ELSE NULL END,
    checked_out_at=CASE WHEN $3 THEN NOW() ELSE NULL END WHERE id=$1 RETURNING *`,
  [copied.id, current, source.require_checkout, source.retention_mode, source.retain_until, source.retention_event_type,
    source.retention_event_at, source.retention_duration_days, source.disposal_status, source.disposal_review_at, source.disposal_extended_until,actor.userId,actor.deviceId || 'server-web'])).rows[0];
}

export async function executeDatabaseOperation(db:pg.Pool, input:DatabaseOperationRequest, actor:FilesIdentity, access:DatabaseOperationAccess, guard?:(client:pg.PoolClient)=>Promise<void>):Promise<DatabaseOperationReceipt> {
  await access.prepare?.(input.collectionId);
  return transaction(db, async client => {
    if (guard) await guard(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + input.collectionId]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([actor.userId, scope(actor), input.idempotencyKey])]);
    const prior = (await client.query(`SELECT *,request=$4::jsonb AS same_request FROM files_database_operation_receipts
      WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=$3 FOR UPDATE`, [actor.userId, scope(actor), input.idempotencyKey, JSON.stringify(input)])).rows[0];
    if (prior) {
      if (!prior.same_request) throw fail(409, 'The idempotency key was already used for a different request');
      await lockedFile(client, prior.file_id, access);
      return receipt(prior);
    }
    const file = await lockedFile(client, input.fileId, access);
    if (file.collection_id !== input.collectionId || file.current_version_id !== input.expectedVersionId ||
      String(file.operation_revision) !== input.expectedRevision || file.deleted_at) throw fail(409, 'The selected file changed; refresh Files');
    editable(file, actor);
    if ((await client.query("SELECT 1 FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') LIMIT 1", [file.collection_id, file.path])).rowCount) throw fail(422, 'Folder-like entries require a folder custody operation');
    const before = snapshot(file);
    let updated = file; let skipped = false;
    // Reserve receipt identity within the same transaction; rollback removes it.
    const row = (await client.query(`INSERT INTO files_database_operation_receipts
      (actor_user_id,actor_scope,idempotency_key,request,collection_id,file_id,action,state,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8,$8) RETURNING *`,
    [actor.userId, scope(actor), input.idempotencyKey, input, file.collection_id, file.id, input.action, before])).rows[0];
    if (input.action === 'trash') {
      const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,0,TRUE,'user',$4,'Moved to Trash',$5,$3) RETURNING id`, [file.id, file.collection_id, file.current_version_id, actor.userId, actor.deviceId || 'server-web'])).rows[0];
      updated = (await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, version.id])).rows[0];
    } else {
      let target = input.targetPath!;
      if (isProtectedPath(target)) throw protectedPathError();
      if (target === file.path && input.action !== 'copy') throw fail(400, 'Destination must differ from source');
      await access.path(client, file.collection_id, target);
      await permissionBoundary(client, file.collection_id, file.path, target);
      const ancestorFile = await client.query("SELECT 1 FROM files WHERE collection_id=$1 AND starts_with($2,path||'/') LIMIT 1", [file.collection_id, target]);
      if (ancestorFile.rowCount) throw fail(409, 'A file occupies an ancestor of the destination');
      const occupied = async(path:string) => Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))
        UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [file.collection_id, path])).rowCount);
      if (await occupied(target)) {
        if (input.collisionPolicy === 'replace') {
          if ((await client.query("SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1", [file.collection_id,target])).rowCount) throw Object.assign(fail(409,'A folder occupies the destination; choose Keep Both or Skip'), { code:'destination-conflict' });
          const destination = (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE', [file.collection_id, target])).rows[0];
          if (!destination || destination.deleted_at) throw fail(409, 'Replace requires a live file destination');
          if (destination.id === file.id) throw fail(409, 'Cannot Replace the source itself; choose Keep Both or Skip');
          await lockedFile(client, destination.id, access);
          editable(destination, actor);
          const expected = input.expectedDestination!;
          if (destination.id !== expected.fileId || destination.current_version_id !== expected.versionId || String(destination.operation_revision) !== expected.revision) throw fail(409, 'The Replace destination changed');
          const slash = target.lastIndexOf('/');
          const recoveryPath = target.slice(0, slash + 1) + '.replaced-' + row.id + '-' + target.slice(slash + 1);
          if (await occupied(recoveryPath)) throw fail(409,'Replace recovery path is occupied');
          await access.path(client, file.collection_id, recoveryPath);
          await permissionBoundary(client, file.collection_id, target, recoveryPath);
          const displaced = (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [destination.id, recoveryPath])).rows[0];
          await journal(client, actor, displaced, 'rename', row.id);
          await client.query('UPDATE files_database_operation_receipts SET displaced_before=$2,displaced_after=$3 WHERE id=$1', [row.id, snapshot(destination), snapshot(displaced)]);
        } else if (input.collisionPolicy === 'skip') skipped = true;
        else if (input.collisionPolicy === 'keep-both') {
          const dot = target.lastIndexOf('.'); const slash = target.lastIndexOf('/');
          const split = dot > slash + 1 ? dot : target.length;
          let found = false;
          for (let n = 2; n <= 1000; n++) {
            const candidate = target.slice(0, split) + ' (' + n + ')' + target.slice(split);
            if (!await occupied(candidate)) { target = candidate; found = true; break }
          }
          if (!found) throw fail(409, 'No Keep Both destination is available');
        } else {
          const destination = (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2', [file.collection_id, target])).rows[0];
          if (destination) await access.file(client, destination.id);
          throw Object.assign(fail(409, 'Destination already exists; choose Replace, Keep Both or Skip'), { code: 'destination-conflict', ...(destination ? { destination: snapshot(destination) } : {}) });
        }
      }
      if (!skipped) {
        await access.path(client, file.collection_id, target);
        await permissionBoundary(client, file.collection_id, file.path, target);
        if ((await client.query("SELECT 1 FROM files WHERE collection_id=$1 AND starts_with($2,path||'/') LIMIT 1", [file.collection_id, target])).rowCount) throw fail(409, 'A file occupies an ancestor of the destination');
        if (input.action === 'copy') {
          updated = await copyReceiptFile(client, file, target, actor);
        } else updated = (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, target])).rows[0];
      }
    }
    if (!skipped) await journal(client, actor, updated, input.action === 'trash' ? 'delete' : input.action === 'copy' ? 'put' : 'rename', row.id);
    await client.query('UPDATE files_database_operation_receipts SET after_state=$2,state=$3 WHERE id=$1', [row.id,snapshot(updated),skipped ? 'skipped' : 'completed']);
    const committed = (await client.query('UPDATE files_database_operation_receipts SET permission_signature=$2 WHERE id=$1 RETURNING *', [row.id,await permissionSignature(client,input.collectionId,row.id)])).rows[0];
    return receipt(committed);
  });
}

export async function undoDatabaseOperation(db:pg.Pool, operationId:string, actor:FilesIdentity, access:DatabaseOperationAccess, guard?:(client:pg.PoolClient)=>Promise<void>):Promise<DatabaseOperationReceipt> {
  if (!uuid.test(operationId)) throw fail(400, 'operationId must be a UUID');
  const collection = (await db.query('SELECT collection_id FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3', [operationId,actor.userId,scope(actor)])).rows[0];
  if (collection) await access.prepare?.(collection.collection_id);
  return transaction(db, async client => {
    if (guard) await guard(client);
    const row = (await client.query('SELECT * FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3 FOR UPDATE', [operationId, actor.userId, scope(actor)])).rows[0];
    if (!row) throw fail(404, 'Database operation receipt not found; native undo is unsupported');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + row.collection_id]);
    if (row.state === 'completed' && row.permission_signature && row.permission_signature !== await permissionSignature(client,row.collection_id,row.id)) throw fail(409, 'Permissions or public links changed after the operation');
    if (row.action === 'create-folder') {
      await access.path(client, row.collection_id, row.after_state?.path ?? row.request.targetPath);
      if (row.state === 'undone') return receipt(row);
      if (row.state !== 'completed') throw fail(409, 'Skipped folders cannot be undone');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + row.collection_id]);
      const folder = (await client.query('SELECT * FROM file_folders WHERE id=$1 FOR UPDATE', [row.after_state.folderId])).rows[0];
      if (!folder || folder.path !== row.after_state.path || String(folder.operation_revision) !== row.after_state.revision) throw fail(409, 'Folder changed after creation');
      const occupied = await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))
        UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND starts_with(path,$2||'/')
        UNION ALL SELECT 1 FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))
        UNION ALL SELECT 1 FROM file_share_links WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) LIMIT 1`, [row.collection_id, folder.path]);
      if (occupied.rowCount) throw fail(409, 'Folder acquired children or grants; undo refused');
      await client.query('DELETE FROM file_folders WHERE id=$1', [folder.id]);
      await client.query(`INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user',$1,'undo-create-folder',$2)`, [actor.userId, { operationId, collectionId: row.collection_id, path: folder.path }]);
      return receipt((await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1 RETURNING *", [row.id])).rows[0]);
    }
    const file = await lockedFile(client, row.after_state.fileId, access);
    if (row.state === 'undone') return receipt(row);
    if (row.state !== 'completed') throw fail(409, 'Skipped operations cannot be undone');
    const expected = row.after_state as DatabaseOperationState; const before = row.before_state as DatabaseOperationState;
    if (JSON.stringify(snapshot(file)) !== JSON.stringify({
      fileId: expected.fileId, path: expected.path, versionId: expected.versionId, revision: expected.revision, deleted: expected.deleted,
    })) throw fail(409, 'Undo refused because the file changed after the operation');
    editable(file, actor);
    await access.path(client, file.collection_id, before.path);
    await permissionBoundary(client, file.collection_id, file.path, before.path);
    if (row.action !== 'copy' && (await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND id<>$3
      AND (path=$2 OR starts_with(path,$2||'/') OR starts_with($2,path||'/')) LIMIT 1`, [file.collection_id, before.path, file.id])).rowCount) throw fail(409, 'Undo destination is occupied');
    let updated:any;
    if (row.action === 'copy') {
      const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,deleted,created_by_type,created_by_id,message,device_id)
        VALUES($1,$2,$3,0,TRUE,'user',$4,'Undo copy',$5) RETURNING id`, [file.id, file.collection_id, file.current_version_id, actor.userId, actor.deviceId || 'server-web'])).rows[0];
      const recoveryPath = file.path + '.undone-' + row.id;
      await access.path(client, file.collection_id, recoveryPath);
      await permissionBoundary(client, file.collection_id, file.path, recoveryPath);
      updated = (await client.query('UPDATE files SET path=$2,current_version_id=$3,deleted_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, recoveryPath, version.id])).rows[0];
    } else if (row.action === 'trash') {
      const source = (await client.query(`SELECT v.id FROM file_versions v JOIN file_versions tombstone ON tombstone.id=$2 AND tombstone.file_id=v.file_id
        WHERE v.id=$1 AND v.file_id=$3 AND v.deleted=FALSE AND tombstone.deleted=TRUE AND tombstone.parent_version_id=v.id FOR SHARE OF v,tombstone`,
      [before.versionId, expected.versionId, file.id])).rows[0];
      if (!source) throw fail(409, 'Undo source version is no longer available');
      // Trash did not change publication pointers/statuses; restore that exact
      // parent while retaining the tombstone and all history.
      updated = (await client.query('UPDATE files SET current_version_id=$2,deleted_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, before.versionId])).rows[0];
    } else updated = (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, before.path])).rows[0];
    if (row.displaced_before) {
      const displaced = await lockedFile(client, row.displaced_after.fileId, access);
      const expectedDisplaced = row.displaced_after;
      if (displaced.path !== expectedDisplaced.path || displaced.current_version_id !== expectedDisplaced.versionId || String(displaced.operation_revision) !== expectedDisplaced.revision || Boolean(displaced.deleted_at) !== expectedDisplaced.deleted) throw fail(409, 'The displaced file changed; undo refused');
      editable(displaced, actor);
      await access.path(client, displaced.collection_id, row.displaced_before.path);
      await permissionBoundary(client, displaced.collection_id, displaced.path, row.displaced_before.path);
      const restored = (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [displaced.id, row.displaced_before.path])).rows[0];
      await journal(client, actor, restored, 'rename', row.id);
    }
    await journal(client, actor, updated, row.action === 'trash' ? 'restore' : row.action === 'copy' ? 'delete' : 'rename', row.id);
    return receipt((await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1 RETURNING *", [row.id])).rows[0]);
  });
}

export async function createDatabaseFolder(db:pg.Pool, input:{ idempotencyKey:string; collectionId:string; targetPath:string; collisionPolicy?:'keep-both'|'skip' }, actor:FilesIdentity, access:DatabaseOperationAccess, guard:(client:pg.PoolClient)=>Promise<void>):Promise<DatabaseOperationReceipt> {
  await access.prepare?.(input.collectionId);
  return transaction(db, async client => {
    await guard(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + input.collectionId]);
    await access.path(client, input.collectionId, input.targetPath);
    const prior = (await client.query('SELECT * FROM files_database_operation_receipts WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=$3', [actor.userId, scope(actor), input.idempotencyKey])).rows[0];
    if (prior) return receipt(prior);
    if ((await client.query('SELECT 1 FROM file_roots WHERE collection_id=$1', [input.collectionId])).rowCount) throw Object.assign(fail(422, 'Native folders require custody'), { code:'native-custody-required' });
    const occupied = async(path:string) => Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [input.collectionId, path])).rowCount);
    let path = input.targetPath; let skipped = false;
    if (await occupied(path)) {
      if (input.collisionPolicy === 'skip') skipped = true;
      else if (input.collisionPolicy === 'keep-both') {
        let n = 2;
        while (await occupied(path) && n <= 1000) path = input.targetPath + ' (' + n++ + ')';
        if (await occupied(path)) throw fail(409, 'No Keep Both folder destination available');
      } else throw Object.assign(fail(409, 'Folder destination exists'), { code: 'destination-conflict' });
    }
    await access.path(client, input.collectionId, path);
    let after:any = null;
    if (!skipped) {
      const folder = (await client.query(`INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,$2,$3) RETURNING *`, [input.collectionId, path, actor.userId])).rows[0];
      after = { folderId: folder.id, path, revision: String(folder.operation_revision) };
    }
    const row = (await client.query(`INSERT INTO files_database_operation_receipts(actor_user_id,actor_scope,idempotency_key,request,collection_id,action,state,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,'create-folder',$6,'null'::jsonb,$7::jsonb) RETURNING *`, [actor.userId, scope(actor), input.idempotencyKey, input, input.collectionId, skipped ? 'skipped' : 'completed', JSON.stringify(after)])).rows[0];
    await client.query(`INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user',$1,'create-folder',$2)`, [actor.userId, { operationId: row.id, collectionId: input.collectionId, path, skipped }]);
    return receipt(row);
  });
}

/** Legacy restore keeps its response shape; all decisions follow the file lock. */
export async function restoreTrashedFile(db:pg.Pool, fileId:string, actor:FilesIdentity, access:DatabaseOperationAccess, expectedVersionId?:string):Promise<{ ok:true; versionId:string }> {
  if (!uuid.test(fileId)) throw fail(400, 'fileId must be a UUID');
  if (expectedVersionId !== undefined && (typeof expectedVersionId !== 'string' || !uuid.test(expectedVersionId))) throw fail(400, 'expectedVersionId must be a UUID');
  const collection = (await db.query('SELECT collection_id FROM files WHERE id=$1',[fileId])).rows[0];
  if (collection) await access.prepare?.(collection.collection_id);
  return transaction(db, async client => {
    const file = (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
    if (!file) throw fail(404, 'file not found');
    await access.file(client, fileId);
    if (!file.deleted_at || (expectedVersionId !== undefined && file.current_version_id !== expectedVersionId)) throw fail(409, 'The trashed file changed; refresh Files');
    editable(file, actor);
    const tombstone = (await client.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 AND deleted=TRUE FOR UPDATE', [file.current_version_id, file.id])).rows[0];
    if (!tombstone) throw fail(409, 'The current version is not a trash tombstone');
    // Follow the locked tombstone lineage, never select an unrelated newer
    // draft/version by timestamp. UNION also terminates malformed cycles.
    const source = (await client.query(`WITH RECURSIVE lineage AS (
      SELECT id,parent_version_id,deleted FROM file_versions WHERE id=$1 AND file_id=$2
      UNION SELECT v.id,v.parent_version_id,v.deleted FROM file_versions v JOIN lineage p ON v.id=p.parent_version_id
      WHERE p.deleted=TRUE AND v.file_id=$2)
      SELECT v.* FROM file_versions v JOIN lineage l ON l.id=v.id WHERE v.deleted=FALSE AND v.manifest_hash IS NOT NULL
      FOR UPDATE OF v`, [tombstone.parent_version_id, file.id])).rows[0];
    if (!source) throw fail(409, 'No restorable ancestor version remains');
    const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id)
      VALUES($1,$2,$3,$4,$5,'user',$6,'Restored from Trash',$7,$3) RETURNING id`, [file.id, source.chunk_collection_id, file.current_version_id, source.manifest_hash, source.size, actor.userId, actor.deviceId || 'server-web'])).rows[0];
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id IN (SELECT jsonb_array_elements_text(chunk_ids) FROM manifests WHERE hash=$2)', [source.chunk_collection_id, source.manifest_hash]);
    const updated = (await client.query(`UPDATE files SET current_version_id=$2,deleted_at=NULL,size=$3,updated_at=NOW()
      WHERE id=$1 AND current_version_id=$4 AND deleted_at IS NOT NULL RETURNING *`, [file.id, version.id, source.size, file.current_version_id])).rows[0];
    if (!updated) throw fail(409, 'The trash tombstone changed while restoring');
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'restore')", [file.collection_id, file.id, version.id]);
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES($1,$2,$3,$4,$5,'trash-restore',$6)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, file.id, version.id, { tombstoneVersionId: tombstone.id, sourceVersionId: source.id }]);
    return { ok: true as const, versionId: version.id };
  });
}

export async function trashFileWithoutReceipt(db:pg.Pool, fileId:string, actor:FilesIdentity, access:DatabaseOperationAccess):Promise<void> {
  if (!uuid.test(fileId)) throw fail(400, 'fileId must be a UUID');
  const collection = (await db.query('SELECT collection_id FROM files WHERE id=$1',[fileId])).rows[0];
  if (collection) await access.prepare?.(collection.collection_id);
  return transaction(db, async client => {
    const file = (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
    if (!file) throw fail(404, 'file not found');
    await access.file(client, fileId);
    if (file.deleted_at) throw fail(409, 'The file is already in Trash');
    editable(file, actor);
    const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
      VALUES($1,$2,$3,0,TRUE,'user',$4,'Moved to Trash',$5,$3) RETURNING id`, [file.id, file.collection_id, file.current_version_id, actor.userId, actor.deviceId || 'server-web'])).rows[0];
    await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [file.id, version.id]);
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [file.collection_id, file.id, version.id]);
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES($1,$2,$3,$4,$5,'trash',$6)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, file.id, version.id, { parentVersionId: file.current_version_id }]);
  });
}
