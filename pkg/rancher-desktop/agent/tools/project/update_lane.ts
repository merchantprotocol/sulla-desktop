import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class UpdateLaneWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const row = await getProjectsApplicationService().updateLane(String(input.id || '').trim(), {
        display_name:  input.display_name,
        description:   input.description,
        color:         input.color === '' ? null : input.color,
        icon:          input.icon === '' ? null : input.icon,
        position:      input.position,
        semantic_role: input.semantic_role,
        enabled:       input.enabled,
        actor:         input.actor || 'sulla',
      }, { actor: input.actor || 'sulla', source: 'tool' });
      if (!row) return { successBoolean: false, responseString: `No active lane found with id: ${ input.id }` };
      return { successBoolean: true, responseString: JSON.stringify(row) };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Update lane failed: ${ err?.message }` };
    }
  }
}
