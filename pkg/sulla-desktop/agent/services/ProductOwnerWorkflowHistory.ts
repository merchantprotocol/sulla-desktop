// SPDX-License-Identifier: GPL-2.0-or-later

import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { AgentLineageIndex } from '../app/Services/AgentLineageIndex';
import { ConversationThreadStore } from '../database/models/ConversationThreadStore';
import { AgentResultCardBuilder } from './agentResults/AgentResultCardBuilder';

import type { AgentRowState } from '../../shared/agentState/AgentStateSnapshot';
import type { ChatOutcomeArchive, WorkflowRunRow } from '../../shared/productOwnerWorkflow';
import type { AgentJob, AgentJobTask } from '../tools/agents/jobRegistry';

const workflowStates: Record<AgentJobTask['status'], AgentRowState> = {
  queued: 'queued', running: 'working', parked: 'parked', lost: 'lost',
  completed: 'done', blocked: 'blocked', error: 'failed', stopped: 'stopped',
};

export class ProductOwnerWorkflowHistory {
  private valid(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
  }

  async history(threadId: string): Promise<WorkflowRunRow[]> {
    if (!this.valid(threadId)) throw new Error('Invalid chat.');
    return this.rows(threadId, await agentJobProvider.jobs.lineageForParentThread(threadId));
  }

  async outcomes(threadId: string, conversationId: string): Promise<ChatOutcomeArchive> {
    if (!this.valid(threadId) || !this.valid(conversationId)) throw new Error('Invalid chat.');
    const [jobs, transcript] = await Promise.all([
      agentJobProvider.jobs.lineageForParentThread(threadId, 100, true),
      ConversationThreadStore.loadReportMessages(conversationId),
    ]);
    const history = this.rows(threadId, jobs);
    const included = new Set(history.map(row => row.key));
    const builder = new AgentResultCardBuilder(undefined);
    const reports = jobs.flatMap(job => job.tasks.flatMap((_, index) => {
      if (!included.has(`${ job.jobId }:${ index }`)) return [];
      const item = builder.recorded(job, index);
      return item ? [{ item }] : [];
    }));
    return { history, reports: [...reports, ...transcript] };
  }

  private rows(threadId: string, jobs: AgentJob[]): WorkflowRunRow[] {
    const index = new AgentLineageIndex(jobs);
    return jobs.flatMap(job => {
      const parent = index.lineage(job);
      if (parent.rootThreadId !== threadId && !job.parentJobId) return [];
      return job.tasks.flatMap((task, taskIndex) => task ? [{
        key: `${ job.jobId }:${ taskIndex }`, jobId: job.jobId, taskIndex, rootThreadId: threadId,
        parentJobId: job.parentJobId ?? parent.parentJobId, parentTaskIndex: job.parentTaskIndex ?? parent.parentTaskIndex,
        agentId: task.agentId, label: task.label, state: workflowStates[task.status],
        startedAt: new Date(task.startedAt ?? job.createdAt).toISOString(),
        endedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
        stateReason: task.waitReason ?? null, responseModels: task.responseModels,
        workflowStep: task.workflowStep, followUpOf: task.followUpOf,
      }] : []);
    });
  }
}

export const productOwnerWorkflowHistory = new ProductOwnerWorkflowHistory();
