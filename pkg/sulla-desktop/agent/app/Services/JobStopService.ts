// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service, type Clock } from '@sulla/foundation';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { StopPrincipal, type StopPrincipalValue } from '../ValueObjects/StopPrincipal';
import { JobRuntimeRegistry } from './JobRuntimeRegistry';
import { JobTaskLocator } from './JobTaskLocator';

export type StopOutcome = 'stopped' | 'not-found' | 'already-finished' | 'forbidden';

/** Applies authorization, attribution, persistence, and aborts for job stops. */
export class JobStopService extends Service {
  constructor(private readonly repository: AgentJobRepository, private readonly runtime: JobRuntimeRegistry, private readonly clock: Clock, private readonly taskLocator: JobTaskLocator) { super(); }
  private async persist(operation: Promise<void>): Promise<void> { try { await operation; } catch (error) { console.warn('[JobStopService] persistence write failed:', (error as Error).message); } }

  abortJob(jobId: string, principal: StopPrincipalValue, reason: string): Exclude<StopOutcome, 'forbidden'> {
    const job = this.runtime.jobs.get(jobId);
    if (!job) return 'not-found';
    if (!['running', 'parked'].includes(job.status)) return 'already-finished';
    this.runtime.abortScopes.get(jobId)?.abortJob();
    job.status = 'stopped'; job.finishedAt = this.clock.now().getTime();
    job.tasks = job.tasks.map(task => ['running', 'queued', 'parked'].includes(task.status) ? { ...task, status: 'stopped', finishedAt: job.finishedAt! } : task);
    job.stoppedBy = StopPrincipal.attribution(principal); job.stopReason = reason;
    void this.persist(this.repository.stop(jobId, job.tasks, job.stoppedBy, reason));
    return 'stopped';
  }

  async stopTask(jobId: string, taskIndex: number, principal: StopPrincipalValue, reason: string): Promise<StopOutcome> {
    const job = this.runtime.jobs.get(jobId) ?? await this.repository.job(jobId);
    const task = job?.tasks[taskIndex];
    if (!job || !task) return 'not-found';
    if (!['running', 'parked'].includes(job.status) || !['queued', 'running', 'parked'].includes(task.status)) return 'already-finished';
    if (principal.kind === 'agent' && !await this.taskLocator.isAncestorThread(job, principal.threadId)) return 'forbidden';
    this.runtime.abortScopes.get(jobId)?.abortTask(taskIndex);
    const stoppedAt = this.clock.now().getTime();
    job.tasks[taskIndex] = { ...task, status: 'stopped', finishedAt: stoppedAt, stoppedBy: StopPrincipal.attribution(principal), stopReason: reason };
    if (job.tasks.every(item => !['queued', 'running', 'parked'].includes(item.status))) {
      job.status = 'stopped'; job.finishedAt = stoppedAt; job.stoppedBy = StopPrincipal.attribution(principal); job.stopReason = reason;
      await this.persist(this.repository.stop(jobId, job.tasks, job.stoppedBy, reason));
    } else await this.persist(this.repository.updateTasks(jobId, job.tasks));
    return 'stopped';
  }

  async authorize(jobId: string, principal: StopPrincipalValue): Promise<'allowed' | 'not-found' | 'forbidden'> {
    const job = this.runtime.jobs.get(jobId) ?? await this.repository.job(jobId);
    if (!job) return 'not-found';
    return principal.kind === 'agent' && !await this.taskLocator.isAncestorThread(job, principal.threadId) ? 'forbidden' : 'allowed';
  }

  async stopCascade(jobId: string, principal: StopPrincipalValue, reason: string): Promise<StopOutcome> {
    const root = this.runtime.jobs.get(jobId) ?? await this.repository.job(jobId);
    if (!root) return 'not-found';
    if (!['running', 'parked'].includes(root.status)) return 'already-finished';
    if (principal.kind === 'agent' && !await this.taskLocator.isAncestorThread(root, principal.threadId)) return 'forbidden';
    const stoppedBy = StopPrincipal.attribution(principal);
    const stoppedIds = await this.repository.stopCascade(jobId, stoppedBy, reason);
    const stoppedAt = this.clock.now().getTime();
    for (const stoppedId of stoppedIds) {
      this.runtime.abortScopes.get(stoppedId)?.abortJob();
      const job = this.runtime.jobs.get(stoppedId);
      if (!job || !['running', 'parked'].includes(job.status)) continue;
      job.status = 'stopped'; job.finishedAt = stoppedAt; job.waitingOnChildren = 0; job.stoppedBy = stoppedBy; job.stopReason = reason;
      job.tasks = job.tasks.map(task => ['queued', 'running', 'parked'].includes(task.status) ? { ...task, status: 'stopped', finishedAt: stoppedAt } : task);
    }
    return 'stopped';
  }
}
