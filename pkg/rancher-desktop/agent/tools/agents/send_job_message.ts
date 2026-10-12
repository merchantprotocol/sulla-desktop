import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';
import { injectSteer } from '../../utils/steerChannel';
import { BaseTool, ToolResponse } from '../base';
import { getJob } from './jobRegistry';

/**
 * Persist a message for one or all open tasks of a job and deliver it.
 * Hidden children get it live (steer) or at their next model call. A tab
 * child is a desktop chat: the message steers its live turn, or starts a turn
 * when it is idle, through the same inject path the old message_tab used.
 */
export async function sendJobMessage(input: { jobId: string; taskIndex?: number; message: string }): Promise<ToolResponse> {
  const { jobId, taskIndex, message } = input;
  if (!jobId || !message) {
    return { successBoolean: false, responseString: 'jobId and a non-empty message are required.' };
  }
  if (taskIndex !== undefined && (!Number.isInteger(taskIndex) || taskIndex < 0)) {
    return { successBoolean: false, responseString: 'taskIndex must be a non-negative integer.' };
  }

  const targets = await AgentJobMessagingModel.targetsForJob(jobId, taskIndex);
  if (targets.length === 0) {
    return {
      successBoolean: false,
      responseString: taskIndex === undefined
        ? `Job "${ jobId }" has no queued or running tasks.`
        : `Job "${ jobId }" has no task at index ${ taskIndex } (or it has already finished).`,
    };
  }
  if (targets.some(target => target.jobStatus !== 'running')) {
    return { successBoolean: false, responseString: `Job "${ jobId }" is no longer running.` };
  }

  const job = await getJob(jobId);
  const queued = await Promise.all(targets.map(async(target) => ({
    target,
    record: await AgentJobMessagingModel.queueMessage(target, message),
  })));
  let deliveredLive = 0;
  const { GraphRegistry } = await import('../../services/GraphRegistry');

  for (const { target, record } of queued) {
    if (!target.threadId) continue;
    const meta = {
      jobId,
      taskIndex:          target.taskIndex,
      jobMessageId:       record.id,
      jobMessageThreadId: target.threadId,
    };

    if (job?.visibility === 'tab') {
      const { messageAgentTab } = await import('../../services/AgentTabOpener');
      try {
        await messageAgentTab(target.threadId, job.tasks[target.taskIndex]?.agentId ?? '', message, meta);
        await AgentJobMessagingModel.markMessagesDelivered([record.id], target.threadId);
        deliveredLive += 1;
      } catch (err) {
        console.warn(`[send_job_message] tab delivery failed for ${ jobId }:`, (err as Error).message);
      }
      continue;
    }

    const running = GraphRegistry.get(target.threadId);
    if (!running) continue;
    const accepted = injectSteer(running.state as any, {
      role:    'user',
      content: `[Message from orchestrator]\n${ message }`,
      metadata: {
        source:       'orchestrator_job_message',
        inputSource:  'system',
        ...meta,
      },
    } as any);
    if (accepted) {
      await AgentJobMessagingModel.markMessagesDelivered([record.id], target.threadId);
      deliveredLive += 1;
    }
  }

  return {
    successBoolean: true,
    responseString: JSON.stringify({
      jobId,
      targetedTasks: queued.map(({ target }) => target.taskIndex),
      deliveredLive,
      queuedForNextBoundary: queued.length - deliveredLive,
    }, null, 2),
  };
}

export class SendJobMessageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    return sendJobMessage({
      jobId:     String(input.jobId ?? '').trim(),
      message:   String(input.message ?? '').trim(),
      taskIndex: input.taskIndex === undefined ? undefined : Number(input.taskIndex),
    });
  }
}
