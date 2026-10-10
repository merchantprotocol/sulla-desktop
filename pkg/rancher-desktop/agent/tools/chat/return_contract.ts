import { getAgentTabContractService } from '../../services/AgentTabContractService';
import { BaseTool, ToolResponse } from '../base';

export class ReturnAgentTabContractWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const childThreadId = String(this.state?.metadata?.threadId ?? '').trim();
    if (!childThreadId) return { successBoolean: false, responseString: 'return_contract must be called from a child chat thread.' };
    try {
      const row = await getAgentTabContractService().returnContract(
        childThreadId,
        String(input.contractId ?? '').trim(),
        input.result,
        typeof input.summary === 'string' ? input.summary : undefined,
      );
      return { successBoolean: true, responseString: `Contract ${ row.id } returned to the parent chat.` };
    } catch (error) {
      return { successBoolean: false, responseString: (error as Error).message };
    }
  }
}
