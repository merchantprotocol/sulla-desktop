import { getAgentTabContractService, type AgentTabContractStatus } from '../../services/AgentTabContractService';
import { BaseTool, ToolResponse } from '../base';

export class ListAgentTabContractsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const parentThreadId = String(this.state?.metadata?.threadId ?? '').trim();
    if (!parentThreadId) return { successBoolean: false, responseString: 'list_tab_contracts must be called from a parent chat thread.' };
    const rows = await getAgentTabContractService().list(parentThreadId, input.status as AgentTabContractStatus | undefined);
    return {
      successBoolean: true,
      responseString: JSON.stringify(rows.map(row => ({
        contractId: row.id,
        childThreadId: row.child_thread_id,
        childAgentId: row.child_agent_id,
        title: row.title,
        contract: row.contract_spec,
        status: row.status,
        result: row.result,
        depth: row.depth,
        createdAt: row.created_at,
        returnedAt: row.returned_at,
      }))),
    };
  }
}
