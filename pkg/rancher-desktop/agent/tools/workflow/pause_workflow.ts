import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Request a running workflow to pause. Cooperative — same Redis-flag model
 * as stop_workflow, but the flag is `sulla:workflow:pause:<executionId>` and
 * PlaybookController treats it as "halt the frontier advance without
 * releasing the playbook". `resume_workflow` clears the flag.
 *
 * Note: like stop, this is a cooperative check. If the orchestrator is
 * blocked on a long sub-agent call, the pause takes effect when that call
 * returns. Currently-in-flight work is NOT cancelled by pause.
 */

const PAUSE_KEY_PREFIX = 'sulla:workflow:pause:';
const PAUSE_TTL_SECONDS = 86_400; // 24h — resume_workflow removes it, but TTL prevents orphaned pauses

export function pauseKey(executionId: string): string {
  return `${ PAUSE_KEY_PREFIX }${ executionId }`;
}

export class PauseWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const executionId = typeof input.executionId === 'string' ? input.executionId.trim() : '';
    const reason = typeof input.reason === 'string' && input.reason.trim().length > 0
      ? input.reason.trim()
      : 'Paused by user';

    if (!executionId) {
      return { successBoolean: false, responseString: 'Missing required field: executionId.' };
    }

    try {
      await redisClient.set(pauseKey(executionId), reason, PAUSE_TTL_SECONDS);
      return {
        successBoolean: true,
        responseString:
          `Pause flag set for execution ${ executionId } (reason: "${ reason }"). ` +
          `The running orchestrator will stop advancing the frontier on its next tick. ` +
          `Resume with \`sulla meta/resume_workflow '{"executionId":"${ executionId }"}'\`.`,
      };
    } catch (err) {
      return { successBoolean: false, responseString: `Pause failed: ${ (err as Error).message }` };
    }
  }
}
