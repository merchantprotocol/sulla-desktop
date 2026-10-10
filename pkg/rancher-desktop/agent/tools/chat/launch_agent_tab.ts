import { getAgentTabContractService } from '../../services/AgentTabContractService';
import { BaseTool, ToolResponse } from '../base';

export class LaunchAgentTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const parentThreadId = String(this.state?.metadata?.threadId ?? '').trim();
    const parentChannel = String(this.state?.metadata?.wsChannel ?? '').trim();
    const parentAgentId = String(this.state?.metadata?.agentId ?? parentChannel).trim();
    if (!parentThreadId || !parentChannel || !parentAgentId) {
      return { successBoolean: false, responseString: 'launch_agent_tab must be called from an active chat thread.' };
    }
    try {
      const result = await getAgentTabContractService().launch({
        parentThreadId,
        parentChannel,
        parentAgentId,
        agentId: String(input.agentId ?? '').trim(),
        brief: String(input.brief ?? '').trim(),
        title: typeof input.title === 'string' ? input.title : undefined,
        contract: input.contract,
        focus: input.focus === true,
      });
      return { successBoolean: true, responseString: JSON.stringify(result) };
    } catch (error) {
      return { successBoolean: false, responseString: (error as Error).message };
    }
  }
}
