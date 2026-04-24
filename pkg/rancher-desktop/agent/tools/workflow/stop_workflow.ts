import { redisClient } from '../../database/RedisClient';
import { BaseTool, ToolResponse } from '../base';

/**
 * Request a running workflow to stop. Writes a short-lived Redis flag that
 * PlaybookController reads at each frontier-advance tick. The running
 * orchestrator will see the flag on its next step and release the workflow
 * as aborted.
 *
 * Important limitations:
 * - The stop is cooperative, not preemptive. If the orchestrator is
 *   blocked waiting for a sub-agent or LLM call, the flag isn't seen
 *   until that call returns.
 * - TTL 10 minutes — after that the flag auto-expires. If the workflow
 *   never advances, it stays "running" forever (no wall-clock sweeper).
 */

const STOP_KEY_PREFIX = 'sulla:workflow:stop:';
const STOP_TTL_SECONDS = 600; // 10 min — long enough for the next frontier tick even on slow paths

export function stopKey(executionId: string): string {
  return `${ STOP_KEY_PREFIX }${ executionId }`;
}

export class StopWorkflowWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const executionId = typeof input.executionId === 'string' ? input.executionId.trim() : '';
    const reason = typeof input.reason === 'string' && input.reason.trim().length > 0
      ? input.reason.trim()
      : 'Stopped by user request';

    if (!executionId) {
      return {
        successBoolean: false,
        responseString: 'Missing required field: executionId (the wfp-… id from execute_workflow).',
      };
    }

    try {
      await redisClient.set(stopKey(executionId), reason, STOP_TTL_SECONDS);
      return {
        successBoolean: true,
        responseString:
          `Stop flag set for execution ${ executionId } (reason: "${ reason }"). ` +
          `The running orchestrator will honor it on its next frontier tick — ` +
          `if it's blocked on a long-running sub-agent or LLM call, the abort ` +
          `takes effect when that call returns. For immediate hard-kill, restart Sulla Desktop.`,
      };
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Failed to set stop flag: ${ (err as Error).message }`,
      };
    }
  }
}
