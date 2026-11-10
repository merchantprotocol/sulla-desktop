// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { JobWrapUpService, type JobWrapUpMessageSender, type JobWrapUpTimer } from '../../../app/Services/JobWrapUpService';
import type { StopPrincipalValue } from '../../../app/ValueObjects/StopPrincipal';

// execute() awaits claim, durable stop, teardown and ack before re-arming; drain them all.
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

class FakeTimer implements JobWrapUpTimer {
  private next = 0;
  readonly callbacks = new Map<ReturnType<typeof setTimeout>, () => void>();
  readonly cancelled: Array<ReturnType<typeof setTimeout>> = [];
  schedule(_delay: number, callback: () => void): ReturnType<typeof setTimeout> { const id = ++this.next as unknown as ReturnType<typeof setTimeout>; this.callbacks.set(id, callback); return id; }
  cancel(handle: ReturnType<typeof setTimeout>): void { this.cancelled.push(handle); this.callbacks.delete(handle); }
  elapse(): void { for (const [id, callback] of [...this.callbacks]) { this.callbacks.delete(id); callback(); } }
}

class FakeMessages implements JobWrapUpMessageSender {
  readonly sent: Array<{ jobId: string; taskIndex?: number; message: string }> = [];
  async send(input: { jobId: string; taskIndex?: number; message: string }): Promise<void> { this.sent.push(input); }
}

class FakeStops {
  readonly stopped: Array<[string, number]> = [];
  async stopTask(jobId: string, taskIndex: number): Promise<'stopped'> { this.stopped.push([jobId, taskIndex]); return 'stopped'; }
}



class AttributedFakeStops {
  readonly stopped: Array<{jobId:string;taskIndex:number;generation:string}> = [];
  outcome:'confirmed'|'still-running'|'unavailable'='confirmed';
  async teardownTask(jobId:string,taskIndex:number,generation:string):Promise<'confirmed'|'still-running'|'unavailable'>{this.stopped.push({jobId,taskIndex,generation});return this.outcome;}
  applyDurableStop(_jobId:string,write:()=>Promise<boolean>):Promise<boolean>{return write();}
}

class FakePersistence {
  private reserved = false;
  completed = 0; acknowledgeResult=true;
  async reserveCurrent(input:any): Promise<any> { const inserted = !this.reserved; this.reserved = true; return {inserted,state:'pending',request:{...input,executionGeneration:'generation-old'}}; }
  async state(): Promise<'pending'> { return 'pending'; }
  async pending(): Promise<any[]> { return []; }
  async claim(): Promise<any> { return {jobId:'job-1',taskIndex:0,executionGeneration:'generation-old',principal,reason:'attributed reason',dueAt:new Date(0),claimToken:'claim',claimVersion:1,claimExpiresAt:new Date(Date.now()+30_000)}; }
  async beginTeardown(): Promise<boolean> { return true; }
  async acknowledgeTeardown(): Promise<boolean> { this.completed++; return this.acknowledgeResult; }
  async cancel(): Promise<void> {}
  async cancelJob(): Promise<void> {}
  async requireManualReconciliation(): Promise<void> {}
  async recordTeardownFailure(): Promise<'retry'> { return 'retry'; }
}

class FailingMessages implements JobWrapUpMessageSender {
  attempts = 0;
  async send(): Promise<void> { this.attempts++; throw new Error('send failed after reserve'); }
}

const principal = { kind: 'human' } as StopPrincipalValue;

