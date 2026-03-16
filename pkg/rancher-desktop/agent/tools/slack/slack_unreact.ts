import { BaseTool, ToolResponse } from '../base';
import { registry } from '../../integrations';
import type { SlackClient } from '../../integrations/slack/SlackClient';

/**
 * Slack Unreact Tool - Worker class for execution
 */
export class SlackUnreactWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { channel, ts, reaction } = input;

    try {
      const slack = await registry.get<SlackClient>('slack');
      if (!slack) {
        return {
          successBoolean: false,
          responseString: `Slack integration is not initialized for command ${ this.name }`,
        };
      }
      await slack.removeReaction(channel, ts, reaction);
      return {
        successBoolean: true,
        responseString: `Slack reaction ":${ reaction }:" removed successfully from message ${ ts } in channel ${ channel }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error removing Slack reaction: ${ (error as Error).message }`,
      };
    }
  }
}
