import { createHash,randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FilesIdentity } from './auth.js';
import { configuredReceiptLifecycle,crossCollectionBoundary,executeDatabaseOperation,folderGrantMigration,restoreTrashReceipt,undoDatabaseOperation,transaction,permissionBoundary,permissionSignature,type DatabaseOperationAccess } from './databaseOperations.js';
import { assertOperationNotCancelled } from './operationCancellation.js';
import type { DatabaseBatchItem,DatabaseFolderState } from './databaseOperationBatches.js';

const fail=(message:string,code='state-conflict')=>Object.assign(new Error(message),{ status:409,code });
const scope=(a:FilesIdentity)=>JSON.stringify([a.kind,a.deviceId,a.agentId??'',a.jobId??'',a.threadId??'']);
const state=(f:any):DatabaseFolderState=>({ collectionId:f.collection_id,folderId:f.id,path:f.path,revision:String(f.operation_revision) });
const canonical=(value:any):string=>JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const metadataAccess=(access:DatabaseOperationAccess):DatabaseOperationAccess => ({ ...access,
  ...(access.custody?{ custody:{ ...access.custody,publish:async()=>undefined } }:{}) });

export async function folderOperationState(db:pg.Pool,collectionId:string,path:string,access:DatabaseOperationAccess):Promise<{
  collectionId:string;path:string;folderId?:string;revision?:string;subtreeSignature:string;
}> {
  await access.prepare?.(collectionId);
  return transaction(db,async client=>{
    await access.path(client,collectionId,path);
    const files=(await client.query("SELECT * FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') AND deleted_at IS NULL ORDER BY path",[collectionId,path])).rows;
    const folders=(await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) AND deleted_at IS NULL ORDER BY length(path),path",[collectionId,path])).rows;
    const native=access.custody?await access.custody.folderSnapshot(collectionId,path,files.map(file=>file.path)):
      {directories:[],nativeSignature:createHash('sha256').update(canonical({files:[],directories:[]})).digest('hex')};
    if (!files.length && !folders.length && !native.directories.length) throw Object.assign(new Error('Folder not found'),{status:404});
    for (const file of files) await access.file(client,file.id);
    for (const folder of folders) await access.path(client,collectionId,folder.path);
    const folderShares=(await client.query("SELECT * FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id",[collectionId,path])).rows;
    const publicLinks=(await client.query("SELECT * FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id",[collectionId,path])).rows;
    const fileIds=files.map(file=>file.id);
    const fileSharesSignature=(await client.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]'::jsonb)::text) signature FROM file_shares item WHERE item.file_id=ANY($1::uuid[])",[fileIds])).rows[0].signature;
    const fileLinksSignature=(await client.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]'::jsonb)::text) signature FROM file_share_links item WHERE item.file_id=ANY($1::uuid[])",[fileIds])).rows[0].signature;
    const subtreeSignature=createHash('sha256').update(canonical({files:files.map(file=>({id:file.id,path:file.path,versionId:file.current_version_id,revision:String(file.operation_revision),deleted:false})),
      folders:folders.map(state),folderShares,publicLinks,fileSharesSignature,fileLinksSignature,nativeSignature:native.nativeSignature})).digest('hex');
    const root=folders.find(folder=>folder.path===path);
    return {collectionId,path,...(root?{folderId:root.id,revision:String(root.operation_revision)}:{}),subtreeSignature};
  });
}