describe('JobWrapUpService', () => {
  it('targets only the requested task and cancels its grace stop when it returns', async() => {
    // risk: lifecycle — a sibling worker must not receive a stop request or hard stop.
    const timer = new FakeTimer(); const messages = new FakeMessages(); const stops = new FakeStops();
    const service = new JobWrapUpService(stops as any, messages, timer);
    await service.request('job-1', [1], principal, 'reason', 1, 'return now');
    expect(messages.sent).toHaveLength(1); expect(messages.sent[0].taskIndex).toBe(1);
    service.taskSettled('job-1', 1, true); timer.elapse();
    expect(stops.stopped).toEqual([]); expect(timer.cancelled).toHaveLength(1);
  });

  it('keeps a committed wrap stop armed when messaging fails and an idempotent retry does not need restart', async() => {
    // risk: irreversible stop — a committed reserve must still execute once with the original attribution.
    const timer = new FakeTimer(); const messages = new FailingMessages(); const stops = new AttributedFakeStops(); const persistence = new FakePersistence();
    const service = new JobWrapUpService(stops as any, messages, timer, persistence);
    await expect(service.request('job-1', [0], principal, 'attributed reason', 1, 'return now')).rejects.toThrow('send failed after reserve');
    await expect(service.request('job-1', [0], principal, 'attributed reason', 1, 'return now')).resolves.toEqual(['pending']);
    expect(messages.attempts).toBe(1); expect(timer.callbacks.size).toBe(1);
    timer.elapse(); await flush();
    expect(stops.stopped).toEqual([{jobId:'job-1',taskIndex:0,generation:'generation-old'}]); expect(persistence.completed).toBe(1);
  });


  it.each(['still-running','unavailable'] as const)('does not acknowledge an %s external teardown', async(outcome) => {
    // risk: lifecycle — restart recovery must retry until the original execution is proven gone.
    const stops = new AttributedFakeStops(); stops.outcome=outcome; const persistence = new FakePersistence();
    const timer=new FakeTimer(); const service = new JobWrapUpService(stops as any, new FakeMessages(), timer, persistence);
    await service.request('job-1',[0],principal,'attributed reason',0,'',true);
    timer.elapse(); await flush();
    expect(stops.stopped).toEqual([{jobId:'job-1',taskIndex:0,generation:'generation-old'}]);
    expect(persistence.completed).toBe(0); expect(timer.callbacks.size).toBe(1);
  });

  it('captures the old generation so a reopen cannot redirect teardown to the new execution',async()=>{
    // risk: irreversible stop — a stale wrap claim must not kill the replacement execution.
    const timer=new FakeTimer();const stops=new AttributedFakeStops();const persistence=new FakePersistence();
    const identities={current:'generation-old',async currentGeneration(){return this.current;}};
    const service=new JobWrapUpService(stops as any,new FakeMessages(),timer,persistence,identities);
    await service.request('job-1',[0],principal,'attributed reason',1,'',true);identities.current='generation-new';
    timer.elapse();await flush();
    expect(stops.stopped).toEqual([{jobId:'job-1',taskIndex:0,generation:'generation-old'}]);
  });

  it('re-arms the durable retry when acknowledgement loses its lease fence',async()=>{
    // risk: false receipt — an ack=false race must retry rather than strand teardown.
    const timer=new FakeTimer();const stops=new AttributedFakeStops();const persistence=new FakePersistence();persistence.acknowledgeResult=false;
    const service=new JobWrapUpService(stops as any,new FakeMessages(),timer,persistence);
    await service.request('job-1',[0],principal,'attributed reason',1,'',true);timer.elapse();await flush();
    expect(timer.callbacks.size).toBe(1);expect(stops.stopped).toHaveLength(1);
  });

  it('re-arms one retry after a transient nonconfirmed teardown without reboot',async()=>{
    // risk: orphan execution — transient runtime failure must not strand the durable claim.
    const timer=new FakeTimer();const stops=new AttributedFakeStops();stops.outcome='unavailable';const persistence=new FakePersistence();
    const service=new JobWrapUpService(stops as any,new FakeMessages(),timer,persistence);
    await service.request('job-1',[0],principal,'attributed reason',1,'',true);timer.elapse();await flush();
    expect(timer.callbacks.size).toBe(1);stops.outcome='confirmed';timer.elapse();await flush();
    expect(stops.stopped).toHaveLength(2);expect(persistence.completed).toBe(1);
  });

  it('hard-stops the targeted task after grace while its sibling keeps running', async() => {
    // risk: lifecycle — grace expiry must stop exactly one task, not cascade to siblings.
    const timer = new FakeTimer(); const messages = new FakeMessages(); const stops = new FakeStops();
    const service = new JobWrapUpService(stops as any, messages, timer);
    await service.request('job-1', [0], principal, 'reason', 1, 'return now');
    timer.elapse();
    expect(stops.stopped).toEqual([['job-1', 0]]);
  });
});
