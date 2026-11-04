// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Service } from '@sulla/foundation';
import { AgentJobRepository } from '../Repositories/AgentJobRepository';
import { JobRecoveryService } from './JobRecoveryService';
import { JobRuntimeRegistry } from './JobRuntimeRegistry';
import type { AgentJob } from '../../tools/agents/jobRegistry';

/**
 * Resolves which job task owns a delegated thread, and how deep that
 * thread sits in the sub-agent chain. Split out of AgentJobService so the
 * job lifecycle (create/park/resume/complete) stays its own class.
 */
export class JobTaskLocator extends Service {
  constructor(
    private readonly repository: AgentJobRepository,
    private readonly runtime: JobRuntimeRegistry,
    private readonly recovery: JobRecoveryService,
  ) { super(); }

  /**
   * The job task a delegated child thread belongs to. Hot cache first; a cache
   * miss (a tab child after a restart) reads the persisted row.
   */
  async findTaskByThread(threadId: string): Promise<{ job: AgentJob; taskIndex: number } | undefined> {
    if (!threadId) return undefined;
    const cached = this.findCachedTaskByThread(threadId);
    if (cached) return cached;
    await this.recovery.ensureHydrated();
    try {
      const persisted = await this.repository.findByTaskThread(threadId);
      if (persisted) {
        const job = this.runtime.jobs.get(persisted.jobId) ?? persisted;
        this.runtime.jobs.set(job.jobId, job);
        const taskIndex = job.tasks.findIndex(task => task.threadId === threadId);
        if (taskIndex >= 0) return { job, taskIndex };
      }
    } catch (err) {
      console.warn('[jobRegistry] thread task read failed:', (err as Error).message);
    }
    return undefined;
  }

  private findCachedTaskByThread(threadId: string): { job: AgentJob; taskIndex: number } | undefined {
    let found: { job: AgentJob; taskIndex: number } | undefined;
    for (const job of this.runtime.jobs.values()) {
      const taskIndex = job.tasks.findIndex(task => task.threadId === threadId);
      if (taskIndex >= 0 && (!found || job.createdAt > found.job.createdAt)) found = { job, taskIndex };
    }
    return found;
  }

  /** Delegation depth of a thread: 0 for a top-level chat, else its task depth. */
  async delegationDepthForThread(threadId: string | undefined): Promise<number> {
    if (!threadId) return 0;
    const owner = await this.findTaskByThread(threadId);
    if (!owner) return 0;
    return Number(owner.job.tasks[owner.taskIndex].depth) || 1;
  }

  /**
   * Current depth of a thread's own agent: metadata set on the running thread
   * wins when present, else the depth recorded on the job task that owns this
   * thread (0 for a top-level chat). Reading the registry as the fallback means
   * a tab child cannot reset its depth just by never writing the metadata.
   */
  async resolveAgentDepth(metadataSubAgentDepth: unknown, threadId: string | undefined): Promise<number> {
    return Math.max(Number(metadataSubAgentDepth) || 0, await this.delegationDepthForThread(threadId));
  }
}