export async function executeFolderBatchItem(db:pg.Pool,input:DatabaseBatchItem & { collectionId:string;idempotencyKey:string;batchOperationId?:string },actor:FilesIdentity,access:DatabaseOperationAccess,guard:(client:pg.PoolClient)=>Promise<void>):Promise<void> {
  await access.prepare?.(input.collectionId);
  const destinationCollection=input.targetCollectionId??input.collectionId;
  if (destinationCollection!==input.collectionId) await access.prepare?.(destinationCollection);
  await transaction(db,async client=>{
    await guard(client);
    for (const id of [...new Set([input.collectionId,destinationCollection])].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['stored-namespace:'+id]);
    const source=input.folderPath!;
    await access.path(client,input.collectionId,source);
    const files=(await client.query("SELECT * FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') ORDER BY path FOR UPDATE",[input.collectionId,source])).rows;
    const folders=(await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY length(path),path FOR UPDATE",[input.collectionId,source])).rows;
    const nativeFolders=await access.custody?.folders(input.collectionId,source,files.map(f=>f.path))??[];
    if (!files.length && !folders.length && !nativeFolders.length) throw fail('Folder no longer exists','source-conflict');
    if (files.some(f=>f.deleted_at) || folders.some(f=>f.deleted_at)) throw fail('Folder contains trashed entries; restore or relocate them first','source-conflict');
    const explicit=folders.find(f=>f.path===source);
    if (input.expectedFolder && (!explicit || explicit.id!==input.expectedFolder.folderId || explicit.path!==input.expectedFolder.path || String(explicit.operation_revision)!==input.expectedFolder.revision ||
      (input.expectedFolder.collectionId!==undefined && input.expectedFolder.collectionId!==input.collectionId))) throw fail('Folder identity or revision changed','source-conflict');
    for (const file of files) await access.file(client,file.id);
    for (const folder of folders) await access.path(client,input.collectionId,folder.path);
    let target=input.targetPath;
    const receiptId=randomUUID();
    let displaced:any=null;
    const occupied=async(collectionId:string,path:string)=>Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/') OR starts_with($2,path||'/'))
      UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`,[collectionId,path])).rowCount) || Boolean(await access.custody?.occupied(collectionId,path));
    const tree=async(collectionId:string,path:string,treeFiles?:any[],treeFolders?:any[]) => {
      const destinationFiles=treeFiles??(await client.query("SELECT * FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') ORDER BY path FOR UPDATE",[collectionId,path])).rows;
      const destinationFolders=treeFolders??(await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY length(path),path FOR UPDATE",[collectionId,path])).rows;
      const native=access.custody
        ? await access.custody.folderSnapshot(collectionId,path,destinationFiles.map(file=>file.path))
        : {directories:[],nativeSignature:createHash('sha256').update(canonical({files:[],directories:[]})).digest('hex')};
      const folderShares=(await client.query("SELECT * FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id FOR UPDATE",[collectionId,path])).rows;
      const publicLinks=(await client.query("SELECT * FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id FOR UPDATE",[collectionId,path])).rows;
      const fileIds=destinationFiles.map(file=>file.id);
      const fileSharesSignature=(await client.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]'::jsonb)::text) signature FROM file_shares item WHERE item.file_id=ANY($1::uuid[])",[fileIds])).rows[0].signature;
      const fileLinksSignature=(await client.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]'::jsonb)::text) signature FROM file_share_links item WHERE item.file_id=ANY($1::uuid[])",[fileIds])).rows[0].signature;
      const root=destinationFolders.find(folder=>folder.path===path);
      const subtreeSignature=createHash('sha256').update(canonical({files:destinationFiles.map(file=>({id:file.id,path:file.path,versionId:file.current_version_id,revision:String(file.operation_revision),deleted:Boolean(file.deleted_at)})),
        folders:destinationFolders.map(state),folderShares,publicLinks,fileSharesSignature,fileLinksSignature,nativeSignature:native.nativeSignature})).digest('hex');
      return {destinationFiles,destinationFolders,destinationNativeFolders:native.directories,folderShares,publicLinks,fileIds,fileSharesSignature,fileLinksSignature,nativeSignature:native.nativeSignature,subtreeSignature,root,
        snapshot:root?{...state(root),subtreeSignature}:undefined};
    };
    const sourceTree=await tree(input.collectionId,source,files,folders);
    if (destinationCollection!==input.collectionId) {
      const expectedSource=(input as any).sourceSubtreeSignature??input.expectedFolder?.subtreeSignature;
      if (!expectedSource || sourceTree.subtreeSignature!==expectedSource) {
        throw Object.assign(fail('The source folder subtree changed; refresh Files','source-conflict'),{source:{collectionId:input.collectionId,...(sourceTree.snapshot??{path:source}),subtreeSignature:sourceTree.subtreeSignature}});
      }
      if (input.action==='copy' && ((await client.query('SELECT 1 FROM file_share_links WHERE revoked_at IS NULL AND (file_id=ANY($1::uuid[]) OR (collection_id=$2 AND folder_path IS NOT NULL AND ($3=folder_path OR starts_with(folder_path,$3||\'/\'))) ) LIMIT 1',[files.map(file=>file.id),input.collectionId,source])).rowCount)) {
        throw Object.assign(new Error('Cross-collection folder copies with active public links require explicit new links'),{status:422,code:'cross-collection-boundary'});
      }
      await crossCollectionBoundary(client,input.collectionId,destinationCollection,actor,{sourcePath:source,targetPath:input.targetPath,fileIds:files.map(file=>file.id)});
    } else if (sourceTree.folderShares.length || sourceTree.publicLinks.length) {
      throw Object.assign(new Error('Folder has nested grants or public links'),{ status:422,code:'folder-permission-boundary' });
    }
    let skipped=false;
    if (input.action!=='trash') {
      if (!target) throw fail('Folder destination is required');
      if (destinationCollection===input.collectionId && (target===source || target.startsWith(source+'/') || source.startsWith(target+'/'))) throw fail('Folder destination overlaps its source');
      await access.path(client,destinationCollection,target);
      const targetOccupied=await occupied(destinationCollection,target);
      if (targetOccupied) {
        if (input.collisionPolicy==='skip') skipped=true;
        else if (input.collisionPolicy==='keep-both') {
          let n=2; while (await occupied(destinationCollection,target) && n<=1000) { target=input.targetPath+' ('+n+')'; n++ }
          if (await occupied(destinationCollection,target)) throw fail('No available Keep Both destination');
        } else if (input.collisionPolicy==='replace') {
          const destination=await tree(destinationCollection,target);
          const {destinationFiles,destinationFolders,destinationNativeFolders,folderShares,publicLinks}=destination;
          const destinationRoot=destination.root;
          const expected=(input as any).expectedDestination;
          if (!destinationRoot || !expected || destinationRoot.id!==expected.folderId || destinationRoot.collection_id!==(expected.collectionId??destinationCollection) || destinationRoot.path!==expected.path || String(destinationRoot.operation_revision)!==expected.revision || destination.snapshot?.subtreeSignature!==expected.subtreeSignature) {
            throw Object.assign(fail('The Replace destination changed; refresh Files','destination-conflict'),{...(destination.snapshot?{destination:destination.snapshot}:{})});
          }
          if (destinationFiles.some(f=>f.deleted_at) || destinationFolders.some(f=>f.deleted_at)) throw fail('Replace destination contains trashed entries; restore or relocate them first');
          for (const file of destinationFiles) await access.file(client,file.id);
          for (const folder of destinationFolders) await access.path(client,destinationCollection,folder.path);
          const slash=target.lastIndexOf('/');
          const recovery=target.slice(0,slash+1)+'.replaced-'+receiptId+'-'+target.slice(slash+1);
          if (await occupied(destinationCollection,recovery)) throw fail('Replace recovery sibling is occupied');
          await access.path(client,destinationCollection,recovery);
          // The complete destination grant subtree moves with its identities to
          // this same-parent recovery sibling; inherited outer grants do not change.
          const destinationPaths=new Set<string>([target,...destinationFolders.map(f=>f.path),...destinationNativeFolders]);
          for (const file of destinationFiles) {
            let path=file.path.slice(0,file.path.lastIndexOf('/'));
            while (path===target || path.startsWith(target+'/')) { destinationPaths.add(path); path=path.slice(0,path.lastIndexOf('/')); if (!path.includes('/') && path!==target) break }
          }
          const destinationOrdered=[...destinationPaths].sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b));
          const destinationFileIds=destination.fileIds;
          const {fileSharesSignature,fileLinksSignature}=destination;
          const displacedChildren:any[]=[];
          for (const file of destinationFiles) {
            const child=await executeDatabaseOperation(db,{idempotencyKey:randomUUID(),collectionId:destinationCollection,action:'rename',fileId:file.id,
              expectedVersionId:file.current_version_id,expectedRevision:String(file.operation_revision),targetPath:recovery+file.path.slice(target.length),[folderGrantMigration]:true},
            actor,metadataAccess(access),undefined,client);
            displacedChildren.push(child);
          }
          const displacedFolders:any[]=[];
          for (const path of destinationOrdered) {
            let folder=destinationFolders.find(f=>f.path===path);
            if (!folder) folder=(await client.query('INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,$2,$3) RETURNING *',[destinationCollection,path,actor.userId])).rows[0];
            const before=state(folder);
            const after=(await client.query('UPDATE file_folders SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *',[folder.id,recovery+path.slice(target.length)])).rows[0];
            displacedFolders.push({before,after:state(after),deleted:false});
          }
          const grants={
            folderShares:folderShares.map(grant=>({id:grant.id,beforePath:grant.folder_path,afterPath:recovery+grant.folder_path.slice(target.length)})),
            publicLinks:publicLinks.map(link=>({id:link.id,beforePath:link.folder_path,afterPath:recovery+link.folder_path.slice(target.length)})),
            fileIds:destinationFileIds,fileSharesSignature,fileLinksSignature,
          };
          for (const grant of grants.folderShares) await client.query('UPDATE folder_shares SET folder_path=$2,updated_at=NOW() WHERE id=$1',[grant.id,grant.afterPath]);
          for (const link of grants.publicLinks) await client.query('UPDATE file_share_links SET folder_path=$2,updated_at=NOW() WHERE id=$1',[link.id,link.afterPath]);
          displaced={collectionId:destinationCollection,source:target,target:recovery,folders:displacedFolders,children:displacedChildren,grants};
        } else {
          const destination=await tree(destinationCollection,target);
          throw Object.assign(fail('Folder destination is occupied; choose Replace, Keep Both or Skip','destination-conflict'),{...(destination.snapshot?{destination:destination.snapshot}:{})});
        }
      } else if (input.collisionPolicy==='replace') throw fail('The Replace destination no longer exists; refresh Files','destination-conflict');
      if (!skipped) {
        await access.path(client,destinationCollection,target);
        if (destinationCollection===input.collectionId) await permissionBoundary(client,input.collectionId,source,target);
      }
    }
    const row=(await client.query(`INSERT INTO files_database_operation_receipts(id,actor_user_id,actor_scope,idempotency_key,request,collection_id,action,state,before_state,after_state,displaced_before,displaced_after)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$9::jsonb,$10::jsonb,$11::jsonb) RETURNING *`,[receiptId,actor.userId,scope(actor),input.idempotencyKey,input,input.collectionId,input.action,skipped?'skipped':'completed',JSON.stringify(explicit?state(explicit):null),
      JSON.stringify(displaced?.folders.find((f:any)=>f.before.path===displaced.source)?.before??null),JSON.stringify(displaced?.folders.find((f:any)=>f.before.path===displaced.source)?.after??null)])).rows[0];
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
      if (input.action==='copy') after=(await client.query('INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,$2,$3) RETURNING *',[destinationCollection,target+path.slice(source.length),actor.userId])).rows[0];
      else if (input.action==='trash') after=(await client.query('UPDATE file_folders SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *',[folder.id])).rows[0];
      else after=(await client.query('UPDATE file_folders SET collection_id=$2,path=$3,updated_at=NOW() WHERE id=$1 RETURNING *',[folder.id,destinationCollection,target+path.slice(source.length)])).rows[0];
      folderChanges.push({before,after:state(after),deleted:input.action==='trash'});
    }
    const children:any[]=[];
    for (const file of files) {
      if (input.batchOperationId) assertOperationNotCancelled(input.batchOperationId);
      const child=await executeDatabaseOperation(db,{idempotencyKey:randomUUID(),collectionId:input.collectionId,action:input.action as 'move'|'copy'|'rename'|'trash',
        fileId:file.id,expectedVersionId:file.current_version_id,expectedRevision:String(file.operation_revision),
        ...(input.action==='trash'?{}:{targetPath:target+file.path.slice(source.length),...(destinationCollection!==input.collectionId?{targetCollectionId:destinationCollection}:{})})},actor,metadataAccess(access),undefined,client);
      children.push(child);
    }
    let transferredGrants:any=undefined;
    if (destinationCollection!==input.collectionId) {
      const folderShares=[] as any[]; const publicLinks=[] as any[];
      for (const grant of sourceTree.folderShares) {
        const afterPath=target+grant.folder_path.slice(source.length);
        if (input.action==='copy') {
          const inserted=(await client.query(`INSERT INTO folder_shares(collection_id,folder_path,principal_type,principal_id,role,created_by)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[destinationCollection,afterPath,grant.principal_type,grant.principal_id,grant.role,actor.userId])).rows[0];
          folderShares.push({id:inserted.id,beforePath:grant.folder_path,afterPath,copy:true});
        } else {
          await client.query('UPDATE folder_shares SET collection_id=$2,folder_path=$3,updated_at=NOW() WHERE id=$1',[grant.id,destinationCollection,afterPath]);
          folderShares.push({id:grant.id,beforePath:grant.folder_path,afterPath,copy:false});
        }
      }
      for (const link of sourceTree.publicLinks) {
        if (input.action==='copy') continue;
        const afterPath=target+link.folder_path.slice(source.length);
        await client.query('UPDATE file_share_links SET collection_id=$2,folder_path=$3,updated_at=NOW() WHERE id=$1',[link.id,destinationCollection,afterPath]);
        publicLinks.push({id:link.id,beforePath:link.folder_path,afterPath});
      }
      transferredGrants={folderShares,publicLinks};
    }
    // Child receipts are created before the folder-owned grant relocation is
    // complete. Sign them only after every owned grant change, otherwise an
    // immediate guarded Undo mistakes this operation's own changes for an
    // external permission change. This includes displaced Replace children:
    // their collection-wide signature also observes transferred grants.
    for (const child of [...children,...(displaced?.children??[])]) await client.query(
      'UPDATE files_database_operation_receipts SET permission_signature=$2 WHERE id=$1',
      [child.operationId,await permissionSignature(client,child.collectionId,child.operationId)]);
    const plan={ sourceCollectionId:input.collectionId,targetCollectionId:destinationCollection,source,target,folders:folderChanges,children,
      sourceSubtreeSignature:sourceTree.subtreeSignature,...(transferredGrants?{transferredGrants}:{}),...(displaced?{displaced}:{}),
      ...(input.action==='trash'?{lifecycle:await configuredReceiptLifecycle(client,input.collectionId,new Date())}:{}) };
    const updated=(await client.query('UPDATE files_database_operation_receipts SET after_state=$2,folder_plan=$3 WHERE id=$1 RETURNING *',
      [row.id,folderChanges.find(f=>f.before.path===source)?.after,plan])).rows[0];
    await client.query('UPDATE files_database_operation_receipts SET permission_signature=$2 WHERE id=$1',[row.id,await permissionSignature(client,input.collectionId,row.id)]);
    await access.custody?.publish(client,updated,false);
    await client.query("INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user',$1,'folder-operation',$2)",[actor.userId,{operationId:row.id,action:input.action,collectionId:input.collectionId}]);
  });
}

