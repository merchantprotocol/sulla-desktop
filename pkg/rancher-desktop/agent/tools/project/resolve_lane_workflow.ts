import { WorkLaneWorkflowBindingModel } from '../../database/models/WorkLaneWorkflowBindingModel';
import { BaseTool, ToolResponse } from '../base';

export class ResolveLaneWorkflowWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const row = await WorkLaneWorkflowBindingModel.resolve(
        String(input.task_id || '').trim(), String(input.lane_key || '').trim(), input.profile_id || 'default');
      return { successBoolean: true, responseString: JSON.stringify(row, null, 2) };
    } catch (error) {
      return { successBoolean: false, responseString: `Failed to resolve lane workflow: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
