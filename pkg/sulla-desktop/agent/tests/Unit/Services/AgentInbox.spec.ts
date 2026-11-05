// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentInbox, type AgentInboxClaim, type AgentInboxDeliveryReceipt, type AgentInboxEntry, type AgentInboxRepository, type AgentInboxTarget } from '../../../services/AgentInbox';

class MemoryInboxRepository implements AgentInboxRepository {
  readonly rows = new Map<string, { entry: AgentInboxEntry; delivered: boolean; owner?: string }>();
  async enqueue(entry: AgentInboxEntry): Promise<boolean> { const id=entry.envelope.ids.messageId; if(this.rows.has(id)) return false; this.rows.set(id,{entry,delivered:false}); return true; }
  async claim(target: AgentInboxTarget, owner: string): Promise<AgentInboxClaim> { const entries=[...this.rows.values()].filter(row => !row.delivered && !row.owner && row.entry.target.channel===target.channel && (!target.threadId || !row.entry.target.threadId || row.entry.target.threadId===target.threadId)).map(row => { row.owner=owner; return row.entry; }); return {owner,target,entries}; }
  async acknowledge(claim: AgentInboxClaim): Promise<void> { for(const entry of claim.entries){ const row=this.rows.get(entry.envelope.ids.messageId); if(row?.owner===claim.owner) row.delivered=true; } }
  async release(claim: AgentInboxClaim): Promise<void> { for(const entry of claim.entries){ const row=this.rows.get(entry.envelope.ids.messageId); if(row?.owner===claim.owner) delete row.owner; } }
  async pendingTargets(): Promise<AgentInboxTarget[]> { return [...this.rows.values()].filter(r=>!r.delivered&&!r.owner).map(r=>r.entry.target).filter((v,i,a)=>a.findIndex(x=>x.channel===v.channel&&x.threadId===v.threadId)===i); }
}
class RecordingDelivery {
  running=false; batches:string[]=[]; receipt:AgentInboxDeliveryReceipt='accepted'; onWake?:()=>void;
  isRunning():boolean{return this.running;}
  async wake(_target:AgentInboxTarget,batch:string):Promise<AgentInboxDeliveryReceipt>{this.batches.push(batch);this.onWake?.();return this.receipt;}
}
const entry=(id:string,body=id):AgentInboxEntry=>({target:{channel:'sulla-desktop',threadId:'receiver-thread',agentId:'sulla-desktop'},envelope:{from:'mobile-relay',kind:'peer',body,ids:{messageId:id,threadId:'sender-thread'}}});

describe('AgentInbox',()=>{
  it('wakes an idle receiver immediately with peer provenance',async()=>{ // risk: core messaging
    const delivery=new RecordingDelivery(); const inbox=new AgentInbox(new MemoryInboxRepository(),delivery);
    expect(await inbox.receive(entry('m1','pick up I1'))).toBe('delivered'); expect(delivery.batches).toEqual(['[Peer message from mobile-relay]\npick up I1']);
  });
  it('does not interrupt a running receiver and flushes all messages in one ordered batch',async()=>{ // risk: core messaging
    const delivery=new RecordingDelivery();delivery.running=true;const inbox=new AgentInbox(new MemoryInboxRepository(),delivery);
    await inbox.receive(entry('m1','first'));await inbox.receive(entry('m2','second'));expect(delivery.batches).toEqual([]);delivery.running=false;
    expect(await inbox.flush(entry('m1').target)).toBe(2);expect(delivery.batches[0]).toContain('first\n\n==========\n\n[Peer message from mobile-relay]\nsecond');
  });
  it('keeps a claim pending unless graph input is accepted',async()=>{ // risk: message loss
    const repository=new MemoryInboxRepository();const delivery=new RecordingDelivery();delivery.receipt='failed';const inbox=new AgentInbox(repository,delivery);
    expect(await inbox.receive(entry('retry'))).toBe('queued');delivery.receipt='accepted';expect(await inbox.flush(entry('retry').target)).toBe(1);expect(delivery.batches).toHaveLength(2);
  });
  it('atomically assigns a message to only one concurrent consumer',async()=>{ // risk: duplicate turns
    const repository=new MemoryInboxRepository();await repository.enqueue(entry('once'));const a=await repository.claim(entry('once').target,'a');const b=await repository.claim(entry('once').target,'b');
    expect(a.entries).toHaveLength(1);expect(b.entries).toHaveLength(0);
  });
  it('replays pending targets after service restart',async()=>{ // risk: restart durability
    const repository=new MemoryInboxRepository();const before=new RecordingDelivery();before.running=true;await new AgentInbox(repository,before).receive(entry('restart','still here'));
    const after=new RecordingDelivery();expect(await new AgentInbox(repository,after).replayPending()).toBe(1);expect(after.batches).toEqual(['[Peer message from mobile-relay]\nstill here']);
  });
  it('rechecks for a same-target message arriving while a flush wake is accepted',async()=>{ // risk: late-arrival stranding
    const repository=new MemoryInboxRepository();await repository.enqueue(entry('first'));const delivery=new RecordingDelivery();delivery.onWake=()=>{delivery.onWake=undefined;void repository.enqueue(entry('late'));};
    const inbox=new AgentInbox(repository,delivery);expect(await inbox.flush(entry('first').target)).toBe(2);expect(delivery.batches).toHaveLength(2);
  });
  it('deduplicates a repeated messageId',async()=>{ // risk: idempotency
    const delivery=new RecordingDelivery();delivery.running=true;const inbox=new AgentInbox(new MemoryInboxRepository(),delivery);expect(await inbox.receive(entry('same'))).toBe('queued');expect(await inbox.receive(entry('same'))).toBe('duplicate');
  });
});
