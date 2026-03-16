import { BaseTool, ToolResponse } from '../base';
import { registry } from '../../integrations';
import type { SlackClient } from '../../integrations/slack/SlackClient';

/**
 * Slack User Tool - Worker class for execution
 */
export class SlackUserWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { userId } = input;

    try {
      const slack = await registry.get<SlackClient>('slack');
      if (!slack) {
        return {
          successBoolean: false,
          responseString: `Slack integration is not initialized for command ${ this.name }`,
        };
      }
      const user = await slack.getUserInfo(userId);
      return {
        successBoolean: true,
        responseString: `Slack user info for ${ userId }:\n- ID: ${ user.id }\n- Name: ${ user.name }\n- Real Name: ${ user.real_name || user.profile?.real_name || 'N/A' }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting Slack user info: ${ (error as Error).message }`,
      };
    }
  }
}
