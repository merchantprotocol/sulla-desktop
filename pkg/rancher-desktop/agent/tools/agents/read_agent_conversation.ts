import { BaseTool, ToolResponse } from '../base';
import { getConversation, getAllConversations } from './agentConversations';

/**
 * Read the transcript of an open sub-agent conversation, or list all open
 * conversations when called without a conversationId. Useful to catch up on a
 * conversation whose last message was still in progress, or to see what's open.
 */
export class ReadAgentConversationWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const { conversationId } = input;

    if (conversationId) {
      const conv = getConversation(conversationId);
      if (!conv) {
        return {
          successBoolean: false,
          responseString: `Conversation "${ conversationId }" not found (closed or expired).`,
        };
      }

      const transcript = conv.transcript
        .map(t => `**${ t.from === 'parent' ? 'You' : conv.label }:** ${ t.text }`)
        .join('\n\n');

      return {
        successBoolean: true,
        responseString: JSON.stringify({
          conversationId: conv.conversationId,
          label:          conv.label,
          status:         conv.status,
          turns:          conv.transcript.length,
          transcript:     transcript || '(no messages yet)',
        }, null, 2),
      };
    }

    // No id — list open conversations.
    const all = getAllConversations();
    if (all.length === 0) {
      return {
        successBoolean: true,
        responseString: 'No open sub-agent conversations.',
      };
    }

    const summary = all.map((c) => {
      const idle = Math.round((Date.now() - c.lastActive) / 1000);

      return `- **${ c.conversationId }** (${ c.label }): ${ c.status }, ${ c.transcript.length } turn(s), idle ${ idle }s`;
    }).join('\n');

    return {
      successBoolean: true,
      responseString: `${ all.length } open conversation(s):\n\n${ summary }`,
    };
  }
}
