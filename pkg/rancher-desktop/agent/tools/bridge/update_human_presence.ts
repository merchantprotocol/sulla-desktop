import { BaseTool, ToolResponse } from '../base';

/**
 * update_human_presence — Updates what the human is currently viewing/doing in Redis.
 * Called by the frontend to keep other agents informed about human activity.
 */
export class UpdateHumanPresenceWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { available, current_view, current_activity, active_channel } = input;

    try {
      const { getHumanHeartbeatBridge } = await import('../../services/HumanHeartbeatBridge');
      const bridge = getHumanHeartbeatBridge();

      await bridge.updatePresence({
        available:       available !== undefined ? available : true,
        currentView:     current_view || 'unknown',
        currentActivity: current_activity || 'unknown',
        activeChannel:   active_channel || '',
      });

      return {
        successBoolean: true,
        responseString: `Human presence updated. Available: ${ available !== undefined ? available : true }, View: ${ current_view || 'unknown' }, Activity: ${ current_activity || 'unknown' }, Channel: ${ active_channel || 'none' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Failed to update human presence: ${ error instanceof Error ? error.message : String(error) }`,
      };
    }
  }
}
