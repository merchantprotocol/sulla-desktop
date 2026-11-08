// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';
import type { StopPrincipalValue } from '../ValueObjects/StopPrincipal';
import type { JobStopService } from './JobStopService';
import type { DurableWrapUpClaim,DurableWrapUpRequest,JobWrapUpPersistence } from '../Repositories/JobWrapUpRepository';
import type { TaskExecutionIdentityStore } from '../Repositories/TaskExecutionIdentityRepository';

type TimerHandle = ReturnType<typeof setTimeout>;
export interface JobWrapUpTimer {
  schedule(delayMs: number, callback: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export class SystemJobWrapUpTimer implements JobWrapUpTimer {
  schedule(delayMs: number, callback: () => void): TimerHandle {
    const handle = setTimeout(callback, delayMs);
    (handle as TimerHandle & { unref?: () => void }).unref?.();
    return handle;
  }
  cancel(handle: TimerHandle): void { clearTimeout(handle); }
}

export interface JobWrapUpMessageSender {
  send(input: { jobId: string; taskIndex?: number; message: string }): Promise<unknown>;
}

export class JobWrapUpService extends Service {
  private static readonly executionLeaseSeconds=30;
  private readonly timers = new Map<string, TimerHandle>();

  constructor(
    private readonly stops: JobStopService,
    private readonly messages: JobWrapUpMessageSender,
    private readonly timer: JobWrapUpTimer = new SystemJobWrapUpTimer(),
    private readonly persistence?: JobWrapUpPersistence,
    private readonly identities?: Pick<TaskExecutionIdentityStore,'currentGeneration'>,
  ) { super(); }

  private key(jobId: string, taskIndex: number): string { return `${ jobId }:${ taskIndex }`; }

  async request(
    jobId: string,
    taskIndexes: number[],
    principal: StopPrincipalValue,
    reason: string,
    gracePeriodSeconds: number,
    message: string,
    skipMessage = false,
  ): Promise<Array<'pending'|'completed'>> {
    const states:Array<'pending'|'completed'>=[];
    for (const taskIndex of taskIndexes) {
      const key = this.key(jobId, taskIndex);
      const delayMs = Math.max(1, gracePeriodSeconds || 120) * 1_000;
      // Capture the exact execution generation now. A later reopen may launch a
      // replacement under the same job/task key; this request must never follow it.
      const executionGeneration=await this.identities?.currentGeneration(jobId,taskIndex)??'unavailable';
      const durable:DurableWrapUpRequest={jobId,taskIndex,executionGeneration,principal,reason,dueAt:new Date(Date.now()+delayMs)};
      const inserted=this.persistence?await this.persistence.reserve(durable):!this.timers.has(key);
      const state=this.persistence?await this.persistence.state(jobId,taskIndex):undefined;
      if(state==='completed'){states.push('completed');continue;}
      states.push('pending');
      // The durable request owns the stop timer. Arm it before best-effort
      // messaging so a committed reservation cannot be stranded by send failure.
      this.schedule(durable);
      if(inserted&&!skipMessage)await this.messages.send({ jobId, taskIndex, message });
    }
    return states;
  }

  async recover():Promise<void>{
    const now=Date.now();
    await Promise.all((await this.persistence?.pending()??[]).map(request=>request.dueAt.getTime()<=now?this.execute(request):Promise.resolve(this.schedule(request))));
  }

  private schedule(request:DurableWrapUpRequest):void{
    const key=this.key(request.jobId,request.taskIndex);if(this.timers.has(key))return;
    const delay=Math.max(1,request.dueAt.getTime()-Date.now());
    const handle=this.timer.schedule(delay,()=>{this.timers.delete(key);void this.execute(request);});this.timers.set(key,handle);
  }

  private retry(request:DurableWrapUpRequest,dueAt:Date):void{
    this.schedule({...request,dueAt});
  }

  private async execute(request:DurableWrapUpRequest):Promise<void>{
    let claim:DurableWrapUpClaim|undefined;
    try{
      claim=this.persistence
        ?await this.persistence.claim(request.jobId,request.taskIndex,JobWrapUpService.executionLeaseSeconds)
        :{...request,claimToken:'process-local',claimVersion:1,claimExpiresAt:new Date(Date.now()+JobWrapUpService.executionLeaseSeconds*1_000)};
      if(!claim){this.retry(request,new Date(Date.now()+JobWrapUpService.executionLeaseSeconds*1_000));return;}
      if(!this.persistence){await this.stops.stopTask(claim.jobId,claim.taskIndex,claim.principal,claim.reason);return;}
      if(!await this.persistence.beginTeardown(claim)){this.retry(request,claim.claimExpiresAt);return;}
      // Only this reservation's immutable generation may cross the external
      // boundary. AbortController loss is a hint, never an exit receipt.
      const teardown=await this.stops.teardownTask(claim.jobId,claim.taskIndex,claim.executionGeneration);
      if(teardown!=='confirmed'){this.retry(request,claim.claimExpiresAt);return;}
      if(!await this.persistence.acknowledgeTeardown(claim))this.retry(request,claim.claimExpiresAt);
    }catch{
      this.retry(request,claim?.claimExpiresAt??new Date(Date.now()+JobWrapUpService.executionLeaseSeconds*1_000));
    }
  }

  /** Called by job lifecycle settlement paths; a returned/settled task wins the grace race. */
  taskSettled(jobId: string, taskIndex: number): void {
    const key = this.key(jobId, taskIndex);
    const handle = this.timers.get(key);
    if (handle){this.timer.cancel(handle);this.timers.delete(key);}
    void this.persistence?.cancel(jobId,taskIndex);
  }

  /** A whole job settlement invalidates every outstanding grace timer. */
  jobSettled(jobId: string): void {
    for (const [key, handle] of this.timers) {
      if (key.startsWith(`${ jobId }:`)) {
        this.timer.cancel(handle);
        this.timers.delete(key);
        const taskIndex=Number(key.slice(key.lastIndexOf(':')+1));
        void this.persistence?.cancel(jobId,taskIndex);
      }
    }
    void this.persistence?.cancelJob(jobId);
  }
}
