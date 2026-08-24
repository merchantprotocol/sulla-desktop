import { WorkLaneWorkflowBindingModel } from '../../database/models/WorkLaneWorkflowBindingModel';
import { BaseTool, ToolResponse } from '../base';

export class InspectLaneEntryAutomationWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const rows = await WorkLaneWorkflowBindingModel.listLaneEntries(String(input.task_id || '').trim());
      return { successBoolean: true, responseString: JSON.stringify(rows, null, 2) };
    } catch (error) {
      return { successBoolean: false, responseString: `Failed to inspect lane-entry automation: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
