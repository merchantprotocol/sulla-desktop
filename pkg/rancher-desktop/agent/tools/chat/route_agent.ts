import { applyThreadAgentRoute, resolveRoutableAgent } from '../../services/ChatAgentRouting';
import { BaseTool, ToolResponse } from '../base';

export class RouteAgentWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const requested = String(input.agentId ?? '').trim();
    const agent = await resolveRoutableAgent(requested);
    if (!agent) {
      return { successBoolean: false, responseString: `Agent "${ requested }" does not exist or is not usable.` };
    }

    if (this.state?.metadata?.threadId) applyThreadAgentRoute(this.state, agent);
    return {
      successBoolean: true,
      responseString: `Chat routed to ${ agent.name } (${ agent.agentId }).`,
    };
  }
}
