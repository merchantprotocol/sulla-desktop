import { getAgentTabContractService } from '../../services/AgentTabContractService';
import { BaseTool, ToolResponse } from '../base';

export class MessageAgentTabWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const parentThreadId = String(this.state?.metadata?.threadId ?? '').trim();
    if (!parentThreadId) return { successBoolean: false, responseString: 'message_tab must be called from a parent chat thread.' };
    if (!input.contractId && !input.childThreadId) {
      return { successBoolean: false, responseString: 'Provide contractId or childThreadId.' };
    }
    try {
      const row = await getAgentTabContractService().messageChild(parentThreadId, {
        contractId: typeof input.contractId === 'string' ? input.contractId.trim() : undefined,
        childThreadId: typeof input.childThreadId === 'string' ? input.childThreadId.trim() : undefined,
        message: String(input.message ?? '').trim(),
      });
      return { successBoolean: true, responseString: `Message delivered to child thread ${ row.child_thread_id }.` };
    } catch (error) {
      return { successBoolean: false, responseString: (error as Error).message };
    }
  }
}
