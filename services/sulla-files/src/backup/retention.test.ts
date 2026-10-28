// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import { retentionVictims, mayPrune, type SignedIncrementalManifest } from './incremental.js';
import { isoWeekStart, unreferencedBackupObjects } from './scheduler.js';

function manifest(id:string,createdAt:string,tier:'hourly'|'daily'|'weekly',objects:string[]=[]):SignedIncrementalManifest {
  return {manifest:{format:'sulla-files-incremental-backup',version:1,id,createdAt,tier,postgresVersion:'synthetic',snapshotId:'synthetic',migrations:[],tables:[],excludedTableData:{},entries:objects.map(objectKey=>({path:objectKey,type:'encrypted-chunk',size:1,sha256:'0'.repeat(64),objectKey}))},signature:{algorithm:'hmac-sha256',value:'synthetic'}};
}

test('retention preserves tier limits and shared objects; pruning requires a newer restore-verified snapshot',()=>{
  const now=new Date('2026-01-05T12:00:00Z');
  const hourly=Array.from({length:25},(_,index)=>manifest(`h${ index }`,new Date(now.getTime()-index*30*60_000).toISOString(),'hourly',['shared',`h${ index }`]));
  const daily=Array.from({length:31},(_,index)=>manifest(`d${ index }`,new Date(now.getTime()-index*60_000).toISOString(),'daily'));
  const weekly=Array.from({length:13},(_,index)=>manifest(`w${ index }`,new Date(now.getTime()-index*60_000).toISOString(),'weekly'));
  const expired=manifest('expired','2025-01-01T00:00:00Z','weekly',['unique-expired']);
  const all=[...hourly,...daily,...weekly,expired];
  const victims=retentionVictims(all,now);
  assert.deepEqual(victims.map(item=>item.manifest.id).sort(),['d30','expired','h24','w12']);
  assert.equal(mayPrune(hourly[24],{manifest:hourly[0],verifiedAt:'yes'}),false);
  assert.equal(mayPrune(hourly[0],{manifest:hourly[0],verifiedAt:'yes',restoreVerifiedAt:'yes'}),false);
  assert.equal(mayPrune(hourly[24],{manifest:hourly[0],verifiedAt:'yes',restoreVerifiedAt:'yes'}),true);
  const ids=new Set(victims.map(item=>item.manifest.id));
  assert.deepEqual(unreferencedBackupObjects(victims,all.filter(item=>!ids.has(item.manifest.id))).sort(),['h24','unique-expired']);
  assert.equal(isoWeekStart(new Date('2026-01-04T23:59:00Z')).toISOString(),'2025-12-29T00:00:00.000Z');
  assert.equal(isoWeekStart(new Date('2026-01-05T00:00:00Z')).toISOString(),'2026-01-05T00:00:00.000Z');
});
