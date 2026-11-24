// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { agentDefinitionService } from './AgentDefinitionService';
import { AgentJobTaskStatusPolicy } from './AgentJobTaskStatusPolicy';
import { delegatedThreadPersistenceKey } from './DelegatedContainerKey';
import { installWorkerRoute } from './WorkerModelRouting';
import { resolveLaunchModelPrecedence } from '../languagemodels/modelPrecedence';
import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { failJob } from '../tools/agents/jobRegistry';

import type { AgentJob, AgentJobTask } from '../tools/agents/jobRegistry';

export interface ParkedAgentIdentity { job: AgentJob; task: AgentJobTask; taskIndex: number; agentId: string; }
export interface ParkedJobReader { findByTaskThread(threadId: string): Promise<AgentJob | undefined>; }
export interface AgentDefinitionReader { findBySlug(slug: string): Promise<unknown | null>; }

/**
 * The container persistence key a rehydrated thread must reuse. A hidden task
 * first ran in-process through spawn_agent, which keys its workspace and
 * provider homes by the bare thread id; a woken turn that used the chat key
 * instead landed in a new empty workspace. Tab jobs always ran as chats, so
 * they keep the chat key (undefined here).
 */
export function delegatedContainerPersistenceKey(identity: ParkedAgentIdentity): string | undefined {
  const visibility = identity.task.visibility ?? identity.job.visibility;
  return visibility === 'tab' || !identity.task.threadId ? undefined : delegatedThreadPersistenceKey(identity.task.threadId);
}

/** Resolves a durable parked thread without ever falling back to the default persona. */
export class ParkedAgentRehydrator {
  constructor(
    private readonly jobs: ParkedJobReader,
    private readonly definitions: AgentDefinitionReader,
    private readonly fail: (jobId: string, error: string) => Promise<void>,
    private readonly notifyFailure: (job: AgentJob, error: string) => void,
    private readonly taskStatusPolicy = new AgentJobTaskStatusPolicy(),
  ) {}

  async isTerminalDelegatedThread(threadId: string): Promise<boolean> {
    const job = await this.jobs.findByTaskThread(threadId);
    if (!job) return false;
    if (['stopped', 'failed', 'completed'].includes(job.status)) return true;
    const task = job.tasks.find(candidate => candidate.threadId === threadId);
    return Boolean(task && this.taskStatusPolicy.isTerminal(task.status));
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
    const definition = agentId ? await this.definitions.findBySlug(agentId) as { enabled?: boolean; status?: string } | null : null;
    if (!agentId || !definition || !definition.enabled || definition.status === 'archive') {
      const message = `Agent "${ agentId || '(missing)' }" was removed or disabled; this parked job cannot wake.`;
      await this.fail(job.jobId, message);
      this.notifyFailure(job, message);
      throw new Error(message);
    }
    return { job, task, taskIndex, agentId };
  }

  apply(state: any, identity: ParkedAgentIdentity): void {
    const precedence = resolveLaunchModelPrecedence({
      override: { provider: identity.task.provider, model: identity.task.model, effort: identity.task.effort },
      workerModelRoute: identity.task.workerModelRoute,
    });
    installWorkerRoute(state, precedence.workerModelRoute, { jobId: identity.job.jobId, taskIndex: identity.taskIndex, generation: identity.task.generation });
    state.metadata.isSubAgent = true;
    state.metadata.modelSlot = 'primary';
    state.metadata.subAgentDepth = Number(identity.task.depth) || 1;
    state.metadata.delegatedJobId = identity.job.jobId;
    state.metadata.modelDecisionTask = { jobId: identity.job.jobId, taskIndex: identity.taskIndex, generation: identity.task.generation ?? 1, threadId: identity.task.threadId };
    state.metadata.modelDecision = identity.task.modelDecision ?? { requested: precedence.requested, ran: null, step: precedence.step, ...(precedence.reason ? { reason: precedence.reason } : {}) };
    if (identity.task.modelOverride) state.metadata.modelOverride = identity.task.modelOverride;
    else delete state.metadata.modelOverride;
    state.metadata.workflowParentChannel = identity.job.parentChannel;
    state.metadata.delegatedRunActive = false;
    const persistenceKey = delegatedContainerPersistenceKey(identity);
    if (persistenceKey) state.metadata.containerPersistenceKey = persistenceKey;
    state.metadata.agent = {
      ...(state.metadata.agent ?? {}),
      ...(identity.task.provider ? { provider: identity.task.provider } : {}),
      ...(identity.task.model ? { model: identity.task.model } : {}),
      ...(identity.task.effort !== undefined ? { effort: identity.task.effort } : {}),
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
