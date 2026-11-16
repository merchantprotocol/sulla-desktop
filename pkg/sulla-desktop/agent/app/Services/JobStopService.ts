// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service, type Clock } from '@sulla/foundation';
import { StopPrincipal, type StopPrincipalValue } from '../ValueObjects/StopPrincipal';
import { JobRuntimeRegistry } from './JobRuntimeRegistry';
import { JobTaskLocator } from './JobTaskLocator';
import type { AgentStateService } from './AgentStateService';
import type { AgentJob } from '../../tools/agents/jobRegistry';
import type { CustodyOwner, CustodyRecord, CustodyTransactionClient, JobCustodyPort } from './JobCustodyTypes';
import type { CustodyLineagePort } from './JobCustodyAuthorityPolicy';
import type { TaskTeardownOutcome, TaskTeardownPort } from './TaskTeardownPort';

export type StopOutcome = 'stopped' | 'not-found' | 'already-finished' | 'forbidden';
export type StopAuthorization = { outcome: 'allowed' | 'not-found' | 'forbidden'; owner?: CustodyOwner };

/** Writes a whole job state inside the caller's custody transaction. */
export interface CustodyScopedJobStateWriter {
  replaceStateWithClient(client: CustodyTransactionClient, job: AgentJob): Promise<boolean>;
}

/**
 * Owner-only stop authority for one custody scope. The ancestor check runs
 * before the custody lock (it may read lineage); inside the lock it is only
 * honoured while the owner is still the exact snapshot it was proven against.
 */
class StopCustodyAuthority {
  constructor(private readonly principal: StopPrincipalValue, private readonly snapshot: CustodyRecord | undefined, private readonly snapshotAncestor: boolean) {}

  permits(owner: CustodyRecord): boolean {
    if (this.principal.kind !== 'agent' || owner.threadId === this.principal.threadId) return true;
    return this.snapshotAncestor && this.snapshot?.threadId === owner.threadId && this.snapshot.version === owner.version;
  }
}

/** Applies authorization, attribution, persistence, publication, and aborts for job stops. */
export class JobStopService extends Service {
  constructor(
    private readonly states: AgentStateService,
    private readonly runtime: JobRuntimeRegistry,
    private readonly clock: Clock,
    private readonly taskLocator: JobTaskLocator,
    private readonly custody?: Pick<JobCustodyPort, 'resolveOwner' | 'withOwner'>,
    private readonly custodyLineage?: Pick<CustodyLineagePort, 'isAncestor'>,
    private readonly taskTeardown?: TaskTeardownPort,
    private readonly scopedWriter?: CustodyScopedJobStateWriter,
  ) { super(); }

  /** Idempotent provider/process boundary. Durable callers acknowledge only after this returns. */
  async teardownTask(jobId: string, taskIndex: number, generation: string): Promise<TaskTeardownOutcome> {
    // Abort is a same-process hint, never evidence that an external CLI exited.
    this.runtime.abortScopes.get(jobId)?.abortTask(taskIndex);
    return this.taskTeardown?.teardown(jobId, taskIndex, generation) ?? 'unavailable';
  }

  /** Applies the wrap-up outbox's terminal stop in the job's state queue so readers and writers see it. */
  applyDurableStop(jobId: string, write: () => Promise<boolean>): Promise<boolean> {
    return this.states.applyExternalWrite(jobId, write);
  }

  abortJob(jobId: string, principal: StopPrincipalValue, reason: string): Exclude<StopOutcome, 'forbidden'> {
    const job = this.runtime.jobs.get(jobId); if (!job) return 'not-found';
    if (!['running', 'parked'].includes(job.status) || this.states.hasPendingTerminalWrite(jobId)) return 'already-finished';
    this.states.markPendingTerminalWrite(jobId);
    const stoppedBy = StopPrincipal.attribution(principal); const finishedAt = this.clock.now().getTime();
    const persistence = this.states.mutateJob(jobId, current => !['running','parked'].includes(current.status) ? undefined : ({ ...current, status: 'stopped', finishedAt, waitingOnChildren: 0, stoppedBy, stopReason: reason,
      tasks: current.tasks.map(task => ['running','queued','parked'].includes(task.status) ? { ...task, status: 'stopped', finishedAt } : task) }));
    // Register the mutation queue entry before aborting so teardown failures line up behind the durable stop.
    this.runtime.abortScopes.get(jobId)?.abortJob();
    void persistence.catch(error => console.warn('[JobStopService] stop persistence failed:', (error as Error).message));
    return 'stopped';
  }

