import { WorkLaneWorkflowBindingModel } from '../../database/models/WorkLaneWorkflowBindingModel';
import { BaseTool, ToolResponse } from '../base';

export class SetLaneWorkflowBindingWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const row = await WorkLaneWorkflowBindingModel.set({
        scope:        input.scope,
        workflowId:   String(input.workflow_id || '').trim(),
        laneKey:      input.lane_key,
        semanticRole: input.semantic_role,
        epicId:       input.epic_id,
        projectId:    input.project_id,
        profileId:    input.profile_id,
        actor:        input.actor || 'sulla',
      });
      return { successBoolean: true, responseString: JSON.stringify(row, null, 2) };
    } catch (error) {
      return { successBoolean: false, responseString: `Failed to set lane workflow binding: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
