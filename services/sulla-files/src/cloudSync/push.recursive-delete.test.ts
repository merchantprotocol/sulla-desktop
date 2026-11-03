// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCommitBatch, drainRecursiveDelete, resumeRecursiveDeleteBatches, type NamespaceBatchStatus, type RecursiveDeleteProgress } from './push.js';
import type { UploadSession } from './repository.js';

test('600 tombstones use three signed commits and resume from Cloud after batch zero crashes',async()=>{
  const rootItemId='00000000-0000-4000-8000-000000000001';
  const batchId='00000000-0000-4000-8000-000000000002';
  const deviceId='device-a';
  const sessions:UploadSession[]=Array.from({length:600},(_,i)=>({journalSeq:i+1,fileId:`00000000-0000-4000-8001-${String(i).padStart(12,'0')}`,versionId:`00000000-0000-4000-8002-${String(i).padStart(12,'0')}`,parentVersionId:null,baseVersionId:null,deleted:true,manifest:{ciphertext:'x'},chunkIds:[],declared:[],staged:[],uploadId:null,present:[]}));
  let local:RecursiveDeleteProgress|null=null;
  let remote:NamespaceBatchStatus|null=null;
  let crash=true;
  const bodies:any[]=[];
  let sync:any={collectionId:'00000000-0000-4000-8000-000000000003',keyVersion:1,lastSeq:0,head:null};
  const cloudHeads:any[]=[];
  const progress={load:async()=>local,save:async(value:RecursiveDeleteProgress)=>{local=value},clear:async()=>{local=null}};
  const send=async(metadata:any,batch:UploadSession[])=>{
    const commit=await buildCommitBatch(sync,batch,cloudHeads,new Uint8Array(32).fill(7),metadata);
    const body=JSON.parse(commit.body); bodies.push(body);
    assert.deepEqual(body.batch,metadata);
    assert.ok(typeof commit.sha256==='string'&&commit.sha256.length===64);
    for(const session of batch) cloudHeads.push({fileId:session.fileId,versionId:session.versionId,deleted:true});
    sync={...sync,lastSeq:commit.head.seq,head:commit.head};
    remote={rootItemId,deviceId,lastIndex:metadata.index,final:metadata.final};
    if(crash){crash=false;throw new Error('simulated crash')}
  };
  const run=()=>resumeRecursiveDeleteBatches({batchId,rootItemId,deviceId,sessions,progress,status:async()=>remote,send});
  await assert.rejects(run(),/simulated crash/);
  await run();
  assert.deepEqual(bodies.map(body=>body.versions.length),[256,256,88]);
  assert.deepEqual(bodies.map(body=>[body.batch.index,body.batch.final]),[[0,false],[1,false],[2,true]]);
  assert.equal(local,null);
});

test('final batch re-pulls and starts a new batch for a concurrent descendant',async()=>{
  const rootItemId='00000000-0000-4000-8000-000000000001';
  const session=(n:number)=>({journalSeq:n,fileId:`00000000-0000-4000-8001-${String(n).padStart(12,'0')}`,versionId:`00000000-0000-4000-8002-${String(n).padStart(12,'0')}`,parentVersionId:null,baseVersionId:null,deleted:true,manifest:{},chunkIds:[],declared:[],staged:[],uploadId:null,present:[]} as UploadSession);
  let local:RecursiveDeleteProgress|null=null,refreshes=0,id=0;
  const sent:string[]=[];
  await drainRecursiveDelete({rootItemId,deviceId:'device-a',initial:[session(1)],newBatchId:()=>`00000000-0000-4000-8003-${String(++id).padStart(12,'0')}`,
    progress:{load:async()=>local,save:async value=>{local=value},clear:async()=>{local=null}},status:async()=>null,
    send:async metadata=>{sent.push(metadata.batchId)},refreshAndEnumerate:async()=>++refreshes===1?[session(2)]:[]});
  assert.equal(refreshes,2);
  assert.equal(new Set(sent).size,2);
});
