// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreTrashReceipt } from './databaseOperations.js';

test('receipt restore appends a new pushable version and retains its source', async() => {
  const fileId='00000000-0000-4000-8000-000000000001';
  const sourceId='00000000-0000-4000-8000-000000000002';
  const tombstoneId='00000000-0000-4000-8000-000000000003';
  const restoredId='00000000-0000-4000-8000-000000000004';
  const collectionId='00000000-0000-4000-8000-000000000005';
  const queries:Array<{sql:string; values:any[]}>=[];
  const file={id:fileId,collection_id:collectionId,path:'a.txt',current_version_id:tombstoneId,operation_revision:'2',deleted_at:new Date(),record_lock_type:'none',checked_out_by_user_id:null,require_checkout:false};
  const client={query:async(sql:string,values:any[]=[])=>{
    queries.push({sql,values});
    if (sql.includes('FROM files WHERE id=$1 FOR UPDATE')) return {rows:[file],rowCount:1};
    if (sql.includes('SELECT v.* FROM file_versions')) return {rows:[{id:sourceId,chunk_collection_id:collectionId,manifest_hash:'a'.repeat(64),size:3}],rowCount:1};
    if (sql.includes('INSERT INTO file_versions')) return {rows:[{id:restoredId}],rowCount:1};
    if (sql.includes('UPDATE files SET current_version_id')) return {rows:[{...file,current_version_id:restoredId,deleted_at:null,size:3}],rowCount:1};
    if(sql.includes('files_protected_files')||sql.includes('FROM file_roots')) return {rows:[],rowCount:0};
    return {rows:[],rowCount:1};
  }} as any;
  const row={id:'00000000-0000-4000-8000-000000000006',action:'trash',state:'completed',collection_id:collectionId,file_id:fileId,
    before_state:{collectionId,fileId,path:'a.txt',versionId:sourceId,revision:'1',deleted:false},
    after_state:{collectionId,fileId,path:'a.txt',versionId:tombstoneId,revision:'2',deleted:true}};
  const access={file:async()=>{},path:async()=>{}} as any;

  const restored=await restoreTrashReceipt(client,row,{userId:'user',deviceId:'device',kind:'user'} as any,access,false);

  assert.equal(restored.current_version_id,restoredId);
  const insert=queries.find(query=>query.sql.includes('INSERT INTO file_versions'))!;
  assert.deepEqual(insert.values.slice(2,5),[tombstoneId,sourceId,'a'.repeat(64)]);
  assert.ok(queries.some(query=>query.sql.includes("INSERT INTO journal")&&query.values[2]===restoredId));
  assert.ok(!queries.some(query=>query.sql.includes('files_cloud_versions')),'new version stays eligible for the push query');
});
