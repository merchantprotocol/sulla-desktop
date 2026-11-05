// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { AgentInbox, type AgentInboxClaim, type AgentInboxDeliveryReceipt, type AgentInboxEntry, type AgentInboxRepository, type AgentInboxScheduler, type AgentInboxTarget } from '../../../services/AgentInbox';

class MemoryInboxRepository implements AgentInboxRepository {
  readonly rows = new Map<string, { entry: AgentInboxEntry; delivered: boolean; owner?: string; leaseExpiresAt?: number }>();
  renewals=0;
  constructor(private readonly leaseMs=120_000){}
  async enqueue(entry: AgentInboxEntry): Promise<boolean> { const id=entry.envelope.ids.messageId; if(this.rows.has(id)) return false; this.rows.set(id,{entry,delivered:false}); return true; }
  async claim(target: AgentInboxTarget, owner: string): Promise<AgentInboxClaim> { const now=Date.now();const entries=[...this.rows.values()].filter(row => !row.delivered && (!row.owner||(row.leaseExpiresAt??0)<now) && row.entry.target.channel===target.channel && (!target.threadId || !row.entry.target.threadId || row.entry.target.threadId===target.threadId)).map(row => { row.owner=owner;row.leaseExpiresAt=now+this.leaseMs;return row.entry; }); return {owner,target,entries}; }
  async renew(claim: AgentInboxClaim): Promise<void> { this.renewals++;for(const entry of claim.entries){const row=this.rows.get(entry.envelope.ids.messageId);if(row?.owner===claim.owner)row.leaseExpiresAt=Date.now()+this.leaseMs;} }
  async acknowledge(claim: AgentInboxClaim): Promise<void> { for(const entry of claim.entries){ const row=this.rows.get(entry.envelope.ids.messageId); if(row?.owner===claim.owner) row.delivered=true; } }
  async release(claim: AgentInboxClaim): Promise<void> { for(const entry of claim.entries){ const row=this.rows.get(entry.envelope.ids.messageId); if(row?.owner===claim.owner) delete row.owner; } }
  async pendingTargets(): Promise<AgentInboxTarget[]> { return [...this.rows.values()].filter(r=>!r.delivered&&!r.owner).map(r=>r.entry.target).filter((v,i,a)=>a.findIndex(x=>x.channel===v.channel&&x.threadId===v.threadId)===i); }
}
class RecordingDelivery {
  running=false; batches:string[]=[]; delivered:string[]=[]; receipt:AgentInboxDeliveryReceipt='accepted'; onWake?:()=>void|Promise<void>;
  isRunning():boolean{return this.running;}
  async wake(_target:AgentInboxTarget,batch:string,entries:AgentInboxEntry[]):Promise<AgentInboxDeliveryReceipt>{this.batches.push(batch);this.delivered.push(...entries.map(({envelope})=>envelope.ids.messageId));await this.onWake?.();return this.receipt;}
}
class ManualScheduler implements AgentInboxScheduler {
  readonly callbacks:(()=>void)[]=[];
  schedule(callback:()=>void):void { this.callbacks.push(callback); }
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
  it('renews a claim throughout a turn so an expired original lease cannot be reclaimed',async()=>{ // risk: duplicate agent turns
    const repository=new MemoryInboxRepository(25);const delivery=new RecordingDelivery();let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});delivery.onWake=()=>gate;
    const inbox=new AgentInbox(repository,delivery,undefined,8,5);const receiving=inbox.receive(entry('long-turn'));await new Promise(resolve=>setTimeout(resolve,45));
    expect((await repository.claim(entry('long-turn').target,'competing-consumer')).entries).toHaveLength(0);expect(repository.renewals).toBeGreaterThan(0);finish();expect(await receiving).toBe('delivered');
  });
  it('reserves before awaiting registration and drains a late arrival without concurrent turns',async()=>{ // risk: duplicate and out-of-order agent turns
    const repository=new MemoryInboxRepository();const delivery=new RecordingDelivery();let finishFirst!:()=>void;const firstGate=new Promise<void>(resolve=>{finishFirst=resolve;});let active=0;let maxActive=0;
    delivery.onWake=async()=>{active++;maxActive=Math.max(maxActive,active);if(delivery.batches.length===1)await firstGate;active--;};
    const inbox=new AgentInbox(repository,delivery);const first=inbox.receive(entry('first','first batch'));await new Promise(resolve=>setImmediate(resolve));
    expect(await inbox.receive(entry('late','late batch'))).toBe('queued');expect(delivery.batches).toHaveLength(1);finishFirst();expect(await first).toBe('delivered');
    expect(maxActive).toBe(1);expect(delivery.batches).toEqual(['[Peer message from mobile-relay]\nfirst batch','[Peer message from mobile-relay]\nlate batch']);
  });
  it('hands off after the drain cap so repeated late arrivals are all delivered in order',async()=>{ // risk: late-message loss
    const repository=new MemoryInboxRepository();const delivery=new RecordingDelivery();const scheduler=new ManualScheduler();let active=0;let maxActive=0;let nextLate=0;
    delivery.onWake=async()=>{active++;maxActive=Math.max(maxActive,active);if(nextLate<10)await repository.enqueue(entry(`late-${++nextLate}`));active--;};
    await repository.enqueue(entry('first'));const inbox=new AgentInbox(repository,delivery,undefined,8,30_000,scheduler);
    await inbox.flush(entry('first').target);
    while(scheduler.callbacks.length){scheduler.callbacks.shift()!();await new Promise(resolve=>setImmediate(resolve));}
    expect(delivery.delivered).toEqual(['first',...Array.from({length:10},(_,index)=>`late-${index+1}`)]);expect(maxActive).toBe(1);expect(scheduler.callbacks).toHaveLength(0);
  });
  it('deduplicates a repeated messageId',async()=>{ // risk: idempotency
    const delivery=new RecordingDelivery();delivery.running=true;const inbox=new AgentInbox(new MemoryInboxRepository(),delivery);expect(await inbox.receive(entry('same'))).toBe('queued');expect(await inbox.receive(entry('same'))).toBe('duplicate');
  });
});