export async function restoreTrashedFolder(db:pg.Pool,folderId:string,receiptId:string,expectedRevision:string,actor:FilesIdentity,access:DatabaseOperationAccess):Promise<{
  status:'restored';kind:'folder';id:string;path:string;revision:string;currentTombstone:null;receiptId:string;
}> {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(folderId) || !uuid.test(receiptId) || !/^\d+$/.test(expectedRevision)) throw Object.assign(new Error('Valid folder, receipt and revision are required'),{status:400});
  const initial=(await db.query(`SELECT collection_id FROM files_database_operation_receipts WHERE id=$1 AND action='trash'`,[receiptId])).rows[0];
  if (!initial) throw Object.assign(new Error('Trash receipt not found'),{status:404});
  await access.prepare?.(initial.collection_id);
  const execute=()=>transaction(db,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['stored-namespace:'+initial.collection_id]);
    const row=(await client.query(`SELECT * FROM files_database_operation_receipts WHERE id=$1 AND action='trash' FOR UPDATE`,[receiptId])).rows[0];
    const plan=row?.folder_plan;
    if (!row || row.state!=='completed' || !plan?.source) throw fail('Folder Trash receipt is no longer restorable');
    if (plan.lifecycle?.disposal?.undoInvalidatedAt) throw fail('The retained Folder Trash receipt expired or was explicitly invalidated');
    if (row.permission_signature && row.permission_signature!==await permissionSignature(client,row.collection_id,row.id)) throw fail('Folder permissions or public links changed after Trash');
    const root=plan.folders.find((item:any)=>item.before.folderId===folderId && item.before.path===plan.source);
    if (!root || root.after.revision!==expectedRevision || !root.deleted) throw fail('The folder tombstone changed; refresh Files');
    const files=(await client.query("SELECT * FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') ORDER BY id FOR UPDATE",[row.collection_id,plan.source])).rows;
    const expectedFiles=new Map(plan.children.map((item:any)=>[item.after.fileId,item.after]));
    if (files.length!==expectedFiles.size || files.some(file=>{const expected:any=expectedFiles.get(file.id);return !expected || file.path!==expected.path || file.current_version_id!==expected.versionId || String(file.operation_revision)!==expected.revision || !file.deleted_at})) throw fail('Folder contents changed after Trash');
    const folders=(await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY id FOR UPDATE",[row.collection_id,plan.source])).rows;
    if (folders.length!==plan.folders.length || folders.some(folder=>!plan.folders.some((item:any)=>item.after.folderId===folder.id && item.after.path===folder.path && item.after.revision===String(folder.operation_revision) && folder.deleted_at))) throw fail('Folder identity, revision or subtree changed after Trash');
    for (const file of files) await access.file(client,file.id);
    for (const folder of folders) { await access.path(client,row.collection_id,folder.path); await access.path(client,row.collection_id,plan.folders.find((item:any)=>item.after.folderId===folder.id).before.path) }
    for (const child of [...plan.children].reverse()) {
      const childRow=(await client.query(`SELECT * FROM files_database_operation_receipts WHERE id=$1 FOR UPDATE`,[child.operationId])).rows[0];
      if (!childRow) throw fail('Folder child Trash receipt is missing');
      await restoreTrashReceipt(client,childRow,actor,metadataAccess(access),false);
    }
    for (const folder of [...plan.folders].reverse()) await client.query('UPDATE file_folders SET path=$2,deleted_at=NULL,updated_at=NOW() WHERE id=$1',[folder.after.folderId,folder.before.path]);
    await access.custody?.publish(client,row,true);
    await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1",[row.id]);
    await client.query("INSERT INTO audit_log(who_type,who_id,device_or_run_id,action,details) VALUES($1,$2,$3,'trash-restore-folder',$4)",[actor.kind==='capability'?'agent-or-device':'user',actor.userId,actor.deviceId||null,{receiptId:row.id,folderId,path:plan.source}]);
    const restored=(await client.query('SELECT * FROM file_folders WHERE id=$1',[folderId])).rows[0];
    return {status:'restored' as const,kind:'folder' as const,id:restored.id,path:restored.path,revision:String(restored.operation_revision),currentTombstone:null,receiptId:row.id};
  });
  return access.custody?access.custody.run(execute):execute();
}

