// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { failJob } from '../tools/agents/jobRegistry';
import { agentDefinitionService } from './AgentDefinitionService';

import type { AgentJob, AgentJobTask } from '../tools/agents/jobRegistry';

export interface ParkedAgentIdentity { job: AgentJob; task: AgentJobTask; taskIndex: number; agentId: string; }
export interface ParkedJobReader { findByTaskThread(threadId: string): Promise<AgentJob | undefined>; }
export interface AgentDefinitionReader { findBySlug(slug: string): Promise<unknown | null>; }

/** Resolves a durable parked thread without ever falling back to the default persona. */
export class ParkedAgentRehydrator {
  constructor(
    private readonly jobs: ParkedJobReader,
    private readonly definitions: AgentDefinitionReader,
    private readonly fail: (jobId: string, error: string) => Promise<void>,
    private readonly notifyFailure: (job: AgentJob, error: string) => void,
  ) {}

  async isTerminalDelegatedThread(threadId: string): Promise<boolean> {
    const job = await this.jobs.findByTaskThread(threadId);
    if (!job) return false;
    if (['stopped', 'failed', 'completed'].includes(job.status)) return true;
    const task = job.tasks.find(candidate => candidate.threadId === threadId);
    return Boolean(task && ['completed', 'blocked', 'error', 'stopped'].includes(task.status));
  }

  /**
   * Task status, not the job-level rollup, decides whether this exact
   * thread is dormant: a sibling task left the job's own status 'running'
   * while this task individually parked, and that sibling must not hide
   * this task from rehydration (or vice versa — a sibling parking must not
   * stop a still-running task from being recognised as recovered).
   */
  async resolve(threadId: string): Promise<ParkedAgentIdentity | null> {
    const job = await this.jobs.findByTaskThread(threadId);
    if (!job || ['stopped', 'failed', 'completed'].includes(job.status)) return null;
    const taskIndex = job.tasks.findIndex(task => task.threadId === threadId);
    const task = job.tasks[taskIndex];
    if (!task || (task.status !== 'parked' && !(task.status === 'running' && Number(job.restartResumeCount) > 0))) return null;
    const agentId = String(task.agentId || job.parentAgentId || '').trim();
    if (!agentId || !await this.definitions.findBySlug(agentId)) {
      const message = `Cannot rehydrate parked job ${ job.jobId }: agent definition "${ agentId || '(missing)' }" is unavailable; refusing default-agent fallback.`;
      await this.fail(job.jobId, message);
      this.notifyFailure(job, message);
      throw new Error(message);
    }
    return { job, task, taskIndex, agentId };
  }

  apply(state: any, identity: ParkedAgentIdentity): void {
    state.metadata.isSubAgent = true;
    state.metadata.modelSlot = 'primary';
    state.metadata.subAgentDepth = Number(identity.task.depth) || 1;
    state.metadata.delegatedJobId = identity.job.jobId;
    state.metadata.workflowParentChannel = identity.job.parentChannel;
    state.metadata.delegatedRunActive = false;
    state.metadata.agent = {
      ...(state.metadata.agent ?? {}),
      ...(identity.task.provider ? { provider: identity.task.provider } : {}),
      ...(identity.task.model ? { model: identity.task.model } : {}),
      ...(identity.task.runLocation ? { runLocation: identity.task.runLocation } : {}),
    };
  }
}

export const parkedAgentRehydrator = new ParkedAgentRehydrator(
  agentJobProvider.jobs,
  agentDefinitionService,
  failJob,
  (job, error) => {
    if (!job.parentChannel || !job.parentThreadId) return;
    void import('./AgentCompletionInbox').then(({ enqueueAgentCompletion }) => enqueueAgentCompletion(job.parentChannel!, job.parentThreadId!, { jobId: job.jobId, taskIndex: -1, results: [], failureReason: error }));
  },
);
