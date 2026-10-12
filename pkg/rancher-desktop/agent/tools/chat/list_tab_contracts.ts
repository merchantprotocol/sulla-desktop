import { BaseTool, ToolResponse } from '../base';
import { getJobsForParentThread, type AgentJob } from '../agents/jobRegistry';

type LegacyStatus = 'open' | 'returned' | 'cancelled';

function legacyStatus(job: AgentJob): LegacyStatus {
  if (job.status === 'running') return 'open';
  return job.tasks[0]?.returnedAt ? 'returned' : 'cancelled';
}

/**
 * Alias view over this chat's tab jobs in the old contract shape. The full
 * picture (hidden children too, check-ins, results) is check_agent_jobs.
 */
export class ListAgentTabContractsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const parentThreadId = String(this.state?.metadata?.threadId ?? '').trim();
    if (!parentThreadId) return { successBoolean: false, responseString: 'list_tab_contracts must be called from a parent chat thread.' };
    const jobs = (await getJobsForParentThread(parentThreadId))
      .filter(job => job.visibility === 'tab')
      .filter(job => !input.status || legacyStatus(job) === input.status)
      .sort((a, b) => b.createdAt - a.createdAt);
    return {
      successBoolean: true,
      responseString: JSON.stringify(jobs.map((job) => {
        const task = job.tasks[0];
        return {
          contractId:    job.jobId,
          jobId:         job.jobId,
          childThreadId: task?.threadId,
          childAgentId:  task?.agentId,
          title:         task?.label,
          contract:      task?.contract,
          status:        legacyStatus(job),
          result:        task?.result ?? null,
          depth:         task?.depth ?? 1,
          createdAt:     new Date(job.createdAt).toISOString(),
          returnedAt:    task?.returnedAt ? new Date(task.returnedAt).toISOString() : null,
        };
      })),
    };
  }
}
