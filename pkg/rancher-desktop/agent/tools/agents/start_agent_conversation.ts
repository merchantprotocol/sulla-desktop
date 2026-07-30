import { BaseTool, ToolResponse } from '../base';
import { createConversation, atConversationCap } from './agentConversations';
import { runConversationTurn } from './conversationRunner';

const MAX_DEPTH = 3;

/**
 * Open a persistent, multi-turn conversation with a sub-agent. Runs the first
 * turn synchronously and returns the sub-agent's reply plus a conversationId to
 * continue with send_agent_message / read_agent_conversation. Unlike
 * spawn_agent, the sub-agent stays alive between messages so you can have a real
 * back-and-forth (delegate, then clarify, correct, or ask follow-ups).
 */
export class StartAgentConversationWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const prompt: string = input.prompt;
    if (!prompt || typeof prompt !== 'string') {
      return {
        successBoolean: false,
        responseString: 'prompt is required (the opening message to the sub-agent).',
      };
    }

    const parentDepth: number = (this.state)?.metadata?.subAgentDepth ?? 0;
    if (parentDepth >= MAX_DEPTH) {
      return {
        successBoolean: false,
        responseString: `Sub-agent depth limit reached (${ MAX_DEPTH }). Cannot open further conversations from here.`,
      };
    }

    if (atConversationCap()) {
      return {
        successBoolean: false,
        responseString: 'Too many open sub-agent conversations. Close one with close_agent_conversation before opening another.',
      };
    }

    const parentChannel = (this.state)?.metadata?.wsChannel || 'sulla-desktop';
    const channel = input.agentId || parentChannel;
    const label = input.label || input.agentId || 'conversation';

    const conv = createConversation(channel, label);
    const result = await runConversationTurn(conv, prompt, this.state, true);

    return {
      successBoolean: result.status !== 'error',
      responseString: JSON.stringify({
        conversationId: conv.conversationId,
        label:          conv.label,
        status:         result.status,
        reply:          result.reply,
        hint:           `Continue with send_agent_message(conversationId: "${ conv.conversationId }", message: "...") or close_agent_conversation when done.`,
      }, null, 2),
    };
  }
}
