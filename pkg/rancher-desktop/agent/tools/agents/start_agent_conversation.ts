import { BaseTool, ToolResponse } from '../base';
import { SpawnAgentWorker } from './spawn_agent';

/**
 * Deprecated compatibility wrapper over spawn_agent. The old persistent
 * conversation model is retired; conversationId is now a jobId alias.
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

    const label = input.label || input.agentId || 'conversation';
    const spawn = new SpawnAgentWorker();
    const result = await spawn.runValidated({
      tasks:    [{ prompt, agentId: input.agentId, label }],
      parallel: false,
      async:    true,
    }, this.state);

    if (!result.successBoolean) return result;

    const spawned = JSON.parse(result.responseString);

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        conversationId: spawned.jobId,
        jobId:          spawned.jobId,
        label,
        status:         'running',
        reply:          '',
        deprecated:     true,
        hint:           `start_agent_conversation now launches an async spawn_agent job. Results wake the parent graph automatically; use check_agent_jobs(jobId: "${ spawned.jobId }") only as fallback/history. Multi-turn follow-ups are no longer supported.`,
      }, null, 2),
    };
  }
}