  async stopTask(jobId: string, taskIndex: number, principal: StopPrincipalValue, reason: string): Promise<StopOutcome> {
    const job = await this.states.jobForWrite(jobId); const task = job?.tasks[taskIndex];
    if (!job || !task) return 'not-found';
    if (!['running','parked'].includes(job.status) || !['queued','running','parked'].includes(task.status)) return 'already-finished';
    const stoppedAt = this.clock.now().getTime(); const stoppedBy = StopPrincipal.attribution(principal);
    const mutate = (current: AgentJob): AgentJob | undefined => {
      const currentTask = current.tasks[taskIndex]; if (!currentTask || !['queued','running','parked'].includes(currentTask.status)) return undefined;
      const tasks = current.tasks.map((item, index) => index === taskIndex ? { ...item, status: 'stopped' as const, finishedAt: stoppedAt, stoppedBy, stopReason: reason } : item);
      const settlesJob = tasks.every(item => !['queued','running','parked'].includes(item.status));
      return { ...current, tasks, ...(settlesJob ? { status: 'stopped' as const, finishedAt: stoppedAt, stoppedBy, stopReason: reason } : {}) };
    };
    const outcome = this.custody && this.scopedWriter
      ? await this.stopUnderCustody(jobId, taskIndex, principal, async client => Boolean(await this.states.mutateJob(jobId, mutate, next => this.scopedWriter!.replaceStateWithClient(client, next))))
      : await this.stopWithoutCustody(job, principal, async() => Boolean(await this.states.mutateJob(jobId, mutate)));
    if (outcome !== 'stopped') return outcome;
    // Mark stopped before aborting so teardown failures see an intentional stop.
    this.runtime.abortScopes.get(jobId)?.abortTask(taskIndex);
    return 'stopped';
  }

  async authorize(jobId: string, principal: StopPrincipalValue): Promise<StopAuthorization> {
    const job = await this.states.jobForWrite(jobId); if (!job) return { outcome: 'not-found' };
    const owner = await this.custody?.resolveOwner(jobId);
    if (principal.kind !== 'agent') return { outcome: 'allowed', ...(owner ? { owner } : {}) };
    if (!owner) return { outcome: await this.taskLocator.isAncestorThread(job, principal.threadId) ? 'allowed' : 'forbidden' };
    return { outcome: await this.authorizedAgainst(owner, principal.threadId) ? 'allowed' : 'forbidden', owner };
  }

  async stopCascade(jobId: string, principal: StopPrincipalValue, reason: string): Promise<StopOutcome> {
    const root = await this.states.jobForWrite(jobId); if (!root) return 'not-found';
    if (!['running','parked'].includes(root.status)) return 'already-finished';
    const stoppedBy = StopPrincipal.attribution(principal);
    let stoppedIds: string[] = [];
    const outcome = this.custody && this.scopedWriter
      ? await this.stopUnderCustody(jobId, undefined, principal, async client => {
        stoppedIds = await this.states.stopCascade(jobId, stoppedBy, reason, next => this.scopedWriter!.replaceStateWithClient(client, next));
        return stoppedIds.length > 0;
      })
      : await this.stopWithoutCustody(root, principal, async() => {
        stoppedIds = await this.states.stopCascade(jobId, stoppedBy, reason);
        return stoppedIds.length > 0;
      });
    if (outcome !== 'stopped') return outcome;
    for (const stoppedId of stoppedIds) this.runtime.abortScopes.get(stoppedId)?.abortJob();
    return 'stopped';
  }

  /**
   * Lock order is always custody advisory lock, then the per-job state queue.
   * The owner check and the state write share one transaction, so a concurrent
   * reassign/adopt cannot let a stale owner stop work it no longer owns.
   */
  private async stopUnderCustody(jobId: string, taskIndex: number | undefined, principal: StopPrincipalValue, write: (client: CustodyTransactionClient) => Promise<boolean>): Promise<StopOutcome> {
    const snapshot = principal.kind === 'agent' ? await this.custody!.resolveOwner(jobId, taskIndex) : undefined;
    const snapshotAncestor = principal.kind === 'agent' && snapshot && snapshot.threadId !== principal.threadId ? await this.authorizedAgainst(snapshot, principal.threadId) : false;
    const authority = new StopCustodyAuthority(principal, snapshot, snapshotAncestor);
    const outcome = await this.custody!.withOwner(jobId, taskIndex, async(client, owner): Promise<StopOutcome> => {
      if (!authority.permits(owner)) return 'forbidden';
      return await write(client) ? 'stopped' : 'already-finished';
    });
    return outcome ?? 'not-found';
  }

  private async stopWithoutCustody(job: AgentJob, principal: StopPrincipalValue, write: () => Promise<boolean>): Promise<StopOutcome> {
    if (principal.kind === 'agent' && !await this.taskLocator.isAncestorThread(job, principal.threadId)) return 'forbidden';
    return await write() ? 'stopped' : 'already-finished';
  }

  private async authorizedAgainst(owner: CustodyOwner, callerThreadId: string): Promise<boolean> {
    return owner.threadId === callerThreadId || (this.custodyLineage?.isAncestor(callerThreadId, owner.threadId) ?? false);
  }
}
