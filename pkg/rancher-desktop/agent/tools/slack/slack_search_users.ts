import { registry } from '../../integrations';
import { BaseTool, ToolResponse } from '../base';

import type { SlackClient } from '../../integrations/slack/SlackClient';

/**
 * Slack Search Users Tool - Worker class for execution
 */
export class SlackSearchUsersWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { query, limit = 10 } = input;

    try {
      const slack = await registry.get<SlackClient>('slack');
      if (!slack) {
        return {
          successBoolean: false,
          responseString: `Slack integration is not initialized for command ${ this.name }`,
        };
      }
      const users = await slack.searchUsers(query, limit);

      if (!users || users.length === 0) {
        return {
          successBoolean: false,
          responseString: `No Slack users found for query: ${ query }`,
        };
      }

      const usersText = users
        .map((user: any) => `- ${ user.id }: ${ user.real_name || user.profile?.real_name || user.name || 'Unknown' } (${ user.name || 'N/A' })`)
        .join('\n');

      return {
        successBoolean: true,
        responseString: `Found ${ users.length } Slack user(s) for query "${ query }":\n${ usersText }`,
      };
    } catch (error) {
      return {
        successBoolean: false,
        responseString: `Error searching Slack users: ${ (error as Error).message }`,
      };
    }
  }
}
