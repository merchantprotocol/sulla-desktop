// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Clock } from '@sulla/foundation';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { JobAbortScope } from './JobAbortScope';
import { JobIdGenerator } from './JobIdGenerator';
import { JobRecoveryService } from './JobRecoveryService';
import { JobRuntimeRegistry } from './JobRuntimeRegistry';
import { SpawnDedupeGuard } from './SpawnDedupeGuard';
import type { AgentJob, AgentJobTask, CreateJobOptions } from '../../tools/agents/jobRegistry';

/** Creates durable jobs and serializes labeled spawn retries. */
export class SpawnJobCreator {
  constructor(private readonly repository: AgentJobRepository, private readonly runtime: JobRuntimeRegistry, private readonly recovery: JobRecoveryService, private readonly clock: Clock, private readonly ids: JobIdGenerator, private readonly dedupe: SpawnDedupeGuard) {}

  async create(taskInput: number | AgentJobTask[], parentChannel?: string, parentThreadId?: string, options: CreateJobOptions = {}): Promise<AgentJob> {
    await this.recovery.ensureHydrated();
    const tasks = Array.isArray(taskInput) ? taskInput : [];
    const label = options.dedupeLabel?.trim();
    const key = label && tasks.length === 1 ? `${ parentThreadId ? `thread:${ parentThreadId }` : `agent:${ options.parentAgentId ?? parentChannel ?? '' }` }\0${ label }` : undefined;
    const result = await this.dedupe.run(key, () => this.find(parentThreadId, options.parentAgentId, label), () => this.insert(tasks, parentChannel, parentThreadId, options));
    if (result.deduplicated) result.value.deduplicated = true;
    return result.value;
  }

  private async find(parentThreadId: string | undefined, parentAgentId: string | undefined, label: string | undefined): Promise<AgentJob | undefined> {
    if (!label) return undefined;
    const since = this.clock.now().getTime() - SpawnDedupeGuard.WINDOW_MS;
    const cached = Array.from(this.runtime.jobs.values()).find(job => job.tasks.length === 1 && job.parentThreadId === parentThreadId && (parentThreadId || job.parentAgentId === parentAgentId) && job.tasks[0].label === label && this.dedupe.isEligible(job));
    return cached ?? this.repository.recentSpawnJob(parentThreadId, parentAgentId, label, since);
  }

  private async insert(tasks: AgentJobTask[], parentChannel: string | undefined, parentThreadId: string | undefined, options: CreateJobOptions): Promise<AgentJob> {
    const job: AgentJob = {
      jobId: this.ids.next(), status: 'running', createdAt: this.clock.now().getTime(), finishedAt: null,
      taskCount: tasks.length, results: [], tasks, parentChannel, parentThreadId, parentAgentId: options.parentAgentId,
      visibility: options.visibility ?? 'hidden', completionDeliveredAt: null, dismissedAt: null,
    };
    this.runtime.jobs.set(job.jobId, job);
    this.runtime.abortScopes.set(job.jobId, new JobAbortScope());
    void import('../../extensions/HookRegistry').then(({ extensionHooks }) => extensionHooks.runAction('on_agent_job_start', { jobId: job.jobId, taskCount: tasks.length, parentAgentId: options.parentAgentId }));
    try { await this.repository.insertJob(job); } catch (error) { console.warn('[SpawnJobCreator] persistence write failed (job continues in-memory):', (error as Error).message); }
    return job;
  }
}
