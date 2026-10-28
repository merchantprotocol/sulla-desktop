// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import { versionCheckedTextSave } from './automergeText.js';

const baseVersionId='11111111-1111-4111-8111-111111111111';
const currentVersionId='22222222-2222-4222-8222-222222222222';

test('version-checked save accepts the head, merges stale text, and rejects stale binary without writing',()=>{
  let writes=0;
  const persist=(result:ReturnType<typeof versionCheckedTextSave>)=>{if(result.status===200)writes+=1};

  const same=versionCheckedTextSave({baseVersionId,currentVersionId:baseVersionId,base:Buffer.from('before'),current:Buffer.from('before'),submitted:Buffer.from('after')});
  assert.deepEqual({status:same.status,merged:same.status===200&&same.merged,content:same.status===200&&same.content},{status:200,merged:false,content:'after'});
  persist(same);

  const stale=versionCheckedTextSave({baseVersionId,currentVersionId,base:Buffer.from('one\ntwo\n'),current:Buffer.from('ONE\ntwo\n'),submitted:Buffer.from('one\nTWO\n')});
  assert.equal(stale.status,200); if(stale.status===200){assert.equal(stale.merged,true);assert.match(stale.content,/ONE/);assert.match(stale.content,/TWO/)}
  persist(stale);

  const beforeConflict=writes;
  const conflict=versionCheckedTextSave({baseVersionId,currentVersionId,base:Buffer.from([0,1]),current:Buffer.from([0,2]),submitted:Buffer.from('replacement')});
  assert.deepEqual(conflict,{status:409,currentVersionId});
  assert.equal(writes,beforeConflict,'a 409 conflict must not write a version');
});
