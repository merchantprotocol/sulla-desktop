// SPDX-License-Identifier: GPL-2.0-or-later

import {describe,expect,it,vi} from 'vitest';
import {CloudUploadSessions} from '../src/cloudSync/CloudUploadSessions.js';

const collectionId='11111111-1111-4111-8111-111111111111';
const uploadId='22222222-2222-4222-8222-222222222222';

function setup(missing:string[], putChunk:(id:string)=>Promise<number>) {
  const repositories={
    chunks:{markUploaded:vi.fn(async()=>{}),forgetUpload:vi.fn(async()=>{}),evictedChunks:vi.fn(async()=>[]),adoptServerCopy:vi.fn(async()=>{})},
    state:{sync:vi.fn(async()=>({uploadSession:{uploadId}})),saveSession:vi.fn(async()=>{})},
    operations:{dropCollectionOperations:vi.fn(async()=>{}),queue:vi.fn(async()=>{})},
    heads:{cloudHeadPages:vi.fn(async()=>[])},
  };
  const api={uploadStatus:vi.fn(async()=>({missing})),putChunk:vi.fn((_uploadId:string,id:string)=>putChunk(id)),abortUpload:vi.fn(async()=>{})};
  const staging={get:vi.fn(async()=>Buffer.from('ciphertext')),clear:vi.fn(async()=>{})};
  const service=new CloudUploadSessions(repositories as any,api as any,staging as any,{} as any,{} as any);
  return {service,repositories,api,staging};
}

function session(ids:string[]) {
  return {uploadId,staged:ids,present:[],fileId:'33333333-3333-4333-8333-333333333333',versionId:'44444444-4444-4444-8444-444444444444'} as any;
}

describe('CloudUploadSessions',()=>{
  it('uploads chunks with bounded parallelism and queues the version commit only after all PUTs finish',async()=>{
    // risk: sync ordering and availability — large files should not serialize independent ciphertext chunk requests.
    const ids=Array.from({length:9},(_,i)=>`chunk-${i}`);
    let active=0,peak=0,finished=0;
    const {service}=setup(ids,async()=>{
      active++; peak=Math.max(peak,active);
      await new Promise(resolve=>setTimeout(resolve,5));
      active--; finished++; return 201;
    });
    const commit=vi.spyOn(service,'queueCommit').mockImplementation(async()=>{
      expect(finished).toBe(ids.length);
    });
    await service.continueUpload({collectionId} as any,session(ids),new Uint8Array(32));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('drops an expired upload and does not commit the incomplete version',async()=>{
    // risk: data integrity — a partial upload must never advance the Cloud version head.
    const ids=['expired','not-started'];
    const {service,api,staging}=setup(ids,async()=>410);
    const commit=vi.spyOn(service,'queueCommit');
    await service.continueUpload({collectionId} as any,session(ids),new Uint8Array(32));
    expect(api.abortUpload).toHaveBeenCalledOnce();
    expect(staging.clear).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('waits for in-flight chunk PUTs before surfacing a network failure, and never commits',async()=>{
    // risk: sync integrity — a thrown PUT must not let a retry overlap sibling uploads or commit a partial version.
    const ids=['fails','slow-1','slow-2'];
    let slowDone=0;
    const {service}=setup(ids,async id=>{
      if (id==='fails') throw new Error('network down');
      await new Promise(resolve=>setTimeout(resolve,20));
      slowDone++; return 201;
    });
    const commit=vi.spyOn(service,'queueCommit');
    await expect(service.continueUpload({collectionId} as any,session(ids),new Uint8Array(32))).rejects.toThrow('network down');
    expect(slowDone).toBe(2);
    expect(commit).not.toHaveBeenCalled();
  });
});
