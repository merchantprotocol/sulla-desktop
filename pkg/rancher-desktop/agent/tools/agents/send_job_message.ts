import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';
import { injectSteer } from '../../utils/steerChannel';
import { BaseTool, ToolResponse } from '../base';

export class SendJobMessageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const jobId = String(input.jobId ?? '').trim();
    const message = String(input.message ?? '').trim();
    const taskIndex = input.taskIndex === undefined ? undefined : Number(input.taskIndex);

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

    const queued = await Promise.all(targets.map(async(target) => ({
      target,
      record: await AgentJobMessagingModel.queueMessage(target, message),
    })));
    let deliveredLive = 0;
    const { GraphRegistry } = await import('../../services/GraphRegistry');

    for (const { target, record } of queued) {
      if (!target.threadId) continue;
      const running = GraphRegistry.get(target.threadId);
      if (!running) continue;
      const accepted = injectSteer(running.state as any, {
        role:    'user',
        content: `[Message from orchestrator]\n${ message }`,
        metadata: {
          source:       'orchestrator_job_message',
          inputSource:  'system',
          jobId,
          taskIndex:    target.taskIndex,
          jobMessageId: record.id,
          jobMessageThreadId: target.threadId,
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
}
