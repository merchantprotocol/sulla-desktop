import { AgentJobMessagingModel, type AgentJobCheckin, type AgentJobTaskTelemetry } from '../../database/models/AgentJobMessagingModel';
import { BaseTool, ToolResponse } from '../base';
import { getJob, getAllJobs, deleteJob } from './jobRegistry';

import type { AgentJob } from './jobRegistry';

function elapsedSince(startedAt: number | undefined, fallback: number, finishedAt?: number): string {
  const start = startedAt ?? fallback;
  const end = finishedAt ?? Date.now();

  return `${ Math.max(0, Math.round((end - start) / 1000)) }s`;
}

function serializeCheckin(checkin: AgentJobCheckin | null): Record<string, unknown> | null {
  if (!checkin) return null;

  return {
    step:         checkin.step,
    summary:      checkin.summary,
    files:        checkin.filesTouched,
    blockers:     checkin.blockers,
    percent:      checkin.percent,
    time:         new Date(checkin.createdAt).toISOString(),
  };
}

export function jobTaskViews(job: AgentJob, telemetry: Record<number, AgentJobTaskTelemetry>): Array<Record<string, unknown>> {
  return job.tasks.map((task, taskIndex) => {
    const activity = telemetry[taskIndex] ?? {
      latestCheckin: null,
      checkins: [],
      undeliveredMessages: 0,
    };

    return {
      taskIndex,
      agentId: task.agentId,
      label: task.label,
      status: task.status,
      elapsed: elapsedSince(task.startedAt, job.createdAt, task.finishedAt),
      threadId: task.threadId,
      latestCheckin: serializeCheckin(activity.latestCheckin),
      undeliveredOrchestratorMessages: activity.undeliveredMessages,
      checkins: activity.checkins.map(serializeCheckin),
    };
  });
}

async function serializeJob(job: AgentJob): Promise<Record<string, unknown>> {
  const telemetry = await AgentJobMessagingModel.telemetryForJob(job.jobId);

  return {
    jobId: job.jobId,
    status: job.status,
    taskCount: job.taskCount,
    elapsed: elapsedSince(job.createdAt, job.createdAt, job.finishedAt ?? undefined),
    error: job.error,
    tasks: jobTaskViews(job, telemetry),
    results: job.results,
  };
}

export class CheckAgentJobsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { jobId } = input;

    if (jobId) {
      const job = await getJob(jobId);
      if (!job) {
        return {
          successBoolean: false,
          responseString: `Job "${ jobId }" not found. It may have expired (jobs are kept for 1 hour after completion).`,
        };
      }

      const result = await serializeJob(job);
      if (job.status !== 'running' && job.completionDeliveredAt) deleteJob(jobId);

      return {
        successBoolean: job.status === 'running' || (job.status === 'completed' && job.results.every(result => result.status === 'completed')),
        responseString: JSON.stringify(result, null, 2),
      };
    }

    const allJobs = await getAllJobs();
    if (allJobs.length === 0) {
      return {
        successBoolean: true,
        responseString: 'No active or recent async agent jobs.',
      };
    }

    const jobs = await Promise.all(allJobs.map(serializeJob));

    return {
      successBoolean: true,
      responseString: JSON.stringify({ count: jobs.length, jobs }, null, 2),
    };
  }
}
