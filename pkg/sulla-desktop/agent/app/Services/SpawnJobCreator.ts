// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Clock } from '@sulla/foundation';
import { JobAbortScope } from './JobAbortScope';
import { JobIdGenerator } from './JobIdGenerator';
import { JobRecoveryService } from './JobRecoveryService';
import { JobRuntimeRegistry } from './JobRuntimeRegistry';
import { SpawnDedupeGuard } from './SpawnDedupeGuard';
import type { AgentJob, AgentJobTask, CreateJobOptions } from '../../tools/agents/jobRegistry';

export interface SpawnJobRepository {
  recentSpawnJob(parentThreadId: string | undefined, parentAgentId: string | undefined, label: string, since: number): Promise<AgentJob | undefined>;
  reserveSpawnJob(job: AgentJob, launchKey: string): Promise<{job:AgentJob; inserted:boolean}>;
}

export interface SpawnJobStateWriter {
  create(job: AgentJob): Promise<unknown>;
  /** Publishes a row another writer already persisted (an idempotent launch-key reservation). */
  remember(job: AgentJob): AgentJob;
}

/** Creates durable jobs and serializes labeled spawn retries. */
export class SpawnJobCreator {
  constructor(private readonly repository: SpawnJobRepository, private readonly runtime: JobRuntimeRegistry, private readonly recovery: JobRecoveryService, private readonly clock: Clock, private readonly ids: JobIdGenerator, private readonly dedupe: SpawnDedupeGuard, private readonly states: SpawnJobStateWriter) {}

  async create(taskInput: number | AgentJobTask[], parentChannel?: string, parentThreadId?: string, options: CreateJobOptions = {}): Promise<AgentJob> {
    await this.recovery.ensureHydrated();
    const tasks = Array.isArray(taskInput) ? taskInput : [];
    const label = options.dedupeLabel?.trim();
    const key = label && tasks.length === 1 ? `${ parentThreadId ? `thread:${ parentThreadId }` : `agent:${ options.parentAgentId ?? parentChannel ?? '' }` }\0${ label }` : undefined;
    if(options.launchKey?.trim()) return this.insertReserved(tasks,parentChannel,parentThreadId,options,options.launchKey.trim());
    const result = await this.dedupe.run(key, () => this.find(parentThreadId, options.parentAgentId, label), () => this.insert(tasks, parentChannel, parentThreadId, options));
    if (result.deduplicated) result.value.deduplicated = true;
    return result.value;
  }

  private async insertReserved(tasks:AgentJobTask[],parentChannel:string|undefined,parentThreadId:string|undefined,options:CreateJobOptions,launchKey:string):Promise<AgentJob>{
    const candidate=this.build(tasks,parentChannel,parentThreadId,options);
    const reserved=await this.repository.reserveSpawnJob(candidate,launchKey);
    const job=this.states.remember(reserved.job);
    if(reserved.inserted){this.runtime.abortScopes.set(job.jobId,new JobAbortScope());void import('../../extensions/HookRegistry').then(({extensionHooks})=>extensionHooks.runAction('on_agent_job_start',{jobId:job.jobId,taskCount:tasks.length,parentAgentId:options.parentAgentId}));}
    else job.deduplicated=true;
    return job;
  }

  private async find(parentThreadId: string | undefined, parentAgentId: string | undefined, label: string | undefined): Promise<AgentJob | undefined> {
    if (!label) return undefined;
    const since = this.clock.now().getTime() - SpawnDedupeGuard.WINDOW_MS;
    const cached = Array.from(this.runtime.jobs.values()).find(job => job.tasks.length === 1 && job.parentThreadId === parentThreadId && (parentThreadId || job.parentAgentId === parentAgentId) && job.tasks[0].label === label && this.dedupe.isEligible(job));
    if (cached) return cached;
    const persisted = await this.repository.recentSpawnJob(parentThreadId, parentAgentId, label, since);
    return persisted && this.dedupe.isEligible(persisted) ? persisted : undefined;
  }

  private async insert(tasks: AgentJobTask[], parentChannel: string | undefined, parentThreadId: string | undefined, options: CreateJobOptions): Promise<AgentJob> {
    const job=this.build(tasks,parentChannel,parentThreadId,options);
    await this.states.create(job);
    this.runtime.abortScopes.set(job.jobId, new JobAbortScope());
    void import('../../extensions/HookRegistry').then(({ extensionHooks }) => extensionHooks.runAction('on_agent_job_start', { jobId: job.jobId, taskCount: tasks.length, parentAgentId: options.parentAgentId }));
    return job;
  }
  private build(tasks:AgentJobTask[],parentChannel:string|undefined,parentThreadId:string|undefined,options:CreateJobOptions):AgentJob{return {
      jobId: this.ids.next(), status: 'running', createdAt: this.clock.now().getTime(), finishedAt: null,
      taskCount: tasks.length, results: [], tasks, parentChannel, parentThreadId, parentAgentId: options.parentAgentId,
      visibility: options.visibility ?? 'hidden', completionDeliveredAt: null, dismissedAt: null,
    };}
}
