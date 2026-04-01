import { BaseTool, ToolResponse } from '../base';
import { ConversationHistoryModel } from '@pkg/agent/database/models/ConversationHistoryModel';

/**
 * Search Conversations Tool — search past chat conversations, browser visits,
 * and workflow executions stored in the conversation history database.
 */
export class SearchConversationsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const action = (input.action as string) || 'search';

      switch (action) {
      case 'search': {
        if (!input.query) {
          return { successBoolean: false, responseString: '"query" is required for search action.' };
        }

        const results = await ConversationHistoryModel.search(input.query);

        if (results.length === 0) {
          return {
            successBoolean: true,
            responseString: `No conversations found matching "${ input.query }".`,
          };
        }

        const lines = results.map((r: any) => {
          const date = new Date(r.last_active_at || r.created_at).toLocaleString();
          const status = r.status === 'active' ? '' : ` [${ r.status }]`;

          return `  [${ r.type }] ${ r.title || 'Untitled' } — ${ date }${ status }${ r.url ? ` (${ r.url })` : '' }`;
        });

        return {
          successBoolean: true,
          responseString: `Found ${ results.length } conversation(s):\n${ lines.join('\n') }`,
        };
      }

      case 'recent': {
        const limit = input.limit || 20;
        const type = input.type || undefined;
        const results = await ConversationHistoryModel.getRecent(limit, type);

        if (results.length === 0) {
          return {
            successBoolean: true,
            responseString: `No recent conversations found${ type ? ` of type "${ type }"` : '' }.`,
          };
        }

        const lines = results.map((r: any) => {
          const date = new Date(r.last_active_at || r.created_at).toLocaleString();

          return `  [${ r.type }] ${ r.title || 'Untitled' } — ${ date } (${ r.message_count || 0 } msgs)${ r.url ? ` ${ r.url }` : '' }`;
        });

        return {
          successBoolean: true,
          responseString: `${ results.length } recent conversation(s):\n${ lines.join('\n') }`,
        };
      }

      case 'get': {
        if (!input.id && !input.threadId) {
          return { successBoolean: false, responseString: '"id" or "threadId" is required for get action.' };
        }

        let record;

        if (input.threadId) {
          record = await ConversationHistoryModel.getByThread(input.threadId);
        } else {
          record = await ConversationHistoryModel.getById(input.id);
        }

        if (!record) {
          return {
            successBoolean: true,
            responseString: `No conversation found with ${ input.threadId ? `threadId "${ input.threadId }"` : `id "${ input.id }"` }.`,
          };
        }

        const details = [
          `ID: ${ record.id }`,
          `Type: ${ record.type }`,
          `Title: ${ record.title || 'Untitled' }`,
          `Status: ${ record.status }`,
          `Messages: ${ record.message_count || 0 }`,
          `Created: ${ new Date(record.created_at).toLocaleString() }`,
          `Last Active: ${ new Date(record.last_active_at).toLocaleString() }`,
          record.thread_id ? `Thread ID: ${ record.thread_id }` : null,
          record.url ? `URL: ${ record.url }` : null,
          record.summary ? `Summary: ${ record.summary }` : null,
          record.log_file ? `Log File: ${ record.log_file }` : null,
        ].filter(Boolean);

        return {
          successBoolean: true,
          responseString: details.join('\n'),
        };
      }

      default:
        return { successBoolean: false, responseString: `Unknown action: ${ action }. Use search, recent, or get.` };
      }
    } catch (error) {
      return { successBoolean: false, responseString: `Conversation search failed: ${ (error as Error).message }` };
    }
  }
}
