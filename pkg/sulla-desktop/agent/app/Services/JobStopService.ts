// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service, type Clock } from '@sulla/foundation';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { StopPrincipal, type StopPrincipalValue } from '../ValueObjects/StopPrincipal';
import { JobRuntimeRegistry } from './JobRuntimeRegistry';
import { JobTaskLocator } from './JobTaskLocator';
import type { CustodyOwner, CustodyRecord, JobCustodyPort } from './JobCustodyTypes';
import type { CustodyLineagePort } from './JobCustodyAuthorityPolicy';
import type { TaskTeardownOutcome, TaskTeardownPort } from './TaskTeardownPort';

export type StopOutcome = 'stopped' | 'not-found' | 'already-finished' | 'forbidden';
export type StopAuthorization={outcome:'allowed'|'not-found'|'forbidden';owner?:CustodyOwner};

/** Applies authorization, attribution, persistence, and aborts for job stops. */
export class JobStopService extends Service {
  constructor(private readonly repository: AgentJobRepository, private readonly runtime: JobRuntimeRegistry, private readonly clock: Clock, private readonly taskLocator: JobTaskLocator, private readonly custody?: Pick<JobCustodyPort,'resolveOwner'|'withOwner'>, private readonly custodyLineage?: Pick<CustodyLineagePort,'isAncestor'>, private readonly taskTeardown?: TaskTeardownPort) { super(); }
  private async persist(operation: Promise<void>): Promise<void> { try { await operation; } catch (error) { console.warn('[JobStopService] persistence write failed:', (error as Error).message); } }

  /** Idempotent provider/process boundary. Durable callers acknowledge only after this returns. */
  async teardownTask(jobId:string,taskIndex:number):Promise<TaskTeardownOutcome> {
    // Abort is a same-process hint, never evidence that an external CLI exited.
    this.runtime.abortScopes.get(jobId)?.abortTask(taskIndex);
    return this.taskTeardown?.teardown(jobId,taskIndex) ?? 'unavailable';
  }

  abortJob(jobId: string, principal: StopPrincipalValue, reason: string): Exclude<StopOutcome, 'forbidden'> {
    const job = this.runtime.jobs.get(jobId);
    if (!job) return 'not-found';
    if (!['running', 'parked'].includes(job.status)) return 'already-finished';
    job.status = 'stopped'; job.finishedAt = this.clock.now().getTime();
    job.tasks = job.tasks.map(task => ['running', 'queued', 'parked'].includes(task.status) ? { ...task, status: 'stopped', finishedAt: job.finishedAt! } : task);
    job.stoppedBy = StopPrincipal.attribution(principal); job.stopReason = reason;
    // Persist the terminal state before aborting. Provider teardown can report a
    // container failure synchronously; the repository guard must already see stopped.
    void this.persist(this.repository.stop(jobId, job.tasks, job.stoppedBy, reason));
    this.runtime.abortScopes.get(jobId)?.abortJob();
    return 'stopped';
  }

  async stopTask(jobId: string, taskIndex: number, principal: StopPrincipalValue, reason: string): Promise<StopOutcome> {
    const job = this.runtime.jobs.get(jobId) ?? await this.repository.job(jobId);
    const task = job?.tasks[taskIndex];
    if (!job || !task) return 'not-found';
    if (!['running', 'parked'].includes(job.status) || !['queued', 'running', 'parked'].includes(task.status)) return 'already-finished';
    const stoppedAt = this.clock.now().getTime();
    const tasks=job.tasks.map(item=>({...item}));
    tasks[taskIndex] = { ...task, status: 'stopped', finishedAt: stoppedAt, stoppedBy: StopPrincipal.attribution(principal), stopReason: reason };
    const settlesJob = tasks.every(item => !['queued', 'running', 'parked'].includes(item.status));
    const snapshot=principal.kind==='agent'?await this.custody?.resolveOwner(jobId,taskIndex):undefined;
    const snapshotAncestor=principal.kind==='agent'&&snapshot&&snapshot.threadId!==principal.threadId?await this.authorizedAgainst(snapshot,principal.threadId):false;
    const mutation=async(client:any,owner:CustodyRecord)=>{
      if(principal.kind==='agent'&&owner.threadId!==principal.threadId&&!(snapshotAncestor&&snapshot?.threadId===owner.threadId&&snapshot.version===owner.version))return 'forbidden' as const;
      const changed=await this.repository.stopWithClient(client,jobId,tasks,StopPrincipal.attribution(principal),reason,settlesJob,taskIndex); return changed?'stopped' as const:'already-finished' as const;
    };
    const outcome=this.custody?await this.custody.withOwner(jobId,taskIndex,mutation):
      (await this.persist(settlesJob?this.repository.stop(jobId,tasks,StopPrincipal.attribution(principal),reason):this.repository.updateTasks(jobId,tasks)),'stopped' as const);
    if(!outcome)return 'not-found'; if(outcome==='forbidden'||outcome==='already-finished')return outcome;
    job.tasks=tasks;
    if (settlesJob) { job.status = 'stopped'; job.finishedAt = stoppedAt; job.stoppedBy = StopPrincipal.attribution(principal); job.stopReason = reason; }
    // Mark stopped before aborting so teardown failures see an intentional stop.
    this.runtime.abortScopes.get(jobId)?.abortTask(taskIndex);
    return 'stopped';
  }

