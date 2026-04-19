import { registry } from '../../integrations';
import { BaseTool, ToolResponse } from '../base';

import type { SlackClient } from '../../integrations/slack/SlackClient';

/**
 * Slack Thread Tool - Worker class for execution
 */
export class SlackThreadWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { channel, ts } = input;

    try {
      const slack = await registry.get<SlackClient>('slack');
      if (!slack) {
        return {
          successBoolean: false,
          responseString: `Slack integration is not initialized for command ${ this.name }`,
        };
      }
      const replies = await slack.getThreadReplies(channel, ts);
      if (!replies || replies.length === 0) {
        return {
          successBoolean: false,
          responseString: `No replies found in Slack thread for message ${ ts } in channel ${ channel }`,
        };
      }
      const repliesStr = replies.map(reply => `- ${ reply.user }: ${ reply.text } (at ${ reply.ts })`).join('\n');
      return {
        successBoolean: true,
        responseString: `Slack thread replies for message ${ ts } in channel ${ channel } (${ replies.length } replies):\n${ repliesStr }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error getting Slack thread: ${ (error as Error).message }`,
      };
    }
  }
}
