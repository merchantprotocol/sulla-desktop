import { getProjectsApplicationService } from '../../projects/application/ProjectsApplicationService';
import { BaseTool, ToolResponse } from '../base';

export class ResetLaneOverrideWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const reset = await getProjectsApplicationService().resetLaneOverride(
        String(input.project_id || '').trim(), String(input.lane_key || '').trim(),
        { actor: input.actor || 'sulla', source: 'tool' },
      );
      return reset
        ? { successBoolean: true, responseString: `Project lane ${ input.lane_key } now inherits the global definition.` }
        : { successBoolean: false, responseString: `No active project override found for lane: ${ input.lane_key }` };
    } catch (err: any) {
      return { successBoolean: false, responseString: `Reset lane override failed: ${ err?.message }` };
    }
  }
}
