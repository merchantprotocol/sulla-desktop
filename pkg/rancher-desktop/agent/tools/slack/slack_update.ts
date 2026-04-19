import { registry } from '../../integrations';
import { BaseTool, ToolResponse } from '../base';

import type { SlackClient } from '../../integrations/slack/SlackClient';

/**
 * Slack Update Tool - Worker class for execution
 */
export class SlackUpdateWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { channel, ts, text } = input;

    try {
      const slack = await registry.get<SlackClient>('slack');
      if (!slack) {
        return {
          successBoolean: false,
          responseString: `Slack integration is not initialized for command ${ this.name }`,
        };
      }
      const res = await slack.updateMessage(channel, ts, text);
      if (res.ok) {
        return {
          successBoolean: true,
          responseString: `Slack message updated successfully in channel ${ channel } at timestamp ${ ts }`,
        };
      } else {
        return {
          successBoolean: false,
          responseString: `Failed to update Slack message: ${ res.error || 'Unknown error' }`,
        };
      }
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error updating Slack message: ${ (error as Error).message }`,
      };
    }
  }
}
