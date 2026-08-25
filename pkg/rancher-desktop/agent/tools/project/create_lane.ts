import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class CreateLaneWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const row = await getProjectsApplicationService().createLane({
        lane_key:      input.lane_key,
        scope:         input.scope,
        project_id:    input.project_id || null,
        base_lane_key: input.base_lane_key || null,
        display_name:  input.display_name,
        description:   input.description,
        color:         input.color || null,
        icon:          input.icon || null,
        position:      input.position,
        semantic_role: input.semantic_role,
        enabled:       input.enabled,
        actor:         input.actor || 'sulla',
      }, { actor: input.actor || 'sulla', source: 'tool' });
      return { successBoolean: true, responseString: JSON.stringify(row) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Create lane failed: ${ err?.message }` };
    }
  }
}
