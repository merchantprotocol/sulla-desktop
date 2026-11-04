// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { agentDefinitionService } from './AgentDefinitionService';

import type { AgentJob, AgentJobTask } from '../tools/agents/jobRegistry';

export interface ParkedAgentIdentity { job: AgentJob; task: AgentJobTask; taskIndex: number; agentId: string; }

/** Resolves a durable parked thread without ever falling back to the default persona. */
export class ParkedAgentRehydrator {
  async resolve(threadId: string): Promise<ParkedAgentIdentity | null> {
    const job = await agentJobProvider.jobs.findByTaskThread(threadId);
    if (!job || job.status !== 'parked') return null;
    const taskIndex = job.tasks.findIndex(task => task.threadId === threadId);
    const task = job.tasks[taskIndex];
    if (!task || task.status !== 'parked') return null;
    const agentId = String(task.agentId || job.parentAgentId || '').trim();
    if (!agentId || !await agentDefinitionService.findBySlug(agentId)) {
      const message = `Cannot rehydrate parked job ${ job.jobId }: agent definition "${ agentId || '(missing)' }" is unavailable; refusing default-agent fallback.`;
      await agentJobProvider.jobs.fail(job.jobId, message, job.tasks);
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
  }
}

export const parkedAgentRehydrator = new ParkedAgentRehydrator();
