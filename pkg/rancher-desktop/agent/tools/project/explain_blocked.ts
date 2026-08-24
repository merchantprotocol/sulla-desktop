import { ProjectReadinessModel } from '../../database/models/ProjectReadinessModel';
import { BaseTool, ToolResponse } from '../base';

export class ExplainBlockedWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
    if (!taskId) return { successBoolean: false, responseString: 'task_id is required.' };
    try {
      const explanation = await ProjectReadinessModel.explainBlocked(taskId);
      return { successBoolean: true, responseString: JSON.stringify(explanation, null, 2) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Failed to explain blocked task: ${ err?.message ?? String(err) }` };
    }
  }
}
