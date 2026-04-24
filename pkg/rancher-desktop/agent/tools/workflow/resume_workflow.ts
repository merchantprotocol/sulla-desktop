import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';
import { pauseKey } from './pause_workflow';

/**
 * Resume a paused workflow by clearing its pause flag.
 */
export class ResumeWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const executionId = typeof input.executionId === 'string' ? input.executionId.trim() : '';
    if (!executionId) {
      return { successBoolean: false, responseString: 'Missing required field: executionId.' };
    }
    try {
      const existed = await redisClient.get(pauseKey(executionId));
      if (!existed) {
        return { successBoolean: true, responseString: `No pause flag set for ${ executionId }. Workflow is either running or already stopped.` };
      }
      await redisClient.del(pauseKey(executionId));
      return {
        successBoolean: true,
        responseString: `Resumed execution ${ executionId } — the orchestrator will advance on its next tick.`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Resume failed: ${ (err as Error).message }` };
    }
  }
}
