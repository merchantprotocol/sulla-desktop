import { BaseTool, ToolResponse } from '../base';

/**
 * get_human_presence — Reads the current human presence state from Redis.
 * Used by the heartbeat to check if the human is available before deciding
 * whether to send a message or work autonomously.
 */
export class GetHumanPresenceWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    try {
      const { getHumanHeartbeatBridge } = await import('../../services/HumanHeartbeatBridge');
      const bridge = getHumanHeartbeatBridge();

      const presence = await bridge.getPresence();
      const summary = await bridge.getPresenceSummary();

      return {
        successBoolean: true,
        responseString: summary,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Failed to read human presence: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }
}
