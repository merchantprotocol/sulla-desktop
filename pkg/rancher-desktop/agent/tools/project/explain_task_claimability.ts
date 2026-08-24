import { WorkTaskDependencyModel } from '../../database/models/WorkTaskDependencyModel';
import { BaseTool, ToolResponse } from '../base';

/** Explain whether a task is claimable: dependency chain + exact blocking reason. */
export class ExplainTaskClaimabilityWorker extends BaseTool {
  name = '';
  description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    if (!taskId) return { successBoolean: false, responseString: 'task_id is required.' };
    try {
      const explanation = await WorkTaskDependencyModel.explainClaimability(taskId);
      return { successBoolean: true, responseString: JSON.stringify(explanation, null, 2) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to explain task claimability: ${ err?.message ?? String(err) }` };
    }
  }
}
