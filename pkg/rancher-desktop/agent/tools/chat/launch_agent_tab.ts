import {
  delegationSituation,
  delegationTaskId,
  safeRejectDelegation,
  safeStartDelegation,
  type AgentDelegationStart,
} from '../../database/models/AgentDelegationModel';
import { getAgentTabContractService } from '../../services/AgentTabContractService';
import { BaseTool, ToolResponse } from '../base';

export class LaunchAgentTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const parentThreadId = String(this.state?.metadata?.threadId ?? '').trim();
    const parentChannel = String(this.state?.metadata?.wsChannel ?? '').trim();
    const parentAgentId = String(
      (this.state?.metadata as any)?.routedAgentId ?? this.state?.metadata?.agentId ?? parentChannel,
    ).trim();
    if (!parentThreadId || !parentChannel || !parentAgentId) {
      return { successBoolean: false, responseString: 'launch_agent_tab must be called from an active chat thread.' };
    }
    const agentId = String(input.agentId ?? '').trim();
    const brief = String(input.brief ?? '').trim();
    // Delegation outcome log (routing training data); returnContract closes it.
    const delegation: AgentDelegationStart = {
      via:            'agent_tab',
      parentAgentId,
      parentThreadId,
      childAgentId:   agentId,
      taskId:         delegationTaskId(undefined, this.state?.metadata),
      situation:      delegationSituation(this.state?.messages),
      brief,
    };
    try {
      const result = await getAgentTabContractService().launch({
        parentThreadId,
        parentChannel,
        parentAgentId,
        agentId,
        brief,
        title: typeof input.title === 'string' ? input.title : undefined,
        contract: input.contract,
        focus: input.focus === true,
      });
      await safeStartDelegation({ ...delegation, childThreadId: result.childThreadId, refId: result.contractId });
      return { successBoolean: true, responseString: JSON.stringify(result) };
    } catch (error) {
      await safeRejectDelegation(delegation, (error as Error).message);
      return { successBoolean: false, responseString: (error as Error).message };
    }
  }
}
