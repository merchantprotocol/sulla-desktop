import { BaseTool, ToolResponse } from '../base';
import { SpawnAgentWorker } from '../agents/spawn_agent';

/**
 * Alias of spawn_agent with visibility "tab". One delegation path: the tab is
 * an agent_jobs job with a contract, shown in the parent's sub-agent rail.
 */
export class LaunchAgentTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const brief = String(input.brief ?? input.prompt ?? '').trim();
    if (!brief) return { successBoolean: false, responseString: 'Agent-tab brief is required and cannot be empty.' };

    const result = await new SpawnAgentWorker().runValidated({
      tasks: [{
        agentId:       String(input.agentId ?? '').trim(),
        prompt:        brief,
        label:         typeof input.title === 'string' ? input.title : undefined,
        contract:      input.contract,
        projectTaskId: input.projectTaskId,
        focus:         input.focus === true,
        visibility:    'tab',
      }],
    }, this.state);
    if (!result.successBoolean) return result;

    const launched = JSON.parse(result.responseString);
    return {
      successBoolean: true,
      responseString: JSON.stringify({
        contractId:    launched.contractId,
        jobId:         launched.jobId,
        childThreadId: launched.childThreadId,
      }),
    };
  }
}
