import { BaseTool, ToolResponse } from '../base';
import { getConversation, deleteConversation } from './agentConversations';

/**
 * Close a sub-agent conversation and free its resources — drops the sub-agent's
 * graph + state from the GraphRegistry and removes it from the conversation
 * registry. Do this when you're done talking to a sub-agent so its context
 * doesn't linger in memory.
 */
export class CloseAgentConversationWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { conversationId } = input;

    if (!conversationId || typeof conversationId !== 'string') {
      return {
        successBoolean: false,
        responseString: 'conversationId is required.',
      };
    }

    const conv = getConversation(conversationId);
    if (!conv) {
      return {
        successBoolean: false,
        responseString: `Conversation "${ conversationId }" not found (already closed or expired).`,
      };
    }

    // Drop the sub-agent's cached graph + state so it doesn't linger.
    try {
      const { GraphRegistry } = await import('../../services/GraphRegistry');
      GraphRegistry.delete(conv.threadId);
    } catch {
      // best-effort — registry cleanup is not critical to closing the record
    }

    deleteConversation(conversationId);

    return {
      successBoolean: true,
      responseString: `Conversation "${ conversationId }" (${ conv.label }) closed after ${ conv.transcript.length } turn(s).`,
    };
  }
}
