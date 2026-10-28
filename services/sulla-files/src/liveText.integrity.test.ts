// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as A from '@automerge/automerge';
import { editTextDocument, newTextDocument, type TextDocument } from './automergeText.js';
import { LiveTextSessions } from './liveText.js';

test('editor and content/mount branch converge, persist exactly, and reject view-only changes',async()=>{
  const sessions=new LiveTextSessions(60_000);
  const initial=newTextDocument('First paragraph.\nLast paragraph.');let persisted='';
  sessions.open('file',A.clone(initial),async document=>{persisted=document.text;});
  const editor=sessions.join('file',{owner:'human',name:'Jonathon',kind:'user',editable:true});
  let document=A.init<TextDocument>(),state=A.initSyncState();
  function sync(peerId=editor.peerId){for(let n=0;n<20;n++){const [next,message]=A.generateSyncMessage(document,state);state=next;if(!message)return;const reply=sessions.receive('file',peerId,message);if(reply)[document,state]=A.receiveSyncMessage(document,state,Buffer.from(reply,'base64'));}assert.fail('Sync did not settle');}
  try{
    sync();
    document=editTextDocument(document,'First paragraph edited by human.\nLast paragraph.');
    // The mount/content API read the same persisted version before the editor submitted its edit.
    const external=editTextDocument(A.clone(initial),'First paragraph.\nLast paragraph edited by agent.');
    sessions.adopt('file',external);sync();
    assert.equal(document.text,'First paragraph edited by human.\nLast paragraph edited by agent.');
    assert.equal(sessions.document('file')!.text,document.text);
    await sessions.flush('file');assert.equal(persisted,document.text);
    const viewer=sessions.join('file',{owner:'viewer',name:'Viewer',kind:'user',editable:false});
    document=A.init<TextDocument>();state=A.initSyncState();sync(viewer.peerId);
    document=editTextDocument(document,document.text+' forbidden');
    const [,message]=A.generateSyncMessage(document,state);assert.ok(message);
    assert.throws(()=>sessions.receive('file',viewer.peerId,message),/View-only/);
    assert.equal(sessions.document('file')!.text,persisted);
  }finally{await sessions.close();}
});
