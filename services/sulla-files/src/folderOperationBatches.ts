import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FilesIdentity } from './auth.js';
import { executeDatabaseOperation,undoDatabaseOperation,transaction,permissionBoundary,permissionSignature,type DatabaseOperationAccess } from './databaseOperations.js';
import { assertOperationNotCancelled } from './operationCancellation.js';
import type { DatabaseBatchItem,DatabaseFolderState } from './databaseOperationBatches.js';

const fail=(message:string,code='state-conflict')=>Object.assign(new Error(message),{ status:409,code });
const scope=(a:FilesIdentity)=>JSON.stringify([a.kind,a.deviceId,a.agentId??'',a.jobId??'',a.threadId??'']);
const state=(f:any):DatabaseFolderState=>({ folderId:f.id,path:f.path,revision:String(f.operation_revision) });
const metadataAccess=(access:DatabaseOperationAccess):DatabaseOperationAccess => ({ ...access,
  ...(access.custody?{ custody:{ ...access.custody,publish:async()=>undefined } }:{}) });

export async function executeFolderBatchItem(db:pg.Pool,input:DatabaseBatchItem & { collectionId:string;idempotencyKey:string;batchOperationId?:string },actor:FilesIdentity,access:DatabaseOperationAccess,guard:(client:pg.PoolClient)=>Promise<void>):Promise<void> {
  await access.prepare?.(input.collectionId);
  if (input.targetCollectionId && input.targetCollectionId!==input.collectionId) throw Object.assign(new Error('Cross-collection folder transfer requires destination key and audience authorization'),{ status:422,code:'cross-collection-folder-unsupported' });
  await transaction(db,async client=>{
    await guard(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['stored-namespace:'+input.collectionId]);
    const source=input.folderPath!;
    await access.path(client,input.collectionId,source);
    const files=(await client.query("SELECT * FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') ORDER BY path FOR UPDATE",[input.collectionId,source])).rows;
    const folders=(await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY length(path),path FOR UPDATE",[input.collectionId,source])).rows;
    const nativeFolders=await access.custody?.folders(input.collectionId,source,files.map(f=>f.path))??[];
    if (!files.length && !folders.length && !nativeFolders.length) throw fail('Folder no longer exists');
    if (files.some(f=>f.deleted_at) || folders.some(f=>f.deleted_at)) throw fail('Folder contains trashed entries; restore or relocate them first');
    const explicit=folders.find(f=>f.path===source);
    if (input.expectedFolder && (!explicit || explicit.id!==input.expectedFolder.folderId || explicit.path!==input.expectedFolder.path || String(explicit.operation_revision)!==input.expectedFolder.revision)) throw fail('Folder identity or revision changed');
    // Nested sharing can expose descendants during a rename/copy. Keep the
    // original grants intact and refuse rather than silently widen audiences.
    if ((await client.query(`SELECT 1 FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))
      UNION ALL SELECT 1 FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) LIMIT 1`,[input.collectionId,source])).rowCount) throw Object.assign(new Error('Folder has nested grants or public links'),{ status:422,code:'folder-permission-boundary' });
    for (const file of files) await access.file(client,file.id);
    for (const folder of folders) await access.path(client,input.collectionId,folder.path);
    let target=input.targetPath;
    const occupied=async(path:string)=>Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/') OR starts_with($2,path||'/'))
      UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`,[input.collectionId,path])).rowCount) || Boolean(await access.custody?.occupied(input.collectionId,path));
    let skipped=false;
    if (input.action!=='trash') {
      if (!target || target===source || target.startsWith(source+'/') || source.startsWith(target+'/')) throw fail('Folder destination overlaps its source');
      await access.path(client,input.collectionId,target);
      await permissionBoundary(client,input.collectionId,source,target);
      if (await occupied(target)) {
        if (input.collisionPolicy==='skip') skipped=true;
        else if (input.collisionPolicy==='keep-both') {
          let n=2; while (await occupied(target) && n<=1000) { target=input.targetPath+' ('+n+')'; n++ }
          if (await occupied(target)) throw fail('No available Keep Both destination');
        } else throw fail('Folder destination is occupied; choose Keep Both or Skip','destination-conflict');
      }
      await access.path(client,input.collectionId,target);
      await permissionBoundary(client,input.collectionId,source,target);
    }
    const row=(await client.query(`INSERT INTO files_database_operation_receipts(actor_user_id,actor_scope,idempotency_key,request,collection_id,action,state,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$8::jsonb) RETURNING *`,[actor.userId,scope(actor),input.idempotencyKey,input,input.collectionId,input.action,skipped?'skipped':'completed',JSON.stringify(explicit?state(explicit):null)])).rows[0];
    if (skipped) return;
    // Include implicit ancestors, so native and stored empty directories have
    // one stable ordered plan rather than fake placeholder file identities.
    const paths=new Set<string>([source,...folders.map(f=>f.path),...nativeFolders]);
    for (const file of files) {
      let path=file.path.slice(0,file.path.lastIndexOf('/'));
      while (path===source || path.startsWith(source+'/')) { paths.add(path); path=path.slice(0,path.lastIndexOf('/')); if (!path.includes('/') && path!==source) break }
    }
    const ordered=[...paths].sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b));
    const folderChanges:any[]=[];
    for (const path of ordered) {
      await access.path(client,input.collectionId,path);
      let folder=folders.find(f=>f.path===path);
      if (!folder) folder=(await client.query('INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,$2,$3) RETURNING *',[input.collectionId,path,actor.userId])).rows[0];
      const before=state(folder);
      let after:any;
      if (input.action==='copy') after=(await client.query('INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,$2,$3) RETURNING *',[input.collectionId,target+path.slice(source.length),actor.userId])).rows[0];
      else if (input.action==='trash') after=(await client.query('UPDATE file_folders SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *',[folder.id])).rows[0];
      else after=(await client.query('UPDATE file_folders SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *',[folder.id,target+path.slice(source.length)])).rows[0];
      folderChanges.push({before,after:state(after),deleted:input.action==='trash'});
    }
    const children:any[]=[];
    for (const file of files) {
      if (input.batchOperationId) assertOperationNotCancelled(input.batchOperationId);
      const child=await executeDatabaseOperation(db,{idempotencyKey:randomUUID(),collectionId:input.collectionId,action:input.action as 'move'|'copy'|'rename'|'trash',
        fileId:file.id,expectedVersionId:file.current_version_id,expectedRevision:String(file.operation_revision),
        ...(input.action==='trash'?{}:{targetPath:target+file.path.slice(source.length)})},actor,metadataAccess(access),undefined,client);
      children.push(child);
    }
    const plan={ source,target,folders:folderChanges,children };
    const updated=(await client.query('UPDATE files_database_operation_receipts SET after_state=$2,folder_plan=$3 WHERE id=$1 RETURNING *',
      [row.id,folderChanges.find(f=>f.before.path===source)?.after,plan])).rows[0];
    await client.query('UPDATE files_database_operation_receipts SET permission_signature=$2 WHERE id=$1',[row.id,await permissionSignature(client,input.collectionId,row.id)]);
    await access.custody?.publish(client,updated,false);
    await client.query("INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user',$1,'folder-operation',$2)",[actor.userId,{operationId:row.id,action:input.action,collectionId:input.collectionId}]);
  });
}

export async function undoFolderBatchItem(db:pg.Pool,id:string,actor:FilesIdentity,access:DatabaseOperationAccess,guard:(client:pg.PoolClient)=>Promise<void>):Promise<void> {
  const initial=(await db.query('SELECT collection_id FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3',[id,actor.userId,scope(actor)])).rows[0];
  if (!initial) throw fail('Folder receipt missing');
  await access.prepare?.(initial.collection_id);
  await transaction(db,async client=>{
    await guard(client);
    const row=(await client.query('SELECT * FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3 FOR UPDATE',[id,actor.userId,scope(actor)])).rows[0];
    if (!row?.folder_plan) throw fail('Folder receipt missing');
    const plan=row.folder_plan;
    await access.path(client,row.collection_id,plan.source);
    if (plan.target) await access.path(client,row.collection_id,plan.target);
    if (row.state==='undone') return;
    if (row.state!=='completed') throw fail('Folder operation cannot be undone');
    if (row.permission_signature!==await permissionSignature(client,row.collection_id,row.id)) throw fail('Folder permissions changed');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['stored-namespace:'+row.collection_id]);
    const subtree=plan.target??plan.source;
    const actualFiles=(await client.query("SELECT id FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) FOR UPDATE",[row.collection_id,subtree])).rows;
    const expectedFiles=new Set(plan.children.map((c:any)=>c.after.fileId));
    if (actualFiles.length!==expectedFiles.size || actualFiles.some(f=>!expectedFiles.has(f.id))) throw fail('Folder acquired unknown children');
    const actualFolders=(await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) FOR UPDATE",[row.collection_id,subtree])).rows;
    if (actualFolders.length!==plan.folders.length || plan.folders.some((f:any)=>!actualFolders.some(a=>a.id===f.after.folderId && a.path===f.after.path && String(a.operation_revision)===f.after.revision))) throw fail('Folder identity, revision or children changed');
    if ((await client.query(`SELECT 1 FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))
      UNION ALL SELECT 1 FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) LIMIT 1`,[row.collection_id,subtree])).rowCount) throw fail('Folder acquired grants');
    // File inverses restore metadata first; the one native journal publishes
    // the complete folder inverse before this transaction can commit.
    for (const child of [...plan.children].reverse()) await undoDatabaseOperation(db,child.operationId,actor,metadataAccess(access),undefined,client);
    for (const folder of [...plan.folders].reverse()) {
      await access.path(client,row.collection_id,folder.after.path);
      await access.path(client,row.collection_id,folder.before.path);
      if (row.action==='copy') await client.query('DELETE FROM file_folders WHERE id=$1',[folder.after.folderId]);
      else await client.query('UPDATE file_folders SET path=$2,deleted_at=NULL,updated_at=NOW() WHERE id=$1',[folder.after.folderId,folder.before.path]);
    }
    await access.custody?.publish(client,row,true);
    await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1",[id]);
  });
}
