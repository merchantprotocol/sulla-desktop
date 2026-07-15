import { BaseTool, ToolResponse } from '../base';
import { getConversation } from './agentConversations';
import { runConversationTurn } from './conversationRunner';

/**
 * Send a follow-up message to an open sub-agent conversation and get its reply.
 * The sub-agent retains its full prior context (it's the same thread), so you
 * can clarify, correct, or ask it to continue. Blocks for the sub-agent's turn.
 */
export class SendAgentMessageWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { conversationId, message } = input;

    if (!conversationId || typeof conversationId !== 'string') {
      return {
        successBoolean: false,
        responseString: 'conversationId is required (from start_agent_conversation).',
      };
    }
    if (!message || typeof message !== 'string') {
      return {
        successBoolean: false,
        responseString: 'message is required (what to say to the sub-agent).',
      };
    }

    const conv = getConversation(conversationId);
    if (!conv) {
      return {
        successBoolean: false,
        responseString: `Conversation "${ conversationId }" not found. It may have been closed or expired (idle conversations are pruned after 1 hour).`,
      };
    }

    if (conv.status === 'busy') {
      return {
        successBoolean: false,
        responseString: `Conversation "${ conversationId }" is still working its previous message. Try read_agent_conversation shortly, then send again.`,
      };
    }

    const result = await runConversationTurn(conv, message, this.state, false);

    return {
      successBoolean: result.status !== 'error',
      responseString: JSON.stringify({
        conversationId: conv.conversationId,
        status:         result.status,
        reply:          result.reply,
      }, null, 2),
    };
  }
}