export async function purgeTrashedFolder(db:pg.Pool,folderId:string,receiptId:string,expectedRevision:string,actor:FilesIdentity,access:DatabaseOperationAccess,input:{
  invalidateUndo:boolean;
  dispose?:(receiptId:string)=>Promise<{state:'none'|'complete'|'recovery-required';error?:string}>;
  drainChunks?:()=>Promise<void>;
}):Promise<any> {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(folderId) || !uuid.test(receiptId) || !/^\d+$/.test(expectedRevision) || input.invalidateUndo!==true) {
    throw Object.assign(new Error('Valid folder, receipt, revision and invalidateUndo=true are required'),{status:400});
  }
  const initial=(await db.query(`SELECT collection_id FROM files_database_operation_receipts WHERE id=$1 AND action='trash'`,[receiptId])).rows[0];
  if (!initial) throw Object.assign(new Error('Folder Trash receipt not found'),{status:404});
  await access.prepare?.(initial.collection_id);
  let committedResult:any;
  const execute=async()=>{
    const result=await transaction(db,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['stored-namespace:'+initial.collection_id]);
    const row=(await client.query(`SELECT * FROM files_database_operation_receipts WHERE id=$1 AND action='trash' FOR UPDATE`,[receiptId])).rows[0];
    const plan=row?.folder_plan;
    if (!row || row.state!=='completed' || !plan?.source) throw Object.assign(new Error('Folder Trash receipt is no longer disposable'),{status:409});
    if (row.permission_signature && row.permission_signature!==await permissionSignature(client,row.collection_id,row.id)) throw fail('Folder permissions or public links changed after Trash');
    const root=plan.folders.find((item:any)=>item.before.folderId===folderId && item.before.path===plan.source);
    if (!root || root.after.revision!==expectedRevision || !root.deleted) throw fail('The folder tombstone changed; refresh Files');
    const files=(await client.query("SELECT * FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') ORDER BY id FOR UPDATE",[row.collection_id,plan.source])).rows;
    const expectedFiles=new Map(plan.children.map((item:any)=>[item.after.fileId,item.after]));
    if (files.length!==expectedFiles.size || files.some(file=>{const expected:any=expectedFiles.get(file.id);return !expected || file.path!==expected.path || file.current_version_id!==expected.versionId || String(file.operation_revision)!==expected.revision || !file.deleted_at})) throw fail('Folder contents changed after Trash');
    const folders=(await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY id FOR UPDATE",[row.collection_id,plan.source])).rows;
    if (folders.length!==plan.folders.length || folders.some(folder=>!plan.folders.some((item:any)=>item.after.folderId===folder.id && item.after.path===folder.path && item.after.revision===String(folder.operation_revision) && folder.deleted_at))) throw fail('Folder identity, revision or subtree changed after Trash');
    for (const file of files) await access.file(client,file.id);
    for (const folder of folders) await access.path(client,row.collection_id,folder.path);
    if (files.some(file=>file.disposal_status!=='approved') || (files.length && (await client.query('SELECT 1 FROM files f WHERE f.id=ANY($1::uuid[]) AND files_retention_active(f) LIMIT 1',[files.map(file=>file.id)])).rowCount)) throw fail('Every file requires approved disposal with no active retention or lock');
    if (files.length && (await client.query('SELECT 1 FROM file_share_links WHERE file_id=ANY($1::uuid[]) AND revoked_at IS NULL LIMIT 1',[files.map(file=>file.id)])).rowCount) throw fail('Active share links must be revoked before folder disposal');
    const operation=(await client.query('SELECT * FROM files_path_operations WHERE operation_id=$1 FOR UPDATE',[row.id])).rows[0];
    if (operation && (!['completed','undone','rolled-back'].includes(operation.state)||operation.last_error)) throw fail('Native Folder Trash journal requires recovery before disposal');
    if (operation && !input.dispose) throw Object.assign(new Error('Native retained-artifact disposal is unavailable; artifacts were preserved'),{status:503});
    for (const child of plan.children) {
      const childRow=(await client.query(`SELECT * FROM files_database_operation_receipts WHERE id=$1 AND action='trash' FOR UPDATE`,[child.operationId])).rows[0];
      if (!childRow || childRow.state!=='completed' || childRow.after_state?.versionId!==child.after.versionId) throw fail('A child Trash receipt changed');
    }
    const invalidation=plan.lifecycle?.disposal??{undoInvalidatedAt:new Date().toISOString(),invalidatedBy:actor.userId,reason:'explicit-folder-disposal'};
    plan.lifecycle={...(plan.lifecycle??{}),disposal:invalidation};
    await client.query('UPDATE files_database_operation_receipts SET folder_plan=$2 WHERE id=$1',[row.id,plan]);
    for (const child of plan.children) await client.query(`UPDATE files_database_operation_receipts SET folder_plan=COALESCE(folder_plan,'{}'::jsonb)||jsonb_build_object(
      'lifecycle',COALESCE(folder_plan->'lifecycle','{}'::jsonb)||jsonb_build_object('disposal',$2::jsonb)) WHERE id=$1`,[child.operationId,JSON.stringify(invalidation)]);
    if (operation) { operation.plan.disposal=invalidation; await client.query('UPDATE files_path_operations SET plan=$2,updated_at=NOW() WHERE operation_id=$1',[row.id,operation.plan]) }
    await client.query('LOCK TABLE file_versions IN SHARE ROW EXCLUSIVE MODE');
    const fileIds=files.map(file=>file.id);
    const chunks=fileIds.length?(await client.query(`SELECT DISTINCT v.chunk_collection_id,jsonb_array_elements_text(m.chunk_ids) chunk_id FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.file_id=ANY($1::uuid[])`,[fileIds])).rows:[];
    const audit=(await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,action,details) VALUES($1,$2,$3,'folder-disposal-purge',$4) RETURNING id`,
      [actor.kind==='capability'?'agent-or-device':'user',actor.userId,actor.deviceId||null,{folderId,path:plan.source,collectionId:row.collection_id,fileIds,receiptId:row.id,physicalChunkGc:chunks.length?'pending':'not-required'}])).rows[0];
    for (const file of files) {
      await client.query(`INSERT INTO file_purge_tombstones(collection_id,file_id,path,lifecycle_generation,audience)
        SELECT $1,$2,$3,$4,jsonb_build_object(
          'users',to_jsonb(ARRAY(SELECT DISTINCT principal FROM (
            SELECT owner_user_id principal FROM collections WHERE id=$1
            UNION SELECT principal_id FROM collection_acl WHERE collection_id=$1 AND principal_type='user'
            UNION SELECT principal_id FROM folder_shares WHERE collection_id=$1 AND principal_type='user' AND ($3=folder_path OR starts_with($3,folder_path||'/'))
            UNION SELECT principal_id FROM file_shares WHERE file_id=$2 AND principal_type='user') users)),
          'groups',to_jsonb(ARRAY(SELECT DISTINCT principal FROM (
            SELECT principal_id principal FROM collection_acl WHERE collection_id=$1 AND principal_type='group'
            UNION SELECT principal_id FROM folder_shares WHERE collection_id=$1 AND principal_type='group' AND ($3=folder_path OR starts_with($3,folder_path||'/'))
            UNION SELECT principal_id FROM file_shares WHERE file_id=$2 AND principal_type='group') groups)))
        ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,lifecycle_generation=GREATEST(file_purge_tombstones.lifecycle_generation,EXCLUDED.lifecycle_generation),audience=EXCLUDED.audience,purged_at=NOW()`,
      [row.collection_id,file.id,file.path,Number(file.lifecycle_generation)+1]);
    }
    if (fileIds.length) {
      await client.query('DELETE FROM journal WHERE file_id=ANY($1::uuid[])',[fileIds]);
      await client.query('UPDATE audit_log SET file_id=NULL,version_id=NULL WHERE file_id=ANY($1::uuid[]) OR version_id IN(SELECT id FROM file_versions WHERE file_id=ANY($1::uuid[]))',[fileIds]);
      await client.query('DELETE FROM file_share_links WHERE file_id=ANY($1::uuid[])',[fileIds]);
      await client.query('UPDATE files SET current_version_id=NULL,draft_version_id=NULL,published_version_id=NULL WHERE id=ANY($1::uuid[])',[fileIds]);
      await client.query('DELETE FROM files WHERE id=ANY($1::uuid[])',[fileIds]);
    }
    for (const folder of [...plan.folders].reverse()) await client.query('DELETE FROM file_folders WHERE id=$1',[folder.after.folderId]);
    let queued=0;
    for (const chunk of chunks) {
      const refs=Number((await client.query(`SELECT COUNT(DISTINCT v.id)::int refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2`,[chunk.chunk_collection_id,chunk.chunk_id])).rows[0].refs);
      await client.query('UPDATE chunks SET refcount=$3 WHERE collection_id=$1 AND id=$2',[chunk.chunk_collection_id,chunk.chunk_id,refs]);
      if (!refs) { await client.query(`INSERT INTO file_chunk_gc(collection_id,chunk_id,audit_id) VALUES($1,$2,$3) ON CONFLICT(collection_id,chunk_id) DO UPDATE SET audit_id=EXCLUDED.audit_id,requested_at=NOW(),last_error=NULL`,[chunk.chunk_collection_id,chunk.chunk_id,audit.id]); queued++ }
    }
      return {auditId:audit.id,queued,retained:Boolean(operation),path:plan.source,revision:expectedRevision};
    });
    committedResult=result;
    return result;
  };
  let custodyRecoveryFailed=false; let removed:any;
  try { removed=access.custody?await access.custody.run(execute):await execute() }
  catch(error) { if (!committedResult) throw error; removed=committedResult; custodyRecoveryFailed=true }
  const retainedResult=removed.retained
    ? custodyRecoveryFailed
      ? {state:'recovery-required' as const,error:'Retained-artifact cleanup did not complete; exact artifacts were preserved for recovery'}
      : await input.dispose!(receiptId).catch(()=>({state:'recovery-required' as const,error:'Retained-artifact cleanup did not complete; exact artifacts were preserved for recovery'}))
    : {state:'none' as const};
  if (removed.queued && input.drainChunks) await input.drainChunks().catch(()=>undefined);
  const chunksPending=Boolean((await db.query('SELECT 1 FROM file_chunk_gc WHERE audit_id=$1 LIMIT 1',[removed.auditId])).rowCount);
  const common={kind:'folder' as const,id:folderId,path:removed.path,revision:removed.revision,currentTombstone:null,metadataPurged:true,undo:'invalidated' as const,receiptId};
  if (chunksPending || retainedResult.state==='recovery-required') return {status:'recovery-required' as const,...common,chunks:chunksPending?'pending':'complete',retainedArtifacts:retainedResult.state==='recovery-required'?'preserved':'complete',...(retainedResult.error?{reason:retainedResult.error}:{})};
  return {status:'purged' as const,...common,chunks:'complete',retainedArtifacts:retainedResult.state};
}

export async function undoFolderBatchItem(db:pg.Pool,id:string,actor:FilesIdentity,access:DatabaseOperationAccess,guard:(client:pg.PoolClient)=>Promise<void>):Promise<void> {
  const initial=(await db.query('SELECT collection_id,request FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3',[id,actor.userId,scope(actor)])).rows[0];
  if (!initial) throw fail('Folder receipt missing');
  await access.prepare?.(initial.collection_id);
  if (initial.request?.targetCollectionId && initial.request.targetCollectionId!==initial.collection_id) await access.prepare?.(initial.request.targetCollectionId);
  await transaction(db,async client=>{
    await guard(client);
    const row=(await client.query('SELECT * FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3 FOR UPDATE',[id,actor.userId,scope(actor)])).rows[0];
    if (!row?.folder_plan) throw fail('Folder receipt missing');
    const plan=row.folder_plan;
    const sourceCollection=plan.sourceCollectionId??row.collection_id;
    const targetCollection=plan.targetCollectionId??row.collection_id;
    if (plan.lifecycle?.disposal?.undoInvalidatedAt) throw fail('Undo was explicitly invalidated by permanent disposal');
    await access.path(client,sourceCollection,plan.source);
    if (plan.target) await access.path(client,targetCollection,plan.target);
    if (row.state==='undone') return;
    if (row.state!=='completed') throw fail('Folder operation cannot be undone');
    if (row.permission_signature!==await permissionSignature(client,row.collection_id,row.id)) throw fail('Folder permissions changed');
    for (const collectionId of [...new Set([sourceCollection,targetCollection])].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['stored-namespace:'+collectionId]);
    const validateTree=async(collectionId:string,subtree:string,children:any[],folders:any[],label:string) => {
      const actualFiles=(await client.query("SELECT * FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY id FOR UPDATE",[collectionId,subtree])).rows;
      const expectedFiles=new Map(children.map((child:any)=>[child.after.fileId,child.after]));
      if (actualFiles.length!==expectedFiles.size || actualFiles.some(file=>{const expected:any=expectedFiles.get(file.id);return !expected || file.path!==expected.path || file.current_version_id!==expected.versionId || String(file.operation_revision)!==expected.revision || Boolean(file.deleted_at)!==expected.deleted})) throw fail(label+' subtree membership, identity or lifecycle changed');
      const actualFolders=(await client.query("SELECT * FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY id FOR UPDATE",[collectionId,subtree])).rows;
      if (actualFolders.length!==folders.length || folders.some((folder:any)=>!actualFolders.some(actual=>actual.id===folder.after.folderId && actual.path===folder.after.path && String(actual.operation_revision)===folder.after.revision && Boolean(actual.deleted_at)===Boolean(folder.deleted)))) throw fail(label+' folder identity, revision or membership changed');
      for (const file of actualFiles) await access.file(client,file.id);
      for (const folder of actualFolders) await access.path(client,collectionId,folder.path);
    };
    const subtree=plan.target??plan.source;
    const currentCollection=plan.target?targetCollection:sourceCollection;
    await validateTree(currentCollection,subtree,plan.children,plan.folders,'Folder');
    const actualFolderShares=(await client.query("SELECT id,folder_path FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id FOR UPDATE",[currentCollection,subtree])).rows;
    const actualPublicLinks=(await client.query("SELECT id,folder_path FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id FOR UPDATE",[currentCollection,subtree])).rows;
    const expectedFolderShares=plan.transferredGrants?.folderShares??[];
    const expectedPublicLinks=plan.transferredGrants?.publicLinks??[];
    if (actualFolderShares.length!==expectedFolderShares.length || expectedFolderShares.some((grant:any)=>!actualFolderShares.some((actual:any)=>actual.id===grant.id && actual.folder_path===grant.afterPath)) ||
      actualPublicLinks.length!==expectedPublicLinks.length || expectedPublicLinks.some((link:any)=>!actualPublicLinks.some((actual:any)=>actual.id===link.id && actual.folder_path===link.afterPath))) throw fail('Folder grants or public links changed');
    if (plan.displaced) {
      const displacedCollection=plan.displaced.collectionId??targetCollection;
      await access.path(client,displacedCollection,plan.displaced.target);
      await validateTree(displacedCollection,plan.displaced.target,plan.displaced.children,plan.displaced.folders,'Displaced folder');
      const actualFolderShares=(await client.query("SELECT id,folder_path FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id FOR UPDATE",[displacedCollection,plan.displaced.target])).rows;
      const actualPublicLinks=(await client.query("SELECT id,folder_path FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) ORDER BY id FOR UPDATE",[displacedCollection,plan.displaced.target])).rows;
      const expectedFolderShares=plan.displaced.grants?.folderShares??[];
      const expectedPublicLinks=plan.displaced.grants?.publicLinks??[];
      if (actualFolderShares.length!==expectedFolderShares.length || expectedFolderShares.some((grant:any)=>!actualFolderShares.some((actual:any)=>actual.id===grant.id && actual.folder_path===grant.afterPath)) ||
        actualPublicLinks.length!==expectedPublicLinks.length || expectedPublicLinks.some((link:any)=>!actualPublicLinks.some((actual:any)=>actual.id===link.id && actual.folder_path===link.afterPath))) throw fail('Displaced folder grants changed');
      const fileIds=plan.displaced.grants?.fileIds??[];
      const fileSharesSignature=(await client.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]'::jsonb)::text) signature FROM file_shares item WHERE item.file_id=ANY($1::uuid[])",[fileIds])).rows[0].signature;
      const fileLinksSignature=(await client.query("SELECT md5(COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]'::jsonb)::text) signature FROM file_share_links item WHERE item.file_id=ANY($1::uuid[])",[fileIds])).rows[0].signature;
      if (fileSharesSignature!==plan.displaced.grants?.fileSharesSignature || fileLinksSignature!==plan.displaced.grants?.fileLinksSignature) throw fail('Displaced folder file grants or links changed');
    }
    const ownedGrantMigration=sourceCollection!==targetCollection && Boolean(plan.transferredGrants);
    if (ownedGrantMigration) {
      // Verify every child before changing the signatures they cover. The
      // transaction is SERIALIZABLE, and only the exact recorded grants below
      // are then restored. Child undo may skip its duplicate signature check,
      // but still performs normal file CAS, authorization and cross-collection
      // audience/key-boundary validation against the restored audience.
      for (const child of [...plan.children,...(plan.displaced?.children??[])]) {
        const receipt=(await client.query('SELECT collection_id,state,permission_signature FROM files_database_operation_receipts WHERE id=$1 FOR UPDATE',[child.operationId])).rows[0];
        if (!receipt || receipt.state!=='completed' || !receipt.permission_signature || receipt.permission_signature!==await permissionSignature(client,receipt.collection_id,child.operationId)) {
          throw fail('Child permissions or public links changed');
        }
      }
      for (const grant of [...(plan.transferredGrants?.folderShares??[])].reverse()) {
        if (grant.copy) await client.query('DELETE FROM folder_shares WHERE id=$1 AND collection_id=$2 AND folder_path=$3',[grant.id,targetCollection,grant.afterPath]);
        else await client.query('UPDATE folder_shares SET collection_id=$2,folder_path=$3,updated_at=NOW() WHERE id=$1 AND collection_id=$4 AND folder_path=$5',[grant.id,sourceCollection,grant.beforePath,targetCollection,grant.afterPath]);
      }
      for (const link of plan.transferredGrants?.publicLinks??[]) await client.query('UPDATE file_share_links SET collection_id=$2,folder_path=$3,updated_at=NOW() WHERE id=$1 AND collection_id=$4 AND folder_path=$5',[link.id,sourceCollection,link.beforePath,targetCollection,link.afterPath]);
    }
    // File inverses restore metadata first; the one native journal publishes
    // the complete folder inverse before this transaction can commit.
    for (const child of [...plan.children].reverse()) await undoDatabaseOperation(db,child.operationId,actor,metadataAccess(access),undefined,client,
      ownedGrantMigration?{permissionSignatureVerified:true}:undefined);
    for (const folder of [...plan.folders].reverse()) {
      await access.path(client,folder.after.collectionId??targetCollection,folder.after.path);
      await access.path(client,folder.before.collectionId??sourceCollection,folder.before.path);
      if (row.action==='copy') await client.query('DELETE FROM file_folders WHERE id=$1',[folder.after.folderId]);
      else await client.query('UPDATE file_folders SET collection_id=$2,path=$3,deleted_at=NULL,updated_at=NOW() WHERE id=$1',[folder.after.folderId,folder.before.collectionId??sourceCollection,folder.before.path]);
    }
    if (plan.displaced) {
      const displacedCollection=plan.displaced.collectionId??targetCollection;
      for (const child of [...plan.displaced.children].reverse()) await undoDatabaseOperation(db,child.operationId,actor,metadataAccess(access),undefined,client,
        {folderGrantMigration:true,...(ownedGrantMigration?{permissionSignatureVerified:true as const}:{})});
      for (const folder of [...plan.displaced.folders].reverse()) {
        await access.path(client,displacedCollection,folder.after.path);
        await access.path(client,displacedCollection,folder.before.path);
        await client.query('UPDATE file_folders SET path=$2,deleted_at=NULL,updated_at=NOW() WHERE id=$1',[folder.after.folderId,folder.before.path]);
      }
      for (const grant of plan.displaced.grants?.folderShares??[]) await client.query('UPDATE folder_shares SET folder_path=$2,updated_at=NOW() WHERE id=$1 AND folder_path=$3',[grant.id,grant.beforePath,grant.afterPath]);
      for (const link of plan.displaced.grants?.publicLinks??[]) await client.query('UPDATE file_share_links SET folder_path=$2,updated_at=NOW() WHERE id=$1 AND folder_path=$3',[link.id,link.beforePath,link.afterPath]);
    }
    await access.custody?.publish(client,row,true);
    await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1",[id]);
  });
}