  async authorize(jobId: string, principal: StopPrincipalValue): Promise<StopAuthorization> {
    const job = this.runtime.jobs.get(jobId) ?? await this.repository.job(jobId);
    if (!job) return {outcome:'not-found'};
    const owner=await this.custody?.resolveOwner(jobId);
    return principal.kind === 'agent' && owner && !await this.authorizedAgainst(owner,principal.threadId) ? {outcome:'forbidden',owner} : {outcome:'allowed',owner};
  }

  private async authorizedOwner(jobId:string,taskIndex:number|undefined,callerThreadId:string,job:any):Promise<boolean>{
    const owner=await this.custody?.resolveOwner(jobId,taskIndex);
    if(!owner)return this.taskLocator.isAncestorThread(job,callerThreadId);
    if(owner.threadId===callerThreadId)return true;
    return this.custodyLineage?.isAncestor(callerThreadId,owner.threadId)??false;
  }
  private async authorizedAgainst(owner:CustodyOwner,callerThreadId:string):Promise<boolean>{return owner.threadId===callerThreadId||(this.custodyLineage?.isAncestor(callerThreadId,owner.threadId)??false);}

  async stopCascade(jobId: string, principal: StopPrincipalValue, reason: string): Promise<StopOutcome> {
    const root = this.runtime.jobs.get(jobId) ?? await this.repository.job(jobId);
    if (!root) return 'not-found';
    if (!['running', 'parked'].includes(root.status)) return 'already-finished';
    const stoppedBy = StopPrincipal.attribution(principal);
    const snapshot=principal.kind==='agent'?await this.custody?.resolveOwner(jobId):undefined;
    const snapshotAncestor=principal.kind==='agent'&&snapshot&&snapshot.threadId!==principal.threadId?await this.authorizedAgainst(snapshot,principal.threadId):false;
    const locked=async(client:any,owner:CustodyRecord)=>{if(principal.kind==='agent'&&owner.threadId!==principal.threadId&&!(snapshotAncestor&&snapshot?.threadId===owner.threadId&&snapshot.version===owner.version))return {forbidden:true as const};return {stoppedIds:await this.repository.stopCascadeWithClient(client,jobId,stoppedBy,reason)};};
    const result=this.custody?await this.custody.withOwner(jobId,undefined,locked):{stoppedIds:await this.repository.stopCascade(jobId,stoppedBy,reason)};
    if(!result)return 'not-found'; if('forbidden'in result)return 'forbidden';
    const stoppedIds=result.stoppedIds;
    const stoppedAt = this.clock.now().getTime();
    for (const stoppedId of stoppedIds) {
      const job = this.runtime.jobs.get(stoppedId);
      if (job && ['running', 'parked'].includes(job.status)) {
        job.status = 'stopped'; job.finishedAt = stoppedAt; job.waitingOnChildren = 0; job.stoppedBy = stoppedBy; job.stopReason = reason;
        job.tasks = job.tasks.map(task => ['queued', 'running', 'parked'].includes(task.status) ? { ...task, status: 'stopped', finishedAt: stoppedAt } : task);
      }
      // Abort only after the in-memory job reads stopped, so teardown never delivers a failure.
      this.runtime.abortScopes.get(stoppedId)?.abortJob();
    }
    return 'stopped';
  }
}
