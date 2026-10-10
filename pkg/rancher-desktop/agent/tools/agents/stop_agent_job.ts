import { BaseTool, ToolResponse } from '../base';
import { emitSubAgentExchange } from './jobExchange';
import { abortJob, getJob } from './jobRegistry';

/**
 * Kill switch for async sub-agent jobs launched with spawn_agent(async: true).
 * Fires the job's AbortController, which is threaded into every sub-agent that
 * job spawned via `metadata.options.abort` — the same signal the user's stop
 * button uses — so the sub-agent graphs unwind cooperatively.
 *
 * Cooperative, not preemptive: a sub-agent blocked inside an in-flight LLM or
 * tool call finishes that call first, then sees the aborted signal on its next
 * step and stops. There is no forced process kill (jobs run in-process, not as
 * child processes).
 */
export class StopAgentJobWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { jobId } = input;

    if (!jobId || typeof jobId !== 'string') {
      return {
        successBoolean: false,
        responseString: 'jobId is required (the id returned by an async spawn_agent call).',
      };
    }

    const job = await getJob(jobId);
    const outcome = abortJob(jobId);

    switch (outcome) {
    case 'stopped':
      await Promise.all((job?.tasks ?? []).map((task, taskIndex) => emitSubAgentExchange(
        job?.parentChannel,
        job?.parentThreadId,
        {
          direction: 'from_agent',
          agentId: task.agentId,
          label: task.label,
          summary: `${ task.label } was stopped`,
          detail: `Stop requested for job ${ jobId } before the sub-agent finished.`,
          status: 'stopped',
          jobId,
          taskIndex,
          conversationId: task.threadId,
        },
      )));
      return {
        successBoolean: true,
        responseString: `Stop requested for job "${ jobId }". Its sub-agents will unwind at their next step (cooperative — an in-flight LLM/tool call finishes first). Poll check_agent_jobs("${ jobId }") to confirm it settled as 'stopped'.`,
      };
    case 'already-finished':
      return {
        successBoolean: false,
        responseString: `Job "${ jobId }" is not running (already completed, failed, or stopped). Nothing to cancel.`,
      };
    case 'not-found':
    default:
      return {
        successBoolean: false,
        responseString: `Job "${ jobId }" not found. It may have already settled and been cleaned up (jobs are pruned 1 hour after finishing).`,
      };
    }
  }
}
