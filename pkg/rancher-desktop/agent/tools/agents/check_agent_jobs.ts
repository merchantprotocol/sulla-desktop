import { BaseTool, ToolResponse } from '../base';
import { getJob, getAllJobs, deleteJob } from './jobRegistry';

export class CheckAgentJobsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { jobId } = input;

    // ── Specific job lookup ──────────────────────────────────────
    if (jobId) {
      const job = await getJob(jobId);

      if (!job) {
        return {
          successBoolean: false,
          responseString: `Job "${ jobId }" not found. It may have expired (jobs are kept for 1 hour after completion).`,
        };
      }

      if (job.status === 'running') {
        const elapsed = Math.round((Date.now() - job.createdAt) / 1000);

        return {
          successBoolean: true,
          responseString: JSON.stringify({
            jobId:     job.jobId,
            status:    'running',
            taskCount: job.taskCount,
            elapsed:   `${ elapsed }s`,
            message:   `Job is still running (${ job.taskCount } task(s), ${ elapsed }s elapsed). Check again later.`,
          }, null, 2),
        };
      }

      if (job.status === 'failed') {
        const result = {
          jobId:  job.jobId,
          status: 'failed',
          error:  job.error,
        };

        deleteJob(jobId);

        return {
          successBoolean: false,
          responseString: JSON.stringify(result, null, 2),
        };
      }

      if (job.status === 'stopped') {
        const done = job.results.filter(r => r.status === 'completed').length;
        const result = {
          jobId:          job.jobId,
          status:         'stopped',
          taskCount:      job.taskCount,
          partialResults: job.results.length,
          message:        `Job was stopped via stop_agent_job. ${ done } of ${ job.taskCount } task(s) had completed before cancellation; the rest were aborted.`,
        };

        deleteJob(jobId);

        return {
          successBoolean: false,
          responseString: JSON.stringify(result, null, 2),
        };
      }

      // Completed — return results. Keep an undelivered completion in the
      // durable outbox so boot recovery can still wake its parent graph.
      const allSuccess = job.results.every(r => r.status === 'completed');

      const formatted = job.results.map(r =>
        `### ${ r.label } [${ r.status.toUpperCase() }]\n${ r.output }`,
      ).join('\n\n---\n\n');

      if (job.completionDeliveredAt) deleteJob(jobId);

      return {
        successBoolean: allSuccess,
        responseString: job.results.length === 1
          ? job.results[0].output
          : `${ job.results.length } sub-agent(s) completed.${ job.completionDeliveredAt ? '' : ' Completion remains queued for parent-graph recovery.' }\n\n${ formatted }`,
      };
    }

    // ── List all jobs ────────────────────────────────────────────
    const allJobs = await getAllJobs();

    if (allJobs.length === 0) {
      return {
        successBoolean: true,
        responseString: 'No active or recent async agent jobs.',
      };
    }

    const summary = allJobs.map((j) => {
      const elapsed = Math.round((Date.now() - j.createdAt) / 1000);

      return `- **${ j.jobId }**: ${ j.status } (${ j.taskCount } task(s), ${ elapsed }s ago)`;
    }).join('\n');

    return {
      successBoolean: true,
      responseString: `${ allJobs.length } job(s):\n\n${ summary }`,
    };
  }
}
