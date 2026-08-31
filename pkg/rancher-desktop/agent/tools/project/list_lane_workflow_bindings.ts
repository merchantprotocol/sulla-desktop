import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class ListLaneWorkflowBindingsWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const rows = await getProjectsApplicationService().listLaneBindings({
        profileId:       input.profile_id,
        scope:           input.scope,
        epicId:          input.epic_id,
        projectId:       input.project_id,
        laneKey:         input.lane_key,
        semanticRole:    input.semantic_role,
        includeArchived: Boolean(input.include_archived),
      });
      return { successBoolean: true, responseString: JSON.stringify(rows, null, 2) };
    } catch (error) {
      return { successBoolean: false, responseString: `Failed to list lane workflow bindings: ${ error instanceof Error ? error.message : String(error) }` };
    }
  }
}
