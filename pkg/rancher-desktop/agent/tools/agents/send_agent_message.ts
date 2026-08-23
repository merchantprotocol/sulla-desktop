import { BaseTool, ToolResponse } from '../base';

/**
 * Deprecated: async jobs are intentionally bounded, single-instruction work.
 */
export class SendAgentMessageWorker extends BaseTool {
  name = '';
  description = '';

  // Compatibility validation is synchronous, but BaseTool's contract is a Promise.
  protected _validatedCall(input: any): Promise<ToolResponse> {
    const { conversationId, message } = input;

    if (!conversationId || typeof conversationId !== 'string') {
      return Promise.resolve({
        successBoolean: false,
        responseString: 'conversationId is required (from start_agent_conversation).',
      });
    }
    if (!message || typeof message !== 'string') {
      return Promise.resolve({
        successBoolean: false,
        responseString: 'message is required (what to say to the sub-agent).',
      });
    }

    return Promise.resolve({
      successBoolean: false,
      responseString: `send_agent_message is deprecated and cannot continue "${ conversationId }". Launch the next bounded task with spawn_agent; use check_agent_jobs for fallback/history of an existing job. Multi-turn continuation requires a separate continue_agent_job contract.`,
    });
  }
}
