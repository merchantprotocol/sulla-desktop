// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service, type Clock } from '@sulla/foundation';
import { StopPrincipal, type StopPrincipalValue } from '../ValueObjects/StopPrincipal';
import { JobRuntimeRegistry } from './JobRuntimeRegistry';
import { JobTaskLocator } from './JobTaskLocator';
import type { AgentStateService } from './AgentStateService';

export type StopOutcome = 'stopped' | 'not-found' | 'already-finished' | 'forbidden';

/** Applies authorization, attribution, persistence, publication, and aborts for job stops. */
export class JobStopService extends Service {
  constructor(private readonly states: AgentStateService, private readonly runtime: JobRuntimeRegistry, private readonly clock: Clock, private readonly taskLocator: JobTaskLocator) { super(); }

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
    if (principal.kind === 'agent' && !await this.taskLocator.isAncestorThread(job, principal.threadId)) return 'forbidden';
    const stoppedAt = this.clock.now().getTime(); const stoppedBy = StopPrincipal.attribution(principal);
    const updated = await this.states.mutateJob(jobId, current => {
      const currentTask = current.tasks[taskIndex]; if (!currentTask || !['queued','running','parked'].includes(currentTask.status)) return undefined;
      const tasks = current.tasks.map((item, index) => index === taskIndex ? { ...item, status: 'stopped' as const, finishedAt: stoppedAt, stoppedBy, stopReason: reason } : item);
      const settlesJob = tasks.every(item => !['queued','running','parked'].includes(item.status));
      return { ...current, tasks, ...(settlesJob ? { status: 'stopped' as const, finishedAt: stoppedAt, stoppedBy, stopReason: reason } : {}) };
    });
    if (!updated) return 'already-finished'; this.runtime.abortScopes.get(jobId)?.abortTask(taskIndex); return 'stopped';
  }

  async authorize(jobId: string, principal: StopPrincipalValue): Promise<'allowed' | 'not-found' | 'forbidden'> {
    const job = await this.states.jobForWrite(jobId); if (!job) return 'not-found';
    return principal.kind === 'agent' && !await this.taskLocator.isAncestorThread(job, principal.threadId) ? 'forbidden' : 'allowed';
  }

  async stopCascade(jobId: string, principal: StopPrincipalValue, reason: string): Promise<StopOutcome> {
    const root = await this.states.jobForWrite(jobId); if (!root) return 'not-found';
    if (!['running','parked'].includes(root.status)) return 'already-finished';
    if (principal.kind === 'agent' && !await this.taskLocator.isAncestorThread(root, principal.threadId)) return 'forbidden';
    const stoppedIds = await this.states.stopCascade(jobId, StopPrincipal.attribution(principal), reason);
    for (const stoppedId of stoppedIds) this.runtime.abortScopes.get(stoppedId)?.abortJob();
    return stoppedIds.length ? 'stopped' : 'already-finished';
  }
}
