// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createApp } from './app.js';
import { appendAuditLine } from './auditChain.js';
import { issueCapabilityToken } from './auth.js';

// One focused integrity/security regression: stable chain plus an immutable audit area.
test('file audit appends form a continuous hash chain and an agent cannot write Logs',async()=>{
  const event={subjectKind:'file',subjectId:'synthetic-file',actor:'synthetic-agent',action:'create',path:'notes.txt',result:'success',requestId:'synthetic-request'};
  const first=appendAuditLine(event,undefined,'2026-10-19T00:00:00.000Z');
  const second=appendAuditLine({...event,action:'rename',path:'renamed.txt'},first,'2026-10-19T00:00:01.000Z');
  assert.equal(first.prevHash,'');
  assert.equal(second.prevHash,first.hash);
  for (const line of [first,second]) {
    const {hash,...payload}=line;
    const canonical=JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([left],[right])=>left.localeCompare(right))));
    assert.equal(hash,createHash('sha256').update(line.prevHash+canonical).digest('hex'));
  }
  const key='synthetic-files-first-signing-key-32bytes';
  const db={query:async(sql:string)=>({rows:sql.startsWith('SELECT * FROM collections')?[{id:'logs',system_area:'logs',kind:'knowledge'}]:[],rowCount:sql.startsWith('SELECT * FROM collections')?1:0}),
    connect:async()=>({query:async()=>({rows:[],rowCount:0}),release:()=>undefined})} as any;
  const app=createApp(db,{keyring:{unlocked:true},chunkRoot:'/synthetic/chunks',dataRoot:'/synthetic',capabilitySigningKey:key,mode:'desktop',userId:'synthetic-user',deviceId:'synthetic-device'} as any);
  const server=app.listen(0);
  await new Promise<void>(resolve=>server.once('listening',resolve));
  try {
    const token=issueCapabilityToken({sub:'synthetic-user',agent_id:'synthetic-agent',scopes:['files/*']},key);
    const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/files/upload?collectionId=logs&path=forged.jsonl`,{
      method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream'},body:'forged',
    });
    assert.equal(response.status,403);
    assert.equal((await response.json() as {code:string}).code,'EROFS');
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});
